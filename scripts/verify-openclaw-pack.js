import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../packages/openclaw/', import.meta.url));

let tarball = '';
try {
  const output = execSync('npm pack --silent', { cwd, encoding: 'utf-8' }).trim();
  tarball = output.split('\n').pop() ?? '';
  if (!tarball) {
    throw new Error('npm pack did not return a tarball name.');
  }

  const tarPath = join(cwd, tarball);
  const listing = execSync(`tar -tf ${tarPath}`, { encoding: 'utf-8' })
    .split('\n')
    .filter(Boolean);

  const required = ['package/openclaw.plugin.json'];
  const missing = required.filter((entry) => !listing.includes(entry));
  if (missing.length > 0) {
    throw new Error(`npm pack missing entries: ${missing.join(', ')}`);
  }
} finally {
  if (tarball) {
    rmSync(join(cwd, tarball), { force: true });
  }
}

console.log('openclaw pack verification passed.');
