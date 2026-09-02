import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AUDIT_MAX_AGE_MS,
  DOCUMENTATION_RECEIPT,
  PUBLIC_BOUNDARY_RECEIPT,
  VERIFICATION_RECEIPT,
  dependencyState,
  documentationState,
  evidenceIsFresh,
  gitHead,
  licenseState,
  readDocumentationReceipt,
  readPublicBoundaryReceipt,
  readVerificationReceipt,
  repositoryState,
  verificationState,
} from './verification-state.mjs';

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pnpmScript = process.env.npm_execpath ?? '';
const pnpmCommand = pnpmScript ? process.execPath : (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
const pnpmArgs = (args) => pnpmScript ? [pnpmScript, ...args] : args;
const force = process.argv.slice(2).some((argument) => argument === '--force');
const metadata = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

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

function documentationIsFresh() {
  const receipt = readDocumentationReceipt(rootDir);
  return receipt?.format === 1 && receipt.fingerprint === documentationState(rootDir).fingerprint;
}

function publicBoundaryIsFresh() {
  const receipt = readPublicBoundaryReceipt(rootDir);
  return receipt?.format === 1 && receipt.fingerprint === repositoryState(rootDir).fingerprint;
}

if (!force && publicBoundaryIsFresh()) {
  const receipt = readPublicBoundaryReceipt(rootDir);
  console.log(`Public-boundary check reused: ${receipt.fingerprint} (${receipt.verifiedAt})`);
} else run('check:public', ['run', 'check:public']);

if (!force && documentationIsFresh()) {
  const receipt = readDocumentationReceipt(rootDir);
  console.log(`Documentation checks reused: ${receipt.fingerprint} (${receipt.verifiedAt})`);
} else run('check:docs', ['run', 'check:docs']);

const state = verificationState(rootDir);
const dependencies = dependencyState(rootDir);
const licenses = licenseState(rootDir);
const existing = readVerificationReceipt(rootDir);
const runtimeIsFresh = !force && existing
  && [1, 2].includes(existing.format)
  && existing.version === metadata.version
  && existing.fingerprint === state.fingerprint
  && existing.node === process.version;
const licensesAreFresh = !force && evidenceIsFresh(existing?.licenses, licenses);
const auditIsFresh = !force && evidenceIsFresh(existing?.audit, dependencies, {
  maxAgeMs: AUDIT_MAX_AGE_MS,
  node: process.version,
});

if (runtimeIsFresh && licensesAreFresh && auditIsFresh) {
  console.log(`Runtime verification reused: ${existing.fingerprint} (${existing.verifiedAt})`);
  console.log(`License verification reused: ${existing.licenses.verifiedAt}`);
  console.log(`Production audit reused: ${existing.audit.verifiedAt}`);
  console.log(`Receipts: ${VERIFICATION_RECEIPT}, ${DOCUMENTATION_RECEIPT}, ${PUBLIC_BOUNDARY_RECEIPT}`);
  process.exit(0);
}

if (licensesAreFresh) console.log(`License verification reused: ${existing.licenses.verifiedAt}`);
else run('check:licenses', ['run', 'check:licenses']);

if (runtimeIsFresh) console.log(`Runtime verification reused: ${existing.fingerprint} (${existing.verifiedAt})`);
else {
  for (const [label, args] of [
    ['astro', ['run', 'check']],
    ['build', ['run', 'build']],
    ['tests', ['test']],
  ]) run(label, args);
}

if (auditIsFresh) console.log(`Production audit reused: ${existing.audit.verifiedAt}`);
else run('production-audit', ['audit', '--prod']);

const verifiedState = verificationState(rootDir);
const verifiedAt = new Date().toISOString();
const receipt = {
  format: 2,
  version: metadata.version,
  fingerprint: verifiedState.fingerprint,
  files: verifiedState.files.length,
  verifiedAt: runtimeIsFresh ? existing.verifiedAt : verifiedAt,
  node: process.version,
  checks: ['public-boundary', 'docs', 'licenses', 'astro', 'build', 'tests', 'production-audit'],
  licenses: licensesAreFresh ? existing.licenses : {
    fingerprint: licenses.fingerprint,
    verifiedAt,
  },
  audit: auditIsFresh ? existing.audit : {
    fingerprint: dependencies.fingerprint,
    verifiedAt,
    node: process.version,
  },
  gitHead: gitHead(rootDir),
};
writeFileSync(path.join(rootDir, VERIFICATION_RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
console.log(`Verification receipt: ${VERIFICATION_RECEIPT}`);
console.log(`Verification fingerprint: ${receipt.fingerprint}`);
