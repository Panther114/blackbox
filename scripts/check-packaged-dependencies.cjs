#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { createRequire } = Module;

function exists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function findPackageRoot(resolvedPath, expectedName) {
  let current = path.dirname(resolvedPath);
  while (true) {
    const manifestPath = path.join(current, 'package.json');
    if (exists(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.name === expectedName) return { root: current, manifest };
      } catch {
        // Keep walking; Node may have resolved a file from a package with no usable manifest.
      }
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolvePackage(name, fromDir, appRoot) {
  // Check physical package locations before require.resolve because Node gives
  // core modules such as "buffer" precedence over same-named npm packages.
  for (const nodeModulesPath of Module._nodeModulePaths(fromDir)) {
    const candidate = path.join(nodeModulesPath, ...name.split('/'));
    const manifestPath = path.join(candidate, 'package.json');
    if (!exists(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const packageRoot = fs.realpathSync(candidate);
      if (manifest.name === name && isWithin(appRoot, packageRoot)) {
        return { root: packageRoot, manifest };
      }
    } catch {
      // Continue through Node's remaining search paths.
    }
  }

  let resolvedPath;
  try {
    resolvedPath = createRequire(path.join(fromDir, '__blackbox_dependency_check__.cjs')).resolve(name);
  } catch {
    return null;
  }
  if (!resolvedPath) return null;
  const packageInfo = findPackageRoot(resolvedPath, name);
  if (!packageInfo || !isWithin(appRoot, packageInfo.root)) return null;
  return packageInfo;
}

function checkDependencyClosure(appRoot) {
  const errors = [];
  const rootManifestPath = path.join(appRoot, 'package.json');
  if (!exists(rootManifestPath)) return ['app.asar is missing package.json'];

  const rootManifest = JSON.parse(fs.readFileSync(rootManifestPath, 'utf8'));
  const visited = new Set();
  const queued = new Set();
  const queue = [];

  function enqueue(name, fromDir, optional, owner) {
    const packageInfo = resolvePackage(name, fromDir, appRoot);
    if (!packageInfo) {
      if (!optional) errors.push(`${owner} requires missing package "${name}"`);
      return;
    }
    const key = path.resolve(packageInfo.root);
    if (!queued.has(key)) {
      queued.add(key);
      queue.push(packageInfo);
    }
  }

  function enqueueManifestDependencies(owner, packageRoot, packageManifest) {
    const dependencies = packageManifest.dependencies || {};
    const optionalDependencies = packageManifest.optionalDependencies || {};
    const peers = packageManifest.peerDependencies || {};
    const optionalNames = new Set(Object.keys(optionalDependencies));
    for (const name of Object.keys(dependencies)) {
      if (!optionalNames.has(name)) enqueue(name, packageRoot, false, owner);
    }
    for (const name of Object.keys(optionalDependencies)) {
      enqueue(name, packageRoot, true, owner);
    }
    for (const name of Object.keys(peers)) {
      if (Object.prototype.hasOwnProperty.call(dependencies, name)) continue;
      enqueue(name, packageRoot, packageManifest.peerDependenciesMeta?.[name]?.optional === true, owner);
    }
  }

  enqueueManifestDependencies('application', appRoot, rootManifest);

  while (queue.length) {
    const current = queue.shift();
    const currentPath = path.resolve(current.root);
    if (visited.has(currentPath)) continue;
    visited.add(currentPath);
    const manifest = current.manifest;
    const owner = `${manifest.name || current.root}@${manifest.version || 'unknown'}`;

    enqueueManifestDependencies(owner, current.root, manifest);
  }

  return errors;
}

function platformBrowserCandidates(platformName, browserDirectory) {
  if (platformName === 'win32') {
    return [
      'chrome-win64/chrome.exe',
      'chrome-win/chrome.exe',
    ];
  }
  if (platformName === 'darwin') {
    return [
      'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac-x64/Chromium.app/Contents/MacOS/Chromium',
      'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
      'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return ['chrome-linux64/chrome', 'chrome-linux/chrome'];
}

function archLabel(arch) {
  if (typeof arch === 'string') return arch;
  if (Number.isInteger(arch)) return ['ia32', 'x64', 'armv7l', 'arm64', 'universal'][arch] || process.arch;
  return process.arch;
}

function nativeAddonExists(packageRoot, platformName, arch) {
  const archName = archLabel(arch);
  const expected = archName === 'universal'
    ? ['x64', 'arm64']
    : [archName];
  return (
    exists(path.join(packageRoot, 'build', 'Release', 'better_sqlite3.node')) ||
    expected.some((candidate) => exists(path.join(packageRoot, 'prebuilds', `${platformName}-${candidate}.node`)))
  );
}

function validatePackagedApp({ appRoot, resourcesDir, platformName = process.platform, arch }) {
  const errors = [];
  const appManifestPath = path.join(appRoot, 'package.json');
  if (!exists(appManifestPath)) return ['packaged app is missing package.json'];

  const manifest = JSON.parse(fs.readFileSync(appManifestPath, 'utf8'));
  const requiredFiles = [
    manifest.main,
    'dist/gui/preload.js',
    'dist/gui/worker.js',
    'dist/gui/renderer/index.html',
  ].filter(Boolean);
  for (const relativePath of requiredFiles) {
    if (!exists(path.join(appRoot, relativePath))) errors.push(`packaged app is missing ${relativePath}`);
  }

  errors.push(...checkDependencyClosure(appRoot));

  const unpackedModules = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules');
  const sqlitePackage = path.join(unpackedModules, 'better-sqlite3');
  if (!exists(path.join(sqlitePackage, 'package.json'))) {
    errors.push('native better-sqlite3 package is missing from app.asar.unpacked');
  } else if (!nativeAddonExists(sqlitePackage, platformName, arch)) {
    errors.push(`native better-sqlite3 addon for ${platformName}-${archLabel(arch)} is missing from app.asar.unpacked`);
  }
  if (!exists(path.join(unpackedModules, 'playwright-core', 'package.json'))) {
    errors.push('playwright-core is missing from app.asar.unpacked');
  }

  const browserRoot = path.join(resourcesDir, 'playwright-browsers');
  let browserFound = false;
  if (exists(browserRoot)) {
    const candidates = platformBrowserCandidates(platformName, browserRoot);
    for (const entry of fs.readdirSync(browserRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const buildRoot = path.join(browserRoot, entry.name);
      if (
        exists(path.join(buildRoot, 'INSTALLATION_COMPLETE')) &&
        candidates.some((candidate) => exists(path.join(buildRoot, candidate)))
      ) {
        browserFound = true;
        break;
      }
    }
  }
  // Windows uses the system Microsoft Edge installation; bundling another
  // browser there materially inflates the installer without changing defaults.
  if (!browserFound && platformName !== 'win32') {
    errors.push('packaged Chromium browser is missing or incomplete');
  }

  return errors;
}

function copyOverlay(source, destination) {
  if (!exists(source)) return;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyOverlay(sourcePath, destinationPath);
    } else if (entry.isSymbolicLink()) {
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      try {
        fs.rmSync(destinationPath, { force: true, recursive: true });
        fs.symlinkSync(fs.readlinkSync(sourcePath), destinationPath, process.platform === 'win32' ? 'junction' : undefined);
      } catch {
        // Symlinks are not required for dependency resolution; electron-builder's unpacked files are copied below.
      }
    } else {
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function removeTemporaryDirectory(directory) {
  if (process.platform === 'win32' && exists(directory)) {
    const makeWritable = (current) => {
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        // Best effort; rmSync below will report any remaining failure.
      }
      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) makeWritable(entryPath);
        try {
          fs.chmodSync(entryPath, entry.isDirectory() ? 0o777 : 0o666);
        } catch {
          // Best effort for filesystems that do not support chmod.
        }
      }
      try {
        fs.chmodSync(current, 0o777);
      } catch {
        // Best effort for filesystems that do not support chmod.
      }
    };
    makeWritable(directory);
  }
  fs.rmSync(directory, { recursive: true, force: true });
}

async function afterPack(context) {
  const resourcesDir = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const archivePath = path.join(resourcesDir, 'app.asar');
  if (!exists(archivePath)) throw new Error(`Packaged application archive is missing: ${archivePath}`);

  const asar = require('@electron/asar');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-packaged-check-'));
  const appRoot = path.join(tempRoot, 'app');
  try {
    asar.extractAll(archivePath, appRoot);
    copyOverlay(path.join(resourcesDir, 'app.asar.unpacked'), appRoot);
    const errors = validatePackagedApp({ appRoot, resourcesDir, platformName: context.electronPlatformName, arch: context.arch });
    if (errors.length) throw new Error(`Packaged application validation failed:\n- ${errors.join('\n- ')}`);
    console.log('[packaged-dependencies] Runtime dependency closure and packaged resources verified.');
  } finally {
    removeTemporaryDirectory(tempRoot);
  }
}

module.exports = afterPack;
module.exports.afterPack = afterPack;
module.exports.validatePackagedApp = validatePackagedApp;
module.exports.checkDependencyClosure = checkDependencyClosure;
module.exports.copyOverlay = copyOverlay;
module.exports.nativeAddonExists = nativeAddonExists;
module.exports.removeTemporaryDirectory = removeTemporaryDirectory;
