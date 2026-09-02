import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTO_VERIFICATION_RECEIPT,
  gitHead,
  readAutoVerificationReceipt,
  repositoryState,
} from './verification-state.mjs';

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const metadata = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const pnpmScript = process.env.npm_execpath ?? '';
const pnpmCommand = pnpmScript ? process.execPath : (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
const pnpmArgs = (args) => pnpmScript ? [pnpmScript, ...args] : args;
const force = process.argv.slice(2).includes('--force');
const requireFull = process.argv.slice(2).includes('--full');

function gitList(args) {
  try {
    return execFileSync('git', [...args, '-z'], { cwd: rootDir, encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

function changedPaths(receipt, currentState) {
  if (receipt?.entries) {
    const paths = new Set([...Object.keys(receipt.entries), ...Object.keys(currentState.entries)]);
    return [...paths].filter((entry) => receipt.entries[entry] !== currentState.entries[entry]).sort();
  }
  const paths = new Set([
    ...gitList(['diff', '--name-only']),
    ...gitList(['diff', '--cached', '--name-only']),
    ...gitList(['ls-files', '--others', '--exclude-standard']),
  ]);
  if (receipt?.gitHead) {
    for (const entry of gitList(['diff', '--name-only', `${receipt.gitHead}..HEAD`])) paths.add(entry);
  }
  return [...paths].map((entry) => entry.replaceAll('\\', '/')).sort();
}

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

const before = repositoryState(rootDir);
const existing = readAutoVerificationReceipt(rootDir);
if (!force && !requireFull && existing?.format === 1 && existing.fingerprint === before.fingerprint && existing.node === process.version) {
  console.log(`Automatic verification reused: ${existing.gate} (${existing.verifiedAt})`);
  console.log('No repository inputs changed, so no checks were repeated.');
  process.exit(0);
}

const paths = changedPaths(existing, before);
const docsChanged = paths.some((entry) => entry.endsWith('.md'));
const docsOnly = paths.length > 0 && paths.every((entry) => entry.endsWith('.md'));
const uiOnly = paths.length > 0 && paths.every((entry) => (
  entry.endsWith('.md')
  || entry.startsWith('openlabstock-landing/')
  || /^(?:src|public)\/.+\.(?:astro|css|scss|png|jpe?g|gif|webp|ico|svg)$/i.test(entry)
));
const fullRisk = paths.some((entry) => (
  /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|Dockerfile|compose\.yaml|astro\.config\.mjs|server\.mjs|storage\.mjs|password\.mjs)$/i.test(entry)
  || entry.startsWith('deploy/')
  || entry.startsWith('.github/workflows/')
  || entry === 'public/sw.js'
  || /^scripts\/(?:release|prepare-release|next-version|release-smoke|verify|verification-state|verify-auto)\.mjs$/i.test(entry)
));

let gate = 'verify';
if (!force && !requireFull && existing?.gitHead && paths.length > 0) {
  if (docsOnly) gate = 'check:docs';
  else if (uiOnly) gate = 'verify:ui';
  else if (!fullRisk) gate = 'verify:quick';
}

console.log(`Changed paths: ${paths.length || 'unknown'}`);
console.log(`Selected gate: ${gate}`);
if (requireFull) console.log('Full gate requested; reusable verification evidence will still be honored.');
if (gate === 'check:docs' && metadata.scripts?.['check:public']) run('check:public', ['run', 'check:public']);
run(gate, ['run', gate, ...(force && gate === 'verify' ? ['--', '--force'] : [])]);
if (docsChanged && !['check:docs', 'verify'].includes(gate)) run('check:docs', ['run', 'check:docs']);

const after = repositoryState(rootDir);
const receipt = {
  format: 1,
  version: metadata.version,
  fingerprint: after.fingerprint,
  files: after.files.length,
  entries: after.entries,
  verifiedAt: new Date().toISOString(),
  node: process.version,
  gate,
  gitHead: gitHead(rootDir),
};
writeFileSync(path.join(rootDir, AUTO_VERIFICATION_RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
console.log(`Automatic verification receipt: ${AUTO_VERIFICATION_RECEIPT}`);
