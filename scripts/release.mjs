import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readVerificationReceipt, verificationState } from './verification-state.mjs';

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJsonPath = join(rootDir, 'package.json');
const metadata = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const version = String(metadata.version ?? '');
const versionMatch = /^(\d{4})\.(\d{1,2})\.(\d{1,2})-r(\d+)$/.exec(version);

if (!versionMatch) {
  throw new Error(`package.json version must match YYYY.M.D-rN, got ${version || '(empty)'}`);
}

const [, year, month, day, revision] = versionMatch;
const releaseTag = `${year}${month.padStart(2, '0')}${day.padStart(2, '0')}-r${revision}`;
const args = process.argv.slice(2).filter((argument) => argument !== '--');
const outputArgIndex = args.indexOf('--output');
const manifestArgIndex = args.indexOf('--manifest');
const outputValue = outputArgIndex >= 0 ? args[outputArgIndex + 1] : `OpenLabStock-production-${releaseTag}.tar.gz`;
const manifestValue = manifestArgIndex >= 0 ? args[manifestArgIndex + 1] : '';
if (!outputValue || outputValue.startsWith('--')) throw new Error('--output requires a file path');
if (manifestArgIndex >= 0 && (!manifestValue || manifestValue.startsWith('--'))) throw new Error('--manifest requires a file path');
const outputPath = resolve(rootDir, outputValue);
const manifestPath = manifestValue ? resolve(rootDir, manifestValue) : '';

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: pnpm run release [--output path.tar.gz] [--manifest path.txt]');
  console.log(`Current package version: ${version}`);
  process.exit(0);
}

if (existsSync(outputPath)) {
  throw new Error(`Release archive already exists: ${relative(rootDir, outputPath)}. Increment package.json version or choose a new --output path.`);
}
if (manifestPath && existsSync(manifestPath)) {
  throw new Error(`Release manifest already exists: ${relative(rootDir, manifestPath)}. Increment package.json version or choose a new --manifest path.`);
}

const docsCheck = spawnSync(process.execPath, ['scripts/check-docs.mjs'], { cwd: rootDir, encoding: 'utf8', stdio: 'inherit' });
if (docsCheck.error) throw docsCheck.error;
if (docsCheck.status !== 0) process.exit(docsCheck.status ?? 1);

const receipt = readVerificationReceipt(rootDir);
if (!receipt) throw new Error('No verification receipt found. Run pnpm run verify before creating a release.');
const currentVerification = verificationState(rootDir);
if (receipt.version !== version) throw new Error(`Verified version ${receipt.version ?? '(unknown)'} does not match package version ${version}. Run pnpm run verify again.`);
if (receipt.fingerprint !== currentVerification.fingerprint) {
  throw new Error('Runtime, tests, dependencies, build output, or deployment files changed after verification. Run pnpm run verify again.');
}

const allowedRoots = [
  '.dockerignore', '.env.docker.example', 'AGENTS.md', 'astro.config.mjs', 'compose.yaml',
  'CHANGELOG.md', 'CLA.md', 'CODE_OF_CONDUCT.md', 'COMMERCIAL.md', 'CONTRIBUTING.md', 'DEPLOYMENT.md',
  'Dockerfile', 'GOVERNANCE.md', 'LICENSE', 'NOTICE', 'PRODUCT_REVIEW.md', 'README.md', 'ROADMAP.md',
  'SECURITY.md', 'SUPPORT.md', 'THIRD_PARTY_NOTICES.md', 'TODO.md', 'TRADEMARKS.md',
  'package.json', 'password.mjs', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'server.mjs', 'storage.mjs',
  '.github', 'deploy', 'dist', 'docs', 'public', 'scripts', 'src', 'tests',
];
function isForbidden(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (segments.some((segment) => ['.git', 'node_modules', 'data', 'backups'].includes(segment))) return true;
  const basename = segments.at(-1) ?? '';
  if ((basename === '.env' || basename.startsWith('.env.')) && !basename.endsWith('.example')) return true;
  return /(?:\.sqlite(?:-(?:shm|wal))?|\.log|\.tar\.gz)$/i.test(basename);
}

function collectFiles(relativePath) {
  const absolutePath = join(rootDir, relativePath);
  if (!existsSync(absolutePath)) throw new Error(`Required release path is missing: ${relativePath}`);
  const stat = lstatSync(absolutePath);
  if (stat.isFile()) return [relativePath.replaceAll('\\', '/')];
  if (!stat.isDirectory()) throw new Error(`Release path is not a regular file or directory: ${relativePath}`);
  const result = [];
  for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
    const child = `${relativePath}/${entry.name}`;
    if (isForbidden(child)) throw new Error(`Forbidden path found under release roots: ${child}`);
    if (entry.isDirectory()) result.push(...collectFiles(child));
    else if (entry.isFile()) result.push(child.replaceAll('\\', '/'));
    else throw new Error(`Unsupported filesystem entry in release roots: ${child}`);
  }
  return result;
}

const files = [...new Set(allowedRoots.flatMap(collectFiles))].sort();
const required = [
  'dist/index.html', 'server.mjs', 'storage.mjs', 'password.mjs', 'scripts/backup.mjs',
  'scripts/reset-owner-password.mjs', 'package.json', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md',
];
for (const entry of required) {
  if (!files.includes(entry)) throw new Error(`Release file list is missing required entry: ${entry}`);
}

const tar = spawnSync('tar', ['-czf', outputPath, '-C', rootDir, '--files-from=-'], {
  input: `${files.join('\n')}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
});
if (tar.error) throw tar.error;
if (tar.status !== 0) throw new Error(`tar failed (${tar.status}): ${String(tar.stderr).trim()}`);

const listing = spawnSync('tar', ['-tzf', outputPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
if (listing.error) throw listing.error;
if (listing.status !== 0) throw new Error(`tar listing failed (${listing.status}): ${String(listing.stderr).trim()}`);
const archivedFiles = String(listing.stdout).split(/\r?\n/).filter(Boolean).sort();
for (const entry of required) {
  if (!archivedFiles.includes(entry)) throw new Error(`Archive is missing required entry: ${entry}`);
}
for (const entry of archivedFiles) {
  if (isForbidden(entry)) throw new Error(`Archive contains a forbidden entry: ${entry}`);
}

const smoke = spawnSync(process.execPath, ['scripts/release-smoke.mjs', outputPath], {
  cwd: rootDir,
  encoding: 'utf8',
  stdio: 'inherit',
});
if (smoke.error || smoke.status !== 0) {
  if (existsSync(outputPath)) unlinkSync(outputPath);
  if (smoke.error) throw smoke.error;
  throw new Error(`Release smoke test failed (${smoke.status})`);
}

const hash = createHash('sha256').update(readFileSync(outputPath)).digest('hex').toUpperCase();
const manifest = [
  `package: ${metadata.name}`,
  `version: ${version}`,
  `release: ${releaseTag}`,
  `archive: ${relative(rootDir, outputPath).replaceAll('\\', '/')}`,
  `sha256: ${hash}`,
  `entries: ${archivedFiles.length}`,
  '',
  ...archivedFiles,
  '',
].join('\n');
if (manifestPath) writeFileSync(manifestPath, manifest, 'utf8');
console.log(manifest);
