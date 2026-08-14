import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(rootDir, 'data'));
const sourcePath = path.join(dataDir, 'labstock.sqlite');
const backupDir = path.resolve(process.env.BACKUP_DIR ?? path.join(dataDir, 'backups'));
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? 30);

if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
  throw new Error('BACKUP_RETENTION_DAYS 必须是 1-3650 之间的整数');
}

await stat(sourcePath);
await mkdir(backupDir, { recursive: true });

const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
const backupPath = path.join(backupDir, `labstock-${timestamp}.sqlite`);
const quoteSqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;

const source = new DatabaseSync(sourcePath);
try {
  source.exec('PRAGMA busy_timeout = 10000;');
  source.exec(`VACUUM INTO ${quoteSqlString(backupPath)}`);
} finally {
  source.close();
}

const backup = new DatabaseSync(backupPath, { readOnly: true });
try {
  const integrity = backup.prepare('PRAGMA integrity_check').get();
  if (integrity?.integrity_check !== 'ok') throw new Error(`备份完整性校验失败：${integrity?.integrity_check ?? '未知错误'}`);
  const initialized = backup.prepare("SELECT value FROM metadata WHERE key = 'initialized'").get();
  if (!initialized) throw new Error('备份缺少初始化标记');
} finally {
  backup.close();
}

const cutoff = Date.now() - retentionDays * 86_400_000;
let removed = 0;
for (const entry of await readdir(backupDir, { withFileTypes: true })) {
  if (!entry.isFile() || !/^labstock-\d{8}T\d{9}Z\.sqlite$/.test(entry.name)) continue;
  const candidate = path.join(backupDir, entry.name);
  if ((await stat(candidate)).mtimeMs < cutoff) {
    await unlink(candidate);
    removed += 1;
  }
}

console.log(`备份完成：${backupPath}`);
console.log(`SQLite integrity_check：ok`);
console.log(`保留策略：${retentionDays} 天，本次清理 ${removed} 个旧备份`);
