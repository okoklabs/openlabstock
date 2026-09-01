import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERIFICATION_RECEIPT, verificationState } from './verification-state.mjs';

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pnpmScript = process.env.npm_execpath ?? '';
const pnpmCommand = pnpmScript ? process.execPath : (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
const pnpmArgs = (args) => pnpmScript ? [pnpmScript, ...args] : args;
const commands = [
  [pnpmCommand, pnpmArgs(['run', 'check:docs'])],
  [pnpmCommand, pnpmArgs(['run', 'check:licenses'])],
  [pnpmCommand, pnpmArgs(['run', 'check'])],
  [pnpmCommand, pnpmArgs(['run', 'build'])],
  [pnpmCommand, pnpmArgs(['test'])],
  [pnpmCommand, pnpmArgs(['audit', '--prod'])],
];

for (const [command, args] of commands) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    ...(process.platform === 'win32' && !pnpmScript ? { shell: true } : {}),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const metadata = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const state = verificationState(rootDir);
const receipt = {
  format: 1,
  version: metadata.version,
  fingerprint: state.fingerprint,
  files: state.files.length,
  verifiedAt: new Date().toISOString(),
  node: process.version,
  checks: ['docs', 'licenses', 'astro', 'build', 'tests', 'production-audit'],
};
writeFileSync(path.join(rootDir, VERIFICATION_RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
console.log(`Verification receipt: ${VERIFICATION_RECEIPT}`);
console.log(`Verification fingerprint: ${receipt.fingerprint}`);
