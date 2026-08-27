#!/usr/bin/env node

const expectedPlatform = {
  windows: 'win32',
  linux: 'linux',
  macos: 'darwin',
}[process.argv[2]];

if (!expectedPlatform) {
  console.error('Usage: node scripts/assert-target-platform.js <windows|linux|macos>');
  process.exit(2);
}

if (process.platform !== expectedPlatform) {
  console.error(
    `[platform] ${process.argv[2]} packaging must run on ${expectedPlatform}; current host is ${process.platform}.`,
  );
  process.exit(1);
}
