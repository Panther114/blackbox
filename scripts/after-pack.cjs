#!/usr/bin/env node
// electron-builder afterPack hook: drop Chromium components Blackbox never uses
// (WebGPU shader compilers and the software Vulkan/WebGL fallback), then verify
// the packaged dependency closure.
const fs = require('node:fs');
const path = require('node:path');
const verify = require('./check-packaged-dependencies.cjs');

const UNUSED = ['dxcompiler.dll', 'dxil.dll', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll'];

module.exports = async function afterPack(context) {
  for (const name of UNUSED) fs.rmSync(path.join(context.appOutDir, name), { force: true });
  await verify(context);
};
