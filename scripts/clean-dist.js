#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const distDirectory = path.resolve(__dirname, '..', 'dist');

// TypeScript does not remove output for source files that were deleted. Clean
// only the generated dist directory before every build so removed modules
// cannot leak into a packaged application.
fs.rmSync(distDirectory, { recursive: true, force: true });
