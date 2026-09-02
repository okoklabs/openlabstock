import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pnpmScript = process.env.npm_execpath ?? '';
const pnpmCommand = pnpmScript ? process.execPath : (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
const pnpmArgs = (args) => pnpmScript ? [pnpmScript, ...args] : args;
const rawArgs = process.argv.slice(2).filter((argument) => argument !== '--');
const nextVersion = rawArgs.includes('--next');
const releaseArgs = rawArgs.filter((argument) => argument !== '--next');

function run(label, args) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(pnpmCommand, pnpmArgs(args), {
    cwd: rootDir,
    stdio: 'inherit',
    ...(process.platform === 'win32' && !pnpmScript ? { shell: true } : {}),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (nextVersion) {
  const result = spawnSync(process.execPath, ['scripts/next-version.mjs'], { cwd: rootDir, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run('verify:auto', ['run', 'verify:auto', '--', '--full']);
run('release', ['run', 'release', '--', ...releaseArgs]);
