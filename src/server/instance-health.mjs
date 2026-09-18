import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const backupManifestPattern = /^labstock-\d{8}T\d{9}Z\.sqlite\.json$/;
const sha256Pattern = /^[A-F0-9]{64}$/;

export function normalizeInstanceId(value) {
  const instanceId = String(value ?? '').trim();
  if (!instanceId) return '';
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(instanceId)) {
    throw new Error('INSTANCE_ID 必须是 1-64 位小写字母、数字或短横线，且不能以短横线开头或结尾');
  }
  return instanceId;
}

function missingBackup() {
  return { status: 'missing', createdAt: null, ageSeconds: null, bytes: null, schemaVersion: null, sha256: null };
}

function invalidBackup(status, createdAt = null) {
  return { status, createdAt, ageSeconds: null, bytes: null, schemaVersion: null, sha256: null };
}

export async function readLatestBackupStatus(backupDir, nowMs = Date.now()) {
  let entries;
  try {
    entries = await readdir(backupDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return missingBackup();
    return invalidBackup('unreadable');
  }
  const latestManifestName = entries
    .filter((entry) => entry.isFile() && backupManifestPattern.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .at(-1);
  if (!latestManifestName) return missingBackup();

  const expectedDatabase = latestManifestName.slice(0, -'.json'.length);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(backupDir, latestManifestName), 'utf8'));
  } catch {
    return invalidBackup('invalid_manifest');
  }
  const createdAt = String(manifest?.createdAt ?? '');
  const createdMs = Date.parse(createdAt);
  const bytes = Number(manifest?.bytes);
  const schemaVersion = Number(manifest?.schemaVersion);
  const sha256 = String(manifest?.sha256 ?? '').toUpperCase();
  const valid = manifest?.format === 1
    && manifest?.database === expectedDatabase
    && Number.isFinite(createdMs)
    && new Date(createdMs).toISOString() === createdAt
    && Number.isInteger(bytes) && bytes >= 0
    && Number.isInteger(schemaVersion) && schemaVersion >= 1
    && sha256Pattern.test(sha256)
    && manifest?.integrity === 'ok'
    && manifest?.foreignKeys === true;
  if (!valid) return invalidBackup('invalid_manifest', Number.isFinite(createdMs) ? createdAt : null);

  let databaseStat;
  try {
    databaseStat = await stat(path.join(backupDir, expectedDatabase));
  } catch (error) {
    if (error?.code === 'ENOENT') return invalidBackup('missing_file', createdAt);
    return invalidBackup('unreadable', createdAt);
  }
  const ageSeconds = Math.max(0, Math.floor((nowMs - createdMs) / 1000));
  return {
    status: databaseStat.isFile() && databaseStat.size === bytes ? 'ok' : 'size_mismatch',
    createdAt,
    ageSeconds,
    bytes,
    schemaVersion,
    sha256,
  };
}
