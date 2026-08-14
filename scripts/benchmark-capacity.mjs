import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as XLSX from 'xlsx';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageMetadata = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
const defaultScales = [1_000, 10_000, 50_000];
const warmups = positiveInteger(process.env.BENCHMARK_WARMUPS ?? 1, 'BENCHMARK_WARMUPS', 0, 20);
const samples = positiveInteger(process.env.BENCHMARK_SAMPLES ?? 5, 'BENCHMARK_SAMPLES', 1, 50);
const scales = parseScales(process.env.BENCHMARK_SCALES);
const measurementNames = new Set([
  'login', 'bootstrap', 'recordFirstPage', 'allTransactions', 'auditXlsxExport',
  'ordinaryWrite', 'ordinaryCorrection', 'quantityImport', 'trackedChange', 'backup',
]);
const selectedMeasurements = parseMeasurements(process.env.BENCHMARK_MEASUREMENTS);
const keepData = ['1', 'true'].includes(String(process.env.BENCHMARK_KEEP_DATA ?? '').toLowerCase());
const initialPassword = 'benchmark-only-password';

function positiveInteger(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}

function parseScales(value) {
  if (!String(value ?? '').trim()) return defaultScales;
  const parsed = String(value).split(',').map((item) => positiveInteger(item.trim(), 'BENCHMARK_SCALES', 1, 1_000_000));
  return [...new Set(parsed)].sort((left, right) => left - right);
}

function parseMeasurements(value) {
  if (!String(value ?? '').trim()) return null;
  const names = [...new Set(String(value).split(',').map((item) => item.trim()).filter(Boolean))];
  const unknown = names.filter((name) => !measurementNames.has(name));
  if (unknown.length > 0) throw new Error(`BENCHMARK_MEASUREMENTS contains unknown names: ${unknown.join(', ')}`);
  return new Set(names);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function startApp(dataDir, backupDir) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      INITIAL_ADMIN_PASSWORD: initialPassword,
      DATA_DIR: dataDir,
      BACKUP_DIR: backupDir,
      HOST: '127.0.0.1',
      PORT: String(port),
      SQLITE_BUSY_TIMEOUT_MS: '10000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-20_000); });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Benchmark server stopped during startup: ${stderr.trim()}`);
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return { child, origin, logs: () => ({ stdout, stderr: stderr.slice(-20_000) }) };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error(`Benchmark server did not start: ${stderr.trim()}`);
}

async function stopApp(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function request(origin, pathname, { method = 'GET', body, cookie = '' } = {}) {
  const started = performance.now();
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  const elapsedMs = performance.now() - started;
  if (!response.ok) throw new Error(`${method} ${pathname} failed (${response.status}): ${payload.error ?? 'unknown error'}`);
  return { response, payload, elapsedMs };
}

async function login(origin) {
  const result = await request(origin, '/api/login', {
    method: 'POST',
    body: { username: 'admin', password: initialPassword },
  });
  return {
    cookie: String(result.response.headers.get('set-cookie') ?? '').split(';')[0],
    elapsedMs: result.elapsedMs,
  };
}

function seedTransactions(databasePath, count, material, trackedMaterial, user, group) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;');
    const insert = database.prepare(`
      INSERT INTO transactions (
        id, type, material_id, material_name, quantity, unit, user_id, user_name,
        group_id, group_name, source_type, counterparty, note, occurred_at,
        operation, inventory_unit_id, inventory_unit_label, status_id, status_name,
        access_scope, owner_user_id, owner_name, position_code, correction_of_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const baseTime = Date.now() - count * 60_000;
    for (let index = 0; index < count; index += 1) {
      const inbound = index % 2 === 0;
      insert.run(
        randomUUID(), inbound ? 'in' : 'out', material.id, material.name, 1, material.unit,
        user.id, user.name, group.id, group.name, 'manual', inbound ? '容量基准供应商' : '容量基准项目',
        `容量基准记录 ${index + 1}`, new Date(baseTime + index * 60_000).toISOString(),
        'stock', '', '', '', '', '', '', '', '', '',
      );
    }
    database.exec('COMMIT;');
    database.prepare('UPDATE materials SET quantity = ?, updated_at = ? WHERE id = ?')
      .run(10_000, new Date().toISOString(), material.id);
    database.prepare('UPDATE materials SET quantity = 1, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), trackedMaterial.id);
  } catch (error) {
    try { database.exec('ROLLBACK;'); } catch {}
    throw error;
  } finally {
    database.close();
  }
}

function databaseFixtures(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const user = database.prepare("SELECT id, name, group_id FROM users WHERE username = 'admin'").get();
    const group = database.prepare('SELECT id, name FROM groups WHERE id = ?').get(user.group_id);
    const material = database.prepare("SELECT id, name, unit FROM materials WHERE name = '容量基准普通耗材'").get();
    const trackedMaterial = database.prepare("SELECT id, name, unit FROM materials WHERE name = '容量基准库存单元耗材'").get();
    const unit = database.prepare('SELECT id, label FROM inventory_units WHERE material_id = ?').get(trackedMaterial.id);
    const status = database.prepare("SELECT id, name FROM inventory_statuses WHERE material_id = ? AND code = 'new'").get(trackedMaterial.id);
    return { user, group, material, trackedMaterial, unit, status };
  } finally {
    database.close();
  }
}

function databaseCounts(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      transactions: database.prepare('SELECT COUNT(*) AS count FROM transactions').get().count,
      inventoryEvents: database.prepare('SELECT COUNT(*) AS count FROM inventory_events').get().count,
    };
  } finally {
    database.close();
  }
}

async function sqliteFootprintBytes(databasePath) {
  let total = 0;
  for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try { total += (await stat(candidate)).size; } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return total;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function summarize(values) {
  return {
    samples: values.length,
    p50Ms: Number(percentile(values, 0.5).toFixed(1)),
    p95Ms: Number(percentile(values, 0.95).toFixed(1)),
    minMs: Number(Math.min(...values).toFixed(1)),
    maxMs: Number(Math.max(...values).toFixed(1)),
  };
}

async function measure(label, callback) {
  console.error(`  Measuring ${label} (${warmups} warmup, ${samples} samples)...`);
  for (let index = 0; index < warmups; index += 1) await callback(index, true);
  const durations = [];
  for (let index = 0; index < samples; index += 1) durations.push(await callback(index, false));
  return [label, summarize(durations)];
}

async function runBackup(dataDir, backupDir) {
  const started = performance.now();
  const child = spawn(process.execPath, ['scripts/backup.mjs'], {
    cwd: rootDir,
    env: { ...process.env, DATA_DIR: dataDir, BACKUP_DIR: backupDir, BACKUP_RETENTION_DAYS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => child.once('exit', resolve));
  if (exitCode !== 0) throw new Error(`Backup benchmark failed: ${stderr.trim()}`);
  return performance.now() - started;
}

async function generateAuditWorkbook(origin, cookie) {
  const started = performance.now();
  const result = await request(origin, '/api/transactions?mode=export', { cookie });
  const rows = [
    ['时间', '类型', '耗材', '数量', '单位', '操作人', '组织分组', '来源 / 去向', '备注'],
    ...result.payload.transactions.map((record) => [
      record.occurredAt, record.correctionOfId ? '更正冲销' : record.type === 'in' ? '入库' : '出库',
      record.materialName, record.quantity, record.unit, record.userName, record.groupName,
      record.counterparty, record.note,
    ]),
    ...(result.payload.inventoryEvents ?? []).map((event) => [
      event.occurredAt, event.eventType, event.materialName, event.quantity, '', event.userName,
      event.groupName, `${event.fromStatusName || '-'} -> ${event.toStatusName || '-'}`, event.note,
    ]),
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '库存审计记录');
  XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
  return performance.now() - started;
}

async function prepareScale(scaleDir, backupDir, count) {
  let app = await startApp(scaleDir, backupDir);
  try {
    const auth = await login(app.origin);
    const ordinary = await request(app.origin, '/api/materials', {
      method: 'POST', cookie: auth.cookie,
      body: { name: '容量基准普通耗材', category: '容量基准', spec: '普通数量', unit: '件', safetyStock: 0, trackingMode: 'quantity' },
    });
    const tracked = await request(app.origin, '/api/materials', {
      method: 'POST', cookie: auth.cookie,
      body: { name: '容量基准库存单元耗材', category: '容量基准', spec: '按盒追踪', unit: '件', safetyStock: 0, trackingMode: 'tracked' },
    });
    const bootstrap = await request(app.origin, '/api/bootstrap', { cookie: auth.cookie });
    const status = bootstrap.payload.inventorySummaries.find((item) => item.materialId === tracked.payload.material.id)?.statuses
      ?.find((item) => item.code === 'new');
    if (!status) throw new Error('Benchmark could not resolve the default tracked inventory status');
    await request(app.origin, '/api/inventory-units', {
      method: 'POST', cookie: auth.cookie,
      body: {
        materialId: tracked.payload.material.id,
        unitType: 'container', label: 'BENCH-BOX', capacity: 1_000,
        counterparty: '容量基准初始化', note: '容量基准库存单元',
        balances: [{ statusId: status.id, quantity: 1, accessScope: 'shared', ownerUserId: '', positionCode: 'BENCH-1' }],
      },
    });
  } finally {
    await stopApp(app.child);
  }
  const databasePath = path.join(scaleDir, 'labstock.sqlite');
  const fixtures = databaseFixtures(databasePath);
  seedTransactions(databasePath, count, fixtures.material, fixtures.trackedMaterial, fixtures.user, fixtures.group);
  app = await startApp(scaleDir, backupDir);
  return { app, databasePath, fixtures };
}

async function benchmarkScale(root, count) {
  const scaleDir = path.join(root, `transactions-${count}`);
  const backupDir = path.join(scaleDir, 'backups');
  await mkdir(scaleDir, { recursive: true });
  const { app, databasePath, fixtures } = await prepareScale(scaleDir, backupDir, count);
  let activeMeasurement = 'login';
  try {
    const loginResult = await login(app.origin);
    const cookie = loginResult.cookie;
    const measurements = {};
    const record = async (label, callback) => {
      if (selectedMeasurements && !selectedMeasurements.has(label)) return;
      activeMeasurement = label;
      const [name, summary] = await measure(label, callback);
      measurements[name] = summary;
    };
    await record('login', async () => (await login(app.origin)).elapsedMs);
    await record('bootstrap', async () => (await request(app.origin, '/api/bootstrap', { cookie })).elapsedMs);
    await record('recordFirstPage', async () => (await request(app.origin, '/api/transactions?mode=page&pageSize=60', { cookie })).elapsedMs);
    await record('allTransactions', async () => (await request(app.origin, '/api/transactions?mode=export', { cookie })).elapsedMs);
    await record('auditXlsxExport', async () => generateAuditWorkbook(app.origin, cookie));
    await record('ordinaryWrite', async (index) => (await request(app.origin, '/api/transactions', {
        method: 'POST', cookie,
        body: { type: 'in', materialId: fixtures.material.id, quantity: 1, counterparty: '容量基准写入', note: `普通写入样本 ${index}` },
      })).elapsedMs);
    await record('ordinaryCorrection', async (index) => {
      const original = await request(app.origin, '/api/transactions', {
        method: 'POST', cookie,
        body: { type: 'in', materialId: fixtures.material.id, quantity: 1, counterparty: '容量基准纠错', note: `待更正样本 ${index}` },
      });
      return (await request(app.origin, `/api/transactions/${encodeURIComponent(original.payload.transaction.id)}/correction`, {
        method: 'POST', cookie,
        body: { quantity: 1, reason: `容量基准更正 ${index}` },
      })).elapsedMs;
    });
    let importBatch = 0;
    await record('quantityImport', async () => {
      importBatch += 1;
      return (await request(app.origin, '/api/import', {
        method: 'POST', cookie,
        body: {
          rows: Array.from({ length: 500 }, (_, index) => ({
            name: `容量基准批量-${importBatch}-${index + 1}`,
            category: '容量基准', quantity: 1, safetyStock: 0, unit: '件', spec: '批量导入',
          })),
        },
      })).elapsedMs;
    });
    let trackedIsUser = false;
    await record('trackedChange', async (index) => {
      const toUser = !trackedIsUser;
      const result = await request(app.origin, `/api/inventory-units/${encodeURIComponent(fixtures.unit.id)}/operation`, {
          method: 'POST', cookie,
          body: {
            operation: 'access_change', quantity: 1,
            fromStatusId: fixtures.status.id,
            fromAccessScope: toUser ? 'shared' : 'user',
            fromOwnerUserId: toUser ? '' : fixtures.user.id,
            fromPositionCode: 'BENCH-1',
            toAccessScope: toUser ? 'user' : 'shared',
            toOwnerUserId: toUser ? fixtures.user.id : '',
            toPositionCode: 'BENCH-1', note: `库存单元变更样本 ${index}`,
          },
        });
      trackedIsUser = toUser;
      return result.elapsedMs;
    });
    await record('backup', async () => runBackup(scaleDir, backupDir));
    const databaseBytes = await sqliteFootprintBytes(databasePath);
    return {
      seededTransactions: count,
      finalCounts: databaseCounts(databasePath),
      databaseMiB: Number((databaseBytes / 1024 / 1024).toFixed(2)),
      initialLoginMs: Number(loginResult.elapsedMs.toFixed(1)),
      measurements,
    };
  } catch (error) {
    const logs = app.logs();
    throw new Error(
      `Capacity benchmark failed at ${count.toLocaleString('en-US')} transactions during ${activeMeasurement}: ${error.message}\n`
      + `Server exit code: ${app.child.exitCode ?? 'running'}\n`
      + `Server stdout:\n${logs.stdout.trim() || '(empty)'}\nServer stderr:\n${logs.stderr.trim() || '(empty)'}`,
      { cause: error },
    );
  } finally {
    await stopApp(app.child);
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), 'openlabstock-capacity-'));
const report = {
  generatedAt: new Date().toISOString(),
  appVersion: packageMetadata.version,
  nodeVersion: process.version,
  platform: `${process.platform}-${process.arch}`,
  warmups,
  samples,
  scales: [],
};

try {
  for (const count of scales) {
    console.error(`Running isolated capacity benchmark with ${count.toLocaleString('en-US')} historical transactions...`);
    const scaleResult = await benchmarkScale(root, count);
    report.scales.push(scaleResult);
    console.error(`  Completed: ${JSON.stringify(scaleResult)}`);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (keepData) console.error(`Benchmark data retained at ${root}`);
  else await rm(root, { recursive: true, force: true });
}
