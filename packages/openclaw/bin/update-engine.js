#!/usr/bin/env node

/**
 * npx @keyoku/openclaw update-engine
 *
 * Downloads the latest keyoku-engine binary, replacing the current one.
 */

import('../dist/update-engine.js')
  .then((m) => m.updateEngine())
  .catch((err) => {
    console.error('Update failed:', err);
    process.exit(1);
  });
