const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validatePackagedApp } = require('../scripts/check-packaged-dependencies.cjs');

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writePackage(root: string, name: string, manifest: Record<string, unknown>) {
  const packageRoot = path.join(root, 'node_modules', ...name.split('/'));
  fs.mkdirSync(packageRoot, { recursive: true });
  writeJson(path.join(packageRoot, 'package.json'), { name, version: '1.0.0', main: 'index.js', ...manifest });
  fs.writeFileSync(path.join(packageRoot, 'index.js'), 'module.exports = {};');
  return packageRoot;
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-validator-test-'));
  const appRoot = path.join(root, 'app');
  const resourcesDir = path.join(root, 'resources');
  const packageRoot = path.join(appRoot, 'package.json');
  writeJson(packageRoot, {
    name: 'blackbox',
    version: '1.1.3',
    main: 'dist/gui/main.js',
    dependencies: { '@scope/top': '1.0.0', 'direct-package': '1.0.0', 'optional-package': '1.0.0', 'hidden-entry': '1.0.0', buffer: '1.0.0' },
    optionalDependencies: { 'optional-package': '1.0.0' },
  });
  for (const file of ['dist/gui/main.js', 'dist/gui/preload.js', 'dist/gui/worker.js', 'dist/gui/renderer/index.html']) {
    const filePath = path.join(appRoot, file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '');
  }

  const topRoot = writePackage(appRoot, '@scope/top', { dependencies: { 'nested-package': '1.0.0' } });
  writePackage(topRoot, 'nested-package', { dependencies: { 'leaf-package': '1.0.0' } });
  writePackage(appRoot, 'leaf-package', {});
  writePackage(appRoot, 'direct-package', {
    optionalDependencies: { 'missing-optional': '1.0.0' },
    peerDependencies: { 'optional-peer': '1.0.0' },
    peerDependenciesMeta: { 'optional-peer': { optional: true } },
  });
  writePackage(appRoot, 'hidden-entry', { exports: { './types': './index.js' } });
  writePackage(appRoot, 'buffer', {});

  const unpackedModules = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules');
  const sqliteRoot = path.join(unpackedModules, 'better-sqlite3');
  fs.mkdirSync(path.join(sqliteRoot, 'build', 'Release'), { recursive: true });
  writeJson(path.join(sqliteRoot, 'package.json'), { name: 'better-sqlite3', version: '1.0.0' });
  fs.writeFileSync(path.join(sqliteRoot, 'build', 'Release', 'better_sqlite3.node'), 'native');
  const playwrightRoot = path.join(unpackedModules, 'playwright-core');
  fs.mkdirSync(playwrightRoot, { recursive: true });
  writeJson(path.join(playwrightRoot, 'package.json'), { name: 'playwright-core', version: '1.0.0' });

  const chromiumRoot = path.join(resourcesDir, 'playwright-browsers', 'chromium-123');
  fs.mkdirSync(path.join(chromiumRoot, 'chrome-linux64'), { recursive: true });
  fs.writeFileSync(path.join(chromiumRoot, 'INSTALLATION_COMPLETE'), 'ok');
  fs.writeFileSync(path.join(chromiumRoot, 'chrome-linux64', 'chrome'), 'browser');

  return { root, appRoot, resourcesDir };
}

describe('packaged dependency validator', () => {
  let fixture: ReturnType<typeof makeFixture>;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  it('accepts a complete scoped and nested dependency closure and required packaged files', () => {
    expect(validatePackagedApp({ ...fixture, platformName: 'linux' })).toEqual([]);
  });

  it('accepts Windows packaging without Chromium because Windows uses system Edge', () => {
    fs.rmSync(path.join(fixture.resourcesDir, 'playwright-browsers'), { recursive: true, force: true });
    expect(validatePackagedApp({ ...fixture, platformName: 'win32' })).toEqual([]);
  });

  it('reports missing transitive packages and packaged resources', () => {
    fs.rmSync(path.join(fixture.appRoot, 'node_modules', 'leaf-package'), { recursive: true, force: true });
    fs.rmSync(path.join(fixture.appRoot, 'node_modules', 'buffer'), { recursive: true, force: true });
    fs.rmSync(path.join(fixture.appRoot, 'dist/gui/worker.js'));
    fs.rmSync(path.join(fixture.resourcesDir, 'app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node'));
    fs.rmSync(path.join(fixture.resourcesDir, 'playwright-browsers'), { recursive: true, force: true });

    const errors = validatePackagedApp({ ...fixture, platformName: 'linux' });
    expect(errors).toContain('nested-package@1.0.0 requires missing package "leaf-package"');
    expect(errors).toContain('application requires missing package "buffer"');
    expect(errors).toContain('packaged app is missing dist/gui/worker.js');
    expect(errors).toContain('native better-sqlite3 addon for linux-x64 is missing from app.asar.unpacked');
    expect(errors).toContain('packaged Chromium browser is missing or incomplete');
  });
});
