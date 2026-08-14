import { randomBytes } from 'node:crypto';
import { accessSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../password.mjs';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(rootDir, 'data'));
const databasePath = path.join(dataDir, 'labstock.sqlite');
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

try {
  accessSync(databasePath);
} catch {
  console.error(`数据库不存在：${databasePath}`);
  process.exit(1);
}

const temporaryPassword = [...randomBytes(18)].map((byte) => alphabet[byte % alphabet.length]).join('');
const database = new DatabaseSync(databasePath);
database.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;');

try {
  const owner = database.prepare(`
    SELECT users.id, users.username, users.name
    FROM users
    JOIN metadata ON metadata.key = 'owner_user_id' AND metadata.value = users.id
    WHERE users.role = 'admin'
  `).get();
  if (!owner) throw new Error('数据库中没有有效的系统所有者，请先从备份恢复或联系维护人员');

  const credentials = hashPassword(temporaryPassword);
  database.prepare('UPDATE users SET salt = ?, password_hash = ?, active = 1 WHERE id = ?')
    .run(credentials.salt, credentials.passwordHash, owner.id);
  database.prepare('DELETE FROM sessions WHERE user_id = ?').run(owner.id);
  database.exec('COMMIT');

  const integrity = database.prepare('PRAGMA integrity_check').get()?.integrity_check;
  if (integrity !== 'ok') throw new Error(`密码已更新，但数据库完整性检查失败：${integrity}`);
  console.log(`系统所有者：${owner.name}`);
  console.log(`登录账号：${owner.username}`);
  console.log(`临时密码：${temporaryPassword}`);
  console.log('该账号的旧登录会话已全部失效。请立即登录并修改密码。');
} catch (error) {
  try { database.exec('ROLLBACK'); } catch {}
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  database.close();
}
