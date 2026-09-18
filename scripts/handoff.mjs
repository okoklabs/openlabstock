import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HANDOFF_FORMAT = 1;
const DEFAULT_OUTPUT_DIR = 'openlabstock-backups';
const CHILD_PROCESS_MAX_BUFFER = 64 * 1024 * 1024;
const RECEIPT_NAMES = [
  '.openlabstock-verification.json',
  '.openlabstock-auto-verification.json',
  '.openlabstock-docs-verification.json',
  '.openlabstock-public-verification.json',
  '.sysulab-verification.json',
  '.sysulab-docs-verification.json',
];

function fail(message) {
  throw new Error(message);
}

function run(command, args, { cwd = rootDir, input = undefined, encoding = 'utf8' } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding,
    maxBuffer: CHILD_PROCESS_MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : String(result.stderr ?? '');
    fail(`${command} ${args.join(' ')} failed (${result.status}): ${stderr.trim() || 'no error output'}`);
  }
  return result.stdout;
}

function tryRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    input: options.input,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: CHILD_PROCESS_MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}

function parseNulList(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
  return text.split('\0').filter(Boolean);
}

function validateRelativePath(relativePath) {
  const normalized = String(relativePath).replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    fail(`Unsafe relative path: ${relativePath}`);
  }
  const segments = normalized.split('/');
  if (segments.includes('..')) fail(`Unsafe relative path: ${relativePath}`);
  return normalized;
}

function formatTimestamp(date = new Date()) {
  return date.toISOString().replaceAll('-', '').replaceAll(':', '').replace(/\.\d{3}Z$/, 'Z');
}

function safeArchiveName(value) {
  const name = path.basename(value);
  if (!/^openlabstock-handoff-\d{8}T\d{6}Z\.tar\.gz$/.test(name)) {
    fail(`Handoff archive name must use openlabstock-handoff-YYYYMMDDTHHMMSSZ.tar.gz: ${name}`);
  }
  return name;
}

function isInside(parent, candidate) {
  const relativePath = path.relative(parent, candidate);
  return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

async function walkFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(absolutePath, relativePath));
    else if (entry.isFile()) files.push(relativePath.replaceAll('\\', '/'));
    else fail(`Handoff staging contains unsupported filesystem entry: ${relativePath}`);
  }
  return files.sort();
}

async function assertNoSymlinks(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, entry.name);
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) fail(`Handoff archive contains a symbolic link: ${relativePath}`);
    if (entry.isDirectory()) await assertNoSymlinks(absolutePath, relativePath);
  }
}

async function hashFile(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex').toUpperCase();
}

async function verifyOuterChecksum(archivePath) {
  const checksumPath = `${archivePath}.sha256`;
  if (!existsSync(checksumPath)) return { checksumPath: null, verified: false };
  const line = String(await readFile(checksumPath, 'utf8')).trim();
  const match = /^([A-Fa-f0-9]{64})  ([^/\\]+)$/.exec(line);
  if (!match || match[2] !== path.basename(archivePath)) fail(`Invalid handoff checksum file: ${checksumPath}`);
  const actual = await hashFile(archivePath);
  if (actual !== match[1].toUpperCase()) fail(`Handoff archive SHA-256 mismatch: ${archivePath}`);
  return { checksumPath, verified: true };
}

async function writeChecksums(stagingDir, files) {
  const lines = [];
  for (const relativePath of files.filter((entry) => entry !== 'checksums.sha256')) {
    lines.push(`${await hashFile(path.join(stagingDir, relativePath))}  ${relativePath}`);
  }
  await writeFile(path.join(stagingDir, 'checksums.sha256'), `${lines.join('\n')}\n`, 'utf8');
}

function parseStatusEntries(raw) {
  const entries = parseNulList(raw);
  const result = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const code = entry.slice(0, 2);
    const item = { code, path: entry.slice(3) };
    if (code.includes('R') || code.includes('C')) item.originalPath = entries[++index];
    result.push(item);
  }
  return result;
}

function sanitizeRemote(raw) {
  const value = String(raw).trim();
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}/<redacted>`;
  } catch {
    const sshMatch = /^(?:[^@/\s]+@)?([^:/\s]+):/.exec(value);
    return sshMatch ? `ssh://${sshMatch[1]}/<redacted>` : '<redacted remote>';
  }
}

function remotes(root) {
  const lines = String(run('git', ['remote', '-v'], { cwd: root })).split(/\r?\n/).filter(Boolean);
  return lines.map((line) => {
    const match = /^(\S+)\s+(.+?)\s+\((fetch|push)\)$/.exec(line);
    if (!match) return { raw: line };
    return { name: match[1], kind: match[3], url: sanitizeRemote(match[2]) };
  });
}

async function ensureGitRoot(root) {
  const resolvedRoot = path.resolve(root);
  const gitRoot = String(run('git', ['rev-parse', '--show-toplevel'], { cwd: resolvedRoot })).trim();
  if (path.resolve(gitRoot) !== resolvedRoot) fail(`Root is not the repository root: ${resolvedRoot}`);
}

async function copyUntracked(root, stagingDir, paths) {
  for (const relativePath of paths) {
    const normalized = validateRelativePath(relativePath);
    const source = path.join(root, normalized);
    const destination = path.join(stagingDir, 'worktree', 'untracked', normalized);
    const entry = await lstat(source);
    if (!entry.isFile()) fail(`Untracked path is not a regular file: ${normalized}`);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { force: false, errorOnExist: true });
  }
}

function versionFromPackage(root) {
  const packagePath = path.join(root, 'package.json');
  if (!existsSync(packagePath)) return null;
  try {
    return JSON.parse(requireFile(packagePath)).version ?? null;
  } catch {
    return null;
  }
}

function runtimeInfo() {
  const pnpm = process.platform === 'win32'
    ? tryRun('cmd.exe', ['/d', '/s', '/c', 'pnpm --version'])
    : tryRun('pnpm', ['--version']);
  const pnpmFromUserAgent = /(?:^|\s)pnpm\/([^\s]+)/.exec(process.env.npm_config_user_agent ?? '')?.[1];
  return {
    node: process.version,
    pnpm: pnpm.status === 0 ? String(pnpm.stdout).trim() : (pnpmFromUserAgent ?? 'unavailable'),
    git: String(run('git', ['--version'])).trim(),
    platform: process.platform,
    arch: process.arch,
  };
}

function requireFile(filePath) {
  // This helper keeps package metadata parsing synchronous and tiny.
  // eslint-disable-next-line no-sync
  return readFileSync(filePath, 'utf8');
}

function branchInfo(root) {
  const branch = tryRun('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root });
  const name = String(branch.stdout ?? '').trim();
  return { name: name || null, detached: !name };
}

function gitPatch(root) {
  return run('git', ['diff', '--binary', 'HEAD'], { cwd: root, encoding: null });
}

function gitIndexPatch(root) {
  return run('git', ['diff', '--binary', '--cached', 'HEAD'], { cwd: root, encoding: null });
}

function gitWorktreePatch(root) {
  return run('git', ['diff', '--binary'], { cwd: root, encoding: null });
}

async function createBundle(root, destination) {
  const bundleRepository = await mkdtemp(path.join(os.tmpdir(), 'openlabstock-bundle-create-'));
  try {
    run('git', ['init', '--bare'], { cwd: bundleRepository });
    run('git', ['fetch', root, '+refs/*:refs/*'], { cwd: bundleRepository });
    run('git', ['fetch', root, 'HEAD:refs/openlabstock-handoff/source-head'], { cwd: bundleRepository });
    run('git', ['bundle', 'create', destination, '--all'], { cwd: bundleRepository });
    run('git', ['bundle', 'verify', destination], { cwd: bundleRepository });
  } finally {
    await rm(bundleRepository, { recursive: true, force: true });
  }
}

async function verifyBundleFile(bundlePath) {
  const verificationDir = await mkdtemp(path.join(os.tmpdir(), 'openlabstock-bundle-verify-'));
  try {
    run('git', ['init', '--bare'], { cwd: verificationDir });
    run('git', ['bundle', 'verify', bundlePath], { cwd: verificationDir });
  } finally {
    await rm(verificationDir, { recursive: true, force: true });
  }
}

function createSourceArchive(root, destination) {
  const result = spawnSync('git', ['archive', '--format=tar.gz', '--prefix=source/', 'HEAD'], {
    cwd: root,
    encoding: null,
    maxBuffer: CHILD_PROCESS_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`git archive failed (${result.status}): ${Buffer.from(result.stderr ?? '').toString('utf8').trim()}`);
  }
  return writeFile(destination, result.stdout);
}

function archiveStaging(stagingDir, outputPath, files) {
  const input = `${files.join('\n')}\n`;
  run('tar', ['-czf', outputPath, '-C', stagingDir, '--files-from=-'], { input });
}

function archiveListing(archivePath) {
  const output = run('tar', ['-tzf', archivePath]);
  return String(output).split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/^\.\//, ''));
}

function assertSafeArchiveListing(entries) {
  for (const entry of entries) validateRelativePath(entry);
}

async function extractAndVerify(archivePath, extractionDir) {
  const entries = archiveListing(archivePath);
  assertSafeArchiveListing(entries);
  run('tar', ['-xzf', archivePath, '-C', extractionDir]);
  await assertNoSymlinks(extractionDir);
  const metadataPath = path.join(extractionDir, 'handoff.json');
  const checksumsPath = path.join(extractionDir, 'checksums.sha256');
  if (!existsSync(metadataPath) || !existsSync(checksumsPath)) fail('Handoff archive is missing handoff.json or checksums.sha256');
  const checksums = String(await readFile(checksumsPath, 'utf8')).split(/\r?\n/).filter(Boolean);
  const checksumPaths = new Set();
  for (const line of checksums) {
    const match = /^([A-Fa-f0-9]{64})  (.+)$/.exec(line);
    if (!match) fail(`Invalid checksum line: ${line}`);
    const relativePath = validateRelativePath(match[2]);
    if (checksumPaths.has(relativePath)) fail(`Duplicate checksum entry: ${relativePath}`);
    checksumPaths.add(relativePath);
    if (!entries.includes(relativePath)) fail(`Checksum references missing archive entry: ${relativePath}`);
    const actual = await hashFile(path.join(extractionDir, relativePath));
    if (actual !== match[1].toUpperCase()) fail(`Checksum mismatch: ${relativePath}`);
  }
  for (const entry of entries.filter((value) => value !== 'checksums.sha256')) {
    if (!checksumPaths.has(entry)) fail(`Archive entry has no checksum: ${entry}`);
  }
  const bundlePath = path.join(extractionDir, 'git', 'openlabstock.bundle');
  if (!existsSync(bundlePath)) fail('Handoff archive is missing git/openlabstock.bundle');
  await verifyBundleFile(bundlePath);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  if (metadata.format !== HANDOFF_FORMAT) fail(`Unsupported handoff format: ${metadata.format}`);
  return { entries, metadata };
}

async function createHandoff({ root = rootDir, output = null, includeUntracked = true } = {}) {
  const repositoryRoot = path.resolve(root);
  await ensureGitRoot(repositoryRoot);
  const sourceHead = String(run('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(sourceHead)) fail(`Invalid Git HEAD: ${sourceHead}`);
  const branch = branchInfo(repositoryRoot);
  const statusRaw = run('git', ['status', '--porcelain=v1', '--untracked-files=all', '-z'], {
    cwd: repositoryRoot,
    encoding: null,
  });
  const statusEntries = parseStatusEntries(statusRaw);
  const untracked = includeUntracked
    ? parseNulList(run('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: repositoryRoot, encoding: null }))
    : [];
  const timestamp = formatTimestamp();
  const defaultOutput = path.join(path.dirname(repositoryRoot), DEFAULT_OUTPUT_DIR, `openlabstock-handoff-${timestamp}.tar.gz`);
  const outputPath = path.resolve(repositoryRoot, output ?? defaultOutput);
  safeArchiveName(outputPath);
  if (outputPath === repositoryRoot || isInside(repositoryRoot, outputPath)) {
    fail('Handoff output must be outside the repository. Use a sibling backup directory or another disk.');
  }
  if (existsSync(outputPath)) fail(`Handoff archive already exists: ${outputPath}`);
  const checksumPath = `${outputPath}.sha256`;
  if (existsSync(checksumPath)) fail(`Handoff checksum already exists: ${checksumPath}`);
  await mkdir(path.dirname(outputPath), { recursive: true });

  const stagingDir = await mkdtemp(path.join(os.tmpdir(), 'openlabstock-handoff-'));
  const temporaryOutput = `${outputPath}.tmp-${process.pid}`;
  const temporaryChecksum = `${checksumPath}.tmp-${process.pid}`;
  try {
    await mkdir(path.join(stagingDir, 'worktree', 'untracked'), { recursive: true });
    await mkdir(path.join(stagingDir, 'context', 'verification'), { recursive: true });
    await mkdir(path.join(stagingDir, 'git'), { recursive: true });
    await mkdir(path.join(stagingDir, 'tools'), { recursive: true });
    await cp(fileURLToPath(import.meta.url), path.join(stagingDir, 'tools', 'handoff.mjs'), { force: false, errorOnExist: true });
    await createSourceArchive(repositoryRoot, path.join(stagingDir, 'git', 'source.tar.gz'));
    await createBundle(repositoryRoot, path.join(stagingDir, 'git', 'openlabstock.bundle'));
    await writeFile(path.join(stagingDir, 'worktree', 'changes.patch'), gitPatch(repositoryRoot));
    await writeFile(path.join(stagingDir, 'worktree', 'index.patch'), gitIndexPatch(repositoryRoot));
    await writeFile(path.join(stagingDir, 'worktree', 'worktree.patch'), gitWorktreePatch(repositoryRoot));
    if (includeUntracked) await copyUntracked(repositoryRoot, stagingDir, untracked);
    await writeFile(
      path.join(stagingDir, 'context', 'status.txt'),
      `${run('git', ['status', '--short', '--branch', '--untracked-files=all'], { cwd: repositoryRoot })}\n\nRecent commits:\n${run('git', ['log', '-12', '--oneline', '--decorate'], { cwd: repositoryRoot })}`,
      'utf8',
    );

    const receipts = [];
    for (const name of RECEIPT_NAMES) {
      const source = path.join(repositoryRoot, name);
      if (!existsSync(source)) continue;
      const target = path.join(stagingDir, 'context', 'verification', name);
      await cp(source, target, { force: false, errorOnExist: true });
      receipts.push(name);
    }

    const metadata = {
      format: HANDOFF_FORMAT,
      generatedAt: new Date().toISOString(),
      repository: path.basename(repositoryRoot),
      sourceHead,
      branch: branch.name,
      detached: branch.detached,
      packageVersion: versionFromPackage(repositoryRoot),
      sourceTree: String(run('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repositoryRoot })).trim(),
      runtime: runtimeInfo(),
      dirty: statusEntries.length > 0,
      statusEntries,
      untrackedIncluded: includeUntracked,
      untrackedFiles: untracked,
      verificationReceipts: receipts,
      remotes: remotes(repositoryRoot),
      included: [
        'git/openlabstock.bundle: complete Git refs and history',
        'git/source.tar.gz: clean git archive snapshot at sourceHead',
        'worktree/changes.patch: combined tracked changes relative to sourceHead for review',
        'worktree/index.patch: staged changes relative to sourceHead',
        'worktree/worktree.patch: unstaged changes relative to the index',
        ...(includeUntracked ? ['worktree/untracked/: non-ignored untracked files'] : []),
        'context/: handoff notes and available verification receipts',
        'tools/handoff.mjs: portable inspect and restore tool using Node.js built-ins',
      ],
      excluded: [
        'data/, backups/, *.sqlite, *.sqlite-wal, *.sqlite-shm',
        '.env files, node_modules/, dist build cache, logs and credentials',
      ],
      database: {
        included: false,
        restoreWith: 'scripts/backup.mjs and the database restore procedure in docs/HANDOFF_BACKUP.md',
      },
      security: {
        warning: 'The Git bundle contains complete repository history. Treat this package as trusted-maintainer material and inspect history before external sharing.',
        noRuntimeDataByDefault: true,
      },
    };
    await writeFile(path.join(stagingDir, 'handoff.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    const handoffNotes = `# OpenLabStock Handoff\n\nGenerated: ${metadata.generatedAt}\nRepository: ${metadata.repository}\nHEAD: ${metadata.sourceHead}\nBranch: ${metadata.branch ?? '(detached HEAD)'}\nPackage version: ${metadata.packageVersion ?? '(unknown)'}\nWorking tree dirty: ${metadata.dirty ? 'yes' : 'no'}\n\n## First steps\n\n1. Read README.md, TODO.md and AGENTS.md in the restored source.\n2. Run pnpm install --frozen-lockfile.\n3. Run pnpm run verify:auto; use pnpm run verify:status before a formal release.\n4. Continue from the recorded TODO and the current branch instead of recreating project context.\n\n## Restore\n\nUse pnpm run handoff:restore -- <handoff.tar.gz> --target <new-directory>. The restore command verifies every checksum, restores Git refs, checks out the recorded HEAD, applies tracked changes, and copies non-ignored untracked files. It never replaces an existing non-empty directory and never restores a database automatically.\n\n## Database\n\nThis handoff intentionally excludes data/, SQLite files, backups, environment files and credentials. Use the existing pnpm run backup / SQLite restore process for business data, and transfer that file separately only to a trusted operator.\n\n## Security\n\nThe included Git bundle preserves complete history. Do not upload it to a public issue, public gist or an untrusted AI. Review history and remove secrets with an appropriate history-rewrite process before public sharing.\n`;
    await writeFile(path.join(stagingDir, 'context', 'HANDOFF.md'), handoffNotes, 'utf8');
    const firstRead = `# Read this first\n\nThis is an OpenLabStock code handoff package. It contains complete Git refs and reachable history, a clean source snapshot, current tracked changes, non-ignored untracked files, verification receipts and checksums. It intentionally excludes business databases, environment files and credentials.\n\nWith an existing OpenLabStock checkout, run:\n\n  pnpm run handoff:inspect -- <archive.tar.gz>\n  pnpm run handoff:restore -- <archive.tar.gz> --target <new-directory>\n\nOffline, extract tools/handoff.mjs from this archive, then run:\n\n  node tools/handoff.mjs inspect <archive.tar.gz>\n  node tools/handoff.mjs restore <archive.tar.gz> --target <new-directory>\n\nAfter restore, read .handoff/HANDOFF.md, README.md, TODO.md and AGENTS.md.\n`;
    await writeFile(path.join(stagingDir, 'README-FIRST.md'), firstRead, 'utf8');

    const stagedFiles = await walkFiles(stagingDir);
    await writeChecksums(stagingDir, stagedFiles);
    const finalFiles = await walkFiles(stagingDir);
    archiveStaging(stagingDir, temporaryOutput, finalFiles);
    const archiveEntries = archiveListing(temporaryOutput);
    assertSafeArchiveListing(archiveEntries);
    const archiveHash = await hashFile(temporaryOutput);
    await writeFile(temporaryChecksum, `${archiveHash}  ${path.basename(outputPath)}\n`, 'utf8');
    await rename(temporaryOutput, outputPath);
    await rename(temporaryChecksum, checksumPath);
    return {
      outputPath,
      checksumPath,
      archiveHash,
      metadata,
      files: finalFiles,
    };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
    await rm(temporaryOutput, { force: true });
    await rm(temporaryChecksum, { force: true });
  }
}

async function inspectHandoff(archivePath) {
  const archive = path.resolve(archivePath);
  if (!existsSync(archive)) fail(`Handoff archive not found: ${archive}`);
  const outerChecksum = await verifyOuterChecksum(archive);
  const extractionDir = await mkdtemp(path.join(os.tmpdir(), 'openlabstock-handoff-inspect-'));
  try {
    const result = await extractAndVerify(archive, extractionDir);
    return {
      archivePath: archive,
      checksumPath: outerChecksum.checksumPath,
      outerChecksumVerified: outerChecksum.verified,
      archiveHash: await hashFile(archive),
      entries: result.entries,
      metadata: result.metadata,
    };
  } finally {
    await rm(extractionDir, { recursive: true, force: true });
  }
}

async function copyDirectoryContents(source, destination) {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = validateRelativePath(entry.name);
    const from = path.join(source, relativePath);
    const to = path.join(destination, relativePath);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copyDirectoryContents(from, to);
    } else if (entry.isFile()) {
      await mkdir(path.dirname(to), { recursive: true });
      await cp(from, to, { force: false, errorOnExist: true });
    } else {
      fail(`Unsupported untracked entry in handoff: ${relativePath}`);
    }
  }
}

async function assertTargetEmpty(targetDir) {
  if (!existsSync(targetDir)) return false;
  const entries = await readdir(targetDir);
  if (entries.length > 0) fail(`Restore target must be new or empty: ${targetDir}`);
  return true;
}

async function restoreHandoff({ archivePath, target } = {}) {
  if (!archivePath || !target) fail('Restore requires an archive path and --target directory.');
  const archive = path.resolve(archivePath);
  const targetDir = path.resolve(target);
  if (!existsSync(archive)) fail(`Handoff archive not found: ${archive}`);
  await verifyOuterChecksum(archive);
  const targetExisted = await assertTargetEmpty(targetDir);
  await mkdir(targetDir, { recursive: true });
  const extractionDir = await mkdtemp(path.join(os.tmpdir(), 'openlabstock-handoff-restore-'));
  try {
    const { metadata } = await extractAndVerify(archive, extractionDir);
    const bundle = path.join(extractionDir, 'git', 'openlabstock.bundle');
    const indexPatch = path.join(extractionDir, 'worktree', 'index.patch');
    const worktreePatch = path.join(extractionDir, 'worktree', 'worktree.patch');
    if (!existsSync(bundle)) fail('Handoff archive is missing git/openlabstock.bundle');
    run('git', ['init'], { cwd: targetDir });
    run('git', ['fetch', bundle, '+refs/*:refs/*'], { cwd: targetDir });
    if (metadata.detached || !metadata.branch) run('git', ['checkout', '--detach', metadata.sourceHead], { cwd: targetDir });
    else run('git', ['checkout', '-B', metadata.branch, metadata.sourceHead], { cwd: targetDir });
    if (existsSync(indexPatch) && (await stat(indexPatch)).size > 0) run('git', ['apply', '--binary', '--index', indexPatch], { cwd: targetDir });
    if (existsSync(worktreePatch) && (await stat(worktreePatch)).size > 0) run('git', ['apply', '--binary', worktreePatch], { cwd: targetDir });
    const untrackedDir = path.join(extractionDir, 'worktree', 'untracked');
    if (existsSync(untrackedDir)) await copyDirectoryContents(untrackedDir, targetDir);
    const temporaryRefs = String(run('git', ['for-each-ref', '--format=%(refname)', 'refs/openlabstock-handoff/'], { cwd: targetDir }))
      .split(/\r?\n/).filter(Boolean);
    for (const ref of temporaryRefs) run('git', ['update-ref', '-d', ref], { cwd: targetDir });
    const contextDir = path.join(targetDir, '.handoff');
    await mkdir(contextDir, { recursive: true });
    await copyDirectoryContents(path.join(extractionDir, 'context'), contextDir);
    await cp(path.join(extractionDir, 'handoff.json'), path.join(contextDir, 'handoff.json'), { force: false, errorOnExist: true });
    await mkdir(path.join(targetDir, '.git', 'info'), { recursive: true });
    const excludePath = path.join(targetDir, '.git', 'info', 'exclude');
    const existingExclude = existsSync(excludePath) ? await readFile(excludePath, 'utf8') : '';
    if (!existingExclude.split(/\r?\n/).includes('.handoff/')) {
      await writeFile(excludePath, `${existingExclude.trimEnd()}\n.handoff/\n`, 'utf8');
    }
    return { targetDir, metadata };
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true });
    if (targetExisted) await mkdir(targetDir, { recursive: true });
    throw error;
  } finally {
    await rm(extractionDir, { recursive: true, force: true });
  }
}

function help() {
  console.log(`OpenLabStock handoff backup\n\nUsage:\n  pnpm run handoff -- create [--output openlabstock-handoff-YYYYMMDDTHHMMSSZ.tar.gz] [--no-untracked]\n  pnpm run handoff:inspect -- handoff.tar.gz\n  pnpm run handoff:restore -- handoff.tar.gz --target new-directory\n\nThe package contains a full Git bundle, a clean git archive snapshot, tracked worktree changes, optional non-ignored untracked files, handoff notes, metadata and SHA-256 checksums. Runtime data and credentials are excluded by design.`);
}

function parseCreateArgs(args) {
  let output = null;
  let includeUntracked = true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--output') {
      output = args[index + 1];
      if (!output) fail('--output requires a path');
      index += 1;
    } else if (argument === '--no-untracked') {
      includeUntracked = false;
    } else if (argument === '--help' || argument === '-h') {
      help();
      process.exit(0);
    } else {
      fail(`Unknown create option: ${argument}`);
    }
  }
  return { output, includeUntracked };
}

async function main(argv = process.argv.slice(2)) {
  const normalizedArgv = argv.filter((argument) => argument !== '--');
  const [first, ...rest] = normalizedArgv;
  const command = !first || first.startsWith('-') ? 'create' : first;
  const args = command === 'create' && first?.startsWith('-') ? normalizedArgv : rest;
  if (command === 'create') {
    const result = await createHandoff(parseCreateArgs(args));
    console.log(`Handoff created: ${result.outputPath}`);
    console.log(`Checksum file: ${result.checksumPath}`);
    console.log(`Archive SHA-256: ${result.archiveHash}`);
    console.log(`Git HEAD: ${result.metadata.sourceHead}`);
    console.log(`Branch: ${result.metadata.branch ?? '(detached HEAD)'}`);
    console.log(`Working tree changes: ${result.metadata.dirty ? 'yes' : 'no'}`);
    console.log(`Untracked files included: ${result.metadata.untrackedFiles.length}`);
  } else if (command === 'inspect') {
    if (!rest[0] || rest.length > 1) fail('Usage: handoff inspect <archive.tar.gz>');
    const result = await inspectHandoff(rest[0]);
    console.log(JSON.stringify({
      archivePath: result.archivePath,
      checksumPath: result.checksumPath,
      archiveHash: result.archiveHash,
      outerChecksumVerified: result.outerChecksumVerified,
      metadata: result.metadata,
      entries: result.entries.length,
    }, null, 2));
  } else if (command === 'restore') {
    const archivePath = rest[0];
    const targetIndex = rest.indexOf('--target');
    const target = targetIndex >= 0 ? rest[targetIndex + 1] : null;
    if (!archivePath || !target || targetIndex !== 1 || rest.length !== 3) fail('Usage: handoff restore <archive.tar.gz> --target <new-directory>');
    const result = await restoreHandoff({ archivePath, target });
    console.log(`Handoff restored: ${result.targetDir}`);
    console.log(`Git HEAD: ${result.metadata.sourceHead}`);
    console.log(`Branch: ${result.metadata.branch ?? '(detached HEAD)'}`);
    console.log('Database was not restored; use the SQLite backup procedure separately.');
  } else if (command === '--help' || command === '-h') {
    help();
  } else {
    fail(`Unknown handoff command: ${command}`);
  }
}

export { createHandoff, inspectHandoff, restoreHandoff };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Handoff failed: ${error.message}`);
    process.exitCode = 1;
  });
}
