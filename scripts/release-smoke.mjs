import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const archivePath = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node scripts/release-smoke.mjs <archive.tar.gz>');

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(origin, child, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged server exited early (${child.exitCode})\n${output()}`);
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Packaged server did not become healthy\n${output()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'openlabstock-release-smoke-'));
const dataDir = path.join(temporaryRoot, 'data');
const password = `smoke-${crypto.randomUUID()}`;
let child = null;
try {
  const extraction = spawnSync('tar', ['-xzf', archivePath, '-C', temporaryRoot], { encoding: 'utf8' });
  if (extraction.error) throw extraction.error;
  if (extraction.status !== 0) throw new Error(`tar extraction failed: ${extraction.stderr.trim()}`);
  const packageMetadata = JSON.parse(readFileSync(path.join(temporaryRoot, 'package.json'), 'utf8'));
  const { CURRENT_SCHEMA_VERSION } = await import(pathToFileURL(path.join(temporaryRoot, 'storage.mjs')).href);
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  let logs = '';
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: temporaryRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir,
      BACKUP_DIR: path.join(temporaryRoot, 'backups'), INITIAL_ADMIN_PASSWORD: password,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const health = await waitForHealth(origin, child, () => logs);
  if (health.version !== packageMetadata.version) throw new Error('Health version does not match package.json');

  const publicSettings = await fetch(`${origin}/api/public-settings`).then((response) => response.json());
  if (publicSettings.version !== packageMetadata.version) throw new Error('Public settings version does not match package.json');
  const loginResponse = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'admin', password }),
  });
  if (!loginResponse.ok) throw new Error(`Packaged owner login failed (${loginResponse.status})`);
  const cookie = loginResponse.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  const bootstrapResponse = await fetch(`${origin}/api/bootstrap`, { headers: { Cookie: cookie } });
  const bootstrap = await bootstrapResponse.json();
  if (!bootstrapResponse.ok || bootstrap.user?.role !== 'admin' || !bootstrap.user?.isOwner) throw new Error('Packaged bootstrap owner check failed');
  if (bootstrap.materials?.length !== 0 || bootstrap.transactionTotal !== 0) throw new Error('Production smoke database is not empty');

  await stopChild(child);
  const database = new DatabaseSync(path.join(dataDir, 'labstock.sqlite'), { readOnly: true });
  const scalar = (sql) => Object.values(database.prepare(sql).get())[0];
  const integrity = scalar('PRAGMA integrity_check');
  const foreignKeyViolation = database.prepare('PRAGMA foreign_key_check').get();
  const schemaVersion = Number(scalar("SELECT value FROM metadata WHERE key='schema_version'"));
  const owners = Number(scalar("SELECT COUNT(*) FROM users u JOIN metadata m ON m.key='owner_user_id' AND m.value=u.id WHERE u.role='admin' AND u.active=1"));
  const materials = Number(scalar('SELECT COUNT(*) FROM materials'));
  const transactions = Number(scalar('SELECT COUNT(*) FROM transactions'));
  database.close();
  if (integrity !== 'ok' || foreignKeyViolation || schemaVersion !== CURRENT_SCHEMA_VERSION || owners !== 1 || materials !== 0 || transactions !== 0) {
    throw new Error(`Packaged database check failed: ${JSON.stringify({ integrity, foreignKeyViolation, schemaVersion, owners, materials, transactions })}`);
  }
  console.log(`Release smoke: ${packageMetadata.version}, schema ${schemaVersion}, integrity ${integrity}`);
} finally {
  if (child) await stopChild(child);
  rmSync(temporaryRoot, { recursive: true, force: true });
}
