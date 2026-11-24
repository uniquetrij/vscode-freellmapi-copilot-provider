#!/usr/bin/env node
'use strict';

// Marks the compiled output as a development build so `describeBuild()` does
// not report the number of the last VSIX that happened to be packaged from this
// checkout. The marker lives outside build/out and is excluded from the VSIX,
// so a packaged extension never sees it.

const fs = require('fs');
const path = require('path');

const marker = path.join(__dirname, '..', '..', 'build', '.dev-build');

fs.mkdirSync(path.dirname(marker), { recursive: true });
fs.writeFileSync(marker, `${new Date().toISOString()}\n`, 'utf8');
