import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const VERIFICATION_RECEIPT = '.openlabstock-verification.json';
export const DOCUMENTATION_RECEIPT = '.openlabstock-docs-verification.json';
export const AUTO_VERIFICATION_RECEIPT = '.openlabstock-auto-verification.json';
export const PUBLIC_BOUNDARY_RECEIPT = '.openlabstock-public-verification.json';
export const AUDIT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const verificationRoots = [
  '.dockerignore', '.env.docker.example', 'astro.config.mjs', 'compose.yaml',
  'Dockerfile', 'package.json', 'password.mjs', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'server.mjs', 'storage.mjs', 'deploy', 'dist', 'public', 'scripts', 'src', 'tests',
];

const dependencyRoots = ['pnpm-lock.yaml', 'pnpm-workspace.yaml'];
const licenseRoots = ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md'];

function collect(relativePath, rootDir) {
  const absolutePath = path.join(rootDir, relativePath);
  if (!existsSync(absolutePath)) throw new Error(`Verification input is missing: ${relativePath}`);
  const stat = lstatSync(absolutePath);
  if (stat.isFile()) return [relativePath.replaceAll('\\', '/')];
  if (!stat.isDirectory()) throw new Error(`Unsupported verification input: ${relativePath}`);
  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
    const child = `${relativePath}/${entry.name}`;
    if (entry.isDirectory()) return collect(child, rootDir);
    if (entry.isFile()) return [child.replaceAll('\\', '/')];
    throw new Error(`Unsupported verification input: ${child}`);
  });
}

function hashFiles(files, rootDir) {
  const hash = createHash('sha256');
  const entries = {};
  for (const relativePath of files) {
    const content = readFileSync(path.join(rootDir, relativePath));
    hash.update(relativePath);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
    entries[relativePath] = createHash('sha256').update(content).digest('hex').toUpperCase();
  }
  return { fingerprint: hash.digest('hex').toUpperCase(), files, entries };
}

export function verificationState(rootDir) {
  const files = [...new Set(verificationRoots.flatMap((entry) => collect(entry, rootDir)))].sort();
  return hashFiles(files, rootDir);
}

export function dependencyState(rootDir) {
  const files = dependencyRoots.flatMap((entry) => collect(entry, rootDir)).sort();
  const metadata = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const hash = createHash('sha256');
  hash.update(JSON.stringify({
    packageManager: metadata.packageManager,
    engines: metadata.engines,
    dependencies: metadata.dependencies,
    optionalDependencies: metadata.optionalDependencies,
    peerDependencies: metadata.peerDependencies,
    pnpm: metadata.pnpm,
  }));
  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(readFileSync(path.join(rootDir, relativePath)));
    hash.update('\0');
  }
  return { fingerprint: hash.digest('hex').toUpperCase(), files: ['package.json#dependencies', ...files] };
}

export function licenseState(rootDir) {
  const dependencies = dependencyState(rootDir);
  const files = licenseRoots.flatMap((entry) => collect(entry, rootDir)).sort();
  const hash = createHash('sha256');
  hash.update(dependencies.fingerprint);
  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(readFileSync(path.join(rootDir, relativePath)));
    hash.update('\0');
  }
  return { fingerprint: hash.digest('hex').toUpperCase(), files: [...dependencies.files, ...files] };
}

export function documentationState(rootDir, files) {
  const markdownFiles = files ?? collectMarkdownFiles(rootDir);
  const normalized = markdownFiles.map((filePath) => path.relative(rootDir, filePath).replaceAll('\\', '/')).sort();
  return hashFiles(normalized, rootDir);
}

function collectMarkdownFiles(directory) {
  const ignoredDirectories = new Set(['.git', '.astro', 'node_modules', 'dist', 'data', 'backups']);
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectMarkdownFiles(absolutePath));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(absolutePath);
  }
  return files.sort();
}

function readReceipt(rootDir, ...names) {
  for (const name of names) {
    const receiptPath = path.join(rootDir, name);
    if (!existsSync(receiptPath)) continue;
    try { return JSON.parse(readFileSync(receiptPath, 'utf8')); } catch { return null; }
  }
  return null;
}

export function readVerificationReceipt(rootDir) {
  return readReceipt(rootDir, VERIFICATION_RECEIPT, '.sysulab-verification.json');
}

export function readDocumentationReceipt(rootDir) {
  return readReceipt(rootDir, DOCUMENTATION_RECEIPT, '.sysulab-docs-verification.json');
}

export function readAutoVerificationReceipt(rootDir) {
  return readReceipt(rootDir, AUTO_VERIFICATION_RECEIPT);
}

export function readPublicBoundaryReceipt(rootDir) {
  return readReceipt(rootDir, PUBLIC_BOUNDARY_RECEIPT);
}

function gitFiles(rootDir) {
  try {
    const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: rootDir,
      encoding: 'utf8',
    });
    return output.split('\0').filter((entry) => entry && existsSync(path.join(rootDir, entry))).sort();
  } catch {
    return null;
  }
}

export function repositoryState(rootDir) {
  const files = gitFiles(rootDir);
  if (files) return hashFiles(files, rootDir);
  const fallback = [...new Set([
    ...verificationState(rootDir).files,
    ...documentationState(rootDir).files,
  ])].sort();
  return hashFiles(fallback, rootDir);
}

export function gitHead(rootDir) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

export function evidenceIsFresh(evidence, state, { maxAgeMs = null, node = null } = {}) {
  if (!evidence || evidence.fingerprint !== state.fingerprint) return false;
  if (node && evidence.node !== node) return false;
  if (maxAgeMs !== null) {
    const verifiedAt = Date.parse(evidence.verifiedAt ?? '');
    if (!Number.isFinite(verifiedAt) || Date.now() - verifiedAt > maxAgeMs) return false;
  }
  return true;
}
