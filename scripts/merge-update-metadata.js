#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const [rootArg, filename] = process.argv.slice(2);
if (!rootArg || !filename) {
  console.error('Usage: node scripts/merge-update-metadata.js <artifact-root> <metadata-filename>');
  process.exit(1);
}

const root = path.resolve(rootArg);
const sources = [];

function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(entryPath);
    else if (entry.name === filename) sources.push(entryPath);
  }
}

if (fs.existsSync(root)) collect(root);
if (sources.length === 0) {
  console.log(`[metadata] ${filename}: no metadata found`);
  process.exit(0);
}

const documents = sources.map(source => yaml.load(fs.readFileSync(source, 'utf8')));
const files = [];
const seenUrls = new Set();
for (const document of documents) {
  for (const file of Array.isArray(document.files) ? document.files : []) {
    if (!file || typeof file.url !== 'string' || seenUrls.has(file.url)) continue;
    seenUrls.add(file.url);
    files.push(file);
  }
}

const merged = { ...documents[0], files };
fs.writeFileSync(path.join(root, filename), `${yaml.dump(merged, { lineWidth: -1, noRefs: true })}`, 'utf8');
console.log(`[metadata] ${filename}: merged ${sources.length} manifests and ${files.length} files`);
