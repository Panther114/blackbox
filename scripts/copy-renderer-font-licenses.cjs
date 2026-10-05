#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourceDirectory = path.join(root, 'src/gui/renderer/src/assets/fonts');
const destinationDirectory = path.join(root, 'dist/gui/renderer/licenses');
const licenses = ['FFL-Satoshi.txt'];

fs.mkdirSync(destinationDirectory, { recursive: true });
for (const filename of licenses) {
  const sourcePath = path.join(sourceDirectory, filename);
  if (!fs.existsSync(sourcePath)) throw new Error(`Font license file is missing: ${sourcePath}`);
  fs.copyFileSync(sourcePath, path.join(destinationDirectory, filename));
}
fs.copyFileSync(
  path.join(root, 'src/gui/renderer/src/assets/icons/LICENSE-Lucide.txt'),
  path.join(destinationDirectory, 'LICENSE-Lucide.txt')
);

console.log(`[font-licenses] Copied ${licenses.length} font license files to ${destinationDirectory}`);
