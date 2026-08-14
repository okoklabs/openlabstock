import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ignoredDirectories = new Set(['.git', '.astro', 'node_modules', 'dist', 'data', 'backups']);

function collectMarkdownFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectMarkdownFiles(absolutePath));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(absolutePath);
  }
  return files;
}

function localTarget(rawTarget) {
  let target = rawTarget.trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
  if (!target || target.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) return '';
  target = target.split('#', 1)[0].split('?', 1)[0];
  try { return decodeURIComponent(target); } catch { return target; }
}

const failures = [];
const markdownFiles = collectMarkdownFiles(rootDir).sort();
for (const filePath of markdownFiles) {
  const content = readFileSync(filePath, 'utf8');
  const relativeSource = path.relative(rootDir, filePath).replaceAll('\\', '/');
  for (const match of content.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+["'][^)]*["'])?\)/g)) {
    const target = localTarget(match[1]);
    if (!target) continue;
    const resolved = path.resolve(path.dirname(filePath), target);
    if (!existsSync(resolved)) {
      const line = content.slice(0, match.index).split('\n').length;
      failures.push(`${relativeSource}:${line} -> ${match[1]}`);
    }
  }
}

if (failures.length) {
  console.error('Markdown local link check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Markdown local links: ${markdownFiles.length} files checked`);
