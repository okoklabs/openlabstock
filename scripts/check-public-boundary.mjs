import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_BOUNDARY_RECEIPT, repositoryState } from './verification-state.mjs';

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const requiredFiles = [
  'AGENTS.md', 'README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md',
  'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'GOVERNANCE.md',
  'TRADEMARKS.md', 'DEPLOYMENT.md', 'CLA.md', 'package.json',
];
const forbiddenPathPatterns = [
  /(^|\/)docs\/private(?:\/|$)/i,
  /(^|\/)docs\/DEPLOYMENT_OPERATIONS\.md$/i,
  /(^|\/)(?:\.sysulab-(?:docs-)?verification|\.openlabstock-(?:auto-|docs-|public-)?verification)\.json$/i,
  /(?:\.sqlite(?:-(?:shm|wal))?|\.tar\.gz|\.manifest\.txt|\.log)$/i,
];
const forbiddenContent = [
  /ImprovMX/i,
  /okoklabs@outlook\.com/i,
  /(?:^|[^\d])8\.218\.237\.160(?:[^\d]|$)/,
  /(?:^|[^\d])172\.19\.\d{1,3}\.\d{1,3}(?:[^\d]|$)/,
  /\/opt\/sysulab(?:[\s/]|$)/i,
  /\/var\/lib\/sysulab(?:[\s/]|$)/i,
  /\bsysulab\.service\b/i,
  /\bsysulab\.com\b/i,
];

function relative(file) {
  return path.relative(rootDir, file).replaceAll('\\', '/');
}

function collect(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist', '.astro', 'data', 'test-results'].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...collect(absolute));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}

const failures = [];
let trackedFiles = null;
try {
  trackedFiles = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: rootDir }).toString().split('\0').filter(Boolean));
} catch {
  // A source archive has no Git index; CI and normal checkouts do.
}
for (const required of requiredFiles) {
  if (!existsSync(path.join(rootDir, required))) failures.push(`缺少公共治理文件：${required}`);
}

for (const file of collect(rootDir)) {
  const name = relative(file);
  // verify.mjs writes this ignored receipt locally; it is excluded from source
  // control and production archives, so do not treat a local run as a leak.
  if (/^\.(?:sysulab-(?:docs-)?verification|openlabstock-(?:auto-|docs-|public-)?verification)\.json$/i.test(name)) {
    if (trackedFiles?.has(name)) failures.push(`验证回执不能被提交：${name}`);
    continue;
  }
  if (forbiddenPathPatterns.some((pattern) => pattern.test(name))) failures.push(`公共仓库禁止路径：${name}`);
  if (name === 'scripts/check-public-boundary.mjs') continue;
  const stat = lstatSync(file);
  if (stat.size > 2_000_000) continue;
  const content = readFileSync(file);
  if (content.includes(0)) continue;
  const text = content.toString('utf8');
  for (const pattern of forbiddenContent) {
    if (pattern.test(text)) failures.push(`公共文件包含私有标记 ${pattern}：${name}`);
  }
}

const packageJson = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
if (packageJson.license !== 'AGPL-3.0-only') failures.push(`package.json license 必须为 AGPL-3.0-only：${packageJson.license ?? '(empty)'}`);
const cla = readFileSync(path.join(rootDir, 'CLA.md'), 'utf8');
if (!/NOT ACTIVE/i.test(cla)) failures.push('CLA.md 必须在门禁完成前保持 NOT ACTIVE');
if (/\bACTIVE\b/i.test(cla.replace(/NOT ACTIVE/gi, ''))) failures.push('CLA.md 不应在候选阶段出现独立 ACTIVE 状态');

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}
console.log(`Public boundary check passed: ${requiredFiles.length} governance files and ${collect(rootDir).length} files checked`);
const state = repositoryState(rootDir);
writeFileSync(path.join(rootDir, PUBLIC_BOUNDARY_RECEIPT), `${JSON.stringify({
  format: 1,
  fingerprint: state.fingerprint,
  files: state.files.length,
  verifiedAt: new Date().toISOString(),
}, null, 2)}\n`, 'utf8');
console.log(`Public-boundary receipt: ${PUBLIC_BOUNDARY_RECEIPT}`);
