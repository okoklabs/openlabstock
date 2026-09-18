import { spawnSync } from 'node:child_process';

export function releaseTuple(value) {
  const match = /^(\d{4})[.-]?(\d{1,2})[.-]?(\d{1,2})-r(\d+)$/.exec(String(value ?? ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])] : null;
}

export function compareReleaseVersions(left, right) {
  const a = releaseTuple(left);
  const b = releaseTuple(right);
  if (!a || !b) return null;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function gitText(rootDir, args) {
  const result = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout).trim() : '';
}

export function packageVersionAt(rootDir, ref) {
  const raw = gitText(rootDir, ['show', `${ref}:package.json`]);
  if (!raw) return '';
  try { return String(JSON.parse(raw).version ?? ''); } catch { return ''; }
}

function compactTag(tuple) {
  return tuple ? `${tuple[0]}.${tuple[1]}.${tuple[2]}-r${tuple[3]}` : '';
}

export function releaseBaseState(rootDir, version) {
  const issues = [];
  const upstreamRef = gitText(rootDir, ['rev-parse', '--verify', 'refs/remotes/upstream/main']);
  const upstreamVersion = upstreamRef ? packageVersionAt(rootDir, 'upstream/main') : '';
  if (upstreamVersion && compareReleaseVersions(version, upstreamVersion) === -1) {
    issues.push(`当前 package.json 版本 ${version} 早于 upstream/main 的 ${upstreamVersion}。请先安全同步公开主线并重新验证，禁止发布旧版本。`);
  }
  const tags = gitText(rootDir, ['tag', '--list']).split(/\r?\n/).map((tag) => tag.trim()).filter(Boolean);
  const newestTagTuple = tags.map(releaseTuple).filter(Boolean).sort((left, right) => {
    for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return right[index] - left[index];
    return 0;
  })[0] ?? null;
  const newestTagVersion = compactTag(newestTagTuple);
  if (newestTagVersion && compareReleaseVersions(version, newestTagVersion) === -1) {
    issues.push(`当前 package.json 版本 ${version} 早于本地已有发布标签 ${newestTagVersion}。请先升版，禁止覆盖旧发布线。`);
  }
  return { issues, upstreamVersion, newestTagVersion };
}
