import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const VERIFICATION_RECEIPT = '.openlabstock-verification.json';

const verificationRoots = [
  '.dockerignore', '.env.docker.example', '.github', 'astro.config.mjs', 'compose.yaml',
  'Dockerfile', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'package.json', 'password.mjs', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'server.mjs', 'storage.mjs', 'deploy', 'dist', 'public', 'scripts', 'src', 'tests',
];

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

export function verificationState(rootDir) {
  const files = [...new Set(verificationRoots.flatMap((entry) => collect(entry, rootDir)))].sort();
  const hash = createHash('sha256');
  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(readFileSync(path.join(rootDir, relativePath)));
    hash.update('\0');
  }
  return { fingerprint: hash.digest('hex').toUpperCase(), files };
}

export function readVerificationReceipt(rootDir) {
  const receiptPath = path.join(rootDir, VERIFICATION_RECEIPT);
  if (!existsSync(receiptPath)) return null;
  try { return JSON.parse(readFileSync(receiptPath, 'utf8')); } catch { return null; }
}
