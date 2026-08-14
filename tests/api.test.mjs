import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { hashPassword } from '../password.mjs';
import {
  createInventoryUnitQrPayload,
  createMaterialQrPayload,
  inventoryTargetFromQrText,
  inventoryUnitIdFromQrText,
  materialIdFromQrText,
} from '../src/scripts/material-qr.mjs';
import { detectMobileKeyboard, measureMobileViewport } from '../src/scripts/mobile-viewport.mjs';
import { paginateRecords } from '../src/scripts/record-pagination.mjs';
import { terminalStateConfirmation } from '../src/scripts/inventory-operation.mjs';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageMetadata = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
const expectedVersion = packageMetadata.version;
let child;
let secondChild;
let dataDir;
let baseUrl;
let secondBaseUrl;

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function request(pathname, { method = 'GET', body, session, origin = baseUrl, requestHeaders = {} } = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(session?.cookie ? { Cookie: session.cookie } : {}),
      ...requestHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get('set-cookie');
  if (session && setCookie) session.cookie = setCookie.split(';')[0];
  const payload = await response.json();
  return { response, payload };
}

async function login(username, password, origin = baseUrl) {
  const session = { cookie: '' };
  const result = await request('/api/login', { method: 'POST', body: { username, password }, session, origin });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  return session;
}

async function startServer(origin, serverDataDir = dataDir, extraEnv = {}) {
  const port = new URL(origin).port;
  const processHandle = spawn(process.execPath, ['server.mjs'], {
    cwd: rootDir,
    env: {
      ...process.env,
      DATA_DIR: serverDataDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      SQLITE_BUSY_TIMEOUT_MS: '2000',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return processHandle;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error('测试服务器未启动');
}

async function stopServer(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return;
  const exited = new Promise((resolve) => processHandle.once('exit', resolve));
  processHandle.kill();
  await exited;
}

async function runNodeScript(script, env = {}) {
  const processHandle = spawn(process.execPath, [script], {
    cwd: rootDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  processHandle.stdout.on('data', (chunk) => { stdout += chunk; });
  processHandle.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => processHandle.once('exit', resolve));
  return { exitCode, stdout, stderr };
}

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'labstock-api-'));
  baseUrl = `http://127.0.0.1:${await freePort()}`;
  secondBaseUrl = `http://127.0.0.1:${await freePort()}`;
  child = await startServer(baseUrl);
  secondChild = await startServer(secondBaseUrl);
});

after(async () => {
  await Promise.all([stopServer(child), stopServer(secondChild)]);
  await rm(dataDir, { recursive: true, force: true });
});

test('手机可视视口平移时保持弹窗贴合输入法', () => {
  assert.deepEqual(measureMobileViewport(null, 844), { height: 844, offsetTop: 0 });
  assert.deepEqual(measureMobileViewport({ height: 320.2, offsetTop: 84.8 }, 844), { height: 321, offsetTop: 84 });
  assert.equal(detectMobileKeyboard({ mobile: true, focusedInsideModal: true, baselineHeight: 844, height: 321, offsetTop: 84 }), true);
  assert.equal(detectMobileKeyboard({ mobile: true, focusedInsideModal: true, baselineHeight: 844, height: 520, offsetTop: 0 }), true);
  assert.equal(detectMobileKeyboard({ mobile: true, focusedInsideModal: true, baselineHeight: 844, height: 844, offsetTop: 0 }), false);
  assert.equal(detectMobileKeyboard({ mobile: true, focusedInsideModal: false, baselineHeight: 844, height: 321, offsetTop: 84 }), false);
});

test('记录分页按每页数量切分并修正越界页码', () => {
  const records = Array.from({ length: 125 }, (_, index) => ({ id: index + 1 }));
  const firstPage = paginateRecords(records, 1);
  assert.deepEqual(
    { page: firstPage.page, totalPages: firstPage.totalPages, from: firstPage.from, to: firstPage.to, length: firstPage.records.length },
    { page: 1, totalPages: 3, from: 1, to: 60, length: 60 },
  );

  const lastPage = paginateRecords(records, 99);
  assert.deepEqual(
    { page: lastPage.page, totalPages: lastPage.totalPages, from: lastPage.from, to: lastPage.to, length: lastPage.records.length },
    { page: 3, totalPages: 3, from: 121, to: 125, length: 5 },
  );

  const emptyPage = paginateRecords([], 2);
  assert.deepEqual(
    { page: emptyPage.page, totalPages: emptyPage.totalPages, from: emptyPage.from, to: emptyPage.to, records: emptyPage.records },
    { page: 1, totalPages: 1, from: 0, to: 0, records: [] },
  );
});

test('只有变更为终止不可用状态时要求二次确认', () => {
  const balance = { displayCode: '260807-2-3' };
  const unavailable = { name: '不可用', terminal: true };
  const pending = { name: '待清洁', terminal: false };
  const confirmation = terminalStateConfirmation('state_change', unavailable, balance);
  assert.deepEqual(confirmation, {
    title: '将库存标记为不可用？',
    message: '“260807-2-3”将变更为“不可用”。不可用库存不能继续登记使用；如需恢复，须由库存管理员修正状态。',
    confirmLabel: '确认标记不可用',
  });
  assert.equal(terminalStateConfirmation('state_change', pending, balance), null);
  assert.equal(terminalStateConfirmation('access_change', unavailable, balance), null);
  assert.equal(terminalStateConfirmation('state_change', unavailable, null), null);
});

test('完整流水响应保留成员 UUID，供“我的记录”稳定筛选', async () => {
  const session = await login('student', 'demo123');
  const bootstrap = await request('/api/bootstrap', { session });
  const records = await request('/api/transactions?includeInventoryEvents=1', { session });
  assert.equal(records.response.status, 200);
  assert.equal(records.payload.total, records.payload.transactions.length);
  assert.equal(records.payload.eventTotal, records.payload.inventoryEvents.length);
  assert.ok(records.payload.transactions.every((record) => typeof record.userId === 'string' && record.userId.length > 0));
  assert.ok(records.payload.transactions.some((record) => record.userId === bootstrap.payload.user.id));
  assert.ok((records.payload.inventoryEvents ?? []).every((event) => typeof event.userId === 'string' && event.userId.length > 0));
  assert.ok(records.payload.transactions.every((record, index, all) => index === 0 || all[index - 1].occurredAt >= record.occurredAt));
  assert.ok(records.payload.inventoryEvents.every((event, index, all) => index === 0 || all[index - 1].occurredAt >= event.occurredAt));
});

test('完整导出在同一数据库快照中返回库存、统计和流水', async () => {
  const session = await login('student', 'demo123');
  const exported = await request('/api/transactions?mode=export', { session });
  assert.equal(exported.response.status, 200, JSON.stringify(exported.payload));
  assert.ok(!Number.isNaN(new Date(exported.payload.exportedAt).valueOf()));
  assert.equal(exported.payload.total, exported.payload.transactions.length);
  assert.equal(exported.payload.eventTotal, exported.payload.inventoryEvents.length);
  assert.ok(Array.isArray(exported.payload.materials));
  assert.ok(Array.isArray(exported.payload.materialStats));
  assert.ok(Array.isArray(exported.payload.groups));
  assert.ok(Array.isArray(exported.payload.directory));
  assert.ok(exported.payload.transactions.every((record, index, all) => (
    index === 0 || all[index - 1].occurredAt > record.occurredAt
      || (all[index - 1].occurredAt === record.occurredAt && all[index - 1].id > record.id)
  )));
});

test('库存活动服务端筛选和游标分页保持稳定顺序', async () => {
  const session = await login('student', 'demo123');
  const first = await request('/api/transactions?mode=page&pageSize=2', { session });
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.items.length, 2);
  assert.equal(first.payload.hasMore, true);
  assert.ok(first.payload.nextCursor);
  assert.ok(first.payload.total > first.payload.items.length);
  const firstIds = first.payload.items.map((item) => item.kind === 'transaction' ? item.record.id : item.event.id);

  const second = await request(`/api/transactions?mode=page&pageSize=2&cursor=${encodeURIComponent(first.payload.nextCursor)}`, { session });
  assert.equal(second.response.status, 200, JSON.stringify(second.payload));
  assert.equal(second.payload.total, first.payload.total);
  const secondIds = second.payload.items.map((item) => item.kind === 'transaction' ? item.record.id : item.event.id);
  assert.equal(new Set([...firstIds, ...secondIds]).size, firstIds.length + secondIds.length);
  assert.ok(first.payload.items.at(-1).occurredAt >= second.payload.items[0].occurredAt);

  const bootstrap = await request('/api/bootstrap', { session });
  const mine = await request('/api/transactions?mode=page&pageSize=100&scope=mine', { session });
  assert.equal(mine.response.status, 200);
  assert.ok(mine.payload.items.length > 0);
  assert.ok(mine.payload.items.every((item) => (item.kind === 'transaction' ? item.record.userId : item.event.userId) === bootstrap.payload.user.id));
  const inbound = await request('/api/transactions?mode=page&pageSize=100&type=in', { session });
  assert.ok(inbound.payload.items.every((item) => item.kind === 'transaction' && item.record.type === 'in'));
  const searched = await request(`/api/transactions?mode=page&pageSize=10&q=${encodeURIComponent('采购到货')}`, { session });
  assert.ok(searched.payload.items.some((item) => item.kind === 'transaction' && item.record.note.includes('采购到货')));
  assert.equal((await request('/api/transactions?mode=page&pageSize=0', { session })).response.status, 400);
  assert.equal((await request('/api/transactions?mode=page&type=unknown', { session })).response.status, 400);
  assert.equal((await request('/api/transactions?mode=page&cursor=invalid', { session })).response.status, 400);
});

test('耗材二维码仅接受稳定 UUID 或带目标参数的网址', () => {
  const materialId = '123e4567-e89b-42d3-a456-426614174000';
  const unitId = '223e4567-e89b-42d3-a456-426614174001';
  assert.equal(
    createMaterialQrPayload(materialId, 'https://inventory.example/lab/?old=1#records'),
    `https://inventory.example/lab/?material=${materialId}`,
  );
  assert.equal(
    createMaterialQrPayload(materialId, 'https://inventory.example.org/?from=inventory#labels'),
    `https://inventory.example.org/?material=${materialId}`,
  );
  assert.equal(materialIdFromQrText(materialId), materialId);
  assert.equal(materialIdFromQrText(`https://inventory.example/?material=${materialId}`), materialId);
  assert.equal(materialIdFromQrText(`https://inventory.example.org/?material=${materialId}`), materialId);
  assert.equal(materialIdFromQrText('https://inventory.example/?material=not-a-uuid'), '');
  assert.equal(materialIdFromQrText('plain inventory text'), '');
  assert.equal(createInventoryUnitQrPayload(unitId, 'https://inventory.example/lab/?old=1'), `https://inventory.example/lab/?unit=${unitId}`);
  assert.equal(inventoryUnitIdFromQrText(`https://inventory.example/?unit=${unitId}`), unitId);
  assert.deepEqual(inventoryTargetFromQrText(`https://inventory.example/?unit=${unitId}`), { type: 'unit', id: unitId });
  assert.deepEqual(inventoryTargetFromQrText(`https://inventory.example/?material=${materialId}`), { type: 'material', id: materialId });
  assert.equal(inventoryTargetFromQrText('plain inventory text'), null);
  assert.throws(() => createMaterialQrPayload('not-a-uuid', 'https://inventory.example/'), /Invalid material ID/);
  assert.throws(() => createInventoryUnitQrPayload('not-a-uuid', 'https://inventory.example/'), /Invalid unit ID/);
});

test('完整的耗材、权限和成员管理流程', async () => {
  const health = await request('/api/health');
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.payload, { ok: true, version: expectedVersion });

  const page = await fetch(baseUrl);
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  assert.match(page.headers.get('etag') ?? '', /^"[a-f0-9]{16}"$/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('permissions-policy'), 'camera=(self), geolocation=(), microphone=()');
  assert.match(page.headers.get('strict-transport-security') ?? '', /^max-age=31536000; includeSubDomains$/);
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  const pageHtml = await page.text();
  assert.match(pageHtml, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(pageHtml, /<meta name="theme-color" content="#006b55">/);
  assert.match(pageHtml, /<link rel="apple-touch-icon" href="\/icons\/labstock-180-v1\.png">/);
  assert.match(pageHtml, /data-open-scanner/);
  assert.match(pageHtml, /data-open-scanner-from-transaction/);
  assert.match(pageHtml, /data-material-qr/);
  assert.match(pageHtml, /data-scanner-image/);
  assert.match(pageHtml, /data-material-label-size/);
  assert.match(pageHtml, /value="40x25"/);
  assert.match(pageHtml, /data-custom-label-width/);
  assert.match(pageHtml, /data-custom-label-height/);
  assert.match(pageHtml, /data-material-print-layout/);
  assert.match(pageHtml, /data-material-print-copies/);
  assert.match(pageHtml, /data-material-cut-lines/);
  assert.match(pageHtml, /data-download-material-label/);
  assert.match(pageHtml, /data-material-label-print-root/);
  assert.match(pageHtml, /data-open-batch-labels/);
  assert.match(pageHtml, /data-modal="batch-labels"/);
  assert.match(pageHtml, /data-batch-label-list/);
  assert.match(pageHtml, /data-batch-cut-lines/);
  assert.match(pageHtml, /data-inventory-overflow/);
  assert.match(pageHtml, /data-inventory-more/);
  assert.match(pageHtml, /data-inventory-action="export"/);
  assert.match(pageHtml, /data-view="audit"/);
  assert.match(pageHtml, /data-modal="audit-detail"/);
  const unchangedPage = await fetch(baseUrl, { headers: { 'If-None-Match': page.headers.get('etag') } });
  assert.equal(unchangedPage.status, 304);
  const headPage = await fetch(baseUrl, { method: 'HEAD' });
  assert.equal(headPage.status, 200);
  assert.equal((await headPage.arrayBuffer()).byteLength, 0);
  const hashedAssetPath = pageHtml.match(/(?:src|href)="(\/_astro\/[^"]+)"/)?.[1];
  assert.ok(hashedAssetPath, 'built page should reference a hashed Astro asset');
  const hashedAsset = await fetch(`${baseUrl}${hashedAssetPath}`);
  assert.equal(hashedAsset.response?.status ?? hashedAsset.status, 200);
  assert.match(hashedAsset.headers.get('cache-control') ?? '', /max-age=31536000, immutable/);

  const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.equal(manifestResponse.status, 200);
  assert.match(manifestResponse.headers.get('content-type') ?? '', /^application\/manifest\+json/);
  assert.equal(manifestResponse.headers.get('cache-control'), 'no-cache');
  const manifestEtag = manifestResponse.headers.get('etag');
  assert.match(manifestEtag ?? '', /^"[a-f0-9]{16}"$/);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'maskable'));
  const unchangedManifest = await fetch(`${baseUrl}/manifest.webmanifest`, { headers: { 'If-None-Match': manifestEtag } });
  assert.equal(unchangedManifest.status, 304);

  const iconResponse = await fetch(`${baseUrl}/icons/labstock-192-v1.png`);
  assert.equal(iconResponse.status, 200);
  assert.equal(iconResponse.headers.get('content-type'), 'image/png');
  assert.match(iconResponse.headers.get('cache-control') ?? '', /max-age=31536000, immutable/);
  const iconBytes = Buffer.from(await iconResponse.arrayBuffer());
  assert.deepEqual([...iconBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(iconBytes.readUInt32BE(16), 192);
  assert.equal(iconBytes.readUInt32BE(20), 192);

  const workerResponse = await fetch(`${baseUrl}/sw.js`);
  assert.equal(workerResponse.status, 200);
  assert.equal(workerResponse.headers.get('cache-control'), 'no-cache');
  const workerSource = await workerResponse.text();
  const workerListeners = {};
  const workerContext = {
    URL,
    Set,
    caches: {
      open: async () => ({ addAll: async () => undefined }),
      keys: async () => [],
      delete: async () => true,
      match: async () => 'cached-icon',
    },
    fetch: async () => 'network',
    self: {
      location: { origin: baseUrl },
      clients: { claim: async () => undefined },
      skipWaiting: async () => undefined,
      addEventListener: (type, listener) => { workerListeners[type] = listener; },
    },
  };
  vm.runInNewContext(workerSource, workerContext);
  let intercepted;
  const dispatchFetch = (request) => {
    intercepted = undefined;
    workerListeners.fetch({ request, respondWith: (value) => { intercepted = value; } });
    return intercepted;
  };
  assert.equal(dispatchFetch({ method: 'GET', mode: 'cors', url: `${baseUrl}/api/bootstrap` }), undefined);
  assert.equal(dispatchFetch({ method: 'GET', mode: 'navigate', url: `${baseUrl}/` }), undefined);
  assert.equal(dispatchFetch({ method: 'GET', mode: 'cors', url: `${baseUrl}/manifest.webmanifest` }), undefined);
  assert.equal(dispatchFetch({ method: 'POST', mode: 'cors', url: `${baseUrl}/icons/labstock-192-v1.png` }), undefined);
  assert.equal(await dispatchFetch({ method: 'GET', mode: 'cors', url: `${baseUrl}/icons/labstock-192-v1.png` }), 'cached-icon');

  const initialPublicSettings = await request('/api/public-settings');
  assert.equal(initialPublicSettings.response.status, 200);
  assert.equal(initialPublicSettings.payload.settings.appName, 'OpenLabStock');
  assert.equal(initialPublicSettings.payload.version, expectedVersion);
  assert.equal(initialPublicSettings.response.headers.get('cache-control'), 'public, no-cache');
  assert.match(initialPublicSettings.response.headers.get('etag') ?? '', /^"[a-f0-9]{16}"$/);
  const unchangedPublicSettings = await fetch(`${baseUrl}/api/public-settings`, {
    headers: { 'If-None-Match': initialPublicSettings.response.headers.get('etag') },
  });
  assert.equal(unchangedPublicSettings.status, 304);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const failedLogin = await request('/api/login', { method: 'POST', body: { username: 'rate_limit_test', password: 'wrong' } });
    assert.equal(failedLogin.response.status, 401);
  }
  const rateLimited = await request('/api/login', { method: 'POST', body: { username: 'rate_limit_test', password: 'wrong' } });
  assert.equal(rateLimited.response.status, 429);
  assert.match(rateLimited.response.headers.get('retry-after') ?? '', /^\d+$/);

  const admin = await login('admin', 'admin123');
  const member = await login('student', 'demo123');
  const sessionDuration = await request('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.match(sessionDuration.response.headers.get('set-cookie') ?? '', /Max-Age=1296000/);

  const crossOriginMutation = await request('/api/groups', {
    method: 'POST', session: member, body: { name: '跨来源请求' },
    requestHeaders: { Origin: 'https://evil.example' },
  });
  assert.equal(crossOriginMutation.response.status, 403);

  const sharedSession = await request('/api/bootstrap', { session: member, origin: secondBaseUrl });
  assert.equal(sharedSession.response.status, 200);
  assert.equal(sharedSession.payload.user.username, 'student');

  const adminBootstrap = await request('/api/bootstrap', { session: admin });
  assert.equal(adminBootstrap.response.status, 200);
  assert.equal(adminBootstrap.payload.version, expectedVersion);
  assert.equal(adminBootstrap.payload.members.length, 2);
  assert.equal(adminBootstrap.payload.user.isOwner, true);
  assert.equal(adminBootstrap.payload.members.find((user) => user.username === 'student').isOwner, false);
  assert.deepEqual(adminBootstrap.payload.settings, {
    appName: 'OpenLabStock',
    labName: '实验室耗材管理系统',
    brandIcon: '',
  });
  assert.equal(adminBootstrap.payload.groups.length, 1);
  assert.equal(adminBootstrap.payload.groups[0].isDefault, true);
  assert.equal(adminBootstrap.payload.tags.length, 2);
  assert.ok(adminBootstrap.payload.members.every((user) => user.groupId === adminBootstrap.payload.groups[0].id));
  assert.ok(adminBootstrap.payload.members.every((user) => Array.isArray(user.tagIds)));
  assert.equal(adminBootstrap.payload.trend.length, 6);
  assert.equal(typeof adminBootstrap.payload.stats.categories, 'number');
  assert.ok(adminBootstrap.payload.stats.monthInRecords >= 1);
  assert.equal(adminBootstrap.payload.trend.at(-1).in, adminBootstrap.payload.stats.monthInRecords);
  assert.equal('total' in adminBootstrap.payload.stats, false);
  assert.equal(adminBootstrap.payload.transactionTotal, adminBootstrap.payload.transactions.length);
  const seededRecentMaterial = adminBootstrap.payload.materials.find((material) => material.name === '移液枪头 200 μL');
  assert.equal(adminBootstrap.payload.recentlyUsedMaterialIds[0], seededRecentMaterial.id);

  const memberBootstrap = await request('/api/bootstrap', { session: member });
  assert.equal(memberBootstrap.payload.members.length, 0);
  assert.equal(memberBootstrap.payload.transactions.length, adminBootstrap.payload.transactions.length);
  assert.ok(memberBootstrap.payload.transactions.some((record) => record.userName !== '周子涵'));
  assert.equal(memberBootstrap.payload.materials.length, adminBootstrap.payload.materials.length);
  assert.ok(memberBootstrap.payload.directory.some((user) => user.username === undefined && user.name === '周子涵'));
  assert.deepEqual(
    memberBootstrap.payload.directory.map((user) => user.name),
    [...memberBootstrap.payload.directory.map((user) => user.name)].sort((left, right) => left.localeCompare(right, 'zh-CN-u-co-pinyin', { numeric: true, sensitivity: 'base' })),
  );
  const memberProfile = await request('/api/profile', {
    method: 'PATCH', session: member,
    body: { name: '周子涵', note: '负责移液耗材；联系：实验室 301', tagIds: adminBootstrap.payload.tags.map((tag) => tag.id) },
  });
  assert.equal(memberProfile.response.status, 200);
  assert.equal(memberProfile.payload.user.note, '负责移液耗材；联系：实验室 301');
  assert.equal(memberProfile.payload.user.tagIds.length, 2);
  const memberDirectory = await request('/api/bootstrap', { session: admin });
  assert.equal(memberDirectory.payload.directory.find((user) => user.name === '周子涵').note, '负责移液耗材；联系：实验室 301');

  const forbiddenSettings = await request('/api/settings', {
    method: 'PATCH', session: member, body: { appName: '越权修改', labName: '越权修改', brandIcon: '' },
  });
  assert.equal(forbiddenSettings.response.status, 403);

  const shortPassword = await request('/api/users', {
    method: 'POST', session: admin,
    body: { name: '短密码成员', username: 'short_password', password: '1234567', role: 'member', groupId: adminBootstrap.payload.groups[0].id },
  });
  assert.equal(shortPassword.response.status, 400);
  assert.match(shortPassword.payload.error, /8-128/);

  const updatedSettings = await request('/api/settings', {
    method: 'PATCH', session: admin,
    body: { appName: 'LabStock 实验室', labName: '示例材料研究实验室', brandIcon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' },
  });
  assert.equal(updatedSettings.response.status, 200);
  assert.equal(updatedSettings.payload.settings.appName, 'LabStock 实验室');
  assert.match(updatedSettings.payload.settings.brandIcon, /^\/api\/brand-icon\?v=[a-f0-9]{16}$/);
  const brandIconResponse = await fetch(`${baseUrl}${updatedSettings.payload.settings.brandIcon}`);
  assert.equal(brandIconResponse.status, 200);
  assert.equal(brandIconResponse.headers.get('content-type'), 'image/png');
  assert.match(brandIconResponse.headers.get('cache-control') ?? '', /max-age=31536000, immutable/);
  assert.match(brandIconResponse.headers.get('etag') ?? '', /^"[a-f0-9]{16}"$/);
  assert.ok((await brandIconResponse.arrayBuffer()).byteLength > 0);
  const preservedSettings = await request('/api/settings', {
    method: 'PATCH', session: admin,
    body: { appName: 'LabStock 实验室', labName: '示例材料研究实验室', brandIcon: updatedSettings.payload.settings.brandIcon },
  });
  assert.equal(preservedSettings.payload.settings.brandIcon, updatedSettings.payload.settings.brandIcon);
  const replacedSettings = await request('/api/settings', {
    method: 'PATCH', session: admin,
    body: { appName: 'LabStock 实验室', labName: '示例材料研究实验室', brandIcon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=' },
  });
  assert.notEqual(replacedSettings.payload.settings.brandIcon, updatedSettings.payload.settings.brandIcon);
  const staleBrandIcon = await fetch(`${baseUrl}${updatedSettings.payload.settings.brandIcon}`);
  assert.equal(staleBrandIcon.status, 404);
  assert.equal(staleBrandIcon.headers.get('cache-control'), 'no-store');
  const settingsBootstrap = await request('/api/bootstrap', { session: member });
  assert.equal(settingsBootstrap.payload.settings.appName, 'LabStock 实验室');
  const publicSettings = await request('/api/public-settings');
  assert.equal(publicSettings.response.status, 200);
  assert.equal(publicSettings.payload.settings.appName, 'LabStock 实验室');
  assert.equal(publicSettings.payload.settings.brandIcon, replacedSettings.payload.settings.brandIcon);
  assert.ok(JSON.stringify(publicSettings.payload).length < 1000);

  const forbiddenGroup = await request('/api/groups', { method: 'POST', session: member, body: { name: '越权分组' } });
  assert.equal(forbiddenGroup.response.status, 403);
  const forbiddenTag = await request('/api/tags', { method: 'POST', session: member, body: { name: '越权标签' } });
  assert.equal(forbiddenTag.response.status, 403);
  const createdGroup = await request('/api/groups', { method: 'POST', session: admin, body: { name: '器件测试组' } });
  assert.equal(createdGroup.response.status, 201);
  assert.equal(createdGroup.payload.group.isDefault, false);
  const createdTag = await request('/api/tags', { method: 'POST', session: admin, body: { name: '器件值班' } });
  assert.equal(createdTag.response.status, 201);
  const renamedTag = await request(`/api/tags/${createdTag.payload.tag.id}`, { method: 'PATCH', session: admin, body: { name: '器件负责人' } });
  assert.equal(renamedTag.response.status, 200);
  assert.equal(renamedTag.payload.tag.name, '器件负责人');
  assert.equal((await request('/api/tags', { method: 'POST', session: admin, body: { name: '器件负责人' } })).response.status, 409);

  const forbiddenMaterialCreate = await request('/api/materials', {
    method: 'POST', session: member,
    body: { name: '越权零库存耗材', category: '测试', unit: '件', safetyStock: 0 },
  });
  assert.equal(forbiddenMaterialCreate.response.status, 403);
  const zeroStockMaterial = await request('/api/materials', {
    method: 'POST', session: admin,
    body: { name: '零库存试剂（1 L）', category: '化学试剂', spec: '1 L', unit: '瓶', safetyStock: 2 },
  });
  assert.equal(zeroStockMaterial.response.status, 201);
  assert.equal(zeroStockMaterial.payload.material.quantity, 0);
  const archivedMaterial = await request(`/api/materials/${zeroStockMaterial.payload.material.id}/status`, {
    method: 'PATCH', session: member, body: { status: 'archived' },
  });
  assert.equal(archivedMaterial.response.status, 403);
  const similarMaterial = await request('/api/materials', {
    method: 'POST', session: admin,
    body: { name: '零 库存试剂-1 L', category: '化学试剂', spec: '1 L', unit: '瓶', safetyStock: 2 },
  });
  assert.equal(similarMaterial.response.status, 409);

  const created = await request('/api/transactions', {
    method: 'POST', session: member,
    body: { type: 'in', materialName: '测试滤膜', quantity: 10, unit: '盒', category: '过滤耗材', safetyStock: 3, spec: '50 片/盒', note: '首次采购' },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.createdMaterial, true);
  assert.equal(created.payload.material.quantity, 10);

  const forbiddenMaterialEdit = await request(`/api/materials/${created.payload.material.id}`, {
    method: 'PATCH', session: member,
    body: { name: '测试滤膜', category: '过滤耗材', spec: '50 片/盒', unit: '盒', safetyStock: 5 },
  });
  assert.equal(forbiddenMaterialEdit.response.status, 403);
  const editedMaterial = await request(`/api/materials/${created.payload.material.id}`, {
    method: 'PATCH', session: admin,
    body: { name: '测试滤膜', category: '过滤耗材', spec: '50 片/盒', unit: '盒', safetyStock: 5 },
  });
  assert.equal(editedMaterial.response.status, 200);
  assert.equal(editedMaterial.payload.material.safetyStock, 5);

  const unsafeUnitEdit = await request(`/api/materials/${created.payload.material.id}`, {
    method: 'PATCH', session: admin,
    body: { name: '测试滤膜', category: '过滤耗材', spec: '50 片/盒', unit: '包', safetyStock: 5 },
  });
  assert.equal(unsafeUnitEdit.response.status, 409);
  assert.match(unsafeUnitEdit.payload.error, /不能直接更改单位/);

  const outbound = await request('/api/transactions', {
    method: 'POST', session: member,
    body: { type: 'out', materialId: created.payload.material.id, quantity: 4, counterparty: '测试项目' },
  });
  assert.equal(outbound.response.status, 201);
  assert.equal(outbound.payload.material.quantity, 6);

  const insufficient = await request('/api/transactions', {
    method: 'POST', session: member,
    body: { type: 'out', materialId: created.payload.material.id, quantity: 99 },
  });
  assert.equal(insufficient.response.status, 409);

  const correctionMaterial = await request('/api/transactions', {
    method: 'POST', session: member,
    body: { type: 'in', materialName: '登记纠错测试耗材', quantity: 5, unit: '件', category: '测试', safetyStock: 0, note: '成员原入库' },
  });
  assert.equal(correctionMaterial.response.status, 201);
  const memberPartialCorrection = await request(`/api/transactions/${correctionMaterial.payload.transaction.id}/correction`, {
    method: 'POST', session: member, body: { quantity: 2, reason: '入库数量多填两件' },
  });
  assert.equal(memberPartialCorrection.response.status, 201, JSON.stringify(memberPartialCorrection.payload));
  assert.equal(memberPartialCorrection.payload.transaction.type, 'out');
  assert.equal(memberPartialCorrection.payload.transaction.correctionOfId, correctionMaterial.payload.transaction.id);
  assert.equal(memberPartialCorrection.payload.material.quantity, 3);
  const afterPartialCorrection = await request('/api/bootstrap', { session: member });
  const correctedStats = afterPartialCorrection.payload.materialStats.find((item) => item.materialId === correctionMaterial.payload.material.id);
  assert.equal(correctedStats.currentUnit.totalIn, 3);
  assert.equal(correctedStats.currentUnit.totalOut, 0);
  assert.equal(correctedStats.currentUnit.inRecords, 1);
  assert.equal(correctedStats.currentUnit.outRecords, 0);
  assert.equal((await request(`/api/transactions/${correctionMaterial.payload.transaction.id}/correction`, {
    method: 'POST', session: member, body: { quantity: 1, reason: '重复更正' },
  })).response.status, 409);

  const outboundToCorrect = await request('/api/transactions', {
    method: 'POST', session: member,
    body: { type: 'out', materialId: correctionMaterial.payload.material.id, quantity: 1, counterparty: '误选项目', note: '成员原出库' },
  });
  assert.equal(outboundToCorrect.response.status, 201);
  const outboundCorrection = await request(`/api/transactions/${outboundToCorrect.payload.transaction.id}/correction`, {
    method: 'POST', session: member, body: { quantity: 1, reason: '重复提交，补回库存' },
  });
  assert.equal(outboundCorrection.response.status, 201);
  assert.equal(outboundCorrection.payload.transaction.type, 'in');
  assert.equal(outboundCorrection.payload.material.quantity, 3);

  const adminOriginal = await request('/api/transactions', {
    method: 'POST', session: admin,
    body: { type: 'in', materialId: correctionMaterial.payload.material.id, quantity: 2, note: '管理员原登记' },
  });
  assert.equal(adminOriginal.response.status, 201);
  assert.equal((await request(`/api/transactions/${adminOriginal.payload.transaction.id}/correction`, {
    method: 'POST', session: member, body: { quantity: 2, reason: '尝试更正他人登记' },
  })).response.status, 403);
  const adminCorrection = await request(`/api/transactions/${adminOriginal.payload.transaction.id}/correction`, {
    method: 'POST', session: admin, body: { quantity: 2, reason: '管理员撤销自己的误登记' },
  });
  assert.equal(adminCorrection.response.status, 201);
  assert.equal(adminCorrection.payload.material.quantity, 3);

  const consumedInbound = await request('/api/transactions', {
    method: 'POST', session: member,
    body: { type: 'in', materialName: '已被领用的纠错测试耗材', quantity: 2, unit: '件', category: '测试', safetyStock: 0 },
  });
  assert.equal(consumedInbound.response.status, 201);
  assert.equal((await request('/api/transactions', {
    method: 'POST', session: member,
    body: { type: 'out', materialId: consumedInbound.payload.material.id, quantity: 2, counterparty: '已实际领用' },
  })).response.status, 201);
  const insufficientCorrection = await request(`/api/transactions/${consumedInbound.payload.transaction.id}/correction`, {
    method: 'POST', session: member, body: { quantity: 2, reason: '库存已被后续使用' },
  });
  assert.equal(insufficientCorrection.response.status, 409);
  assert.match(insufficientCorrection.payload.error, /不足以冲销/);

  const forbiddenImport = await request('/api/import', { method: 'POST', session: member, body: { rows: [{ name: '越权数据', quantity: 1 }] } });
  assert.equal(forbiddenImport.response.status, 403);

  const invalidImport = await request('/api/import', {
    method: 'POST', session: admin,
    body: { rows: [{ name: '无效库存', quantity: '不是数字' }] },
  });
  assert.equal(invalidImport.response.status, 400);
  assert.match(invalidImport.payload.error, /第 2 行/);

  const duplicateImport = await request('/api/import', {
    method: 'POST', session: admin,
    body: { rows: [{ name: '重复耗材', quantity: 1 }, { name: '重复耗材', quantity: 2 }] },
  });
  assert.equal(duplicateImport.response.status, 400);
  assert.match(duplicateImport.payload.error, /重复耗材/);

  const atomicImport = await request('/api/import', {
    method: 'POST', session: admin,
    body: { rows: [{ name: '不应部分写入的耗材', quantity: 1 }, { name: '测试 滤膜', quantity: 2 }] },
  });
  assert.equal(atomicImport.response.status, 409);
  assert.equal((await request('/api/bootstrap', { session: admin })).payload.materials.some((material) => material.name === '不应部分写入的耗材'), false);

  const unsafeUnitImport = await request('/api/import', {
    method: 'POST', session: admin,
    body: { rows: [{ name: '测试滤膜', category: '过滤耗材', quantity: 8, safetyStock: 3, unit: '包', spec: '50 片/盒' }] },
  });
  assert.equal(unsafeUnitImport.response.status, 409);
  assert.match(unsafeUnitImport.payload.error, /不能通过导入/);

  const imported = await request('/api/import', {
    method: 'POST', session: admin,
    body: { rows: [
      { name: '测试滤膜', category: '过滤耗材', quantity: 8, safetyStock: 3, unit: '盒', spec: '50 片/盒' },
      { name: '测试导管', category: '塑料耗材', quantity: 5, safetyStock: 2, unit: '包', spec: '10 根/包' },
    ] },
  });
  assert.equal(imported.response.status, 200);
  assert.deepEqual(imported.payload, { imported: 2, adjustments: 2 });

  const concurrentWrites = await Promise.all(Array.from({ length: 100 }, (_, index) => request('/api/transactions', {
    method: 'POST', session: member, origin: index % 2 ? secondBaseUrl : baseUrl,
    body: { type: 'in', materialId: created.payload.material.id, quantity: 1, note: '双进程并发测试' },
  })));
  const failedConcurrentWrites = concurrentWrites
    .filter((result) => result.response.status !== 201)
    .map((result) => ({ status: result.response.status, error: result.payload.error }));
  assert.deepEqual(failedConcurrentWrites, []);

  const singleStock = await request('/api/transactions', {
    method: 'POST', session: member,
    body: { type: 'in', materialName: '并发单库存测试', category: '并发测试', unit: '件', quantity: 1, note: '并发领用基线' },
  });
  assert.equal(singleStock.response.status, 201, JSON.stringify(singleStock.payload));
  const competingOutbounds = await Promise.all([baseUrl, secondBaseUrl].map((origin) => request('/api/transactions', {
    method: 'POST', session: member, origin,
    body: { type: 'out', materialId: singleStock.payload.material.id, quantity: 1, note: '并发竞争领用' },
  })));
  assert.deepEqual(competingOutbounds.map((result) => result.response.status).sort(), [201, 409]);

  const afterInventory = await request('/api/bootstrap', { session: admin });
  const afterInventoryTransactions = await request('/api/transactions', { session: admin });
  assert.equal(afterInventory.payload.transactions.length, 30);
  assert.equal(afterInventory.payload.transactionTotal, afterInventoryTransactions.payload.total);
  assert.ok(afterInventoryTransactions.payload.total > afterInventory.payload.transactions.length);
  const filter = afterInventory.payload.materials.find((material) => material.name === '测试滤膜');
  assert.equal(filter.quantity, 108);
  const materialStats = afterInventory.payload.materialStats.find((item) => item.materialId === filter.id);
  assert.deepEqual(materialStats.currentUnit, { unit: '盒', totalIn: 112, totalOut: 4, inRecords: 102, outRecords: 1 });
  assert.deepEqual(materialStats.otherUnits, []);
  assert.ok(materialStats.lastInAt);
  assert.ok(materialStats.lastOutAt);
  assert.ok(afterInventoryTransactions.payload.transactions.some((record) => record.note === '首次采购' && record.userName === '周子涵'));
  assert.ok(afterInventoryTransactions.payload.transactions.some((record) => record.note === 'Excel 导入库存调整' && record.type === 'in' && record.sourceType === 'inventory_adjustment'));
  assert.ok(afterInventoryTransactions.payload.transactions.some((record) => record.note === 'Excel 导入期初库存' && record.sourceType === 'inventory_adjustment'));
  assert.equal(afterInventory.payload.materials.find((material) => material.id === singleStock.payload.material.id).quantity, 0);
  const concurrentExport = await request('/api/transactions?mode=export', { session: admin });
  const singleStockLedger = concurrentExport.payload.transactions.filter((record) => record.materialId === singleStock.payload.material.id);
  assert.equal(singleStockLedger.reduce((quantity, record) => quantity + (record.type === 'in' ? record.quantity : -record.quantity), 0), 0);
  assert.equal(singleStockLedger.filter((record) => record.note === '并发竞争领用').length, 1);

  const exportWriteMaterial = await request('/api/transactions', {
    method: 'POST', session: member,
    body: { type: 'in', materialName: '导出并发写入测试', category: '并发测试', unit: '件', quantity: 10, note: '导出并发基线' },
  });
  for (let round = 1; round <= 3; round += 1) {
    const [snapshotDuringWrite, writeDuringSnapshot] = await Promise.all([
      request('/api/transactions?mode=export', { session: admin, origin: baseUrl }),
      request('/api/transactions', {
        method: 'POST', session: member, origin: secondBaseUrl,
        body: { type: 'out', materialId: exportWriteMaterial.payload.material.id, quantity: 1, note: `导出期间写入 ${round}` },
      }),
    ]);
    assert.equal(snapshotDuringWrite.response.status, 200, JSON.stringify(snapshotDuringWrite.payload));
    assert.equal(writeDuringSnapshot.response.status, 201, JSON.stringify(writeDuringSnapshot.payload));
    const snapshotMaterial = snapshotDuringWrite.payload.materials.find((material) => material.id === exportWriteMaterial.payload.material.id);
    const snapshotLedger = snapshotDuringWrite.payload.transactions.filter((record) => record.materialId === exportWriteMaterial.payload.material.id);
    assert.equal(
      snapshotLedger.reduce((quantity, record) => quantity + (record.type === 'in' ? record.quantity : -record.quantity), 0),
      snapshotMaterial.quantity,
    );
    assert.ok([10 - round, 11 - round].includes(snapshotMaterial.quantity));
  }

  const lockDatabase = new DatabaseSync(path.join(dataDir, 'labstock.sqlite'));
  lockDatabase.exec('BEGIN IMMEDIATE');
  try {
    const busy = await request('/api/transactions', {
      method: 'POST', session: member,
      body: { type: 'in', materialId: created.payload.material.id, quantity: 1, note: '不应保存' },
    });
    assert.equal(busy.response.status, 503);
    assert.equal(busy.response.headers.get('retry-after'), '2');
    assert.match(busy.payload.error, /本次操作未保存/);
  } finally {
    lockDatabase.exec('ROLLBACK');
    lockDatabase.close();
  }

  const forbiddenUser = await request('/api/users', { method: 'POST', session: member, body: { name: '越权成员', username: 'forbidden', password: '123456' } });
  assert.equal(forbiddenUser.response.status, 403);

  const createdUser = await request('/api/users', { method: 'POST', session: admin, body: { name: '测试成员', username: 'api_test', password: 'oldpass1', role: 'member', groupId: createdGroup.payload.group.id, tagIds: [createdTag.payload.tag.id] } });
  assert.equal(createdUser.response.status, 201);
  assert.equal(createdUser.payload.user.groupId, createdGroup.payload.group.id);
  assert.deepEqual(createdUser.payload.user.tagIds, [createdTag.payload.tag.id]);
  const groupedMember = await login('api_test', 'oldpass1');
  const groupedOutbound = await request('/api/transactions', {
    method: 'POST', session: groupedMember,
    body: { type: 'out', materialId: created.payload.material.id, quantity: 1, counterparty: '器件测试', note: '组织分组统计测试' },
  });
  assert.equal(groupedOutbound.response.status, 201);
  assert.equal(groupedOutbound.payload.transaction.groupId, createdGroup.payload.group.id);
  assert.equal(groupedOutbound.payload.transaction.groupName, '器件测试组');
  assert.equal(groupedOutbound.payload.transaction.sourceType, 'manual');
  assert.equal((await request(`/api/groups/${createdGroup.payload.group.id}`, { method: 'PATCH', session: admin, body: { name: '器件组织' } })).response.status, 200);
  const afterGroupRename = await request('/api/bootstrap', { session: admin });
  const afterGroupRenameTransactions = await request('/api/transactions', { session: admin });
  const historicalGroupRecord = afterGroupRenameTransactions.payload.transactions.find((record) => record.note === '组织分组统计测试');
  assert.equal(historicalGroupRecord.groupName, '器件测试组');
  const updatedUser = await request(`/api/users/${createdUser.payload.user.id}`, {
    method: 'PATCH', session: admin,
    body: { username: 'api_test_new', name: '更新后的成员', note: '负责器件测试组耗材', role: 'admin', groupId: createdGroup.payload.group.id, tagIds: [createdTag.payload.tag.id] },
  });
  assert.equal(updatedUser.response.status, 200);
  assert.equal(updatedUser.payload.user.username, 'api_test_new');
  assert.equal(updatedUser.payload.user.name, '更新后的成员');
  assert.equal(updatedUser.payload.user.note, '负责器件测试组耗材');
  assert.equal(updatedUser.payload.user.role, 'admin');
  assert.deepEqual(updatedUser.payload.user.tagIds, [createdTag.payload.tag.id]);
  const duplicateUsername = await request(`/api/users/${createdUser.payload.user.id}`, {
    method: 'PATCH', session: admin,
    body: { username: 'STUDENT', name: '更新后的成员', role: 'admin', groupId: createdGroup.payload.group.id },
  });
  assert.equal(duplicateUsername.response.status, 409);

  const ordinaryAdmin = await login('api_test_new', 'oldpass1');
  const ordinaryAdminSelfGroup = await request('/api/profile', {
    method: 'PATCH', session: ordinaryAdmin,
    body: { name: '更新后的成员', note: '负责器件测试组耗材', groupId: adminBootstrap.payload.groups[0].id, tagIds: [createdTag.payload.tag.id] },
  });
  assert.equal(ordinaryAdminSelfGroup.response.status, 200);
  assert.equal(ordinaryAdminSelfGroup.payload.user.groupId, adminBootstrap.payload.groups[0].id);
  const memberSelfGroup = await request('/api/profile', {
    method: 'PATCH', session: member,
    body: { name: '周子涵', note: '负责移液耗材', groupId: createdGroup.payload.group.id, tagIds: [] },
  });
  assert.equal(memberSelfGroup.response.status, 403);
  const ordinaryAdminSettings = await request('/api/settings', {
    method: 'PATCH', session: ordinaryAdmin,
    body: { appName: '系统管理员已更新', labName: '示例材料研究实验室', brandIcon: '' },
  });
  assert.equal(ordinaryAdminSettings.response.status, 200);
  const ordinaryAdminCreatesAdmin = await request('/api/users', {
    method: 'POST', session: ordinaryAdmin,
    body: { username: 'second_admin', name: '第二管理员', password: 'password8', role: 'admin', groupId: createdGroup.payload.group.id },
  });
  assert.equal(ordinaryAdminCreatesAdmin.response.status, 403);
  const ordinaryAdminManagesOwner = await request(`/api/users/${adminBootstrap.payload.user.id}/reset-password`, {
    method: 'POST', session: ordinaryAdmin, body: { newPassword: 'password9' },
  });
  assert.equal(ordinaryAdminManagesOwner.response.status, 403);

  const inventoryAccount = await request('/api/users', {
    method: 'POST', session: ordinaryAdmin,
    body: { username: 'inventory_manager', name: '库存管理员', password: 'inventory8', role: 'inventory', groupId: createdGroup.payload.group.id },
  });
  assert.equal(inventoryAccount.response.status, 201);
  assert.equal(inventoryAccount.payload.user.role, 'inventory');
  const inventoryAdmin = await login('inventory_manager', 'inventory8');
  const inventoryBootstrap = await request('/api/bootstrap', { session: inventoryAdmin });
  assert.equal(inventoryBootstrap.response.status, 200);
  assert.equal(inventoryBootstrap.payload.members.length, 0);
  assert.ok(inventoryBootstrap.payload.transactions.some((record) => record.userName === '周子涵'));
  assert.equal((await request('/api/settings', {
    method: 'PATCH', session: inventoryAdmin,
    body: { appName: '越权修改', labName: '越权修改', brandIcon: '' },
  })).response.status, 403);
  assert.equal((await request('/api/groups', { method: 'POST', session: inventoryAdmin, body: { name: '越权分组' } })).response.status, 403);
  assert.equal((await request('/api/audit-logs', { session: member })).response.status, 403);
  assert.equal((await request('/api/audit-logs', { session: inventoryAdmin })).response.status, 403);
  const auditPage = await request('/api/audit-logs?pageSize=2&type=user', { session: admin });
  assert.equal(auditPage.response.status, 200, JSON.stringify(auditPage.payload));
  assert.equal(auditPage.payload.items.length, 2);
  assert.equal(auditPage.payload.hasMore, true);
  assert.ok(auditPage.payload.nextCursor);
  assert.ok(auditPage.payload.items.every((item) => item.targetType === 'user'));
  const auditNextPage = await request(`/api/audit-logs?pageSize=2&type=user&cursor=${encodeURIComponent(auditPage.payload.nextCursor)}`, { session: admin });
  assert.equal(auditNextPage.response.status, 200, JSON.stringify(auditNextPage.payload));
  assert.ok(auditNextPage.payload.items.every((item) => !auditPage.payload.items.some((first) => first.id === item.id)));
  const auditExport = await request('/api/audit-logs?mode=export&type=user', { session: admin });
  assert.equal(auditExport.response.status, 200, JSON.stringify(auditExport.payload));
  assert.equal(auditExport.payload.items.length, auditExport.payload.total);
  assert.ok(auditExport.payload.items.some((item) => item.action === 'user.create' && item.targetName === '库存管理员'));
  assert.doesNotMatch(JSON.stringify(auditExport.payload), /inventory8|password8|oldpass1|passwordHash|brandIcon|salt/);
  const auditExportWithCursor = await request(`/api/audit-logs?mode=export&type=user&cursor=${encodeURIComponent(auditPage.payload.nextCursor)}`, { session: admin });
  assert.equal(auditExportWithCursor.response.status, 200, JSON.stringify(auditExportWithCursor.payload));
  assert.equal(auditExportWithCursor.payload.items.length, auditExportWithCursor.payload.total);
  const auditTotalBeforeFailure = (await request('/api/audit-logs', { session: admin })).payload.total;
  const failedManagementAction = await request('/api/groups', {
    method: 'POST', session: admin, body: { name: '' },
  });
  assert.equal(failedManagementAction.response.status, 400);
  assert.equal((await request('/api/audit-logs', { session: admin })).payload.total, auditTotalBeforeFailure);
  assert.equal((await request('/api/audit-logs?pageSize=0', { session: admin })).response.status, 400);
  assert.equal((await request('/api/audit-logs?type=unknown', { session: admin })).response.status, 400);
  assert.equal((await request('/api/audit-logs?cursor=invalid', { session: admin })).response.status, 400);
  assert.equal((await request('/api/users', {
    method: 'POST', session: inventoryAdmin,
    body: { username: 'forbidden_member', name: '越权成员', password: 'password8', role: 'member' },
  })).response.status, 403);
  const inventoryMaterial = await request('/api/materials', {
    method: 'POST', session: inventoryAdmin,
    body: { name: '库存管理员创建的耗材', category: '测试', spec: 'A 型', unit: '件', safetyStock: 2 },
  });
  assert.equal(inventoryMaterial.response.status, 201);

  const probePeerAccount = await request('/api/users', {
    method: 'POST', session: ordinaryAdmin,
    body: { username: 'probe_peer', name: '探针协作成员', password: 'probepass8', role: 'member', groupId: adminBootstrap.payload.groups[0].id },
  });
  assert.equal(probePeerAccount.response.status, 201);
  const probePeer = await login('probe_peer', 'probepass8');
  const studentUser = adminBootstrap.payload.members.find((candidate) => candidate.username === 'student');
  assert.ok(studentUser);

  const trackedProbe = await request('/api/materials', {
    method: 'POST', session: inventoryAdmin,
    body: {
      name: 'Multi75E-G 探针', category: '探针', spec: '10 根/盒', unit: '根', safetyStock: 2, trackingMode: 'tracked',
      positionCodeHelp: '1-1 表示第一行第一个', usageContextHelp: '填写实验项目或样品编号',
    },
  });
  assert.equal(trackedProbe.response.status, 201);
  assert.equal(trackedProbe.payload.material.trackingMode, 'tracked');
  assert.equal(trackedProbe.payload.material.positionCodeHelp, '1-1 表示第一行第一个');
  assert.equal(trackedProbe.payload.material.usageContextHelp, '填写实验项目或样品编号');
  const trackedImport = await request('/api/import', {
    method: 'POST', session: inventoryAdmin,
    body: { rows: [{ name: 'Multi75E-G 探针', category: '探针', quantity: 10, safetyStock: 2, unit: '根', spec: '10 根/盒' }] },
  });
  assert.equal(trackedImport.response.status, 409);
  assert.match(trackedImport.payload.error, /状态化库存/);
  const emptyTrackedInventory = await request(`/api/inventory-units?materialId=${trackedProbe.payload.material.id}`, { session: member });
  assert.equal(emptyTrackedInventory.response.status, 200);
  assert.equal(emptyTrackedInventory.payload.units.length, 0);
  assert.equal(emptyTrackedInventory.payload.statuses.length, 3);
  const newStatus = emptyTrackedInventory.payload.statuses.find((status) => status.code === 'new');
  const usedStatus = emptyTrackedInventory.payload.statuses.find((status) => status.code === 'active');
  const unavailableStatus = emptyTrackedInventory.payload.statuses.find((status) => status.code === 'unavailable');
  assert.ok(newStatus && usedStatus && unavailableStatus);

  const ordinaryTrackedTransaction = await request('/api/transactions', {
    method: 'POST', session: member,
    body: { type: 'in', materialId: trackedProbe.payload.material.id, quantity: 1 },
  });
  assert.equal(ordinaryTrackedTransaction.response.status, 409);
  assert.match(ordinaryTrackedTransaction.payload.error, /状态化库存/);

  const probeBox = await request('/api/inventory-units', {
    method: 'POST', session: member,
    body: {
      materialId: trackedProbe.payload.material.id,
      unitType: 'container',
      label: '260705-探针2',
      capacity: 10,
      counterparty: '探针采购入库',
      note: '第一批盒装探针',
      balances: [
        { statusId: newStatus.id, accessScope: 'shared', quantity: 1, positionCode: '1-1' },
        { statusId: newStatus.id, accessScope: 'shared', quantity: 1, positionCode: '1-2' },
        { statusId: newStatus.id, accessScope: 'shared', quantity: 1, positionCode: '2-1' },
      ],
    },
  });
  assert.equal(probeBox.response.status, 201, JSON.stringify(probeBox.payload));
  assert.equal(probeBox.payload.unit.quantity, 3);
  assert.equal(probeBox.payload.summary.total, 3);
  assert.equal(probeBox.payload.summary.sharedUsable, 3);
  assert.ok(probeBox.payload.unit.balances.some((balance) => balance.displayCode === '260705-探针2-2-1'));

  const probeInboundRecords = await request('/api/transactions', { session: member });
  const positionOneInbound = probeInboundRecords.payload.transactions.find((record) => record.inventoryUnitId === probeBox.payload.unit.id && record.positionCode === '1-1' && record.type === 'in');
  const positionTwoInbound = probeInboundRecords.payload.transactions.find((record) => record.inventoryUnitId === probeBox.payload.unit.id && record.positionCode === '1-2' && record.type === 'in');
  assert.ok(positionOneInbound && positionTwoInbound);
  assert.equal((await request(`/api/transactions/${positionOneInbound.id}/correction`, {
    method: 'POST', session: probePeer, body: { quantity: 1, reason: '尝试更正他人的探针登记' },
  })).response.status, 403);
  const positionedCorrection = await request(`/api/transactions/${positionOneInbound.id}/correction`, {
    method: 'POST', session: member, body: { quantity: 1, reason: '盒内位置误录，先冲销' },
  });
  assert.equal(positionedCorrection.response.status, 201, JSON.stringify(positionedCorrection.payload));
  assert.equal(positionedCorrection.payload.material.quantity, 2);
  assert.equal((await request(`/api/transactions/${positionOneInbound.id}/correction`, {
    method: 'POST', session: ordinaryAdmin, body: { quantity: 1, reason: '不能重复冲销' },
  })).response.status, 409);
  const adminPositionCorrection = await request(`/api/transactions/${positionTwoInbound.id}/correction`, {
    method: 'POST', session: ordinaryAdmin, body: { quantity: 1, reason: '管理员修正成员登记' },
  });
  assert.equal(adminPositionCorrection.response.status, 201);
  assert.equal((await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: member,
    body: { operation: 'in', quantity: 1, toStatusId: newStatus.id, toAccessScope: 'shared', toPositionCode: '1-1', note: '纠错后重新登记' },
  })).response.status, 200);
  assert.equal((await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: member,
    body: { operation: 'in', quantity: 1, toStatusId: newStatus.id, toAccessScope: 'shared', toPositionCode: '1-2', note: '管理员纠错后重新登记' },
  })).response.status, 200);

  assert.equal((await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: member,
    body: { operation: 'in', quantity: 1, toStatusId: newStatus.id, toAccessScope: 'shared', toPositionCode: '7-7', note: '并发格位基线' },
  })).response.status, 200);
  const competingPositionOutbounds = await Promise.all([baseUrl, secondBaseUrl].map((origin) => request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: member, origin,
    body: { operation: 'out', quantity: 1, fromStatusId: newStatus.id, fromAccessScope: 'shared', fromPositionCode: '7-7', note: '并发格位竞争' },
  })));
  assert.deepEqual(competingPositionOutbounds.map((result) => result.response.status).sort(), [200, 409]);
  const afterPositionCompetition = await request(`/api/inventory-units?unitId=${probeBox.payload.unit.id}`, { session: member });
  assert.equal(afterPositionCompetition.payload.units[0].balances.some((balance) => balance.positionCode === '7-7'), false);

  const searchedProbe = await request(`/api/inventory-units?materialId=${trackedProbe.payload.material.id}&q=2-1`, { session: probePeer });
  assert.equal(searchedProbe.payload.units.length, 1);
  assert.equal(searchedProbe.payload.units[0].balances.find((balance) => balance.positionCode === '2-1').ownerName, '');
  const searchedProbeByFullCode = await request(`/api/inventory-units?q=${encodeURIComponent('260705-探针2-2-1')}`, { session: probePeer });
  assert.equal(searchedProbeByFullCode.payload.units.length, 1);
  assert.equal(searchedProbeByFullCode.payload.units[0].id, probeBox.payload.unit.id);
  const searchedProbeByBoxAndPosition = await request(`/api/inventory-units?q=${encodeURIComponent('260705-探针2 2-1')}`, { session: probePeer });
  assert.equal(searchedProbeByBoxAndPosition.payload.units.length, 1);
  assert.equal(searchedProbeByBoxAndPosition.payload.units[0].id, probeBox.payload.unit.id);

  const claimProbe = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: member,
    body: {
      operation: 'access_change', quantity: 1,
      fromStatusId: newStatus.id, fromAccessScope: 'shared', fromPositionCode: '2-1',
      toAccessScope: 'user', toOwnerUserId: studentUser.id,
      note: '260705 探针2-1 设为本人自用',
    },
  });
  assert.equal(claimProbe.response.status, 200, JSON.stringify(claimProbe.payload));
  const claimedBalance = claimProbe.payload.unit.balances.find((balance) => balance.positionCode === '2-1');
  assert.equal(claimedBalance.ownerName, '周子涵');
  assert.equal(claimedBalance.accessScope, 'user');
  const movedPositionCorrection = await request(`/api/transactions/${probeInboundRecords.payload.transactions.find((record) => record.inventoryUnitId === probeBox.payload.unit.id && record.positionCode === '2-1' && record.type === 'in').id}/correction`, {
    method: 'POST', session: member, body: { quantity: 1, reason: '位置已转为自用后不能自动冲销' },
  });
  assert.equal(movedPositionCorrection.response.status, 409);
  assert.match(movedPositionCorrection.payload.error, /后续使用或变更/);

  const peerCannotUseClaimed = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: probePeer,
    body: { operation: 'use', quantity: 1, fromStatusId: newStatus.id, fromAccessScope: 'user', fromOwnerUserId: studentUser.id, fromPositionCode: '2-1' },
  });
  assert.equal(peerCannotUseClaimed.response.status, 403);
  const inventoryManagerCannotUseClaimed = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: inventoryAdmin,
    body: { operation: 'use', quantity: 1, fromStatusId: newStatus.id, fromAccessScope: 'user', fromOwnerUserId: studentUser.id, fromPositionCode: '2-1' },
  });
  assert.equal(inventoryManagerCannotUseClaimed.response.status, 403);
  assert.match(inventoryManagerCannotUseClaimed.payload.error, /只有自用人/);
  const systemAdminCannotUseClaimed = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: ordinaryAdmin,
    body: { operation: 'use', quantity: 1, fromStatusId: newStatus.id, fromAccessScope: 'user', fromOwnerUserId: studentUser.id, fromPositionCode: '2-1' },
  });
  assert.equal(systemAdminCannotUseClaimed.response.status, 403);

  const firstSharedProbeUse = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: member,
    body: { operation: 'use', quantity: 1, fromStatusId: newStatus.id, fromAccessScope: 'shared', fromPositionCode: '1-1', counterparty: 'A 项目', note: '首次使用自动启用' },
  });
  assert.equal(firstSharedProbeUse.response.status, 200, JSON.stringify(firstSharedProbeUse.payload));
  assert.equal(firstSharedProbeUse.payload.transaction, null);
  assert.equal(firstSharedProbeUse.payload.inventoryEvent.eventType, 'use');
  assert.equal(firstSharedProbeUse.payload.inventoryEvent.userName, '周子涵');
  assert.equal(firstSharedProbeUse.payload.inventoryEvent.fromStatusName, '全新');
  assert.equal(firstSharedProbeUse.payload.inventoryEvent.toStatusName, '已启用');
  assert.equal(firstSharedProbeUse.payload.inventoryEvent.counterparty, 'A 项目');
  assert.equal(firstSharedProbeUse.payload.summary.total, 3);
  assert.equal(firstSharedProbeUse.payload.unit.balances.find((balance) => balance.positionCode === '1-1').statusId, usedStatus.id);

  const repeatedSharedProbeUse = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: probePeer,
    body: { operation: 'use', quantity: 1, fromStatusId: usedStatus.id, fromAccessScope: 'shared', fromPositionCode: '1-1', counterparty: 'B 项目', note: '已启用探针再次使用' },
  });
  assert.equal(repeatedSharedProbeUse.response.status, 200, JSON.stringify(repeatedSharedProbeUse.payload));
  assert.equal(repeatedSharedProbeUse.payload.inventoryEvent.eventType, 'use');
  assert.equal(repeatedSharedProbeUse.payload.inventoryEvent.fromStatusName, '已启用');
  assert.equal(repeatedSharedProbeUse.payload.inventoryEvent.toStatusName, '已启用');
  assert.equal(repeatedSharedProbeUse.payload.inventoryEvent.userName, '探针协作成员');
  assert.equal(repeatedSharedProbeUse.payload.summary.total, 3);
  assert.equal(repeatedSharedProbeUse.payload.unit.balances.find((balance) => balance.positionCode === '1-1').statusId, usedStatus.id);

  const memberCannotCorrectPeerUse = await request(`/api/inventory-events/${repeatedSharedProbeUse.payload.inventoryEvent.id}/correction`, {
    method: 'POST', session: member, body: { reason: '不能更正他人的登记' },
  });
  assert.equal(memberCannotCorrectPeerUse.response.status, 403);
  const correctedRepeatedUse = await request(`/api/inventory-events/${repeatedSharedProbeUse.payload.inventoryEvent.id}/correction`, {
    method: 'POST', session: probePeer, body: { reason: 'B 重复提交，整笔冲销' },
  });
  assert.equal(correctedRepeatedUse.response.status, 201, JSON.stringify(correctedRepeatedUse.payload));
  assert.equal(correctedRepeatedUse.payload.event.eventType, 'use_correction');
  assert.equal(correctedRepeatedUse.payload.event.correctionOfId, repeatedSharedProbeUse.payload.inventoryEvent.id);
  assert.equal((await request(`/api/inventory-events/${repeatedSharedProbeUse.payload.inventoryEvent.id}/correction`, {
    method: 'POST', session: probePeer, body: { reason: '不能重复更正' },
  })).response.status, 409);
  const correctedUsePage = await request(`/api/transactions?mode=page&pageSize=100&type=use&q=${encodeURIComponent('B 项目')}`, { session: probePeer });
  const originalUsePageItem = correctedUsePage.payload.items.find((item) => item.kind === 'event' && item.event.id === repeatedSharedProbeUse.payload.inventoryEvent.id);
  assert.ok(originalUsePageItem);
  assert.equal(originalUsePageItem.event.corrected, true);

  const peerUsesShared = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: probePeer,
    body: { operation: 'out', quantity: 1, fromStatusId: usedStatus.id, fromAccessScope: 'shared', fromPositionCode: '1-1', counterparty: '公共探针领出库存' },
  });
  assert.equal(peerUsesShared.response.status, 200);
  assert.equal(peerUsesShared.payload.summary.total, 2);

  const firstClaimedProbeUse = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: member,
    body: {
      operation: 'use', quantity: 1,
      fromStatusId: newStatus.id, fromAccessScope: 'user', fromOwnerUserId: studentUser.id, fromPositionCode: '2-1',
      note: '首次启用后仍可继续使用',
    },
  });
  assert.equal(firstClaimedProbeUse.response.status, 200, JSON.stringify(firstClaimedProbeUse.payload));
  assert.equal(firstClaimedProbeUse.payload.inventoryEvent.fromStatusName, '全新');
  assert.equal(firstClaimedProbeUse.payload.inventoryEvent.toStatusName, '已启用');
  const firstClaimedProbeBalance = firstClaimedProbeUse.payload.unit.balances.find((balance) => balance.positionCode === '2-1');
  assert.equal(firstClaimedProbeBalance.statusId, usedStatus.id);
  assert.equal(firstClaimedProbeBalance.accessScope, 'user');
  assert.equal(firstClaimedProbeBalance.ownerUserId, studentUser.id);
  assert.equal(firstClaimedProbeUse.payload.summary.total, 2);
  assert.equal(firstClaimedProbeUse.payload.summary.usable, 2);
  const bootstrapAfterProbeUse = await request('/api/bootstrap', { session: member });
  assert.equal(bootstrapAfterProbeUse.payload.recentlyUsedMaterialIds[0], trackedProbe.payload.material.id);

  const stateChangeCannotMoveAnotherPosition = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: member,
    body: {
      operation: 'state_change', quantity: 1,
      fromStatusId: usedStatus.id, fromAccessScope: 'user', fromOwnerUserId: studentUser.id, fromPositionCode: '2-1',
      toStatusId: unavailableStatus.id, toPositionCode: '2-2',
    },
  });
  assert.equal(stateChangeCannotMoveAnotherPosition.response.status, 400);
  assert.match(stateChangeCannotMoveAnotherPosition.payload.error, /调整格位/);
  const probeAfterRejectedMove = await request(`/api/inventory-units?unitId=${probeBox.payload.unit.id}`, { session: member });
  assert.ok(probeAfterRejectedMove.payload.units[0].balances.some((balance) => balance.positionCode === '2-1' && balance.statusId === usedStatus.id));
  assert.ok(!probeAfterRejectedMove.payload.units[0].balances.some((balance) => balance.positionCode === '2-2'));

  const markProbeUnavailable = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: member,
    body: {
      operation: 'state_change', quantity: 1,
      fromStatusId: usedStatus.id, fromAccessScope: 'user', fromOwnerUserId: studentUser.id, fromPositionCode: '2-1',
      toStatusId: unavailableStatus.id,
      note: '针尖损坏',
    },
  });
  assert.equal(markProbeUnavailable.response.status, 200);
  assert.equal(markProbeUnavailable.payload.summary.total, 2);
  assert.equal(markProbeUnavailable.payload.summary.unavailable, 1);
  assert.equal(markProbeUnavailable.payload.summary.sharedUsable, 1);

  const memberCannotRestoreTerminal = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: member,
    body: {
      operation: 'state_change', quantity: 1,
      fromStatusId: unavailableStatus.id, fromAccessScope: 'user', fromOwnerUserId: studentUser.id, fromPositionCode: '2-1',
      toStatusId: newStatus.id,
    },
  });
  assert.equal(memberCannotRestoreTerminal.response.status, 403);
  const unavailableCannotBeIssued = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: member,
    body: { operation: 'out', quantity: 1, fromStatusId: unavailableStatus.id, fromAccessScope: 'user', fromOwnerUserId: studentUser.id, fromPositionCode: '2-1' },
  });
  assert.equal(unavailableCannotBeIssued.response.status, 409);
  const disposeProbe = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: member,
    body: {
      operation: 'dispose', quantity: 1,
      fromStatusId: unavailableStatus.id, fromAccessScope: 'user', fromOwnerUserId: studentUser.id, fromPositionCode: '2-1',
      counterparty: '实验室废弃物', note: '损坏后处置',
    },
  });
  assert.equal(disposeProbe.response.status, 200);
  assert.equal(disposeProbe.payload.transaction.operation, 'dispose');
  assert.equal(disposeProbe.payload.summary.total, 1);

  const inboundOwnProbe = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: probePeer,
    body: {
      operation: 'in', quantity: 1, toStatusId: usedStatus.id,
      toAccessScope: 'user', toOwnerUserId: probePeerAccount.payload.user.id, toPositionCode: '3-1',
      counterparty: '归还可复用探针',
    },
  });
  assert.equal(inboundOwnProbe.response.status, 200);
  assert.equal(inboundOwnProbe.payload.summary.total, 2);
  assert.equal(inboundOwnProbe.payload.summary.reservedUsable, 1);
  const peerCannotInboundForStudent = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: probePeer,
    body: { operation: 'in', quantity: 1, toStatusId: usedStatus.id, toAccessScope: 'user', toOwnerUserId: studentUser.id, toPositionCode: '3-2' },
  });
  assert.equal(peerCannotInboundForStudent.response.status, 403);
  const inventoryManagerCannotInboundForStudent = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: inventoryAdmin,
    body: { operation: 'in', quantity: 1, toStatusId: usedStatus.id, toAccessScope: 'user', toOwnerUserId: studentUser.id, toPositionCode: '3-2' },
  });
  assert.equal(inventoryManagerCannotInboundForStudent.response.status, 403);
  const adminCanInboundForStudent = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: ordinaryAdmin,
    body: { operation: 'in', quantity: 1, toStatusId: usedStatus.id, toAccessScope: 'user', toOwnerUserId: studentUser.id, toPositionCode: '3-2' },
  });
  assert.equal(adminCanInboundForStudent.response.status, 200);
  assert.equal((await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: ordinaryAdmin,
    body: { operation: 'in', quantity: 1, toStatusId: newStatus.id, toAccessScope: 'shared', toPositionCode: '3-2' },
  })).response.status, 409);
  assert.equal((await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: ordinaryAdmin,
    body: { operation: 'in', quantity: 2, toStatusId: newStatus.id, toAccessScope: 'shared', toPositionCode: '9-9' },
  })).response.status, 400);
  assert.equal((await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: ordinaryAdmin,
    body: {
      operation: 'out', quantity: 1, fromStatusId: usedStatus.id, fromAccessScope: 'user',
      fromOwnerUserId: studentUser.id, fromPositionCode: '3-2', counterparty: '权限回归清理',
    },
  })).response.status, 200);

  const peerClaimsShared = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: probePeer,
    body: {
      operation: 'access_change', quantity: 1,
      fromStatusId: newStatus.id, fromAccessScope: 'shared', fromPositionCode: '1-2',
      toAccessScope: 'user', toOwnerUserId: probePeerAccount.payload.user.id,
    },
  });
  assert.equal(peerClaimsShared.response.status, 200);
  const studentCannotUsePeerProbe = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: member,
    body: { operation: 'out', quantity: 1, fromStatusId: newStatus.id, fromAccessScope: 'user', fromOwnerUserId: probePeerAccount.payload.user.id, fromPositionCode: '1-2' },
  });
  assert.equal(studentCannotUsePeerProbe.response.status, 403);
  const peerReleasesProbe = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: probePeer,
    body: {
      operation: 'access_change', quantity: 1,
      fromStatusId: newStatus.id, fromAccessScope: 'user', fromOwnerUserId: probePeerAccount.payload.user.id, fromPositionCode: '1-2',
      toAccessScope: 'shared',
    },
  });
  assert.equal(peerReleasesProbe.response.status, 200);

  const inactiveOwnerProbe = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: ordinaryAdmin,
    body: {
      operation: 'in', quantity: 1, toStatusId: usedStatus.id,
      toAccessScope: 'user', toOwnerUserId: probePeerAccount.payload.user.id, toPositionCode: '4-1',
      counterparty: '停用成员库存测试',
    },
  });
  assert.equal(inactiveOwnerProbe.response.status, 200);
  assert.equal((await request(`/api/users/${probePeerAccount.payload.user.id}/status`, {
    method: 'PATCH', session: ordinaryAdmin, body: { active: false },
  })).response.status, 200);
  const deleteOwnerWithInventory = await request(`/api/users/${probePeerAccount.payload.user.id}`, {
    method: 'DELETE', session: ordinaryAdmin,
  });
  assert.equal(deleteOwnerWithInventory.response.status, 409);
  assert.match(deleteOwnerWithInventory.payload.error, /自用库存/);
  const releaseInactiveOwnerProbe = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: ordinaryAdmin,
    body: {
      operation: 'access_change', quantity: 1,
      fromStatusId: usedStatus.id, fromAccessScope: 'user', fromOwnerUserId: probePeerAccount.payload.user.id, fromPositionCode: '4-1',
      toAccessScope: 'shared',
    },
  });
  assert.equal(releaseInactiveOwnerProbe.response.status, 200);
  assert.equal((await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: inventoryAdmin,
    body: { operation: 'out', quantity: 1, fromStatusId: usedStatus.id, fromAccessScope: 'shared', fromPositionCode: '4-1' },
  })).response.status, 200);
  assert.equal((await request(`/api/users/${probePeerAccount.payload.user.id}/status`, {
    method: 'PATCH', session: ordinaryAdmin, body: { active: true },
  })).response.status, 200);
  const reenabledProbePeer = await login('probe_peer', 'probepass8');

  const forbiddenCustomStatus = await request('/api/inventory-statuses', {
    method: 'POST', session: member,
    body: { materialId: trackedProbe.payload.material.id, name: '待清洁', usable: false },
  });
  assert.equal(forbiddenCustomStatus.response.status, 403);
  const customStatus = await request('/api/inventory-statuses', {
    method: 'POST', session: inventoryAdmin,
    body: { materialId: trackedProbe.payload.material.id, name: '待清洁', usable: false, terminal: false },
  });
  assert.equal(customStatus.response.status, 201);
  assert.match(customStatus.payload.status.code, /^status-/);

  const fallbackMaterial = await request('/api/materials', {
    method: 'POST', session: inventoryAdmin,
    body: { name: '自定义启用状态探针', category: '探针', unit: '根', trackingMode: 'tracked' },
  });
  const fallbackInventory = await request(`/api/inventory-units?materialId=${fallbackMaterial.payload.material.id}`, { session: inventoryAdmin });
  const fallbackNewStatus = fallbackInventory.payload.statuses.find((status) => status.code === 'new');
  const fallbackActiveStatus = fallbackInventory.payload.statuses.find((status) => status.code === 'active');
  const fallbackUsableStatus = await request('/api/inventory-statuses', {
    method: 'POST', session: inventoryAdmin,
    body: { materialId: fallbackMaterial.payload.material.id, name: '清洗后可用', usable: true },
  });
  assert.equal((await request(`/api/inventory-statuses/${fallbackActiveStatus.id}`, {
    method: 'PATCH', session: inventoryAdmin, body: { active: false },
  })).response.status, 200);
  const fallbackUnit = await request('/api/inventory-units', {
    method: 'POST', session: inventoryAdmin,
    body: {
      materialId: fallbackMaterial.payload.material.id,
      unitType: 'container', label: 'FALLBACK-01', capacity: 1,
      balances: [{ statusId: fallbackNewStatus.id, accessScope: 'shared', positionCode: '1-1', quantity: 1 }],
    },
  });
  const fallbackFirstUse = await request(`/api/inventory-units/${fallbackUnit.payload.unit.id}/operation`, {
    method: 'POST', session: member,
    body: { operation: 'use', quantity: 1, fromStatusId: fallbackNewStatus.id, fromAccessScope: 'shared', fromPositionCode: '1-1' },
  });
  assert.equal(fallbackFirstUse.response.status, 200, JSON.stringify(fallbackFirstUse.payload));
  assert.equal(fallbackFirstUse.payload.inventoryEvent.toStatusId, fallbackUsableStatus.payload.status.id);
  assert.equal(fallbackFirstUse.payload.summary.total, 1);

  const noTargetMaterial = await request('/api/materials', {
    method: 'POST', session: inventoryAdmin,
    body: { name: '缺少启用状态探针', category: '探针', unit: '根', trackingMode: 'tracked' },
  });
  const noTargetInventory = await request(`/api/inventory-units?materialId=${noTargetMaterial.payload.material.id}`, { session: inventoryAdmin });
  const noTargetNewStatus = noTargetInventory.payload.statuses.find((status) => status.code === 'new');
  const noTargetActiveStatus = noTargetInventory.payload.statuses.find((status) => status.code === 'active');
  assert.equal((await request(`/api/inventory-statuses/${noTargetActiveStatus.id}`, {
    method: 'PATCH', session: inventoryAdmin, body: { active: false },
  })).response.status, 200);
  const noTargetUnit = await request('/api/inventory-units', {
    method: 'POST', session: inventoryAdmin,
    body: {
      materialId: noTargetMaterial.payload.material.id,
      unitType: 'container', label: 'NO-TARGET-01', capacity: 1,
      balances: [{ statusId: noTargetNewStatus.id, accessScope: 'shared', positionCode: '1-1', quantity: 1 }],
    },
  });
  const rejectedFirstUse = await request(`/api/inventory-units/${noTargetUnit.payload.unit.id}/operation`, {
    method: 'POST', session: member,
    body: { operation: 'use', quantity: 1, fromStatusId: noTargetNewStatus.id, fromAccessScope: 'shared', fromPositionCode: '1-1' },
  });
  assert.equal(rejectedFirstUse.response.status, 409);
  assert.match(rejectedFirstUse.payload.error, /已启用/);
  const unchangedNoTargetUnit = await request(`/api/inventory-units?unitId=${noTargetUnit.payload.unit.id}`, { session: member });
  assert.equal(unchangedNoTargetUnit.payload.units[0].balances[0].statusId, noTargetNewStatus.id);

  const trackedEvents = await request(`/api/inventory-events?materialId=${trackedProbe.payload.material.id}`, { session: reenabledProbePeer });
  assert.equal(trackedEvents.response.status, 200);
  assert.ok(trackedEvents.payload.total >= 5);
  assert.ok(trackedEvents.payload.events.some((event) => event.eventType === 'dispose' && event.note === '损坏后处置' && event.fromPositionCode === '2-1'));
  assert.equal((await request(`/api/inventory-events/${trackedEvents.payload.events[0].id}`, { method: 'DELETE', session: inventoryAdmin })).response.status, 404);
  const mergedRecords = await request('/api/transactions?includeInventoryEvents=1', { session: member });
  assert.equal(mergedRecords.response.status, 200);
  assert.ok(Array.isArray(mergedRecords.payload.inventoryEvents));
  assert.ok(mergedRecords.payload.inventoryEvents.some((event) => event.materialId === trackedProbe.payload.material.id && event.eventType === 'state_change'));

  assert.equal((await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: reenabledProbePeer,
    body: { operation: 'out', quantity: 1, fromStatusId: usedStatus.id, fromAccessScope: 'user', fromOwnerUserId: probePeerAccount.payload.user.id, fromPositionCode: '3-1' },
  })).response.status, 200);
  const emptyProbeBox = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: member,
    body: { operation: 'out', quantity: 1, fromStatusId: newStatus.id, fromAccessScope: 'shared', fromPositionCode: '1-2' },
  });
  assert.equal(emptyProbeBox.response.status, 200);
  assert.equal(emptyProbeBox.payload.summary.total, 0);
  const unpositionedProbe = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: inventoryAdmin,
    body: { operation: 'in', quantity: 1, toStatusId: newStatus.id, toAccessScope: 'shared', note: '验证未定位库存登记规则' },
  });
  assert.equal(unpositionedProbe.response.status, 200, JSON.stringify(unpositionedProbe.payload));
  const unpositionedBalance = unpositionedProbe.payload.unit.balances.find((balance) => !balance.positionCode && balance.statusId === newStatus.id);
  assert.ok(unpositionedBalance);
  const missingProbePosition = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: member,
    body: { operation: 'use', quantity: 1, fromStatusId: newStatus.id, fromAccessScope: 'shared', fromPositionCode: '' },
  });
  assert.equal(missingProbePosition.response.status, 400);
  assert.match(missingProbePosition.payload.error, /位置|单件编号/);
  const missingStateChangePosition = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: inventoryAdmin,
    body: { operation: 'state_change', quantity: 1, fromStatusId: newStatus.id, fromAccessScope: 'shared', fromPositionCode: '', toStatusId: unavailableStatus.id },
  });
  assert.equal(missingStateChangePosition.response.status, 400);
  assert.match(missingStateChangePosition.payload.error, /位置|单件编号/);
  const positionedUnavailableProbe = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: inventoryAdmin,
    body: { operation: 'state_change', quantity: 1, fromStatusId: newStatus.id, fromAccessScope: 'shared', fromPositionCode: '', toStatusId: unavailableStatus.id, toPositionCode: '3-4', note: '定位后标记不可用' },
  });
  assert.equal(positionedUnavailableProbe.response.status, 200, JSON.stringify(positionedUnavailableProbe.payload));
  assert.equal(positionedUnavailableProbe.payload.inventoryEvent.toPositionCode, '3-4');
  assert.ok(positionedUnavailableProbe.payload.unit.balances.some((balance) => balance.positionCode === '3-4' && balance.statusId === unavailableStatus.id));
  const replenishUnpositionedProbe = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: inventoryAdmin,
    body: { operation: 'in', quantity: 1, toStatusId: newStatus.id, toAccessScope: 'shared', note: '补足首次使用测试库存' },
  });
  assert.equal(replenishUnpositionedProbe.response.status, 200);
  const positionedProbeUse = await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: member,
    body: { operation: 'use', quantity: 1, fromStatusId: newStatus.id, fromAccessScope: 'shared', fromPositionCode: '', toPositionCode: '3-3', note: '补录具体探针位置' },
  });
  assert.equal(positionedProbeUse.response.status, 200, JSON.stringify(positionedProbeUse.payload));
  assert.equal(positionedProbeUse.payload.inventoryEvent.toPositionCode, '3-3');
  assert.ok(positionedProbeUse.payload.unit.balances.some((balance) => balance.positionCode === '3-3' && balance.statusId === usedStatus.id));
  assert.equal((await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: member,
    body: { operation: 'out', quantity: 1, fromStatusId: usedStatus.id, fromAccessScope: 'shared', fromPositionCode: '3-3', note: '清理规则测试库存' },
  })).response.status, 200);
  assert.equal((await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: inventoryAdmin,
    body: { operation: 'dispose', quantity: 1, fromStatusId: unavailableStatus.id, fromAccessScope: 'shared', fromPositionCode: '3-4', note: '清理不可用测试库存' },
  })).response.status, 200);
  const archiveProbeBoxByMember = await request(`/api/inventory-units/${probeBox.payload.unit.id}/status`, {
    method: 'PATCH', session: member, body: { status: 'archived' },
  });
  assert.equal(archiveProbeBoxByMember.response.status, 403);
  const archiveProbeBox = await request(`/api/inventory-units/${probeBox.payload.unit.id}/status`, {
    method: 'PATCH', session: inventoryAdmin, body: { status: 'archived' },
  });
  assert.equal(archiveProbeBox.response.status, 200);
  assert.equal(archiveProbeBox.payload.unit.active, false);
  const archivedProbeQr = await request(`/api/inventory-units?unitId=${probeBox.payload.unit.id}`, { session: member });
  assert.equal(archivedProbeQr.response.status, 200);
  assert.equal(archivedProbeQr.payload.units[0].active, false);
  assert.equal((await request(`/api/inventory-units/${probeBox.payload.unit.id}/operation`, {
    method: 'POST', session: member,
    body: { operation: 'in', quantity: 1, toStatusId: newStatus.id, toAccessScope: 'shared' },
  })).response.status, 409);
  assert.equal((await request(`/api/inventory-units/${probeBox.payload.unit.id}/status`, {
    method: 'PATCH', session: inventoryAdmin, body: { status: 'active' },
  })).response.status, 200);
  const deleteEmptyTrackedMaterial = await request(`/api/materials/${trackedProbe.payload.material.id}`, {
    method: 'DELETE', session: ordinaryAdmin,
  });
  assert.equal(deleteEmptyTrackedMaterial.response.status, 200);
  assert.equal((await request(`/api/inventory-units?unitId=${probeBox.payload.unit.id}`, { session: member })).response.status, 404);
  const eventsAfterTrackedDelete = await request(`/api/inventory-events?materialId=${trackedProbe.payload.material.id}`, { session: inventoryAdmin });
  assert.equal(eventsAfterTrackedDelete.response.status, 200);
  assert.ok(eventsAfterTrackedDelete.payload.total >= trackedEvents.payload.total);

  const statefulFilter = await request('/api/materials', {
    method: 'POST', session: inventoryAdmin,
    body: { name: '可清洗过滤芯', category: '过滤耗材', spec: '可重复使用', unit: '个', safetyStock: 2, trackingMode: 'stateful' },
  });
  assert.equal(statefulFilter.response.status, 201);
  const statefulInventory = await request(`/api/inventory-units?materialId=${statefulFilter.payload.material.id}`, { session: member });
  assert.equal(statefulInventory.payload.units.length, 1);
  assert.equal(statefulInventory.payload.units[0].unitType, 'aggregate');
  const statefulNew = statefulInventory.payload.statuses.find((status) => status.code === 'new');
  const statefulUnavailable = statefulInventory.payload.statuses.find((status) => status.code === 'unavailable');
  const aggregateUnit = statefulInventory.payload.units[0];
  const statefulInbound = await request(`/api/inventory-units/${aggregateUnit.id}/operation`, {
    method: 'POST', session: member,
    body: { operation: 'in', quantity: 4, toStatusId: statefulNew.id, toAccessScope: 'shared', counterparty: '过滤芯入库' },
  });
  assert.equal(statefulInbound.response.status, 200);
  assert.equal(statefulInbound.payload.summary.sharedUsable, 4);
  const occupiedStatusSemanticChange = await request(`/api/inventory-statuses/${statefulNew.id}`, {
    method: 'PATCH', session: inventoryAdmin,
    body: { name: '全新滤芯', usable: false, terminal: true },
  });
  assert.equal(occupiedStatusSemanticChange.response.status, 409);
  assert.match(occupiedStatusSemanticChange.payload.error, /仍有库存/);
  const occupiedStatusRename = await request(`/api/inventory-statuses/${statefulNew.id}`, {
    method: 'PATCH', session: inventoryAdmin,
    body: { name: '未启用', usable: true, terminal: false },
  });
  assert.equal(occupiedStatusRename.response.status, 200);
  assert.equal(occupiedStatusRename.payload.status.name, '未启用');
  assert.equal((await request(`/api/materials/${statefulFilter.payload.material.id}`, {
    method: 'PATCH', session: inventoryAdmin,
    body: { ...statefulFilter.payload.material, trackingMode: 'quantity' },
  })).response.status, 409);
  const statefulUnavailableChange = await request(`/api/inventory-units/${aggregateUnit.id}/operation`, {
    method: 'POST', session: member,
    body: { operation: 'state_change', quantity: 1, fromStatusId: statefulNew.id, fromAccessScope: 'shared', toStatusId: statefulUnavailable.id, note: '达到清洗周期' },
  });
  assert.equal(statefulUnavailableChange.response.status, 200);
  assert.equal(statefulUnavailableChange.payload.summary.total, 4);
  assert.equal(statefulUnavailableChange.payload.summary.sharedUsable, 3);
  assert.equal((await request(`/api/inventory-units/${aggregateUnit.id}/operation`, {
    method: 'POST', session: member,
    body: { operation: 'dispose', quantity: 1, fromStatusId: statefulUnavailable.id, fromAccessScope: 'shared', note: '无法再生' },
  })).response.status, 200);
  assert.equal((await request(`/api/inventory-units/${aggregateUnit.id}/operation`, {
    method: 'POST', session: member,
    body: { operation: 'out', quantity: 3, fromStatusId: statefulNew.id, fromAccessScope: 'shared' },
  })).response.status, 200);
  const filterBase = { name: '可清洗过滤芯', category: '过滤耗材', spec: '可重复使用', unit: '个', safetyStock: 2 };
  assert.equal((await request(`/api/materials/${statefulFilter.payload.material.id}`, {
    method: 'PATCH', session: inventoryAdmin, body: { ...filterBase, trackingMode: 'tracked' },
  })).response.status, 200);
  assert.equal((await request(`/api/materials/${statefulFilter.payload.material.id}`, {
    method: 'PATCH', session: inventoryAdmin, body: { ...filterBase, trackingMode: 'stateful' },
  })).response.status, 200);
  assert.equal((await request(`/api/materials/${statefulFilter.payload.material.id}`, {
    method: 'PATCH', session: inventoryAdmin, body: { ...filterBase, trackingMode: 'quantity' },
  })).response.status, 200);

  const genericTrackedMaterial = await request('/api/materials', {
    method: 'POST', session: inventoryAdmin,
    body: { name: '通用追踪单元验收', category: '测试', spec: '批次与序列', unit: 'L', safetyStock: 0, trackingMode: 'tracked' },
  });
  assert.equal(genericTrackedMaterial.response.status, 201);
  const genericTrackedInventory = await request(`/api/inventory-units?materialId=${genericTrackedMaterial.payload.material.id}`, { session: member });
  const genericNewStatus = genericTrackedInventory.payload.statuses.find((status) => status.code === 'new');
  const trackedLot = await request('/api/inventory-units', {
    method: 'POST', session: member,
    body: {
      materialId: genericTrackedMaterial.payload.material.id, unitType: 'lot', label: 'LOT-20260812',
      capacity: 1.5, quantity: 0.5, statusId: genericNewStatus.id, accessScope: 'shared', counterparty: '批次入库',
    },
  });
  assert.equal(trackedLot.response.status, 201, JSON.stringify(trackedLot.payload));
  assert.equal(trackedLot.payload.unit.unitType, 'lot');
  assert.equal(trackedLot.payload.unit.quantity, 0.5);
  const trackedSerial = await request('/api/inventory-units', {
    method: 'POST', session: member,
    body: {
      materialId: genericTrackedMaterial.payload.material.id, unitType: 'position', label: 'SERIAL-001',
      capacity: 1, quantity: 1, statusId: genericNewStatus.id, accessScope: 'shared', counterparty: '序列单件入库',
    },
  });
  assert.equal(trackedSerial.response.status, 201, JSON.stringify(trackedSerial.payload));
  assert.equal(trackedSerial.payload.unit.unitType, 'position');
  assert.equal(trackedSerial.payload.summary.total, 1.5);
  assert.equal((await request('/api/inventory-units', {
    method: 'POST', session: member,
    body: {
      materialId: genericTrackedMaterial.payload.material.id, unitType: 'position', label: 'SERIAL-001',
      capacity: 1, quantity: 1, statusId: genericNewStatus.id, accessScope: 'shared',
    },
  })).response.status, 409);
  assert.equal((await request(`/api/inventory-units/${trackedLot.payload.unit.id}/operation`, {
    method: 'POST', session: member,
    body: { operation: 'out', quantity: 0.5, fromStatusId: genericNewStatus.id, fromAccessScope: 'shared' },
  })).response.status, 200);
  assert.equal((await request(`/api/inventory-units/${trackedSerial.payload.unit.id}/operation`, {
    method: 'POST', session: member,
    body: { operation: 'out', quantity: 1, fromStatusId: genericNewStatus.id, fromAccessScope: 'shared' },
  })).response.status, 200);
  assert.equal((await request(`/api/materials/${genericTrackedMaterial.payload.material.id}`, {
    method: 'DELETE', session: ordinaryAdmin,
  })).response.status, 200);

  const archiveByInventoryAdmin = await request(`/api/materials/${zeroStockMaterial.payload.material.id}/status`, {
    method: 'PATCH', session: inventoryAdmin, body: { status: 'archived' },
  });
  assert.equal(archiveByInventoryAdmin.response.status, 200);
  assert.equal(archiveByInventoryAdmin.payload.material.active, false);
  const archivedTransaction = await request('/api/transactions', {
    method: 'POST', session: member,
    body: { type: 'in', materialId: zeroStockMaterial.payload.material.id, quantity: 1 },
  });
  assert.equal(archivedTransaction.response.status, 409);
  assert.match(archivedTransaction.payload.error, /归档/);
  const archivedImport = await request('/api/import', {
    method: 'POST', session: inventoryAdmin,
    body: { rows: [{ name: zeroStockMaterial.payload.material.name, category: '化学试剂', quantity: 1, unit: '瓶' }] },
  });
  assert.equal(archivedImport.response.status, 409);
  const memberAfterArchive = await request('/api/bootstrap', { session: member });
  assert.equal(memberAfterArchive.payload.materials.some((material) => material.id === zeroStockMaterial.payload.material.id), false);
  const restoreByInventoryAdmin = await request(`/api/materials/${zeroStockMaterial.payload.material.id}/status`, {
    method: 'PATCH', session: inventoryAdmin, body: { status: 'active' },
  });
  assert.equal(restoreByInventoryAdmin.response.status, 200);
  const archiveForDelete = await request(`/api/materials/${zeroStockMaterial.payload.material.id}/status`, {
    method: 'PATCH', session: inventoryAdmin, body: { status: 'archived' },
  });
  assert.equal(archiveForDelete.response.status, 200);
  const forbiddenPermanentDelete = await request(`/api/materials/${zeroStockMaterial.payload.material.id}`, { method: 'DELETE', session: inventoryAdmin });
  assert.equal(forbiddenPermanentDelete.response.status, 403);
  const permanentDelete = await request(`/api/materials/${zeroStockMaterial.payload.material.id}`, { method: 'DELETE', session: ordinaryAdmin });
  assert.equal(permanentDelete.response.status, 200);
  const afterPermanentDelete = await request('/api/bootstrap', { session: ordinaryAdmin });
  assert.equal(afterPermanentDelete.payload.materials.some((material) => material.id === zeroStockMaterial.payload.material.id), false);
  const historicalMaterial = await request('/api/transactions', {
    method: 'POST', session: member,
    body: { type: 'in', materialName: '待删除历史耗材', quantity: 2, unit: '件', category: '测试', safetyStock: 0 },
  });
  assert.equal(historicalMaterial.response.status, 201);
  assert.equal((await request('/api/transactions', {
    method: 'POST', session: member,
    body: { type: 'out', materialId: historicalMaterial.payload.material.id, quantity: 2, counterparty: '删除保留流水测试' },
  })).response.status, 201);
  assert.equal((await request(`/api/materials/${historicalMaterial.payload.material.id}`, {
    method: 'DELETE', session: ordinaryAdmin,
  })).response.status, 200);
  const afterHistoricalDelete = await request('/api/bootstrap', { session: ordinaryAdmin });
  assert.equal(afterHistoricalDelete.payload.materials.some((material) => material.id === historicalMaterial.payload.material.id), false);
  assert.equal(afterHistoricalDelete.payload.transactions.filter((record) => record.materialId === historicalMaterial.payload.material.id).length, 2);
  assert.equal((await request('/api/import', {
    method: 'POST', session: inventoryAdmin,
    body: { rows: [{ name: '库存管理员创建的耗材', category: '测试', quantity: 3, safetyStock: 2, unit: '件', spec: 'A 型' }] },
  })).response.status, 200);
  const stockedDelete = await request(`/api/materials/${inventoryMaterial.payload.material.id}`, { method: 'DELETE', session: ordinaryAdmin });
  assert.equal(stockedDelete.response.status, 409);
  assert.match(stockedDelete.payload.error, /仍有库存/);

  const transferTarget = await request('/api/users', {
    method: 'POST', session: admin,
    body: { username: 'owner_successor', name: '第二位老师', password: 'ownerpass8', role: 'admin', groupId: adminBootstrap.payload.groups[0].id },
  });
  assert.equal(transferTarget.response.status, 201);
  assert.equal(transferTarget.payload.user.role, 'admin');
  assert.equal((await request(`/api/users/${transferTarget.payload.user.id}/reset-password`, {
    method: 'POST', session: ordinaryAdmin, body: { newPassword: 'forbidden9' },
  })).response.status, 403);

  const renamedOwner = await request(`/api/users/${adminBootstrap.payload.user.id}`, {
    method: 'PATCH', session: admin,
    body: { username: 'admin_primary', name: '林小满', role: 'admin', groupId: adminBootstrap.payload.groups[0].id },
  });
  assert.equal(renamedOwner.response.status, 200);
  assert.equal(renamedOwner.payload.user.username, 'admin_primary');
  assert.equal(renamedOwner.payload.user.isOwner, true);
  const selfDemotion = await request(`/api/users/${adminBootstrap.payload.user.id}`, {
    method: 'PATCH', session: admin,
    body: { username: 'admin_primary', name: '林小满', role: 'member', groupId: adminBootstrap.payload.groups[0].id },
  });
  assert.equal(selfDemotion.response.status, 400);
  const oldUserSession = await login('api_test_new', 'oldpass1');
  const reset = await request(`/api/users/${createdUser.payload.user.id}/reset-password`, { method: 'POST', session: admin, body: { newPassword: 'newpass1' } });
  assert.equal(reset.response.status, 200);
  const expiredSession = await request('/api/bootstrap', { session: oldUserSession });
  assert.equal(expiredSession.response.status, 401);
  const passwordOwner = await login('api_test_new', 'newpass1');
  const otherDevice = await login('api_test_new', 'newpass1');
  const changedPassword = await request('/api/password', {
    method: 'POST', session: passwordOwner, body: { currentPassword: 'newpass1', newPassword: 'newpass2' },
  });
  assert.equal(changedPassword.response.status, 200);
  assert.equal((await request('/api/bootstrap', { session: passwordOwner })).response.status, 200);
  assert.equal((await request('/api/bootstrap', { session: otherDevice })).response.status, 401);
  assert.equal((await request('/api/login', { method: 'POST', body: { username: 'api_test_new', password: 'newpass1' } })).response.status, 401);
  await login('api_test_new', 'newpass2');

  const disabled = await request(`/api/users/${createdUser.payload.user.id}/status`, { method: 'PATCH', session: admin, body: { active: false } });
  assert.equal(disabled.payload.user.active, false);
  const disabledLogin = await request('/api/login', { method: 'POST', body: { username: 'api_test_new', password: 'newpass2' }, session: { cookie: '' } });
  assert.equal(disabledLogin.response.status, 401);
  const enabled = await request(`/api/users/${createdUser.payload.user.id}/status`, { method: 'PATCH', session: admin, body: { active: true } });
  assert.equal(enabled.payload.user.active, true);

  const selfDelete = await request(`/api/users/${adminBootstrap.payload.user.id}`, { method: 'DELETE', session: admin });
  assert.equal(selfDelete.response.status, 403);
  const deleted = await request(`/api/users/${createdUser.payload.user.id}`, { method: 'DELETE', session: admin });
  assert.equal(deleted.response.status, 200);
  const deletedInventoryAdmin = await request(`/api/users/${inventoryAccount.payload.user.id}`, { method: 'DELETE', session: admin });
  assert.equal(deletedInventoryAdmin.response.status, 200);
  const deletedTag = await request(`/api/tags/${createdTag.payload.tag.id}`, { method: 'DELETE', session: admin });
  assert.equal(deletedTag.response.status, 200);
  const deletedGroup = await request(`/api/groups/${createdGroup.payload.group.id}`, { method: 'DELETE', session: admin });
  assert.equal(deletedGroup.response.status, 200);
  const afterOrganizationCleanup = await request('/api/bootstrap', { session: admin });
  const afterOrganizationCleanupTransactions = await request('/api/transactions', { session: admin });
  assert.equal(afterOrganizationCleanup.payload.tags.some((tag) => tag.id === createdTag.payload.tag.id), false);
  assert.equal(afterOrganizationCleanupTransactions.payload.transactions.find((record) => record.note === '组织分组统计测试').groupName, '器件测试组');

  const successorSession = await login('owner_successor', 'ownerpass8');
  const wrongTransferPassword = await request('/api/owner/transfer', {
    method: 'POST', session: admin,
    body: { targetUserId: transferTarget.payload.user.id, currentPassword: 'wrong-password' },
  });
  assert.equal(wrongTransferPassword.response.status, 400);
  const transferred = await request('/api/owner/transfer', {
    method: 'POST', session: admin,
    body: { targetUserId: transferTarget.payload.user.id, currentPassword: 'admin123' },
  });
  assert.equal(transferred.response.status, 200);
  assert.equal(transferred.payload.owner.isOwner, true);
  assert.equal(transferred.payload.user.isOwner, false);
  assert.equal((await request('/api/bootstrap', { session: admin })).payload.user.isOwner, false);
  assert.equal((await request('/api/bootstrap', { session: successorSession })).payload.user.isOwner, true);
  assert.equal((await request('/api/users', {
    method: 'POST', session: admin,
    body: { username: 'old_owner_admin', name: '不应创建', password: 'password8', role: 'admin' },
  })).response.status, 403);

  const resetOwner = await runNodeScript('scripts/reset-owner-password.mjs', { DATA_DIR: dataDir });
  assert.equal(resetOwner.exitCode, 0, resetOwner.stderr);
  const temporaryPassword = resetOwner.stdout.match(/临时密码：(\S+)/)?.[1];
  assert.ok(temporaryPassword, resetOwner.stdout);
  assert.equal((await request('/api/bootstrap', { session: successorSession })).response.status, 401);
  assert.equal((await request('/api/login', {
    method: 'POST', body: { username: 'owner_successor', password: 'ownerpass8' },
  })).response.status, 401);
  const recoveredOwner = await login('owner_successor', temporaryPassword);
  assert.equal((await request('/api/bootstrap', { session: recoveredOwner })).payload.user.isOwner, true);
  const createdByRecoveredOwner = await request('/api/users', {
    method: 'POST', session: recoveredOwner,
    body: { username: 'second_system_admin', name: '另一位老师', password: 'password8', role: 'admin', groupId: adminBootstrap.payload.groups[0].id },
  });
  assert.equal(createdByRecoveredOwner.response.status, 201);

  const nonOwnerBackup = await fetch(`${baseUrl}/api/admin/database-backup`, { headers: { Cookie: admin.cookie } });
  assert.equal(nonOwnerBackup.status, 403);
  const backupResponse = await fetch(`${baseUrl}/api/admin/database-backup`, { headers: { Cookie: recoveredOwner.cookie } });
  assert.equal(backupResponse.status, 200);
  assert.match(backupResponse.headers.get('content-disposition') ?? '', /OpenLabStock-database-.*\.sqlite/);
  const backupBody = Buffer.from(await backupResponse.arrayBuffer());
  assert.equal(backupBody.subarray(0, 16).toString('ascii'), 'SQLite format 3\0');
  const downloadedBackupPath = path.join(dataDir, 'downloaded-test-backup.sqlite');
  await writeFile(downloadedBackupPath, backupBody);
  const downloadedBackup = new DatabaseSync(downloadedBackupPath, { readOnly: true });
  try {
    assert.equal(downloadedBackup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.ok(downloadedBackup.prepare('SELECT COUNT(*) AS count FROM materials').get().count >= 1);
  } finally {
    downloadedBackup.close();
  }

  const wrongRestorePassword = await request('/api/admin/database-restore/authorize', {
    method: 'POST', session: recoveredOwner, body: { currentPassword: 'wrong-password' },
  });
  assert.equal(wrongRestorePassword.response.status, 400);
  const invalidAuthorization = await request('/api/admin/database-restore/authorize', {
    method: 'POST', session: recoveredOwner, body: { currentPassword: temporaryPassword },
  });
  assert.equal(invalidAuthorization.response.status, 200);
  const invalidRestore = await fetch(`${baseUrl}/api/admin/database-restore`, {
    method: 'POST',
    headers: {
      Cookie: recoveredOwner.cookie,
      'Content-Type': 'application/vnd.sqlite3',
      'X-OpenLabStock-Restore-Token': invalidAuthorization.payload.token,
    },
    body: Buffer.from('not a sqlite database'),
  });
  assert.equal(invalidRestore.status, 400);
  assert.equal((await request('/api/bootstrap', { session: recoveredOwner })).response.status, 200);

  const postBackupMaterial = await request('/api/materials', {
    method: 'POST', session: recoveredOwner,
    body: { name: '恢复后应消失的测试耗材', category: '恢复测试', unit: '件', safetyStock: 0 },
  });
  assert.equal(postBackupMaterial.response.status, 201);
  await stopServer(secondChild);
  secondChild = null;
  const restoreAuthorization = await request('/api/admin/database-restore/authorize', {
    method: 'POST', session: recoveredOwner, body: { currentPassword: temporaryPassword },
  });
  assert.equal(restoreAuthorization.response.status, 200);
  const restoreResponse = await fetch(`${baseUrl}/api/admin/database-restore`, {
    method: 'POST',
    headers: {
      Cookie: recoveredOwner.cookie,
      'Content-Type': 'application/vnd.sqlite3',
      'X-OpenLabStock-Restore-Token': restoreAuthorization.payload.token,
    },
    body: backupBody,
  });
  const restorePayload = await restoreResponse.json();
  assert.equal(restoreResponse.status, 200, JSON.stringify(restorePayload));
  assert.equal(restorePayload.ok, true);
  assert.equal((await request('/api/bootstrap', { session: recoveredOwner })).response.status, 401);
  const ownerAfterRestore = await login('owner_successor', temporaryPassword);
  const afterRestore = await request('/api/bootstrap', { session: ownerAfterRestore });
  assert.equal(afterRestore.payload.materials.some((material) => material.name === '恢复后应消失的测试耗材'), false);
  assert.ok((await readdir(path.join(dataDir, 'backups'))).some((name) => name.startsWith('pre-restore-') && name.endsWith('.sqlite')));

  const database = new DatabaseSync(path.join(dataDir, 'labstock.sqlite'), { readOnly: true });
  try {
    assert.ok(database.prepare('SELECT COUNT(*) AS count FROM transactions').get().count >= 17);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users WHERE username = 'api_test_new'").get().count, 0);
    assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'owner_user_id'").get().value, transferTarget.payload.user.id);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users WHERE id = ? AND role = 'admin'").get(transferTarget.payload.user.id).count, 1);
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    database.close();
  }
});

test('旧角色约束会自动迁移并保留所有者与账号数据', async () => {
  const legacyDataDir = await mkdtemp(path.join(os.tmpdir(), 'labstock-schema-v1-'));
  const origin = `http://127.0.0.1:${await freePort()}`;
  const databasePath = path.join(legacyDataDir, 'labstock.sqlite');
  const database = new DatabaseSync(databasePath);
  const ownerId = 'legacy-owner-id';
  const groupId = 'legacy-group-id';
  const credentials = hashPassword('legacy-pass8');
  let legacyServer;
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), app_name TEXT NOT NULL, lab_name TEXT NOT NULL, brand_icon TEXT NOT NULL DEFAULT '') STRICT;
      CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, is_default INTEGER NOT NULL CHECK (is_default IN (0, 1))) STRICT;
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        last_login_at TEXT
      ) STRICT;
    `);
    database.prepare("INSERT INTO metadata (key, value) VALUES ('initialized', ?), ('schema_version', '1'), ('owner_user_id', ?)")
      .run(new Date().toISOString(), ownerId);
    database.prepare('INSERT INTO settings (id, app_name, lab_name, brand_icon) VALUES (1, ?, ?, ?)')
      .run('旧版自定义名称', '旧数据库迁移测试', '');
    database.prepare('INSERT INTO groups (id, name, is_default) VALUES (?, ?, 1)').run(groupId, '默认组');
    database.prepare('INSERT INTO users (id, username, name, role, group_id, active, salt, password_hash, last_login_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL)')
      .run(ownerId, 'legacy_admin', '旧系统所有者', 'admin', groupId, credentials.salt, credentials.passwordHash);
    database.close();

    legacyServer = await startServer(origin, legacyDataDir);
    const legacyOwner = await login('legacy_admin', 'legacy-pass8', origin);
    const bootstrap = await request('/api/bootstrap', { session: legacyOwner, origin });
    assert.equal(bootstrap.payload.user.id, ownerId);
    assert.equal(bootstrap.payload.user.isOwner, true);
    const inventoryUser = await request('/api/users', {
      method: 'POST', session: legacyOwner, origin,
      body: { username: 'migrated_inventory', name: '迁移后库存管理员', password: 'password8', role: 'inventory', groupId },
    });
    assert.equal(inventoryUser.response.status, 201);

    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.match(migrated.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().sql, /'inventory'/);
         assert.equal(migrated.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, '14');
         assert.equal(migrated.prepare('SELECT app_name FROM settings WHERE id = 1').get().app_name, '旧版自定义名称');
        assert.ok(migrated.prepare('PRAGMA table_info(materials)').all().some((column) => column.name === 'active'));
        const migratedMaterialColumns = new Set(migrated.prepare('PRAGMA table_info(materials)').all().map((column) => column.name));
        assert.ok(migratedMaterialColumns.has('position_code_help'));
        assert.ok(migratedMaterialColumns.has('usage_context_help'));
        assert.ok(migrated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('tags', 'user_tags')").get().count === 2);
        assert.equal(
          migrated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('inventory_statuses', 'inventory_units', 'inventory_unit_balances', 'inventory_events')").get().count,
          4,
        );
        assert.ok(migrated.prepare('PRAGMA table_info(inventory_unit_balances)').all().some((column) => column.name === 'position_code'));
        assert.ok(migrated.prepare('PRAGMA table_info(inventory_events)').all().some((column) => column.name === 'from_position_code'));
      assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'audit_logs'").get().count, 1);
      const transactionColumns = new Set(migrated.prepare('PRAGMA table_info(transactions)').all().map((column) => column.name));
      assert.ok(['group_id', 'group_name', 'source_type', 'position_code', 'correction_of_id'].every((column) => transactionColumns.has(column)));
      assert.ok(migrated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'transactions_one_correction'").get().count === 1);
      assert.equal(migrated.prepare("SELECT value FROM metadata WHERE key = 'owner_user_id'").get().value, ownerId);
      assert.equal(migrated.prepare("SELECT role FROM users WHERE username = 'migrated_inventory'").get().role, 'inventory');
      assert.equal(migrated.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally {
      migrated.close();
    }
  } finally {
    try { database.close(); } catch {}
    await stopServer(legacyServer);
    await rm(legacyDataDir, { recursive: true, force: true });
  }
});

test('版本 12 数据库会直接迁移到版本 14 并开始记录系统审计', async () => {
  const version12DataDir = await mkdtemp(path.join(os.tmpdir(), 'labstock-schema-v12-audit-'));
  const origin = `http://127.0.0.1:${await freePort()}`;
  const databasePath = path.join(version12DataDir, 'labstock.sqlite');
  let version12Server;
  let database;
  try {
    version12Server = await startServer(origin, version12DataDir);
    await stopServer(version12Server);
    version12Server = null;

    database = new DatabaseSync(databasePath);
    const materialCountBefore = database.prepare('SELECT COUNT(*) AS count FROM materials').get().count;
    database.exec('DROP TABLE audit_logs');
    database.prepare("UPDATE metadata SET value = '12' WHERE key = 'schema_version'").run();
    database.close();
    database = null;

    version12Server = await startServer(origin, version12DataDir);
    const owner = await login('admin', 'admin123', origin);
    const settingsUpdate = await request('/api/settings', {
      method: 'PATCH', session: owner, origin,
      body: { appName: 'OpenLabStock', labName: '版本 12 升级验证', brandIcon: '' },
    });
    assert.equal(settingsUpdate.response.status, 200, JSON.stringify(settingsUpdate.payload));
    const audit = await request('/api/audit-logs', { session: owner, origin });
    assert.equal(audit.response.status, 200, JSON.stringify(audit.payload));
    assert.equal(audit.payload.total, 1);
    assert.equal(audit.payload.items[0].action, 'settings.update');

    database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, '14');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM materials').get().count, materialCountBefore);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'audit_logs'").get().count, 1);
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    try { database?.close(); } catch {}
    await stopServer(version12Server);
    await rm(version12DataDir, { recursive: true, force: true });
  }
});

test('版本 8 库存事件会自动迁移并保留历史事实', async () => {
  const legacyDataDir = await mkdtemp(path.join(os.tmpdir(), 'labstock-schema-v8-events-'));
  const origin = `http://127.0.0.1:${await freePort()}`;
  const databasePath = path.join(legacyDataDir, 'labstock.sqlite');
  const legacyEventId = 'legacy-inventory-event-v8';
  let legacyServer;
  let database;
  try {
    legacyServer = await startServer(origin, legacyDataDir);
    await stopServer(legacyServer);
    legacyServer = null;

    database = new DatabaseSync(databasePath);
    const owner = database.prepare("SELECT users.id, users.name, users.group_id, groups.name AS group_name FROM users JOIN groups ON groups.id = users.group_id WHERE users.username = 'admin'").get();
    database.exec(`
      DROP TABLE inventory_events;
      CREATE TABLE inventory_events (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL,
        material_name TEXT NOT NULL,
        inventory_unit_id TEXT NOT NULL,
        inventory_unit_label TEXT NOT NULL DEFAULT '',
        quantity REAL NOT NULL CHECK (quantity > 0),
        event_type TEXT NOT NULL CHECK (event_type IN ('state_change', 'access_change', 'transfer', 'dispose', 'adjustment')),
        from_status_id TEXT NOT NULL DEFAULT '',
        from_status_name TEXT NOT NULL DEFAULT '',
        to_status_id TEXT NOT NULL DEFAULT '',
        to_status_name TEXT NOT NULL DEFAULT '',
        from_access_scope TEXT NOT NULL DEFAULT '',
        from_owner_user_id TEXT NOT NULL DEFAULT '',
        from_owner_name TEXT NOT NULL DEFAULT '',
        from_position_code TEXT NOT NULL DEFAULT '',
        to_access_scope TEXT NOT NULL DEFAULT '',
        to_owner_user_id TEXT NOT NULL DEFAULT '',
        to_owner_name TEXT NOT NULL DEFAULT '',
        to_position_code TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        group_id TEXT NOT NULL DEFAULT '',
        group_name TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        occurred_at TEXT NOT NULL
      ) STRICT;
    `);
    database.prepare(`
      INSERT INTO inventory_events (
        id, material_id, material_name, inventory_unit_id, inventory_unit_label, quantity, event_type,
        from_status_id, from_status_name, to_status_id, to_status_name,
        from_access_scope, from_owner_user_id, from_owner_name, from_position_code,
        to_access_scope, to_owner_user_id, to_owner_name, to_position_code,
        user_id, user_name, group_id, group_name, note, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      legacyEventId, 'legacy-material', '旧探针', 'legacy-unit', '旧探针盒-1-1', 1, 'state_change',
      'new-status', '全新', 'active-status', '已启用', 'shared', '', '', '1-1', 'shared', '', '', '1-1',
      owner.id, owner.name, owner.group_id, owner.group_name, '迁移前历史状态事件', '2026-08-11T08:00:00.000Z',
    );
    database.prepare("UPDATE metadata SET value = '8' WHERE key = 'schema_version'").run();
    database.close();
    database = null;

    legacyServer = await startServer(origin, legacyDataDir);
    const legacyOwner = await login('admin', 'admin123', origin);
    const events = await request('/api/inventory-events?materialId=legacy-material', { session: legacyOwner, origin });
    assert.equal(events.response.status, 200);
    assert.equal(events.payload.total, 1);
    assert.equal(events.payload.events[0].id, legacyEventId);
    assert.equal(events.payload.events[0].note, '迁移前历史状态事件');
    assert.equal(events.payload.events[0].counterparty, '');
    assert.equal(events.payload.events[0].correctionOfId, '');

    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(migrated.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, '14');
      assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'audit_logs'").get().count, 1);
      assert.match(migrated.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'transactions_occurred_at'").get().sql, /occurred_at DESC, id DESC/);
      assert.match(migrated.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'inventory_events_occurred_at'").get().sql, /occurred_at DESC, id DESC/);
      const eventColumns = new Set(migrated.prepare('PRAGMA table_info(inventory_events)').all().map((column) => column.name));
      assert.ok(eventColumns.has('counterparty'));
      assert.ok(eventColumns.has('correction_of_id'));
      assert.match(migrated.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inventory_events'").get().sql, /'use'/);
      assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM inventory_events WHERE id = ?').get(legacyEventId).count, 1);
      assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'inventory_events_one_correction'").get().count, 1);
      assert.equal(migrated.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally {
      migrated.close();
    }
  } finally {
    try { database?.close(); } catch {}
    await stopServer(legacyServer);
    await rm(legacyDataDir, { recursive: true, force: true });
  }
});

test('只有系统管理员可以检测并修复旧库存位置冲突，且保留审计历史', async () => {
  const anomalyDataDir = await mkdtemp(path.join(os.tmpdir(), 'labstock-anomaly-'));
  const origin = `http://127.0.0.1:${await freePort()}`;
  let anomalyServer;
  let database;
  try {
    anomalyServer = await startServer(origin, anomalyDataDir);
    const owner = await login('admin', 'admin123', origin);
    const member = await login('student', 'demo123', origin);
    const ownerBootstrap = await request('/api/bootstrap', { session: owner, origin });
    const material = await request('/api/materials', {
      method: 'POST', session: owner, origin,
      body: { name: '旧位置异常探针', category: '探针', spec: '10 根 / 盒', unit: '根', safetyStock: 0, trackingMode: 'tracked' },
    });
    assert.equal(material.response.status, 201, JSON.stringify(material.payload));
    const inventory = await request(`/api/inventory-units?materialId=${material.payload.material.id}`, { session: owner, origin });
    const newStatus = inventory.payload.statuses.find((status) => status.code === 'new');
    const activeStatus = inventory.payload.statuses.find((status) => status.code === 'active');
    const unit = await request('/api/inventory-units', {
      method: 'POST', session: owner, origin,
      body: {
        materialId: material.payload.material.id,
        unitType: 'container', label: '异常盒-1', capacity: 10,
        balances: [
          { statusId: newStatus.id, accessScope: 'shared', quantity: 1, positionCode: '2-2' },
          { statusId: activeStatus.id, accessScope: 'shared', quantity: 1, positionCode: '2-3' },
          { statusId: activeStatus.id, accessScope: 'shared', quantity: 1, positionCode: '2-4' },
        ],
      },
    });
    assert.equal(unit.response.status, 201, JSON.stringify(unit.payload));
    await stopServer(anomalyServer);
    anomalyServer = null;

    database = new DatabaseSync(path.join(anomalyDataDir, 'labstock.sqlite'));
    database.prepare(`
      UPDATE inventory_unit_balances SET position_code = '2-2'
      WHERE inventory_unit_id = ? AND status_id = ? AND position_code = '2-3'
    `).run(unit.payload.unit.id, activeStatus.id);
    database.close();
    database = null;

    anomalyServer = await startServer(origin, anomalyDataDir);
    const refreshedOwner = await login('admin', 'admin123', origin);
    const refreshedMember = await login('student', 'demo123', origin);
    assert.equal((await request(`/api/inventory-anomalies?materialId=${material.payload.material.id}`, { session: refreshedMember, origin })).response.status, 403);

    const secondAdmin = await request('/api/users', {
      method: 'POST', session: refreshedOwner, origin,
      body: { username: 'anomaly_admin', name: '异常管理员', password: 'anomaly88', role: 'admin', groupId: ownerBootstrap.payload.groups[0].id },
    });
    assert.equal(secondAdmin.response.status, 201, JSON.stringify(secondAdmin.payload));
    const inventoryAccount = await request('/api/users', {
      method: 'POST', session: refreshedOwner, origin,
      body: { username: 'anomaly_inventory', name: '异常库存员', password: 'inventory88', role: 'inventory', groupId: ownerBootstrap.payload.groups[0].id },
    });
    assert.equal(inventoryAccount.response.status, 201, JSON.stringify(inventoryAccount.payload));
    const systemAdmin = await login('anomaly_admin', 'anomaly88', origin);
    const inventoryAdmin = await login('anomaly_inventory', 'inventory88', origin);
    assert.equal((await request(`/api/inventory-anomalies?materialId=${material.payload.material.id}`, { session: inventoryAdmin, origin })).response.status, 403);

    const detected = await request(`/api/inventory-anomalies?materialId=${material.payload.material.id}`, { session: systemAdmin, origin });
    assert.equal(detected.response.status, 200, JSON.stringify(detected.payload));
    assert.equal(detected.payload.total, 1);
    assert.equal(detected.payload.anomalies[0].positionCode, '2-2');
    assert.equal(detected.payload.anomalies[0].entries.length, 2);
    const source = detected.payload.anomalies[0].entries.find((entry) => entry.statusId === activeStatus.id);
    const repairBody = {
      inventoryUnitId: unit.payload.unit.id,
      fromStatusId: source.statusId,
      fromAccessScope: source.accessScope,
      fromOwnerUserId: source.ownerUserId,
      fromPositionCode: '2-2',
      toPositionCode: '2-3',
      reason: '核对实物后确认已启用探针实际位于 2-3',
    };
    assert.equal((await request('/api/inventory-anomalies/position/resolve', { method: 'POST', session: inventoryAdmin, origin, body: repairBody })).response.status, 403);

    const occupied = await request('/api/inventory-anomalies/position/resolve', {
      method: 'POST', session: systemAdmin, origin, body: { ...repairBody, toPositionCode: '2-4' },
    });
    assert.equal(occupied.response.status, 409);
    assert.match(occupied.payload.error, /已经.*占用/);

    const concurrentRepairs = await Promise.all([
      request('/api/inventory-anomalies/position/resolve', { method: 'POST', session: systemAdmin, origin, body: repairBody }),
      request('/api/inventory-anomalies/position/resolve', { method: 'POST', session: systemAdmin, origin, body: repairBody }),
    ]);
    assert.deepEqual(concurrentRepairs.map((result) => result.response.status).sort(), [200, 409]);
    const repaired = concurrentRepairs.find((result) => result.response.status === 200);
    assert.equal(repaired.response.status, 200, JSON.stringify(repaired.payload));
    assert.equal(repaired.payload.remainingAnomalies, 0);
    assert.equal(repaired.payload.event.eventType, 'adjustment');
    assert.match(repaired.payload.event.note, /核对实物/);
    assert.equal(repaired.payload.event.fromPositionCode, '2-2');
    assert.equal(repaired.payload.event.toPositionCode, '2-3');
    assert.equal((await request('/api/inventory-anomalies/position/resolve', { method: 'POST', session: systemAdmin, origin, body: repairBody })).response.status, 409);

    const after = await request(`/api/inventory-units?unitId=${unit.payload.unit.id}`, { session: refreshedMember, origin });
    assert.equal(after.payload.units[0].balances.filter((balance) => balance.positionCode === '2-2').length, 1);
    assert.equal(after.payload.units[0].balances.filter((balance) => balance.positionCode === '2-3').length, 1);
    assert.equal(after.payload.units[0].balances.filter((balance) => balance.positionCode === '2-4').length, 1);
    const events = await request(`/api/inventory-events?materialId=${material.payload.material.id}`, { session: systemAdmin, origin });
    assert.ok(events.payload.events.some((event) => event.id === repaired.payload.event.id));
    assert.equal((await request(`/api/inventory-anomalies?materialId=${material.payload.material.id}`, { session: systemAdmin, origin })).payload.total, 0);
  } finally {
    try { database?.close(); } catch {}
    await stopServer(anomalyServer);
    await rm(anomalyDataDir, { recursive: true, force: true });
  }
});

test('盘点任务按批次复核普通库存差异，并要求追踪库存先逐单元纠正', async () => {
  const stocktakeDataDir = await mkdtemp(path.join(os.tmpdir(), 'labstock-stocktake-'));
  const origin = `http://127.0.0.1:${await freePort()}`;
  let stocktakeServer;
  try {
    stocktakeServer = await startServer(origin, stocktakeDataDir);
    const owner = await login('admin', 'admin123', origin);
    const member = await login('student', 'demo123', origin);
    const category = `盘点验收-${Date.now()}`;

    assert.equal((await request('/api/stocktakes', { session: member, origin })).response.status, 403);
    assert.equal((await request('/api/stocktakes', {
      method: 'POST', session: member, origin, body: { title: '越权盘点', category },
    })).response.status, 403);

    const ordinaryInbound = await request('/api/transactions', {
      method: 'POST', session: owner, origin,
      body: { type: 'in', materialName: '盘点验收滤膜', quantity: 10, unit: '盒', category, safetyStock: 0 },
    });
    assert.equal(ordinaryInbound.response.status, 201, JSON.stringify(ordinaryInbound.payload));
    const ordinaryMaterialId = ordinaryInbound.payload.material.id;

    assert.equal((await request('/api/stocktakes', {
      method: 'POST', session: owner, origin,
      body: { title: '无效单项耗材', materialId: 'missing-material' },
    })).response.status, 404);
    assert.equal((await request('/api/stocktakes', {
      method: 'POST', session: owner, origin,
      body: { title: '冲突盘点范围', category, materialId: ordinaryMaterialId },
    })).response.status, 400);
    const singleMaterialBatch = await request('/api/stocktakes', {
      method: 'POST', session: owner, origin,
      body: { title: '单项耗材抽盘', materialId: ordinaryMaterialId },
    });
    assert.equal(singleMaterialBatch.response.status, 201, JSON.stringify(singleMaterialBatch.payload));
    assert.equal(singleMaterialBatch.payload.stocktake.itemCount, 1);
    assert.equal(singleMaterialBatch.payload.stocktake.items[0].materialId, ordinaryMaterialId);
    assert.equal((await request(`/api/stocktakes/${singleMaterialBatch.payload.stocktake.id}/cancel`, {
      method: 'POST', session: owner, origin, body: { reason: '单项抽盘接口验收完成' },
    })).response.status, 200);

    const firstBatch = await request('/api/stocktakes', {
      method: 'POST', session: owner, origin, body: { title: '普通耗材并发复核', category },
    });
    assert.equal(firstBatch.response.status, 201, JSON.stringify(firstBatch.payload));
    assert.equal(firstBatch.payload.stocktake.itemCount, 1);
    const firstItem = firstBatch.payload.stocktake.items[0];
    assert.equal(firstItem.expectedQuantity, 10);

    assert.equal((await request('/api/stocktakes', {
      method: 'POST', session: owner, origin, body: { title: '重复范围', category },
    })).response.status, 409);
    assert.equal((await request(`/api/stocktakes/${firstBatch.payload.stocktake.id}/items/${firstItem.id}`, {
      method: 'PATCH', session: owner, origin, body: {},
    })).response.status, 400);
    assert.equal((await request(`/api/stocktakes/${firstBatch.payload.stocktake.id}/items/${firstItem.id}`, {
      method: 'PATCH', session: owner, origin, body: { countedQuantity: 8 },
    })).response.status, 400);
    assert.equal((await request(`/api/stocktakes/${firstBatch.payload.stocktake.id}/items/${firstItem.id}`, {
      method: 'PATCH', session: owner, origin,
      body: { countedQuantity: 8, reason: '现场少两盒', resolutionNote: '复核领用记录' },
    })).response.status, 200);

    assert.equal((await request('/api/transactions', {
      method: 'POST', session: member, origin,
      body: { type: 'in', materialId: ordinaryMaterialId, quantity: 1, note: '盘点期间到货' },
    })).response.status, 201);
    const staleCompletion = await request(`/api/stocktakes/${firstBatch.payload.stocktake.id}/complete`, {
      method: 'POST', session: owner, origin, body: {},
    });
    assert.equal(staleCompletion.response.status, 409);
    assert.match(staleCompletion.payload.error, /盘点期间库存已从 10 变为 11/);
    assert.equal((await request(`/api/stocktakes/${firstBatch.payload.stocktake.id}/cancel`, {
      method: 'POST', session: owner, origin, body: {},
    })).response.status, 400);
    const cancelled = await request(`/api/stocktakes/${firstBatch.payload.stocktake.id}/cancel`, {
      method: 'POST', session: owner, origin, body: { reason: '盘点期间发生入库，重新建立快照' },
    });
    assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.payload));
    assert.equal(cancelled.payload.stocktake.status, 'cancelled');
    assert.equal(cancelled.payload.stocktake.cancellationReason, '盘点期间发生入库，重新建立快照');
    assert.equal((await request(`/api/stocktakes/${firstBatch.payload.stocktake.id}/cancel`, {
      method: 'POST', session: owner, origin, body: { reason: '重复取消' },
    })).response.status, 409);

    const freshBatch = await request('/api/stocktakes', {
      method: 'POST', session: owner, origin, body: { title: '普通耗材差异调整', category },
    });
    assert.equal(freshBatch.response.status, 201, JSON.stringify(freshBatch.payload));
    const freshItem = freshBatch.payload.stocktake.items[0];
    assert.equal(freshItem.expectedQuantity, 11);
    assert.equal((await request(`/api/stocktakes/${freshBatch.payload.stocktake.id}/items/${freshItem.id}`, {
      method: 'PATCH', session: owner, origin,
      body: { countedQuantity: 8, reason: '未登记领用三盒', resolutionNote: '已核对领用人' },
    })).response.status, 200);
    const completedOrdinary = await request(`/api/stocktakes/${freshBatch.payload.stocktake.id}/complete`, {
      method: 'POST', session: owner, origin, body: {},
    });
    assert.equal(completedOrdinary.response.status, 200, JSON.stringify(completedOrdinary.payload));
    assert.equal(completedOrdinary.payload.stocktake.status, 'completed');
    assert.equal(completedOrdinary.payload.stocktake.items[0].currentQuantity, 8);
    assert.ok(completedOrdinary.payload.stocktake.items[0].adjustmentTransactionId);

    const exported = await request('/api/transactions?mode=export', { session: owner, origin });
    const adjustment = exported.payload.transactions.find((record) => record.id === completedOrdinary.payload.stocktake.items[0].adjustmentTransactionId);
    assert.ok(adjustment);
    assert.equal(adjustment.sourceType, 'inventory_adjustment');
    assert.equal(adjustment.counterparty, '盘点差异复核');
    assert.equal(adjustment.type, 'out');
    assert.equal(adjustment.quantity, 3);

    const trackedCategory = `${category}-探针`;
    const trackedMaterial = await request('/api/materials', {
      method: 'POST', session: owner, origin,
      body: { name: '盘点验收探针', category: trackedCategory, unit: '根', safetyStock: 0, trackingMode: 'tracked' },
    });
    assert.equal(trackedMaterial.response.status, 201, JSON.stringify(trackedMaterial.payload));
    const inventory = await request(`/api/inventory-units?materialId=${trackedMaterial.payload.material.id}`, { session: owner, origin });
    const newStatus = inventory.payload.statuses.find((status) => status.code === 'new');
    assert.ok(newStatus);
    const unit = await request('/api/inventory-units', {
      method: 'POST', session: owner, origin,
      body: {
        materialId: trackedMaterial.payload.material.id, unitType: 'container', label: 'ST-50', capacity: 50,
        balances: [
          { statusId: newStatus.id, accessScope: 'shared', quantity: 1, positionCode: '1-1' },
          { statusId: newStatus.id, accessScope: 'shared', quantity: 1, positionCode: '1-2' },
        ],
      },
    });
    assert.equal(unit.response.status, 201, JSON.stringify(unit.payload));
    const trackedBatch = await request('/api/stocktakes', {
      method: 'POST', session: owner, origin, body: { title: '追踪库存逐位置复核', category: trackedCategory },
    });
    assert.equal(trackedBatch.response.status, 201, JSON.stringify(trackedBatch.payload));
    const trackedItem = trackedBatch.payload.stocktake.items[0];
    assert.equal(trackedItem.expectedQuantity, 2);
    assert.equal((await request(`/api/stocktakes/${trackedBatch.payload.stocktake.id}/items/${trackedItem.id}`, {
      method: 'PATCH', session: owner, origin,
      body: { countedQuantity: 1, reason: '1-2 未找到', resolutionNote: '按位置 1-2 登记领出' },
    })).response.status, 200);
    const trackedPrematureCompletion = await request(`/api/stocktakes/${trackedBatch.payload.stocktake.id}/complete`, {
      method: 'POST', session: owner, origin, body: {},
    });
    assert.equal(trackedPrematureCompletion.response.status, 409);
    assert.match(trackedPrematureCompletion.payload.error, /请先在库存明细中逐根修正/);
    assert.equal((await request(`/api/inventory-units/${unit.payload.unit.id}/operation`, {
      method: 'POST', session: owner, origin,
      body: {
        operation: 'out', quantity: 1, fromStatusId: newStatus.id, fromAccessScope: 'shared',
        fromPositionCode: '1-2', counterparty: '盘点差异纠正', note: '按盘点结果补登记',
      },
    })).response.status, 200);
    const completedTracked = await request(`/api/stocktakes/${trackedBatch.payload.stocktake.id}/complete`, {
      method: 'POST', session: owner, origin, body: {},
    });
    assert.equal(completedTracked.response.status, 200, JSON.stringify(completedTracked.payload));
    assert.equal(completedTracked.payload.stocktake.status, 'completed');
    assert.equal(completedTracked.payload.stocktake.items[0].currentQuantity, 1);
    assert.equal(completedTracked.payload.stocktake.items[0].adjustmentTransactionId, '');

    const audit = await request('/api/audit-logs?type=stocktake&pageSize=100', { session: owner, origin });
    assert.equal(audit.response.status, 200, JSON.stringify(audit.payload));
    const actions = new Set(audit.payload.items.map((entry) => entry.action));
    assert.ok(['stocktake.create', 'stocktake.count_update', 'stocktake.complete', 'stocktake.cancel'].every((action) => actions.has(action)));
    const completionAudit = audit.payload.items.find((entry) => entry.action === 'stocktake.complete' && entry.targetId === freshBatch.payload.stocktake.id);
    assert.deepEqual(completionAudit.after.adjustmentTransactionIds, [adjustment.id]);
  } finally {
    await stopServer(stocktakeServer);
    await rm(stocktakeDataDir, { recursive: true, force: true });
  }
});

test('版本 13 数据库会迁移盘点批次表并保留现有数据', async () => {
  const version13DataDir = await mkdtemp(path.join(os.tmpdir(), 'labstock-schema-v13-stocktake-'));
  const origin = `http://127.0.0.1:${await freePort()}`;
  const databasePath = path.join(version13DataDir, 'labstock.sqlite');
  let version13Server;
  let database;
  try {
    version13Server = await startServer(origin, version13DataDir);
    await stopServer(version13Server);
    version13Server = null;

    database = new DatabaseSync(databasePath);
    const materialCount = database.prepare('SELECT COUNT(*) AS count FROM materials').get().count;
    const transactionCount = database.prepare('SELECT COUNT(*) AS count FROM transactions').get().count;
    database.exec('DROP TABLE stocktake_items; DROP TABLE stocktakes;');
    database.prepare("UPDATE metadata SET value = '13' WHERE key = 'schema_version'").run();
    database.close();
    database = null;

    version13Server = await startServer(origin, version13DataDir);
    database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, '14');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM materials').get().count, materialCount);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM transactions').get().count, transactionCount);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('stocktakes', 'stocktake_items')").get().count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name IN ('stocktakes_created_at', 'stocktake_items_stocktake')").get().count, 2);
    const stocktakeColumns = new Set(database.prepare('PRAGMA table_info(stocktakes)').all().map((column) => column.name));
    assert.ok(['cancelled_by_user_id', 'cancelled_by_name', 'cancelled_at', 'cancellation_reason'].every((column) => stocktakeColumns.has(column)));
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    try { database?.close(); } catch {}
    await stopServer(version13Server);
    await rm(version13DataDir, { recursive: true, force: true });
  }
});

test('生产环境首次启动只创建安全的空库存管理员账号', async () => {
  const productionDataDir = await mkdtemp(path.join(os.tmpdir(), 'labstock-production-'));
  const origin = `http://127.0.0.1:${await freePort()}`;
  const initialPassword = 'Production-Test-Password-2026';
  let productionServer;
  try {
    productionServer = await startServer(origin, productionDataDir, {
      NODE_ENV: 'production',
      INITIAL_ADMIN_PASSWORD: initialPassword,
    });
    const session = await login('admin', initialPassword, origin);
    const bootstrap = await request('/api/bootstrap', { session, origin });
    assert.equal(bootstrap.response.status, 200);
    assert.equal(bootstrap.payload.members.length, 1);
    assert.equal(bootstrap.payload.members[0].username, 'admin');
    assert.equal(bootstrap.payload.user.isOwner, true);
    assert.equal(bootstrap.payload.materials.length, 0);
    assert.equal(bootstrap.payload.transactions.length, 0);
    assert.equal((await request('/api/login', {
      method: 'POST', origin, body: { username: 'admin', password: 'admin123' },
    })).response.status, 401);
  } finally {
    await stopServer(productionServer);
    await rm(productionDataDir, { recursive: true, force: true });
  }
});
