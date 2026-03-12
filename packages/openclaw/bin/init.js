#!/usr/bin/env node

/**
 * npx @keyoku/openclaw init
 *
 * One-command setup for the Keyoku OpenClaw plugin.
 * This is a thin shim that imports the compiled init module.
 */

import('../dist/init.js')
  .then((m) => m.init())
  .catch((err) => {
    console.error('Setup failed:', err);
    process.exit(1);
  });
