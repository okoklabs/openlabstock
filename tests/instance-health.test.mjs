import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeInstanceId, readLatestBackupStatus } from '../src/server/instance-health.mjs';

test('实例 ID 使用适合配置和控制面的稳定格式', () => {
  assert.equal(normalizeInstanceId('lab-a-prod'), 'lab-a-prod');
  assert.equal(normalizeInstanceId(''), '');
  assert.throws(() => normalizeInstanceId('Lab A'), /INSTANCE_ID/);
  assert.throws(() => normalizeInstanceId('-lab-a'), /INSTANCE_ID/);
  assert.throws(() => normalizeInstanceId('a'.repeat(65)), /INSTANCE_ID/);
});

test('实例健康摘要识别最近备份及文件大小异常', async () => {
  const backupDir = await mkdtemp(path.join(os.tmpdir(), 'openlabstock-instance-health-'));
  const database = 'labstock-20260918T040500000Z.sqlite';
  const manifestPath = path.join(backupDir, `${database}.json`);
  const manifest = {
    format: 1,
    createdAt: '2026-09-18T04:05:00.000Z',
    database,
    bytes: 4,
    sha256: 'A'.repeat(64),
    schemaVersion: 15,
    integrity: 'ok',
    foreignKeys: true,
  };
  try {
    await writeFile(path.join(backupDir, database), 'data');
    await writeFile(manifestPath, JSON.stringify(manifest));
    const status = await readLatestBackupStatus(backupDir, Date.parse('2026-09-18T04:10:00.000Z'));
    assert.deepEqual(status, {
      status: 'ok', createdAt: manifest.createdAt, ageSeconds: 300, bytes: 4,
      schemaVersion: 15, sha256: 'A'.repeat(64),
    });
    await writeFile(path.join(backupDir, database), 'changed');
    assert.equal((await readLatestBackupStatus(backupDir)).status, 'size_mismatch');
  } finally {
    await rm(backupDir, { recursive: true, force: true });
  }
});

test('实例健康摘要安全处理备份缺失和无效清单', async () => {
  const backupDir = await mkdtemp(path.join(os.tmpdir(), 'openlabstock-instance-health-invalid-'));
  try {
    assert.equal((await readLatestBackupStatus(backupDir)).status, 'missing');
    await writeFile(path.join(backupDir, 'labstock-20260918T040500000Z.sqlite.json'), '{broken');
    assert.equal((await readLatestBackupStatus(backupDir)).status, 'invalid_manifest');
  } finally {
    await rm(backupDir, { recursive: true, force: true });
  }
});
