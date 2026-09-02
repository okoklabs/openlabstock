import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pnpmScript = process.env.npm_execpath ?? '';
const pnpmCommand = pnpmScript ? process.execPath : (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
const pnpmArgs = (args) => pnpmScript ? [pnpmScript, ...args] : args;

for (const [label, args] of [
  ['check:public', ['run', 'check:public']],
  ['astro', ['run', 'check']],
  ['build', ['run', 'build']],
]) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(pnpmCommand, pnpmArgs(args), {
    cwd: rootDir,
    stdio: 'inherit',
    ...(process.platform === 'win32' && !pnpmScript ? { shell: true } : {}),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log('\nUI verification passed. Use verify:quick for behavior changes and verify for high-risk or release changes.');
