import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const run = promisify(execFile);
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function createDatabase(dataDir, { initialized = true } = {}) {
  const database = new DatabaseSync(path.join(dataDir, 'labstock.sqlite'));
  database.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  if (initialized) database.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run('initialized', 'true');
  database.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run('schema_version', '15');
  database.close();
}

test('备份脚本发布带校验清单的原子 SQLite 快照', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'openlabstock-backup-'));
  const backupDir = path.join(dataDir, 'backups');
  try {
    await createDatabase(dataDir);
    await run(process.execPath, ['scripts/backup.mjs'], {
      cwd: rootDir,
      env: { ...process.env, DATA_DIR: dataDir, BACKUP_DIR: backupDir, BACKUP_RETENTION_DAYS: '30' },
    });
    const files = (await readdir(backupDir)).sort();
    assert.equal(files.length, 2);
    const databaseFile = files.find((file) => file.endsWith('.sqlite'));
    const manifestFile = files.find((file) => file.endsWith('.sqlite.json'));
    assert.ok(databaseFile);
    assert.ok(manifestFile);
    assert.equal(files.some((file) => file.includes('.partial-')), false);
    const manifest = JSON.parse(await readFile(path.join(backupDir, manifestFile), 'utf8'));
    const bytes = await readFile(path.join(backupDir, databaseFile));
    assert.equal(manifest.database, databaseFile);
    assert.equal(manifest.bytes, bytes.byteLength);
    assert.equal(manifest.sha256, createHash('sha256').update(bytes).digest('hex').toUpperCase());
    assert.equal(manifest.integrity, 'ok');
    assert.equal(manifest.foreignKeys, true);
    assert.equal(manifest.schemaVersion, 15);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('备份校验失败时不会留下可误用的快照或清单', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'openlabstock-backup-invalid-'));
  const backupDir = path.join(dataDir, 'backups');
  try {
    await createDatabase(dataDir, { initialized: false });
    await assert.rejects(
      run(process.execPath, ['scripts/backup.mjs'], {
        cwd: rootDir,
        env: { ...process.env, DATA_DIR: dataDir, BACKUP_DIR: backupDir, BACKUP_RETENTION_DAYS: '30' },
      }),
      /备份缺少初始化标记/,
    );
    assert.deepEqual(await readdir(backupDir), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
