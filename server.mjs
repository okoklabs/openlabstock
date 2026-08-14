import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStorage, validateBackupDatabase } from './storage.mjs';
import { hashPassword, verifyPassword } from './password.mjs';
import { createLoginProtection } from './src/server/login-attempts.mjs';
import { encodeRecordCursor, recordPageOptions } from './src/server/record-query.mjs';
import { normalizedMaterialName, planQuantityImport } from './src/server/quantity-import.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const packageMetadata = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
const appVersion = String(process.env.APP_VERSION ?? packageMetadata.version ?? 'dev');
const distDir = path.join(rootDir, 'dist');
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(rootDir, 'data'));
const port = Number(process.env.PORT ?? 4388);
const host = process.env.HOST ?? '127.0.0.1';
const sqliteBusyTimeoutMs = Number(process.env.SQLITE_BUSY_TIMEOUT_MS ?? 10000);
const parsedBodies = new WeakMap();
const requestIds = new WeakMap();
const requestStorage = new AsyncLocalStorage();
const sessionMaxAgeDays = Number(process.env.SESSION_MAX_AGE_DAYS ?? 15);
if (!Number.isInteger(sessionMaxAgeDays) || sessionMaxAgeDays < 1 || sessionMaxAgeDays > 30) {
  throw new Error('SESSION_MAX_AGE_DAYS 必须是 1-30 之间的整数');
}
const sessionMaxAgeMs = 1000 * 60 * 60 * 24 * sessionMaxAgeDays;
const loginAttemptWindowMs = 1000 * 60 * 15;
const maxLoginAttempts = 8;
const maxClientLoginAttempts = 80;
const loginProtection = createLoginProtection({
  windowMs: loginAttemptWindowMs,
  maxAccountAttempts: maxLoginAttempts,
  maxClientAttempts: maxClientLoginAttempts,
  maxEntries: 10_000,
});
// 组内账号保持易用，不强制字符组合；公网部署仍拒绝过短密码。
const minimumPasswordLength = 8;
const trustProxy = ['1', 'true'].includes(String(process.env.TRUST_PROXY ?? '').toLowerCase());
const forceSecureCookies = ['1', 'true'].includes(String(process.env.COOKIE_SECURE ?? '').toLowerCase());
const sessionCookieName = forceSecureCookies ? '__Host-labstock_session' : 'labstock_session';
const databaseUploadMaxBytes = Number(process.env.DATABASE_UPLOAD_MAX_BYTES ?? 100 * 1024 * 1024);
const bootstrapTransactionLimit = 30;
const backupDir = path.resolve(process.env.BACKUP_DIR ?? path.join(dataDir, 'backups'));
const restoreAuthorizations = new Map();
const staticFileCache = new Map();
let maintenanceMode = false;
if (!Number.isInteger(databaseUploadMaxBytes) || databaseUploadMaxBytes < 1_000_000 || databaseUploadMaxBytes > 500 * 1024 * 1024) {
  throw new Error('DATABASE_UPLOAD_MAX_BYTES must be an integer between 1 MB and 500 MB');
}
let mutationQueue = Promise.resolve();
let storage;

const defaultSettings = Object.freeze({
  appName: 'OpenLabStock',
  labName: '实验室耗材管理系统',
  brandIcon: '',
});

const defaultInventoryStatusBlueprints = Object.freeze([
  { code: 'new', name: '全新', usable: true, terminal: false, sortOrder: 10 },
  { code: 'active', name: '已启用', usable: true, terminal: false, sortOrder: 20 },
  { code: 'unavailable', name: '不可用', usable: false, terminal: true, sortOrder: 30 },
]);

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
};

const securityHeaders = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), geolocation=(), microphone=()',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

function clientAddress(request) {
  const forwarded = request.headers['x-forwarded-for'];
  if (trustProxy && typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return request.socket.remoteAddress ?? 'unknown';
}

function loginAttemptKey(request, username) {
  return `${clientAddress(request)}|${String(username).trim().toLowerCase()}`;
}

function loginAttemptState(request, username) {
  const clientKey = clientAddress(request);
  return loginProtection.check(clientKey, loginAttemptKey(request, username));
}

function secureCookieSuffix(request) {
  const forwardedHttps = trustProxy && String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase() === 'https';
  return forceSecureCookies || forwardedHttps ? '; Secure' : '';
}

function allowsStateChange(request) {
  if (String(request.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  const forwardedHttps = trustProxy && String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase() === 'https';
  const protocol = forceSecureCookies || forwardedHttps ? 'https' : 'http';
  try {
    return new URL(String(origin)).origin === `${protocol}://${request.headers.host}`;
  } catch {
    return false;
  }
}

function makeUser(username, password, name, role, groupId) {
  return { id: randomUUID(), username, name, note: '', role, groupId, tagIds: [], active: true, ...hashPassword(password), lastLoginAt: null };
}

function createDefaultStore() {
  const now = new Date().toISOString();
  const production = process.env.NODE_ENV === 'production';
  const initialAdminPassword = production ? String(process.env.INITIAL_ADMIN_PASSWORD ?? '') : 'admin123';
  if (production && (initialAdminPassword.length < minimumPasswordLength || initialAdminPassword.length > 128)) {
    throw new Error('首次生产启动必须通过 INITIAL_ADMIN_PASSWORD 设置 8-128 位管理员密码');
  }
  const defaultGroup = { id: randomUUID(), name: '默认组', isDefault: true };
  const admin = makeUser('admin', initialAdminPassword, production ? '系统所有者' : '林小满', 'admin', defaultGroup.id);
  if (production) {
    return {
      settings: { ...defaultSettings },
      groups: [defaultGroup],
      tags: [],
      users: [admin],
      materials: [],
      transactions: [],
      inventoryStatuses: [],
      inventoryUnits: [],
      inventoryUnitBalances: [],
      inventoryEvents: [],
    };
  }
  const member = makeUser('student', 'demo123', '周子涵', 'member', defaultGroup.id);
  const tags = [
    { id: randomUUID(), name: '采购负责人' },
    { id: randomUUID(), name: '危化品' },
  ];
  admin.tagIds = [tags[0].id];
  member.tagIds = [tags[1].id];
  const materials = [
    { id: randomUUID(), name: 'PE 手套（无粉）', category: '防护用品', quantity: 12, safetyStock: 30, unit: '盒', spec: '100 只/盒', updatedAt: now },
    { id: randomUUID(), name: '移液枪头 200 μL', category: '塑料耗材', quantity: 18, safetyStock: 25, unit: '盒', spec: '96 支/盒', updatedAt: now },
    { id: randomUUID(), name: '无水乙醇', category: '化学试剂', quantity: 7, safetyStock: 10, unit: '瓶', spec: '500 mL/瓶', updatedAt: now },
    { id: randomUUID(), name: '玻璃样品瓶', category: '玻璃器皿', quantity: 86, safetyStock: 30, unit: '个', spec: '20 mL/个', updatedAt: now },
    { id: randomUUID(), name: '铝箔纸', category: '包装耗材', quantity: 42, safetyStock: 20, unit: '卷', spec: '30 cm × 10 m', updatedAt: now },
  ];
  const byName = Object.fromEntries(materials.map((item) => [item.name, item]));
  return {
    settings: { ...defaultSettings },
    groups: [defaultGroup],
    tags,
    users: [admin, member],
    materials,
    transactions: [
      { id: randomUUID(), type: 'in', materialId: byName['无水乙醇'].id, materialName: '无水乙醇', quantity: 24, unit: '瓶', userId: member.id, userName: member.name, counterparty: '采购单 CG-0821', note: '采购到货', occurredAt: now },
      { id: randomUUID(), type: 'out', materialId: byName['移液枪头 200 μL'].id, materialName: '移液枪头 200 μL', quantity: 3, unit: '盒', userId: admin.id, userName: admin.name, counterparty: '项目 CELL-04', note: '细胞实验', occurredAt: new Date(Date.now() - 86_400_000).toISOString() },
      { id: randomUUID(), type: 'in', materialId: byName['PE 手套（无粉）'].id, materialName: 'PE 手套（无粉）', quantity: 20, unit: '盒', userId: admin.id, userName: admin.name, counterparty: '采购单 CG-0818', note: '月初补货', occurredAt: new Date(Date.now() - 2 * 86_400_000).toISOString() },
    ],
    inventoryStatuses: [],
    inventoryUnits: [],
    inventoryUnitBalances: [],
    inventoryEvents: [],
  };
}

function normalizeStore(input) {
  const store = input && typeof input === 'object' ? input : {};
  const settings = store.settings && typeof store.settings === 'object' ? store.settings : {};
  const requestedAppName = String(settings.appName ?? '').trim();
  store.settings = {
    appName: requestedAppName || defaultSettings.appName,
    labName: String(settings.labName ?? '').trim() || defaultSettings.labName,
    brandIcon: typeof settings.brandIcon === 'string' ? settings.brandIcon : defaultSettings.brandIcon,
  };
  store.groups = Array.isArray(store.groups) && store.groups.length
    ? store.groups
    : [{ id: randomUUID(), name: '默认组', isDefault: true }];
  store.tags = Array.isArray(store.tags) ? store.tags : [];
  store.users = Array.isArray(store.users) ? store.users : [];
  store.materials = Array.isArray(store.materials) ? store.materials : [];
  store.transactions = Array.isArray(store.transactions) ? store.transactions : [];
  store.inventoryStatuses = Array.isArray(store.inventoryStatuses) ? store.inventoryStatuses : [];
  store.inventoryUnits = Array.isArray(store.inventoryUnits) ? store.inventoryUnits : [];
  store.inventoryUnitBalances = Array.isArray(store.inventoryUnitBalances) ? store.inventoryUnitBalances : [];
  store.inventoryEvents = Array.isArray(store.inventoryEvents) ? store.inventoryEvents : [];

  const defaultGroup = store.groups.find((group) => group.isDefault) ?? store.groups[0];
  store.groups.forEach((group) => { group.isDefault = group.id === defaultGroup.id; });
  const validTagIds = new Set(store.tags.map((tag) => tag.id));
  store.users.forEach((user) => {
    if (!store.groups.some((group) => group.id === user.groupId)) user.groupId = defaultGroup.id;
    if (typeof user.note !== 'string') user.note = '';
    user.tagIds = [...new Set(Array.isArray(user.tagIds) ? user.tagIds.filter((tagId) => validTagIds.has(tagId)) : [])];
  });
  store.materials.forEach((material) => {
    material.active = material.active !== false;
    material.trackingMode = ['quantity', 'stateful', 'tracked'].includes(material.trackingMode) ? material.trackingMode : 'quantity';
    material.positionCodeHelp = typeof material.positionCodeHelp === 'string' ? material.positionCodeHelp : '';
    material.usageContextHelp = typeof material.usageContextHelp === 'string' ? material.usageContextHelp : '';
  });
  const usersById = new Map(store.users.map((user) => [user.id, user]));
  const groupsById = new Map(store.groups.map((group) => [group.id, group]));
  store.transactions.forEach((record) => {
    const transactionUser = usersById.get(record.userId);
    const transactionGroup = transactionUser ? groupsById.get(transactionUser.groupId) : null;
    if (typeof record.groupId !== 'string') record.groupId = transactionGroup?.id ?? '';
    if (typeof record.groupName !== 'string') record.groupName = transactionGroup?.name ?? '';
    if (!['manual', 'inventory_adjustment'].includes(record.sourceType)) {
      record.sourceType = record.counterparty === 'Excel 批量导入' ? 'inventory_adjustment' : 'manual';
    }
    record.operation = ['stock', 'dispose'].includes(record.operation) ? record.operation : 'stock';
    record.inventoryUnitId = typeof record.inventoryUnitId === 'string' ? record.inventoryUnitId : '';
    record.inventoryUnitLabel = typeof record.inventoryUnitLabel === 'string' ? record.inventoryUnitLabel : '';
    record.statusId = typeof record.statusId === 'string' ? record.statusId : '';
    record.statusName = typeof record.statusName === 'string' ? record.statusName : '';
    record.accessScope = typeof record.accessScope === 'string' ? record.accessScope : '';
    record.ownerUserId = typeof record.ownerUserId === 'string' ? record.ownerUserId : '';
    record.ownerName = typeof record.ownerName === 'string' ? record.ownerName : '';
    record.positionCode = typeof record.positionCode === 'string' ? record.positionCode : '';
    record.correctionOfId = typeof record.correctionOfId === 'string' ? record.correctionOfId : '';
  });
  store.inventoryStatuses.forEach((status) => {
    status.code = String(status.code ?? '').trim();
    status.name = String(status.name ?? '').trim();
    status.usable = status.usable !== false;
    status.terminal = status.terminal === true;
    status.active = status.active !== false;
    status.sortOrder = Number.isInteger(status.sortOrder) ? status.sortOrder : 0;
  });
  store.inventoryUnits.forEach((unit) => {
    unit.unitType = ['aggregate', 'lot', 'container', 'position'].includes(unit.unitType) ? unit.unitType : 'lot';
    unit.label = String(unit.label ?? '').trim();
    unit.positionCode = String(unit.positionCode ?? '').trim();
    unit.capacity = Number.isFinite(Number(unit.capacity)) && Number(unit.capacity) >= 0 ? Number(unit.capacity) : 0;
    unit.note = String(unit.note ?? '').trim();
    unit.active = unit.active !== false;
    unit.createdAt = typeof unit.createdAt === 'string' ? unit.createdAt : new Date().toISOString();
    unit.updatedAt = typeof unit.updatedAt === 'string' ? unit.updatedAt : unit.createdAt;
  });
  store.inventoryUnitBalances = store.inventoryUnitBalances.filter((balance) => {
    balance.accessScope = balance.accessScope === 'user' ? 'user' : 'shared';
    balance.ownerUserId = String(balance.ownerUserId ?? '');
    balance.positionCode = String(balance.positionCode ?? '').trim();
    balance.quantity = Number(balance.quantity);
    return balance.inventoryUnitId && balance.statusId && Number.isFinite(balance.quantity) && balance.quantity > 0
      && (balance.accessScope === 'shared' ? balance.ownerUserId === '' : balance.ownerUserId !== '');
  });
  store.inventoryEvents.forEach((event) => {
    event.eventType = ['use', 'use_correction', 'state_change', 'access_change', 'transfer', 'dispose', 'adjustment'].includes(event.eventType) ? event.eventType : 'adjustment';
    event.quantity = Number(event.quantity);
    event.counterparty = String(event.counterparty ?? '').trim();
    event.note = String(event.note ?? '').trim();
    event.correctionOfId = String(event.correctionOfId ?? '');
    event.fromPositionCode = String(event.fromPositionCode ?? '').trim();
    event.toPositionCode = String(event.toPositionCode ?? '').trim();
  });
  return store;
}

async function readStore() {
  return normalizeStore((requestStorage.getStore() ?? storage.readView).readStore());
}

async function writeStore(command) {
  const view = requestStorage.getStore();
  if (!view?.writeStore) throw new Error('Write attempted outside a database transaction');
  if (!command || typeof command !== 'object') throw new Error('Invalid write command');
  const normalizedCommand = command.operation === 'syncStore'
    ? { operation: 'syncStore', store: normalizeStore(command.store) }
    : command;
  view.writeStore(normalizedCommand);
}

function sendJson(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(body));
}

function sendRevalidatedJson(request, response, body) {
  const payload = Buffer.from(JSON.stringify(body));
  const etag = `"${createHash('sha256').update(payload).digest('hex').slice(0, 16)}"`;
  const headers = {
    ...securityHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, no-cache',
    ETag: etag,
  };
  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304, headers);
    return response.end();
  }
  response.writeHead(200, { ...headers, 'Content-Length': payload.length });
  if (request.method === 'HEAD') return response.end();
  response.end(payload);
}

function brandIconResource(value) {
  const match = String(value ?? '').match(/^data:image\/(png|jpeg|webp);base64,([a-z0-9+/]+={0,2})$/i);
  if (!match) return null;
  const body = Buffer.from(match[2], 'base64');
  if (!body.length) return null;
  const contentType = `image/${match[1].toLowerCase()}`;
  const version = createHash('sha256').update(body).digest('hex').slice(0, 16);
  return { body, contentType, version, etag: `"${version}"` };
}

function publicSettings(settings) {
  const icon = brandIconResource(settings?.brandIcon);
  return {
    appName: String(settings?.appName ?? defaultSettings.appName),
    labName: String(settings?.labName ?? defaultSettings.labName),
    brandIcon: icon ? `/api/brand-icon?v=${icon.version}` : '',
  };
}

function sendBrandIcon(request, response, settings, requestedVersion) {
  const icon = brandIconResource(settings?.brandIcon);
  if (!icon || requestedVersion !== icon.version) return sendJson(response, 404, { error: '图标版本不存在' });
  const headers = {
    ...securityHeaders,
    'Content-Type': icon.contentType,
    'Content-Length': icon.body.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: icon.etag,
  };
  if (request.headers['if-none-match'] === icon.etag) {
    response.writeHead(304, headers);
    return response.end();
  }
  response.writeHead(200, headers);
  if (request.method === 'HEAD') return response.end();
  response.end(icon.body);
}

function sendDownload(response, body, filename, contentType = 'application/octet-stream') {
  response.writeHead(200, {
    ...securityHeaders,
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie ?? '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter(([key]) => key));
}

function getSession(request) {
  const token = parseCookies(request)[sessionCookieName];
  if (!token) return null;
  const session = (requestStorage.getStore() ?? storage.readView).getSession(token);
  if (!session || session.expires_at <= Date.now()) return null;
  return { userId: session.user_id, expiresAt: session.expires_at };
}

function getActiveReadUser(request) {
  const session = getSession(request);
  if (!session) return { session: null, store: null, user: null };
  const store = normalizeStore(storage.readView.readStore());
  const user = store.users.find((candidate) => candidate.id === session.userId && candidate.active) ?? null;
  return { session, store, user };
}

function cleanupRestoreAuthorizations() {
  const now = Date.now();
  for (const [token, authorization] of restoreAuthorizations) {
    if (authorization.expiresAt <= now) restoreAuthorizations.delete(token);
  }
}

async function handleDatabaseBackup(request, response) {
  const { session, user } = getActiveReadUser(request);
  if (!session || !user) return sendJson(response, 401, { error: '请先登录' });
  if (!isOwner(user)) return sendJson(response, 403, { error: '只有系统所有者可以下载数据库备份' });
  await mkdir(backupDir, { recursive: true });
  const temporaryPath = path.join(backupDir, `.download-${randomUUID()}.sqlite`);
  try {
    storage.createBackup(temporaryPath);
    const summary = validateBackupDatabase(temporaryPath);
    const body = await readFile(temporaryPath);
    const stamp = new Date().toISOString().replaceAll(/[-:]/g, '').replace('T', '-').replace(/\.\d{3}Z$/, 'Z');
    writeStandaloneAuditLog(standaloneAuditLog(request, user, {
      action: 'database.backup_download',
      targetType: 'database',
      targetId: 'primary',
      summary: '下载主数据库一致性备份',
      after: { schemaVersion: summary.schemaVersion, users: summary.users, materials: summary.materials, transactions: summary.transactions },
    }));
    return sendDownload(response, body, `OpenLabStock-database-${stamp}.sqlite`, 'application/vnd.sqlite3');
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function handleDatabaseRestore(request, response, body, authorization) {
  const { session, user } = getActiveReadUser(request);
  if (!session || !user) return sendJson(response, 401, { error: '请先登录' });
  if (!isOwner(user)) return sendJson(response, 403, { error: '只有系统所有者可以恢复数据库' });
  if (!authorization || authorization.userId !== user.id || authorization.expiresAt <= Date.now()) {
    return sendJson(response, 401, { error: '恢复授权已失效，请重新输入当前密码' });
  }
  if (body.length < 16 || body.subarray(0, 16).toString('ascii') !== 'SQLite format 3\0') {
    return sendJson(response, 400, { error: '文件不是有效的 SQLite 数据库' });
  }

  const temporaryPath = path.join(dataDir, `.restore-upload-${randomUUID()}.sqlite`);
  const databasePath = storage.databasePath;
  const rollbackPath = path.join(dataDir, `.restore-rollback-${randomUUID()}.sqlite`);
  let temporaryMoved = false;
  let previousMoved = false;
  let currentStorageClosed = false;
  try {
    await writeFile(temporaryPath, body, { flag: 'wx', mode: 0o600 });
    const summary = validateBackupDatabase(temporaryPath, { clearSessions: true });
    await mkdir(backupDir, { recursive: true });
    const preRestorePath = path.join(backupDir, `pre-restore-${new Date().toISOString().replaceAll(/[-:]/g, '').replace('T', '-').replace(/\.\d{3}Z$/, 'Z')}.sqlite`);
    storage.createBackup(preRestorePath);

    storage.close();
    storage = null;
    currentStorageClosed = true;
    await rename(databasePath, rollbackPath);
    previousMoved = true;
    await unlink(`${databasePath}-wal`).catch(() => undefined);
    await unlink(`${databasePath}-shm`).catch(() => undefined);
    await rename(temporaryPath, databasePath);
    temporaryMoved = true;
    storage = await openStorage({ dataDir, createDefaultStore, normalizeStore, busyTimeoutMs: sqliteBusyTimeoutMs });
    writeStandaloneAuditLog(standaloneAuditLog(request, user, {
      action: 'database.restore',
      targetType: 'database',
      targetId: 'primary',
      summary: '恢复主数据库并清除全部登录会话',
      after: { schemaVersion: summary.schemaVersion, users: summary.users, materials: summary.materials, transactions: summary.transactions },
    }));
    await unlink(rollbackPath).catch(() => undefined);
    return sendJson(response, 200, {
      ok: true,
      summary,
      message: '数据库已恢复，所有账号需要重新登录',
    }, {
      'Set-Cookie': `${sessionCookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookieSuffix(request)}`,
    });
  } catch (error) {
    if (currentStorageClosed) {
      if (storage) {
        try { storage.close(); } catch {}
        storage = null;
      }
      if (temporaryMoved) await unlink(databasePath).catch(() => undefined);
      await unlink(`${databasePath}-wal`).catch(() => undefined);
      await unlink(`${databasePath}-shm`).catch(() => undefined);
      if (previousMoved) await rename(rollbackPath, databasePath).catch(() => undefined);
      try {
        storage = await openStorage({ dataDir, createDefaultStore, normalizeStore, busyTimeoutMs: sqliteBusyTimeoutMs });
      } catch (reopenError) {
        console.error('Failed to reopen database after restore rollback', reopenError);
      }
    }
    throw Object.assign(new Error(`数据库恢复失败，原数据库已保留：${error.message}`), { statusCode: 400 });
  } finally {
    if (!temporaryMoved) await unlink(temporaryPath).catch(() => undefined);
    if (currentStorageClosed && !storage) {
      try { storage = await openStorage({ dataDir, createDefaultStore, normalizeStore, busyTimeoutMs: sqliteBusyTimeoutMs }); } catch {}
    }
  }
}

function clearSessionsForUser(userId, exceptToken = '') {
  const view = requestStorage.getStore();
  if (!view?.clearSessionsForUser) throw new Error('Session mutation attempted outside a database transaction');
  view.clearSessionsForUser(userId, exceptToken);
}

function createBufferedResponse() {
  let statusCode = 200;
  let headers = {};
  let body = '';
  return {
    response: {
      writeHead(code, nextHeaders = {}) {
        statusCode = code;
        headers = nextHeaders;
      },
      end(nextBody = '') {
        body = nextBody;
      },
    },
    flush(response) {
      response.writeHead(statusCode, headers);
      response.end(body);
    },
    result() {
      let payload = {};
      try { payload = body ? JSON.parse(String(body)) : {}; } catch {}
      return { statusCode, headers, body, payload };
    },
  };
}

function isDatabaseBusy(error) {
  return String(error?.code ?? '').toUpperCase().includes('BUSY')
    || /database is locked|database table is locked|database is busy/i.test(String(error?.message ?? ''));
}

async function readJsonBody(request) {
  if (parsedBodies.has(request)) return parsedBodies.get(request);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 5_000_000) throw Object.assign(new Error('请求内容过大'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) {
    parsedBodies.set(request, {});
    return {};
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    parsedBodies.set(request, body);
    return body;
  } catch {
    throw Object.assign(new Error('请求内容不是有效 JSON'), { statusCode: 400 });
  }
}

async function readBinaryBody(request, maxBytes = databaseUploadMaxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('数据库文件超过允许大小限制'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function publicUser(user) {
  return { id: user.id, username: user.username, name: user.name, note: user.note, role: user.role, groupId: user.groupId, tagIds: user.tagIds ?? [], active: user.active, lastLoginAt: user.lastLoginAt, isOwner: Boolean(user.isOwner) };
}

function directoryUser(user) {
  return { id: user.id, name: user.name, note: user.note, role: user.role, groupId: user.groupId, tagIds: user.tagIds ?? [], isOwner: Boolean(user.isOwner) };
}

const isOwner = (user) => Boolean(user.isOwner);
const isSystemAdmin = (user) => user.role === 'admin';
const isInventoryAdmin = (user) => user.role === 'inventory';
const canManageInventory = (user) => isSystemAdmin(user) || isInventoryAdmin(user);
const canManageMembers = (user) => isSystemAdmin(user);
const canManageSettings = (user) => isSystemAdmin(user);
const canViewAllTransactions = () => true;
const compareUsersByName = (left, right) => left.name.localeCompare(right.name, 'zh-CN-u-co-pinyin', {
  numeric: true,
  sensitivity: 'base',
}) || String(left.username ?? '').localeCompare(String(right.username ?? ''), 'en', { sensitivity: 'base' });
const canManageUser = (actor, target) => canManageMembers(actor) && (isOwner(actor) || !isSystemAdmin(target));
function similarMaterial(store, name, exceptId = '') {
  const normalized = normalizedMaterialName(name);
  return normalized
    ? store.materials.find((material) => material.id !== exceptId && normalizedMaterialName(material.name) === normalized)
    : null;
}

function inventoryUnitDisplayLabel(unit, positionCode = '') {
  if (unit.unitType === 'aggregate') return '总库存';
  return [unit.label, unit.positionCode, positionCode].filter(Boolean).join('-') || '未命名单元';
}

function matchesInventorySearch(value, query) {
  const haystack = String(value ?? '').toLocaleLowerCase('zh-CN');
  return String(query ?? '').trim().toLocaleLowerCase('zh-CN').split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
}

function statusesForMaterial(store, materialId, { includeInactive = false } = {}) {
  return store.inventoryStatuses
    .filter((status) => status.materialId === materialId && (includeInactive || status.active))
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'zh-CN'));
}

function ensureDefaultInventoryStatuses(store, materialId) {
  const existing = statusesForMaterial(store, materialId, { includeInactive: true });
  if (existing.length) return existing;
  const statuses = defaultInventoryStatusBlueprints.map((blueprint) => ({
    id: randomUUID(),
    materialId,
    ...blueprint,
    active: true,
  }));
  store.inventoryStatuses.push(...statuses);
  return statuses;
}

function balancesForUnit(store, unitId) {
  return store.inventoryUnitBalances.filter((balance) => balance.inventoryUnitId === unitId);
}

function balanceIdentity({ inventoryUnitId, statusId, accessScope, ownerUserId = '', positionCode = '' }) {
  return `${inventoryUnitId}|${statusId}|${accessScope}|${ownerUserId}|${positionCode}`;
}

function upsertInventoryBalance(store, identity, delta) {
  const index = store.inventoryUnitBalances.findIndex((balance) => balanceIdentity(balance) === balanceIdentity(identity));
  const current = index >= 0 ? store.inventoryUnitBalances[index].quantity : 0;
  const next = current + delta;
  if (next < -1e-9) throw Object.assign(new Error(`库存单元数量不足，当前仅 ${current}`), { statusCode: 409 });
  if (next <= 1e-9) {
    if (index >= 0) store.inventoryUnitBalances.splice(index, 1);
    return 0;
  }
  if (index >= 0) store.inventoryUnitBalances[index].quantity = next;
  else store.inventoryUnitBalances.push({ ...identity, ownerUserId: identity.ownerUserId ?? '', positionCode: identity.positionCode ?? '', quantity: next });
  return next;
}

function inventorySummary(store, materialId) {
  const statuses = statusesForMaterial(store, materialId, { includeInactive: true });
  const statusById = new Map(statuses.map((status) => [status.id, status]));
  const unitIds = new Set(store.inventoryUnits.filter((unit) => unit.materialId === materialId && unit.active).map((unit) => unit.id));
  const byStatus = new Map(statuses.map((status) => [status.id, 0]));
  let total = 0;
  let usable = 0;
  let shared = 0;
  let reserved = 0;
  let sharedUsable = 0;
  let reservedUsable = 0;
  const nonemptyUnitIds = new Set();
  for (const balance of store.inventoryUnitBalances) {
    if (!unitIds.has(balance.inventoryUnitId)) continue;
    const status = statusById.get(balance.statusId);
    nonemptyUnitIds.add(balance.inventoryUnitId);
    total += balance.quantity;
    if (status?.usable) usable += balance.quantity;
    if (balance.accessScope === 'shared') {
      shared += balance.quantity;
      if (status?.usable) sharedUsable += balance.quantity;
    } else {
      reserved += balance.quantity;
      if (status?.usable) reservedUsable += balance.quantity;
    }
    byStatus.set(balance.statusId, (byStatus.get(balance.statusId) ?? 0) + balance.quantity);
  }
  return {
    materialId,
    total,
    usable,
    unavailable: Math.max(0, total - usable),
    shared,
    reserved,
    sharedUsable,
    reservedUsable,
    unitCount: nonemptyUnitIds.size,
    activeUnitCount: unitIds.size,
    statuses: statuses.map((status) => ({ ...status, quantity: byStatus.get(status.id) ?? 0 })),
  };
}

function refreshTrackedMaterialQuantity(store, material) {
  const summary = inventorySummary(store, material.id);
  material.quantity = summary.total;
  material.updatedAt = new Date().toISOString();
  return summary;
}

function validInventoryOwner(store, ownerUserId) {
  return store.users.find((candidate) => candidate.id === ownerUserId && candidate.active) ?? null;
}

function validateAccessTarget(store, accessScope, ownerUserId = '') {
  if (accessScope === 'shared') return { accessScope, ownerUserId: '', owner: null };
  if (accessScope !== 'user') throw Object.assign(new Error('使用范围必须是开放或成员自用'), { statusCode: 400 });
  const owner = validInventoryOwner(store, String(ownerUserId));
  if (!owner) throw Object.assign(new Error('请选择启用中的自用成员'), { statusCode: 400 });
  return { accessScope, ownerUserId: owner.id, owner };
}

function validateAccessSource(store, accessScope, ownerUserId = '') {
  if (accessScope === 'shared') return { accessScope, ownerUserId: '', owner: null };
  if (accessScope !== 'user') throw Object.assign(new Error('使用范围必须是开放或成员自用'), { statusCode: 400 });
  const normalizedOwnerUserId = String(ownerUserId);
  if (!normalizedOwnerUserId) throw Object.assign(new Error('自用库存缺少成员编号'), { statusCode: 400 });
  return {
    accessScope,
    ownerUserId: normalizedOwnerUserId,
    owner: store.users.find((candidate) => candidate.id === normalizedOwnerUserId) ?? null,
  };
}

function canUseInventoryBalance(user, balance) {
  return canManageInventory(user) || balance.accessScope === 'shared' || balance.ownerUserId === user.id;
}

function canRegisterInventoryUse(user, balance) {
  return balance.accessScope === 'shared' || balance.ownerUserId === user.id;
}

function canChangeInventoryAccess(user, sourceBalance, targetAccess) {
  // Assigning self-use stock to another member is an administrator-only action.
  if (user.role === 'admin') return true;
  if (sourceBalance.accessScope === 'shared') return targetAccess.accessScope === 'user' && targetAccess.ownerUserId === user.id;
  return sourceBalance.ownerUserId === user.id && targetAccess.accessScope === 'shared';
}

function normalizedPositionCode(value) {
  const positionCode = String(value ?? '').trim();
  if (positionCode.length > 40) throw Object.assign(new Error('位置编号不能超过 40 个字符'), { statusCode: 400 });
  return positionCode;
}

function assertPositionBalance(store, identity, quantity, { ignoreIdentity = null } = {}) {
  const positionCode = String(identity.positionCode ?? '').trim();
  if (!positionCode) return;
  if (Math.abs(Number(quantity) - 1) > 1e-9) {
    throw Object.assign(new Error('填写位置编号时，每个位置的数量必须为 1'), { statusCode: 400 });
  }
  const conflict = store.inventoryUnitBalances.find((balance) => {
    if (balance.inventoryUnitId !== identity.inventoryUnitId || balance.positionCode !== positionCode || balance.quantity <= 1e-9) return false;
    return !ignoreIdentity || balanceIdentity(balance) !== balanceIdentity(ignoreIdentity);
  });
  if (conflict) {
    throw Object.assign(new Error(`位置“${positionCode}”已经在该库存单元中占用，请先选择已有明细或调整原位置`), { statusCode: 409 });
  }
}

function inventoryAnomaliesForStore(store, { materialId = '' } = {}) {
  const materialById = new Map(store.materials.map((material) => [material.id, material]));
  const unitById = new Map(store.inventoryUnits
    .filter((unit) => !materialId || unit.materialId === materialId)
    .map((unit) => [unit.id, unit]));
  const statusById = new Map(store.inventoryStatuses.map((status) => [status.id, status]));
  const userById = new Map(store.users.map((candidate) => [candidate.id, candidate]));
  const groups = new Map();

  for (const balance of store.inventoryUnitBalances) {
    const unit = unitById.get(balance.inventoryUnitId);
    const positionCode = String(balance.positionCode ?? '').trim();
    if (!unit || !positionCode || balance.quantity <= 1e-9) continue;
    const key = `${unit.id}|${positionCode}`;
    const group = groups.get(key) ?? { unit, positionCode, balances: [] };
    group.balances.push(balance);
    groups.set(key, group);
  }

  const positionAnomalies = [...groups.values()].flatMap(({ unit, positionCode, balances }) => {
    const duplicate = balances.length > 1;
    const invalidQuantities = balances.some((balance) => Math.abs(balance.quantity - 1) > 1e-9);
    if (!duplicate && !invalidQuantities) return [];
    const material = materialById.get(unit.materialId);
    return [{
      id: `${unit.id}|${positionCode}`,
      type: 'position_conflict',
      materialId: unit.materialId,
      materialName: material?.name ?? '未知耗材',
      materialUnit: material?.unit ?? '件',
      inventoryUnitId: unit.id,
      inventoryUnitLabel: inventoryUnitDisplayLabel(unit),
      positionCode,
      duplicate,
      invalidQuantities,
      totalQuantity: balances.reduce((sum, balance) => sum + balance.quantity, 0),
      entries: balances.map((balance) => {
        const status = statusById.get(balance.statusId);
        const owner = userById.get(balance.ownerUserId);
        return {
          statusId: balance.statusId,
          statusName: status?.name ?? '未知状态',
          accessScope: balance.accessScope,
          ownerUserId: balance.ownerUserId,
          ownerName: balance.accessScope === 'user' ? owner?.name ?? '成员已停用或删除' : '',
          positionCode,
          displayCode: inventoryUnitDisplayLabel(unit, positionCode),
          quantity: balance.quantity,
          repairable: balance.quantity >= 1 - 1e-9 && Math.abs(balance.quantity - Math.round(balance.quantity)) <= 1e-9,
        };
      }).sort((left, right) => left.statusName.localeCompare(right.statusName, 'zh-CN')
        || left.ownerName.localeCompare(right.ownerName, 'zh-CN')),
    }];
  });

  const capacityAnomalies = [...unitById.values()].flatMap((unit) => {
    const totalQuantity = totalForUnit(store, unit.id);
    if (unit.capacity <= 0 || totalQuantity <= unit.capacity + 1e-9) return [];
    const material = materialById.get(unit.materialId);
    return [{
      id: `${unit.id}|capacity`,
      type: 'capacity_exceeded',
      materialId: unit.materialId,
      materialName: material?.name ?? '未知耗材',
      materialUnit: material?.unit ?? '件',
      inventoryUnitId: unit.id,
      inventoryUnitLabel: inventoryUnitDisplayLabel(unit),
      positionCode: '',
      duplicate: false,
      invalidQuantities: false,
      capacity: unit.capacity,
      totalQuantity,
      entries: [],
    }];
  });

  const quantityAnomalies = store.materials
    .filter((material) => !materialId || material.id === materialId)
    .flatMap((material) => {
    if (material.trackingMode === 'quantity') return [];
    const currentTotal = inventorySummary(store, material.id).total;
    if (Math.abs(material.quantity - currentTotal) <= 1e-9) return [];
    return [{
      id: `${material.id}|quantity`,
      type: 'material_quantity_mismatch',
      materialId: material.id,
      materialName: material.name,
      materialUnit: material.unit,
      inventoryUnitId: '',
      inventoryUnitLabel: '',
      positionCode: '',
      duplicate: false,
      invalidQuantities: false,
      storedQuantity: material.quantity,
      totalQuantity: currentTotal,
      entries: [],
    }];
  });

  return [...positionAnomalies, ...capacityAnomalies, ...quantityAnomalies]
    .sort((left, right) => left.materialName.localeCompare(right.materialName, 'zh-CN')
      || left.inventoryUnitLabel.localeCompare(right.inventoryUnitLabel, 'zh-CN', { numeric: true })
      || left.positionCode.localeCompare(right.positionCode, 'zh-CN', { numeric: true }));
}

function totalForUnit(store, unitId) {
  return balancesForUnit(store, unitId).reduce((sum, balance) => sum + balance.quantity, 0);
}

function assertUnitCapacity(store, unit, delta) {
  if (unit.capacity > 0 && totalForUnit(store, unit.id) + delta > unit.capacity + 1e-9) {
    throw Object.assign(new Error(`操作后数量将超过库存单元容量 ${unit.capacity}`), { statusCode: 409 });
  }
}

function inventoryUnitPayload(store, unit) {
  const statusById = new Map(store.inventoryStatuses.map((status) => [status.id, status]));
  const userById = new Map(store.users.map((candidate) => [candidate.id, candidate]));
  const balances = balancesForUnit(store, unit.id).map((balance) => {
    const status = statusById.get(balance.statusId);
    const owner = userById.get(balance.ownerUserId);
    return {
      ...balance,
      statusName: status?.name ?? '未知状态',
      usable: status?.usable ?? false,
      terminal: status?.terminal ?? false,
      ownerName: balance.accessScope === 'user' ? owner?.name ?? '成员已停用或删除' : '',
      displayCode: inventoryUnitDisplayLabel(unit, balance.positionCode),
    };
  }).sort((left, right) => left.displayCode.localeCompare(right.displayCode, 'zh-CN', { numeric: true })
    || left.statusName.localeCompare(right.statusName, 'zh-CN'));
  return {
    ...unit,
    displayLabel: inventoryUnitDisplayLabel(unit),
    quantity: balances.reduce((sum, balance) => sum + balance.quantity, 0),
    balances,
  };
}

function inventoryTransactionSnapshot(store, unit, status, access, owner, positionCode = '') {
  return {
    operation: 'stock',
    inventoryUnitId: unit?.id ?? '',
    inventoryUnitLabel: unit ? inventoryUnitDisplayLabel(unit, positionCode) : '',
    statusId: status?.id ?? '',
    statusName: status?.name ?? '',
    accessScope: access ?? '',
    ownerUserId: owner?.id ?? '',
    ownerName: owner?.name ?? '',
    positionCode,
  };
}

function occurredAtFromInput(value) {
  const occurredAt = value ? new Date(value) : new Date();
  if (Number.isNaN(occurredAt.valueOf())) throw Object.assign(new Error('发生时间无效'), { statusCode: 400 });
  if (occurredAt.valueOf() > Date.now() + 10 * 60_000) throw Object.assign(new Error('发生时间不能晚于当前时间'), { statusCode: 400 });
  return occurredAt.toISOString();
}

function transactionGroupSnapshot(store, user) {
  const group = store.groups.find((candidate) => candidate.id === user.groupId);
  return { groupId: group?.id ?? '', groupName: group?.name ?? '' };
}

function appendInventoryEvent(store, user, payload) {
  const group = transactionGroupSnapshot(store, user);
  const event = {
    id: randomUUID(),
    materialId: payload.materialId,
    materialName: payload.materialName,
    inventoryUnitId: payload.inventoryUnitId,
    inventoryUnitLabel: payload.inventoryUnitLabel ?? '',
    quantity: payload.quantity,
    eventType: payload.eventType,
    fromStatusId: payload.fromStatusId ?? '',
    fromStatusName: payload.fromStatusName ?? '',
    toStatusId: payload.toStatusId ?? '',
    toStatusName: payload.toStatusName ?? '',
    fromAccessScope: payload.fromAccessScope ?? '',
    fromOwnerUserId: payload.fromOwnerUserId ?? '',
    fromOwnerName: payload.fromOwnerName ?? '',
    fromPositionCode: payload.fromPositionCode ?? '',
    toAccessScope: payload.toAccessScope ?? '',
    toOwnerUserId: payload.toOwnerUserId ?? '',
    toOwnerName: payload.toOwnerName ?? '',
    toPositionCode: payload.toPositionCode ?? '',
    userId: user.id,
    userName: user.name,
    ...group,
    counterparty: payload.counterparty ?? '',
    note: payload.note ?? '',
    correctionOfId: payload.correctionOfId ?? '',
    occurredAt: payload.occurredAt,
  };
  store.inventoryEvents.push(event);
  return event;
}

function aggregateUnitForMaterial(store, materialId) {
  return store.inventoryUnits.find((unit) => unit.materialId === materialId && unit.unitType === 'aggregate' && unit.active);
}

function createAggregateUnit(store, materialId) {
  const now = new Date().toISOString();
  const unit = {
    id: randomUUID(),
    materialId,
    unitType: 'aggregate',
    label: '',
    positionCode: '',
    capacity: 0,
    note: '状态化库存的总库存单元',
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  store.inventoryUnits.push(unit);
  return unit;
}

function configureMaterialTracking(store, material, trackingMode, user, initialStatusId = '') {
  if (!['quantity', 'stateful', 'tracked'].includes(trackingMode)) {
    throw Object.assign(new Error('请选择有效的库存追踪模式'), { statusCode: 400 });
  }
  const previousMode = material.trackingMode ?? 'quantity';
  if (previousMode === trackingMode) return;
  const materialUnits = () => store.inventoryUnits.filter((unit) => unit.materialId === material.id);
  const removeMaterialUnits = () => {
    const unitIds = new Set(materialUnits().map((unit) => unit.id));
    store.inventoryUnitBalances = store.inventoryUnitBalances.filter((balance) => !unitIds.has(balance.inventoryUnitId));
    store.inventoryUnits = store.inventoryUnits.filter((unit) => unit.materialId !== material.id);
  };
  if (trackingMode === 'quantity') {
    if (material.quantity !== 0) throw Object.assign(new Error('当前仍有状态化库存，归还或处置后才能切回普通数量模式'), { statusCode: 409 });
    removeMaterialUnits();
    store.inventoryStatuses = store.inventoryStatuses.filter((status) => status.materialId !== material.id);
    material.trackingMode = trackingMode;
    return;
  }

  const statuses = ensureDefaultInventoryStatuses(store, material.id);
  const targetStatus = statuses.find((status) => status.id === initialStatusId && status.active)
    ?? statuses.find((status) => status.code === 'new' && status.active)
    ?? statuses.find((status) => status.active);
  if (!targetStatus) throw Object.assign(new Error('该耗材没有可用的库存状态，请先配置状态'), { statusCode: 409 });
  if (trackingMode === 'tracked' && material.quantity > 0) {
    throw Object.assign(new Error('切换为库存单元模式前，请先把当前数量导入到具体批次、盒子或位置'), { statusCode: 409 });
  }
  if (trackingMode === 'stateful' && previousMode === 'quantity') {
    const unit = createAggregateUnit(store, material.id);
    if (material.quantity > 0) {
      upsertInventoryBalance(store, { inventoryUnitId: unit.id, statusId: targetStatus.id, accessScope: 'shared', ownerUserId: '' }, material.quantity);
      appendInventoryEvent(store, user, {
        materialId: material.id,
        materialName: material.name,
        inventoryUnitId: unit.id,
        quantity: material.quantity,
        eventType: 'adjustment',
        toStatusId: targetStatus.id,
        toStatusName: targetStatus.name,
        toAccessScope: 'shared',
        note: '启用状态管理，现有库存归入初始状态',
        occurredAt: new Date().toISOString(),
      });
    }
  }
  if (trackingMode === 'tracked' && previousMode === 'stateful') {
    if (material.quantity > 0) {
      throw Object.assign(new Error('总库存单元仍有数量，请先拆分到具体库存单元'), { statusCode: 409 });
    }
    removeMaterialUnits();
  }
  if (trackingMode === 'stateful' && previousMode === 'tracked') {
    if (material.quantity > 0) throw Object.assign(new Error('具体库存单元仍有数量，清零后才能改为按状态统计'), { statusCode: 409 });
    removeMaterialUnits();
    createAggregateUnit(store, material.id);
  }
  material.trackingMode = trackingMode;
}

function normalizeBrandIcon(value) {
  const brandIcon = String(value ?? '').trim();
  if (!brandIcon) return '';
  const match = brandIcon.match(/^data:image\/(png|jpeg|webp);base64,([a-z0-9+/]+={0,2})$/i);
  if (!match) throw Object.assign(new Error('图标仅支持 PNG、JPG 或 WebP 图片'), { statusCode: 400 });
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 512 * 1024) throw Object.assign(new Error('图标大小不能超过 512 KB'), { statusCode: 400 });
  const type = match[1].toLowerCase();
  const validSignature = type === 'png'
    ? bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    : type === 'jpeg'
      ? bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
      : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!validSignature) throw Object.assign(new Error('图标文件内容无效'), { statusCode: 400 });
  return `data:image/${type};base64,${match[2]}`;
}

function normalizeUpdatedBrandIcon(value, currentValue) {
  const requested = String(value ?? '').trim();
  if (/^\/api\/brand-icon\?v=[a-f0-9]{16}$/i.test(requested)) return currentValue;
  return normalizeBrandIcon(requested);
}

function validatedTagIds(store, value, fallback = []) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw Object.assign(new Error('成员标签格式无效'), { statusCode: 400 });
  const tagIds = [...new Set(value.map((item) => String(item)))];
  if (tagIds.length > 20) throw Object.assign(new Error('每位成员最多选择 20 个标签'), { statusCode: 400 });
  const validIds = new Set(store.tags.map((tag) => tag.id));
  if (tagIds.some((tagId) => !validIds.has(tagId))) throw Object.assign(new Error('选择了不存在的成员标签'), { statusCode: 400 });
  return tagIds;
}

function transactionTrend(transactions) {
  const now = new Date();
  const months = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (5 - index), 1);
    return { key: `${date.getFullYear()}-${date.getMonth()}`, label: `${date.getMonth() + 1}月`, in: 0, out: 0 };
  });
  const byMonth = new Map(months.map((month) => [month.key, month]));
  transactions.forEach((record) => {
    const date = new Date(record.occurredAt);
    if (Number.isNaN(date.valueOf())) return;
    const month = byMonth.get(`${date.getFullYear()}-${date.getMonth()}`);
    if (month) month[record.type] += 1;
  });
  return months.map(({ key: _key, ...month }) => month);
}

function effectiveStockTransactions(transactions) {
  const correctedQuantity = new Map();
  transactions.forEach((record) => {
    if (!record.correctionOfId) return;
    correctedQuantity.set(record.correctionOfId, (correctedQuantity.get(record.correctionOfId) ?? 0) + record.quantity);
  });
  return transactions
    .filter((record) => !record.correctionOfId)
    .map((record) => ({ ...record, effectiveQuantity: Math.max(0, record.quantity - (correctedQuantity.get(record.id) ?? 0)) }))
    .filter((record) => record.effectiveQuantity > 1e-9);
}

function materialTransactionStats(materials, transactions) {
  const stats = new Map(materials.map((material) => [material.id, {
    materialId: material.id,
    units: new Map(),
    lastInAt: null,
    lastOutAt: null,
  }]));
  for (const record of transactions) {
    const material = stats.get(record.materialId);
    if (!material) continue;
    const unit = String(record.unit ?? '').trim() || '未标注';
    const unitStats = material.units.get(unit) ?? { unit, totalIn: 0, totalOut: 0, inRecords: 0, outRecords: 0 };
    if (record.type === 'in') {
      unitStats.totalIn += record.effectiveQuantity ?? record.quantity;
      unitStats.inRecords += 1;
      if (!material.lastInAt || record.occurredAt > material.lastInAt) material.lastInAt = record.occurredAt;
    } else {
      unitStats.totalOut += record.effectiveQuantity ?? record.quantity;
      unitStats.outRecords += 1;
      if (!material.lastOutAt || record.occurredAt > material.lastOutAt) material.lastOutAt = record.occurredAt;
    }
    material.units.set(unit, unitStats);
  }
  return materials.map((material) => {
    const materialStats = stats.get(material.id);
    const unitStats = materialStats?.units.get(material.unit) ?? {
      unit: material.unit,
      totalIn: 0,
      totalOut: 0,
      inRecords: 0,
      outRecords: 0,
    };
    return {
      materialId: material.id,
      currentUnit: unitStats,
      otherUnits: [...(materialStats?.units.values() ?? [])].filter((item) => item.unit !== material.unit),
      lastInAt: materialStats?.lastInAt ?? null,
      lastOutAt: materialStats?.lastOutAt ?? null,
    };
  });
}

function recentlyUsedMaterialIds(store, user, limit = 20) {
  const activeMaterialIds = new Set(store.materials.filter((material) => material.active).map((material) => material.id));
  const correctedTransactionIds = new Set(store.transactions.map((record) => record.correctionOfId).filter(Boolean));
  const correctedInventoryEventIds = new Set(store.inventoryEvents.map((event) => event.correctionOfId).filter(Boolean));
  const activities = [
    ...store.transactions
      .filter((record) => record.userId === user.id && record.type === 'out' && record.sourceType !== 'inventory_adjustment'
        && !record.correctionOfId && !correctedTransactionIds.has(record.id) && record.operation !== 'dispose')
      .map((record) => ({ materialId: record.materialId, occurredAt: record.occurredAt })),
    ...store.inventoryEvents
      .filter((event) => event.userId === user.id && ['use', 'state_change', 'access_change', 'transfer'].includes(event.eventType)
        && !correctedInventoryEventIds.has(event.id))
      .map((event) => ({ materialId: event.materialId, occurredAt: event.occurredAt })),
  ].sort((left, right) => new Date(right.occurredAt) - new Date(left.occurredAt));
  const result = [];
  const seen = new Set();
  for (const activity of activities) {
    if (!activeMaterialIds.has(activity.materialId) || seen.has(activity.materialId)) continue;
    seen.add(activity.materialId);
    result.push(activity.materialId);
    if (result.length >= limit) break;
  }
  return result;
}

function formatBootstrap(store, user) {
  const operationalMaterials = store.materials.filter((material) => material.active);
  const visibleMaterials = canManageInventory(user) ? store.materials : operationalMaterials;
  const inventorySummaries = new Map(visibleMaterials.map((material) => [material.id, inventorySummary(store, material.id)]));
  const visibleMaterialPayload = visibleMaterials.map((material) => ({
    ...material,
    availableQuantity: material.trackingMode === 'quantity' ? material.quantity : inventorySummaries.get(material.id)?.sharedUsable ?? 0,
  }));
  const transactions = [...store.transactions]
    .filter((record) => canViewAllTransactions(user) || record.userId === user.id)
    .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const effectiveTransactions = effectiveStockTransactions(store.transactions);
  const monthRecords = effectiveTransactions.filter((record) => new Date(record.occurredAt) >= monthStart);
  const monthInbound = monthRecords.filter((record) => record.type === 'in');
  const monthOutbound = monthRecords.filter((record) => record.type === 'out');
  const lowStock = operationalMaterials.filter((material) => {
    const availableQuantity = material.trackingMode === 'quantity' ? material.quantity : inventorySummary(store, material.id).sharedUsable;
    return availableQuantity <= material.safetyStock;
  }).length;
  return {
    version: appVersion,
    user: publicUser(user),
    settings: publicSettings(store.settings),
    groups: [...store.groups].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name, 'zh-CN')),
    tags: [...store.tags].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN-u-co-pinyin')),
    directory: store.users.filter((candidate) => candidate.active).map(directoryUser).sort(compareUsersByName),
    members: canManageMembers(user) ? store.users.map(publicUser).sort(compareUsersByName) : [],
    materials: [...visibleMaterialPayload].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    materialStats: materialTransactionStats(visibleMaterials, effectiveTransactions),
    inventorySummaries: [...inventorySummaries.values()],
    transactions: transactions.slice(0, bootstrapTransactionLimit),
    transactionTotal: transactions.length,
    recentlyUsedMaterialIds: recentlyUsedMaterialIds(store, user),
    stats: {
      items: operationalMaterials.length,
      categories: new Set(operationalMaterials.map((material) => material.category)).size,
      lowStock,
      normalStock: operationalMaterials.length - lowStock,
      monthInRecords: monthInbound.length,
      monthOutRecords: monthOutbound.length,
      monthInMaterials: new Set(monthInbound.map((record) => record.materialId)).size,
      monthOutMaterials: new Set(monthOutbound.map((record) => record.materialId)).size,
    },
    trend: transactionTrend(effectiveTransactions),
  };
}

function formatExportSnapshot(store, user, exportedAt) {
  const bootstrap = formatBootstrap(store, user);
  const transactions = [...store.transactions]
    .filter((record) => canViewAllTransactions(user) || record.userId === user.id)
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id));
  const inventoryEvents = [...store.inventoryEvents]
    .filter((event) => canViewAllTransactions(user) || event.userId === user.id)
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id));
  return {
    exportedAt,
    settings: bootstrap.settings,
    groups: bootstrap.groups,
    directory: bootstrap.directory,
    materials: bootstrap.materials,
    materialStats: bootstrap.materialStats,
    transactions,
    total: transactions.length,
    inventoryEvents,
    eventTotal: inventoryEvents.length,
  };
}

async function handleApi(request, response, url) {
  if (url.pathname === '/api/health' && request.method === 'GET') return sendJson(response, 200, { ok: true, version: appVersion });

  if (url.pathname === '/api/brand-icon' && (request.method === 'GET' || request.method === 'HEAD')) {
    const view = requestStorage.getStore() ?? storage.readView;
    return sendBrandIcon(request, response, view.readSettings() ?? defaultSettings, url.searchParams.get('v'));
  }

  if (url.pathname === '/api/public-settings' && (request.method === 'GET' || request.method === 'HEAD')) {
    const view = requestStorage.getStore() ?? storage.readView;
    return sendRevalidatedJson(request, response, { settings: publicSettings(view.readSettings() ?? defaultSettings), version: appVersion });
  }

  if (url.pathname === '/api/login' && request.method === 'POST') {
    const { username = '', password = '' } = await readJsonBody(request);
    const attempt = loginAttemptState(request, username);
    if (attempt.limited) {
      return sendJson(response, 429, { error: '登录尝试过多，请 15 分钟后再试' }, {
        'Retry-After': String(attempt.retryAfterSeconds),
      });
    }
    if (String(password).length > 128) {
      loginProtection.recordFailure(attempt);
      return sendJson(response, 401, { error: '账号或密码不正确' });
    }
    const view = requestStorage.getStore();
    const user = view.readActiveUserByUsername(String(username).trim());
    if (!user || !verifyPassword(String(password), user)) {
      loginProtection.recordFailure(attempt);
      return sendJson(response, 401, { error: '账号或密码不正确' });
    }
    loginProtection.resetAccount(attempt);
    user.lastLoginAt = new Date().toISOString();
    view.updateUserLastLogin(user.id, user.lastLoginAt);
    const token = randomBytes(32).toString('hex');
    view.createSession(token, user.id, Date.now() + sessionMaxAgeMs);
    return sendJson(response, 200, { user: publicUser(user) }, { 'Set-Cookie': `${sessionCookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionMaxAgeMs / 1000}${secureCookieSuffix(request)}` });
  }

  if (url.pathname === '/api/logout' && request.method === 'POST') {
    const token = parseCookies(request)[sessionCookieName];
    if (token) requestStorage.getStore().deleteSession(token);
    return sendJson(response, 200, { ok: true }, { 'Set-Cookie': `${sessionCookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookieSuffix(request)}` });
  }

  const session = getSession(request);
  if (!session) return sendJson(response, 401, { error: '请先登录' });

  if (url.pathname === '/api/audit-logs' && request.method === 'GET') {
    const view = requestStorage.getStore() ?? storage.readView;
    const user = view.readActiveUser(session.userId);
    if (!user) return sendJson(response, 401, { error: '账号已停用' });
    if (!isSystemAdmin(user)) return sendJson(response, 403, { error: '只有系统所有者或系统管理员可以查看系统审计记录' });
    const options = auditPageOptions(url);
    const exportAll = url.searchParams.get('mode') === 'export';
    const page = view.queryAuditLogs({ ...options, cursor: exportAll ? null : options.cursor, exportAll });
    return sendJson(response, 200, {
      items: page.items,
      total: page.total,
      hasMore: page.hasMore,
      nextCursor: encodeAuditCursor(page.nextCursor),
      exportedAt: exportAll ? new Date().toISOString() : undefined,
    });
  }

  if (url.pathname === '/api/stocktakes' && request.method === 'GET') {
    const view = requestStorage.getStore() ?? storage.readView;
    const user = view.readActiveUser(session.userId);
    if (!user) return sendJson(response, 401, { error: '账号已停用' });
    if (!canManageInventory(user)) return sendJson(response, 403, { error: '只有库存管理员及以上身份可以查看盘点任务' });
    return sendJson(response, 200, { stocktakes: view.queryStocktakes() });
  }

  if (url.pathname === '/api/stocktakes' && request.method === 'POST') {
    const view = requestStorage.getStore();
    const user = view.readActiveUser(session.userId);
    if (!user) return sendJson(response, 401, { error: '账号已停用' });
    if (!canManageInventory(user)) return sendJson(response, 403, { error: '只有库存管理员及以上身份可以创建盘点任务' });
    const input = await readJsonBody(request);
    const title = String(input.title ?? '').trim();
    const category = String(input.category ?? '').trim();
    const materialId = String(input.materialId ?? '').trim();
    if (!title || title.length > 80) return sendJson(response, 400, { error: '盘点批次名称需为 1-80 个字符' });
    if (category.length > 80) return sendJson(response, 400, { error: '盘点分类不能超过 80 个字符' });
    if (materialId.length > 120) return sendJson(response, 400, { error: '盘点耗材编号无效' });
    if (category && materialId) return sendJson(response, 400, { error: '盘点范围只能选择分类或单项耗材其中一种' });

    const store = view.readCurrentInventoryStore();
    const selectedMaterial = materialId ? store.materials.find((material) => material.id === materialId && material.active) : null;
    if (materialId && !selectedMaterial) return sendJson(response, 404, { error: '所选耗材不存在或已归档，请重新选择' });
    const materials = selectedMaterial
      ? [selectedMaterial]
      : store.materials.filter((material) => material.active && (!category || material.category === category));
    const items = [];
    for (const material of materials) {
      if (material.trackingMode === 'quantity') {
        items.push({
          id: randomUUID(), scopeType: 'material', materialId: material.id, materialName: material.name,
          materialUnit: material.unit, trackingMode: material.trackingMode, inventoryUnitId: '', inventoryUnitLabel: '',
          expectedQuantity: material.quantity,
        });
        continue;
      }
      for (const unit of store.inventoryUnits.filter((candidate) => candidate.materialId === material.id && candidate.active)) {
        const expectedQuantity = store.inventoryUnitBalances
          .filter((balance) => balance.inventoryUnitId === unit.id)
          .reduce((total, balance) => total + balance.quantity, 0);
        items.push({
          id: randomUUID(), scopeType: 'inventory_unit', materialId: material.id, materialName: material.name,
          materialUnit: material.unit, trackingMode: material.trackingMode, inventoryUnitId: unit.id,
          inventoryUnitLabel: inventoryUnitDisplayLabel(unit), expectedQuantity,
        });
      }
    }
    if (!items.length) return sendJson(response, 409, {
      error: selectedMaterial
        ? `“${selectedMaterial.name}”当前没有可盘点的在用库存单元`
        : category ? '该分类没有可盘点的使用中耗材或库存单元' : '当前没有可盘点的使用中耗材或库存单元',
    });

    const requestedKeys = new Set(items.map((item) => `${item.scopeType}:${item.materialId}:${item.inventoryUnitId}`));
    for (const existing of view.queryStocktakes().filter((stocktake) => stocktake.status === 'open')) {
      const detail = view.readStocktake(existing.id);
      const overlap = detail?.items.find((item) => requestedKeys.has(`${item.scopeType}:${item.materialId}:${item.inventoryUnitId}`));
      if (overlap) return sendJson(response, 409, { error: `“${overlap.materialName}${overlap.inventoryUnitLabel ? ` · ${overlap.inventoryUnitLabel}` : ''}”已在未完成盘点“${existing.title}”中` });
    }

    const stocktake = {
      id: randomUUID(), title, status: 'open', createdByUserId: user.id, createdByName: user.name,
      createdAt: new Date().toISOString(), completedByUserId: '', completedByName: '', completedAt: '',
    };
    await writeStore({ operation: 'stocktakeCreate', stocktake, items });
    await appendAuditLog(request, user, {
      action: 'stocktake.create', targetType: 'stocktake', targetId: stocktake.id, targetName: stocktake.title,
      summary: `创建盘点任务：${stocktake.title}`,
      after: {
        status: 'open',
        scope: selectedMaterial ? `单项耗材 · ${selectedMaterial.name}` : category ? `分类 · ${category}` : '全部使用中耗材',
        materialId: selectedMaterial?.id ?? '',
        itemCount: items.length,
      },
    });
    return sendJson(response, 201, { stocktake: view.readStocktake(stocktake.id) });
  }

  const stocktakeDetailMatch = url.pathname.match(/^\/api\/stocktakes\/([^/]+)$/);
  if (stocktakeDetailMatch && request.method === 'GET') {
    const view = requestStorage.getStore() ?? storage.readView;
    const user = view.readActiveUser(session.userId);
    if (!user) return sendJson(response, 401, { error: '账号已停用' });
    if (!canManageInventory(user)) return sendJson(response, 403, { error: '只有库存管理员及以上身份可以查看盘点任务' });
    const stocktake = view.readStocktake(decodeURIComponent(stocktakeDetailMatch[1]));
    return stocktake ? sendJson(response, 200, { stocktake }) : sendJson(response, 404, { error: '盘点任务不存在' });
  }

  const stocktakeItemMatch = url.pathname.match(/^\/api\/stocktakes\/([^/]+)\/items\/([^/]+)$/);
  if (stocktakeItemMatch && request.method === 'PATCH') {
    const view = requestStorage.getStore();
    const user = view.readActiveUser(session.userId);
    if (!user) return sendJson(response, 401, { error: '账号已停用' });
    if (!canManageInventory(user)) return sendJson(response, 403, { error: '只有库存管理员及以上身份可以登记盘点结果' });
    const stocktakeId = decodeURIComponent(stocktakeItemMatch[1]);
    const itemId = decodeURIComponent(stocktakeItemMatch[2]);
    const stocktake = view.readStocktake(stocktakeId);
    if (!stocktake) return sendJson(response, 404, { error: '盘点任务不存在' });
    if (stocktake.status !== 'open') return sendJson(response, 409, { error: '已完成的盘点不能修改' });
    const item = stocktake.items.find((candidate) => candidate.id === itemId);
    if (!item) return sendJson(response, 404, { error: '盘点明细不存在' });
    const input = await readJsonBody(request);
    if (input.countedQuantity === undefined || input.countedQuantity === null || input.countedQuantity === '') {
      return sendJson(response, 400, { error: '请填写实盘数量' });
    }
    const countedQuantity = Number(input.countedQuantity);
    const reason = String(input.reason ?? '').trim();
    const resolutionNote = String(input.resolutionNote ?? '').trim();
    if (!Number.isFinite(countedQuantity) || countedQuantity < 0) return sendJson(response, 400, { error: '实盘数量必须是大于或等于 0 的数字' });
    if (reason.length > 300) return sendJson(response, 400, { error: '差异原因不能超过 300 个字符' });
    if (resolutionNote.length > 500) return sendJson(response, 400, { error: '处理说明不能超过 500 个字符' });
    if (Math.abs(countedQuantity - item.expectedQuantity) > 1e-9 && !reason) return sendJson(response, 400, { error: '实盘数量与账面不一致，请填写差异原因' });
    const countedAt = new Date().toISOString();
    await writeStore({
      operation: 'stocktakeItemUpdate', stocktakeId, itemId, countedQuantity, reason, resolutionNote,
      countedByUserId: user.id, countedByName: user.name, countedAt,
    });
    await appendAuditLog(request, user, {
      action: 'stocktake.count_update', targetType: 'stocktake', targetId: stocktake.id, targetName: stocktake.title,
      summary: `登记盘点数量：${item.materialName}${item.inventoryUnitLabel ? ` · ${item.inventoryUnitLabel}` : ''}`,
      before: { itemId, countedQuantity: item.countedQuantity, reason: item.reason, resolutionNote: item.resolutionNote },
      after: { itemId, expectedQuantity: item.expectedQuantity, countedQuantity, reason, resolutionNote },
    });
    return sendJson(response, 200, { stocktake: view.readStocktake(stocktakeId) });
  }

  const stocktakeCompleteMatch = url.pathname.match(/^\/api\/stocktakes\/([^/]+)\/complete$/);
  if (stocktakeCompleteMatch && request.method === 'POST') {
    const view = requestStorage.getStore();
    const user = view.readActiveUser(session.userId);
    if (!user) return sendJson(response, 401, { error: '账号已停用' });
    if (!canManageInventory(user)) return sendJson(response, 403, { error: '只有库存管理员及以上身份可以完成盘点任务' });
    const stocktakeId = decodeURIComponent(stocktakeCompleteMatch[1]);
    const stocktake = view.readStocktake(stocktakeId);
    if (!stocktake) return sendJson(response, 404, { error: '盘点任务不存在' });
    if (stocktake.status !== 'open') return sendJson(response, 409, { error: '该盘点任务已经完成' });
    const uncounted = stocktake.items.find((item) => item.countedQuantity == null);
    if (uncounted) return sendJson(response, 409, { error: `请先登记“${uncounted.materialName}${uncounted.inventoryUnitLabel ? ` · ${uncounted.inventoryUnitLabel}` : ''}”的实盘数量` });

    const currentStore = view.readCurrentInventoryStore();
    const materials = currentStore.materials;
    const completedAt = new Date().toISOString();
    const group = view.readGroup(user.groupId);
    const resolutions = [];
    for (const item of stocktake.items) {
      const currentMaterial = currentStore.materials.find((candidate) => candidate.id === item.materialId && candidate.active);
      if (!currentMaterial) return sendJson(response, 409, { error: `“${item.materialName}”已归档或删除，不能完成盘点` });
      if (item.scopeType === 'inventory_unit') {
        const currentUnit = currentStore.inventoryUnits.find((candidate) => candidate.id === item.inventoryUnitId && candidate.active);
        if (!currentUnit) return sendJson(response, 409, { error: `“${item.materialName} · ${item.inventoryUnitLabel}”已归档或不存在，不能完成盘点` });
      }
      if (item.currentQuantity == null) return sendJson(response, 409, { error: `“${item.materialName}”已被归档、删除或库存单元不存在，不能完成盘点` });
      const hasDifference = Math.abs(item.countedQuantity - item.expectedQuantity) > 1e-9;
      if (hasDifference && !item.reason) return sendJson(response, 409, { error: `“${item.materialName}”存在差异，请先填写原因` });
      if (item.scopeType === 'inventory_unit') {
        if (Math.abs(item.currentQuantity - item.countedQuantity) > 1e-9) {
          return sendJson(response, 409, { error: `“${item.materialName} · ${item.inventoryUnitLabel}”当前仍为 ${item.currentQuantity} ${item.materialUnit}；请先在库存明细中逐根修正到实盘数量 ${item.countedQuantity}` });
        }
        if (hasDifference && !item.resolutionNote) return sendJson(response, 409, { error: `“${item.materialName} · ${item.inventoryUnitLabel}”有差异，请填写处理说明` });
        resolutions.push({ itemId: item.id, material: null, transaction: null });
        continue;
      }
      if (Math.abs(item.currentQuantity - item.expectedQuantity) > 1e-9) {
        return sendJson(response, 409, { error: `“${item.materialName}”盘点期间库存已从 ${item.expectedQuantity} 变为 ${item.currentQuantity} ${item.materialUnit}，请重新建立盘点任务复核` });
      }
      const difference = item.countedQuantity - item.currentQuantity;
      if (Math.abs(difference) <= 1e-9) {
        resolutions.push({ itemId: item.id, material: null, transaction: null });
        continue;
      }
      const material = materials.find((candidate) => candidate.id === item.materialId);
      if (!material || !material.active || material.trackingMode !== 'quantity') return sendJson(response, 409, { error: `“${item.materialName}”当前不能自动调整，请重新复核` });
      material.quantity = item.countedQuantity;
      material.updatedAt = completedAt;
      const transaction = {
        id: randomUUID(), type: difference > 0 ? 'in' : 'out', materialId: material.id, materialName: material.name,
        quantity: Math.abs(difference), unit: material.unit, userId: user.id, userName: user.name,
        groupId: group?.id ?? '', groupName: group?.name ?? '', sourceType: 'inventory_adjustment', counterparty: '盘点差异复核',
        note: `盘点“${stocktake.title}”：${item.reason}${item.resolutionNote ? `；处理：${item.resolutionNote}` : ''}`,
        occurredAt: completedAt, operation: 'stock', inventoryUnitId: '', inventoryUnitLabel: '', statusId: '', statusName: '',
        accessScope: '', ownerUserId: '', ownerName: '', positionCode: '', correctionOfId: '',
      };
      resolutions.push({ itemId: item.id, material, transaction });
    }
    await writeStore({
      operation: 'stocktakeComplete', stocktakeId, completedByUserId: user.id, completedByName: user.name,
      completedAt, resolutions,
    });
    const adjustmentTransactionIds = resolutions.flatMap((resolution) => resolution.transaction ? [resolution.transaction.id] : []);
    await appendAuditLog(request, user, {
      action: 'stocktake.complete', targetType: 'stocktake', targetId: stocktake.id, targetName: stocktake.title,
      summary: `完成盘点任务：${stocktake.title}`, before: { status: 'open', itemCount: stocktake.items.length },
      after: { status: 'completed', differenceCount: stocktake.items.filter((item) => Math.abs(item.countedQuantity - item.expectedQuantity) > 1e-9).length, adjustmentTransactionIds },
    });
    return sendJson(response, 200, { stocktake: view.readStocktake(stocktakeId) });
  }

  const stocktakeCancelMatch = url.pathname.match(/^\/api\/stocktakes\/([^/]+)\/cancel$/);
  if (stocktakeCancelMatch && request.method === 'POST') {
    const view = requestStorage.getStore();
    const user = view.readActiveUser(session.userId);
    if (!user) return sendJson(response, 401, { error: '账号已停用' });
    if (!canManageInventory(user)) return sendJson(response, 403, { error: '只有库存管理员及以上身份可以取消盘点任务' });
    const stocktakeId = decodeURIComponent(stocktakeCancelMatch[1]);
    const stocktake = view.readStocktake(stocktakeId);
    if (!stocktake) return sendJson(response, 404, { error: '盘点任务不存在' });
    if (stocktake.status !== 'open') return sendJson(response, 409, { error: '只有未完成的盘点任务可以取消' });
    const input = await readJsonBody(request);
    const cancellationReason = String(input.reason ?? '').trim();
    if (!cancellationReason || cancellationReason.length > 300) {
      return sendJson(response, 400, { error: '取消原因需为 1-300 个字符' });
    }
    const cancelledAt = new Date().toISOString();
    await writeStore({
      operation: 'stocktakeCancel', stocktakeId, cancellationReason,
      cancelledByUserId: user.id, cancelledByName: user.name, cancelledAt,
    });
    await appendAuditLog(request, user, {
      action: 'stocktake.cancel', targetType: 'stocktake', targetId: stocktake.id, targetName: stocktake.title,
      summary: `取消盘点任务：${stocktake.title}`, before: { status: 'open' },
      after: { status: 'cancelled', cancellationReason },
    });
    return sendJson(response, 200, { stocktake: view.readStocktake(stocktakeId) });
  }

  if (url.pathname === '/api/transactions' && request.method === 'GET') {
    const view = requestStorage.getStore() ?? storage.readView;
    if (url.searchParams.get('mode') === 'export') {
      const { store, exportedAt } = view.readStoreSnapshot();
      const user = store.users.find((candidate) => candidate.id === session.userId && candidate.active);
      if (!user) return sendJson(response, 401, { error: '账号已停用' });
      return sendJson(response, 200, formatExportSnapshot(store, user, exportedAt));
    }
    const user = view.readActiveUser(session.userId);
    if (!user) return sendJson(response, 401, { error: '账号已停用' });
    if (url.searchParams.get('mode') === 'page') {
      const page = view.queryRecordPage(recordPageOptions(url, {
        userId: user.id,
        canViewAll: canViewAllTransactions(user),
      }));
      return sendJson(response, 200, {
        items: page.items,
        total: page.total,
        hasMore: page.hasMore,
        nextCursor: encodeRecordCursor(page.nextCursor),
      });
    }
    const query = canViewAllTransactions(user) ? {} : { userId: user.id };
    const transactions = view.queryTransactions(query);
    const result = { transactions, total: transactions.length };
    if (url.searchParams.get('includeInventoryEvents') === '1') {
      result.inventoryEvents = view.queryInventoryEvents(query);
      result.eventTotal = result.inventoryEvents.length;
    }
    return sendJson(response, 200, result);
  }

  if (url.pathname === '/api/transactions' && request.method === 'POST') {
    const view = requestStorage.getStore();
    const user = view.readActiveUser(session.userId);
    if (!user) return sendJson(response, 401, { error: '账号已停用' });
    const input = await readJsonBody(request);
    const type = input.type === 'out' ? 'out' : input.type === 'in' ? 'in' : null;
    const quantity = Number(input.quantity);
    const requestedName = String(input.materialName ?? '').trim();
    const counterparty = String(input.counterparty ?? '').trim();
    const note = String(input.note ?? '').trim();
    const materials = view.readMaterials();
    let material = materials.find((item) => item.id === input.materialId || (requestedName && item.name.toLowerCase() === requestedName.toLowerCase()));
    if (!type || !Number.isFinite(quantity) || quantity <= 0) return sendJson(response, 400, { error: '耗材、类型或数量无效' });
    if (counterparty.length > 120) return sendJson(response, 400, { error: '来源或去向不能超过 120 个字符' });
    if (note.length > 500) return sendJson(response, 400, { error: '备注不能超过 500 个字符' });
    let createdMaterial = false;
    if (!material && type === 'in' && requestedName) {
      const safetyStock = Number(input.safetyStock ?? 0);
      const spec = String(input.spec ?? '').trim();
      const category = String(input.category ?? '未分类').trim() || '未分类';
      const unit = String(input.unit ?? '件').trim() || '件';
      if (requestedName.length > 120) return sendJson(response, 400, { error: '耗材名称不能超过 120 个字符' });
      if (category.length > 80) return sendJson(response, 400, { error: '分类不能超过 80 个字符' });
      if (spec.length > 120) return sendJson(response, 400, { error: '规格、型号不能超过 120 个字符' });
      if (unit.length > 20) return sendJson(response, 400, { error: '单位不能超过 20 个字符' });
      if (!Number.isFinite(safetyStock) || safetyStock < 0) return sendJson(response, 400, { error: '安全库存必须是大于或等于 0 的数字' });
      const duplicate = similarMaterial({ materials }, requestedName);
      if (duplicate) return sendJson(response, 409, { error: `可能与已有耗材“${duplicate.name}”重复，请从候选项中选择；不同规格请在名称中写明` });
      material = {
        id: randomUUID(),
        name: requestedName,
        category,
        quantity: 0,
        safetyStock,
        unit,
        spec,
        trackingMode: 'quantity',
        positionCodeHelp: '',
        usageContextHelp: '',
        active: true,
        updatedAt: new Date().toISOString(),
      };
      createdMaterial = true;
    }
    if (!material) return sendJson(response, 400, { error: type === 'out' ? '出库必须选择已有耗材' : '请填写或选择耗材' });
    if (!material.active) return sendJson(response, 409, { error: `耗材“${material.name}”已归档，请先由管理员恢复` });
    if (material.trackingMode !== 'quantity') return sendJson(response, 409, { error: `耗材“${material.name}”启用了状态化库存，请在库存单元登记中选择状态和使用范围` });
    if (type === 'out' && material.quantity < quantity) return sendJson(response, 409, { error: `${material.name} 库存不足，当前仅 ${material.quantity} ${material.unit}` });
    material.quantity += type === 'in' ? quantity : -quantity;
    material.updatedAt = new Date().toISOString();
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    if (Number.isNaN(occurredAt.valueOf())) return sendJson(response, 400, { error: '发生时间无效' });
    if (occurredAt.valueOf() > Date.now() + 10 * 60_000) return sendJson(response, 400, { error: '发生时间不能晚于当前时间' });
    const transactionGroup = view.readGroup(user.groupId);
    const transaction = {
      id: randomUUID(), type, materialId: material.id, materialName: material.name, quantity, unit: material.unit,
      userId: user.id, userName: user.name, groupId: transactionGroup?.id ?? '', groupName: transactionGroup?.name ?? '', sourceType: 'manual', counterparty,
      note, occurredAt: occurredAt.toISOString(), operation: 'stock', inventoryUnitId: '', inventoryUnitLabel: '', statusId: '', statusName: '', accessScope: '', ownerUserId: '', ownerName: '', positionCode: '',
    };
    await writeStore({ operation: 'quantityTransaction', material, transaction, createdMaterial });
    return sendJson(response, 201, { transaction, material, createdMaterial });
  }

  const directTransactionCorrectionMatch = url.pathname.match(/^\/api\/transactions\/([^/]+)\/correction$/);
  if (directTransactionCorrectionMatch && request.method === 'POST') {
    const view = requestStorage.getStore();
    const user = view.readActiveUser(session.userId);
    if (!user) return sendJson(response, 401, { error: '账号已停用' });
    const original = view.readTransaction(decodeURIComponent(directTransactionCorrectionMatch[1]));
    if (!original) return sendJson(response, 404, { error: '原始登记不存在' });

    // Unit-tracked corrections still require the full balance and ownership model below.
    if (!original.inventoryUnitId) {
      if (original.userId !== user.id && user.role !== 'admin') return sendJson(response, 403, { error: '成员只能更正自己的登记；系统管理员可以更正全部登记' });
      if (original.sourceType !== 'manual' || original.correctionOfId) return sendJson(response, 409, { error: '只有原始手工登记可以更正' });
      if (view.hasTransactionCorrection(original.id)) return sendJson(response, 409, { error: '这笔登记已经更正，不能重复操作' });
      const input = await readJsonBody(request);
      const quantity = Number(input.quantity ?? original.quantity);
      const reason = String(input.reason ?? '').trim();
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > original.quantity + 1e-9) return sendJson(response, 400, { error: `更正数量应大于 0 且不超过原登记的 ${original.quantity} ${original.unit}` });
      if (!reason || reason.length > 300) return sendJson(response, 400, { error: '请填写 1-300 个字符的更正原因' });
      const material = view.readMaterials().find((candidate) => candidate.id === original.materialId);
      if (!material || !material.active) return sendJson(response, 409, { error: '原耗材已归档或删除，不能在线反向更正，请联系系统管理员' });
      if (material.trackingMode !== 'quantity') return sendJson(response, 409, { error: '原登记与当前库存管理方式不一致，不能自动更正' });
      const correctionType = original.type === 'in' ? 'out' : 'in';
      if (correctionType === 'out' && material.quantity < quantity) return sendJson(response, 409, { error: `当前库存只有 ${material.quantity} ${material.unit}，不足以冲销原入库` });
      const occurredAt = new Date().toISOString();
      material.quantity += correctionType === 'in' ? quantity : -quantity;
      material.updatedAt = occurredAt;
      const group = view.readGroup(user.groupId);
      const correction = {
        id: randomUUID(), type: correctionType, materialId: original.materialId, materialName: original.materialName, quantity, unit: original.unit,
        userId: user.id, userName: user.name, groupId: group?.id ?? '', groupName: group?.name ?? '', sourceType: 'manual', counterparty: '更正原登记',
        note: `更正 ${original.id.slice(0, 8)}：${reason}`, occurredAt, operation: 'stock',
        inventoryUnitId: '', inventoryUnitLabel: '', statusId: '', statusName: '', accessScope: '', ownerUserId: '', ownerName: '', positionCode: '',
        correctionOfId: original.id,
      };
      await writeStore({ operation: 'quantityTransaction', material, transaction: correction, createdMaterial: false });
      return sendJson(response, 201, { transaction: correction, material });
    }
  }

  if (url.pathname === '/api/import' && request.method === 'POST') {
    const view = requestStorage.getStore();
    const user = view.readActiveUser(session.userId);
    if (!user) return sendJson(response, 401, { error: '账号已停用' });
    if (!canManageInventory(user)) return sendJson(response, 403, { error: '只有库存管理员及以上身份可以批量导入' });
    const input = await readJsonBody(request);
    const plan = planQuantityImport({
      rows: input.rows,
      materials: view.readMaterials(),
      user,
      group: view.readGroup(user.groupId),
    });
    if (!plan.ok) return sendJson(response, plan.status, { error: plan.error });
    await writeStore({ operation: 'quantityImport', materials: plan.materials, transactions: plan.transactions });
    return sendJson(response, 200, { imported: plan.imported, adjustments: plan.adjustments });
  }

  const currentInventoryRequest = (
    url.pathname === '/api/inventory-units'
    || /^\/api\/inventory-units\/[^/]+\/(operation|status)$/.test(url.pathname)
    || url.pathname === '/api/inventory-anomalies'
    || url.pathname === '/api/inventory-anomalies/position/resolve'
    || url.pathname === '/api/inventory-statuses'
    || /^\/api\/inventory-statuses\/[^/]+$/.test(url.pathname)
  );
  const view = requestStorage.getStore();
  const store = currentInventoryRequest && view?.readCurrentInventoryStore
    ? view.readCurrentInventoryStore()
    : await readStore();
  const user = store.users.find((candidate) => candidate.id === session.userId && candidate.active);
  if (!user) return sendJson(response, 401, { error: '账号已停用' });

  if (url.pathname === '/api/admin/database-restore/authorize' && request.method === 'POST') {
    if (!isOwner(user)) return sendJson(response, 403, { error: '只有系统所有者可以恢复数据库' });
    const input = await readJsonBody(request);
    if (!verifyPassword(String(input.currentPassword ?? ''), user)) return sendJson(response, 400, { error: '当前密码不正确' });
    cleanupRestoreAuthorizations();
    const token = randomBytes(32).toString('hex');
    restoreAuthorizations.set(token, { userId: user.id, expiresAt: Date.now() + 5 * 60_000 });
    return sendJson(response, 200, { token, expiresInSeconds: 300 });
  }

  if (url.pathname === '/api/bootstrap' && request.method === 'GET') return sendJson(response, 200, formatBootstrap(store, user));

  if (url.pathname === '/api/settings' && request.method === 'PATCH') {
    if (!canManageSettings(user)) return sendJson(response, 403, { error: '只有系统所有者或系统管理员可以修改实验室信息' });
    const input = await readJsonBody(request);
    const appName = String(input.appName ?? '').trim();
    const labName = String(input.labName ?? '').trim();
    if (!appName) return sendJson(response, 400, { error: '请填写系统显示名称' });
    if (appName.length > 30) return sendJson(response, 400, { error: '系统显示名称不能超过 30 个字符' });
    if (!labName) return sendJson(response, 400, { error: '请填写实验室名称' });
    if (labName.length > 100) return sendJson(response, 400, { error: '实验室名称不能超过 100 个字符' });
    store.settings = { appName, labName, brandIcon: normalizeUpdatedBrandIcon(input.brandIcon, store.settings.brandIcon) };
    await writeStore({ operation: 'syncStore', store });
    return sendJson(response, 200, { settings: publicSettings(store.settings) });
  }

  if (url.pathname === '/api/groups' && request.method === 'POST') {
    if (!canManageSettings(user)) return sendJson(response, 403, { error: '只有系统所有者或系统管理员可以添加分组' });
    const input = await readJsonBody(request);
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 40) return sendJson(response, 400, { error: '分组名称需为 1-40 个字符' });
    if (store.groups.some((group) => group.name.toLowerCase() === name.toLowerCase())) return sendJson(response, 409, { error: '该分组名称已存在' });
    const group = { id: randomUUID(), name, isDefault: false };
    store.groups.push(group);
    await writeStore({ operation: 'syncStore', store });
    return sendJson(response, 201, { group });
  }

  const groupActionMatch = url.pathname.match(/^\/api\/groups\/([^/]+)$/);
  if (groupActionMatch && ['PATCH', 'DELETE'].includes(request.method ?? '')) {
    if (!canManageSettings(user)) return sendJson(response, 403, { error: '只有系统所有者或系统管理员可以管理分组' });
    const groupId = decodeURIComponent(groupActionMatch[1]);
    const group = store.groups.find((candidate) => candidate.id === groupId);
    if (!group) return sendJson(response, 404, { error: '分组不存在' });
    if (request.method === 'PATCH') {
      const input = await readJsonBody(request);
      if (input.name !== undefined) {
        const name = String(input.name).trim();
        if (!name || name.length > 40) return sendJson(response, 400, { error: '分组名称需为 1-40 个字符' });
        if (store.groups.some((candidate) => candidate.id !== group.id && candidate.name.toLowerCase() === name.toLowerCase())) return sendJson(response, 409, { error: '该分组名称已存在' });
        group.name = name;
      }
      if (input.isDefault === true) store.groups.forEach((candidate) => { candidate.isDefault = candidate.id === group.id; });
      await writeStore({ operation: 'syncStore', store });
      return sendJson(response, 200, { group });
    }
    if (store.groups.length <= 1) return sendJson(response, 400, { error: '至少需要保留一个分组' });
    if (store.users.some((candidate) => candidate.groupId === group.id)) return sendJson(response, 409, { error: '请先将该组成员移动到其他分组' });
    store.groups = store.groups.filter((candidate) => candidate.id !== group.id);
    if (group.isDefault) store.groups[0].isDefault = true;
    await writeStore({ operation: 'syncStore', store });
    return sendJson(response, 200, { ok: true });
  }

  if (url.pathname === '/api/tags' && request.method === 'POST') {
    if (!canManageSettings(user)) return sendJson(response, 403, { error: '只有系统所有者或系统管理员可以添加标签' });
    const input = await readJsonBody(request);
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 24) return sendJson(response, 400, { error: '标签名称需为 1-24 个字符' });
    if (store.tags.length >= 50) return sendJson(response, 409, { error: '成员标签最多创建 50 个，请合并重复标签' });
    if (store.tags.some((tag) => tag.name.toLowerCase() === name.toLowerCase())) return sendJson(response, 409, { error: '该标签名称已存在' });
    const tag = { id: randomUUID(), name };
    store.tags.push(tag);
    await writeStore({ operation: 'syncStore', store });
    return sendJson(response, 201, { tag });
  }

  const tagActionMatch = url.pathname.match(/^\/api\/tags\/([^/]+)$/);
  if (tagActionMatch && ['PATCH', 'DELETE'].includes(request.method ?? '')) {
    if (!canManageSettings(user)) return sendJson(response, 403, { error: '只有系统所有者或系统管理员可以管理标签' });
    const tagId = decodeURIComponent(tagActionMatch[1]);
    const tag = store.tags.find((candidate) => candidate.id === tagId);
    if (!tag) return sendJson(response, 404, { error: '标签不存在' });
    if (request.method === 'PATCH') {
      const input = await readJsonBody(request);
      const name = String(input.name ?? '').trim();
      if (!name || name.length > 24) return sendJson(response, 400, { error: '标签名称需为 1-24 个字符' });
      if (store.tags.some((candidate) => candidate.id !== tag.id && candidate.name.toLowerCase() === name.toLowerCase())) return sendJson(response, 409, { error: '该标签名称已存在' });
      tag.name = name;
      await writeStore({ operation: 'syncStore', store });
      return sendJson(response, 200, { tag });
    }
    store.tags = store.tags.filter((candidate) => candidate.id !== tag.id);
    await writeStore({ operation: 'syncStore', store });
    return sendJson(response, 200, { ok: true });
  }

  if (url.pathname === '/api/materials' && request.method === 'POST') {
    if (!canManageInventory(user)) return sendJson(response, 403, { error: '只有库存管理员及以上身份可以新增耗材' });
    const input = await readJsonBody(request);
    const name = String(input.name ?? '').trim();
    const category = String(input.category ?? '').trim();
    const spec = String(input.spec ?? '').trim();
    const unit = String(input.unit ?? '').trim();
    const safetyStock = Number(input.safetyStock ?? 0);
    const trackingMode = String(input.trackingMode ?? 'quantity');
    const positionCodeHelp = String(input.positionCodeHelp ?? '').trim();
    const usageContextHelp = String(input.usageContextHelp ?? '').trim();
    if (!name || name.length > 120) return sendJson(response, 400, { error: '耗材名称需为 1-120 个字符' });
    if (!category || category.length > 80) return sendJson(response, 400, { error: '请填写有效分类' });
    if (spec.length > 120) return sendJson(response, 400, { error: '规格、型号不能超过 120 个字符' });
    if (!unit || unit.length > 20) return sendJson(response, 400, { error: '请填写有效单位' });
    if (!Number.isFinite(safetyStock) || safetyStock < 0) return sendJson(response, 400, { error: '安全库存必须是大于或等于 0 的数字' });
    if (!['quantity', 'stateful', 'tracked'].includes(trackingMode)) return sendJson(response, 400, { error: '请选择有效的库存追踪模式' });
    if (positionCodeHelp.length > 200 || usageContextHelp.length > 200) return sendJson(response, 400, { error: '登记字段说明不能超过 200 个字符' });
    const duplicate = similarMaterial(store, name);
    if (duplicate) return sendJson(response, 409, { error: `可能与已有耗材“${duplicate.name}”重复；不同规格请在名称中写明，例如“移液枪头 200 μL”` });
    const material = {
      id: randomUUID(), name, category, spec, unit, safetyStock, quantity: 0,
      active: true,
      trackingMode,
      positionCodeHelp,
      usageContextHelp,
      updatedAt: new Date().toISOString(),
    };
    store.materials.push(material);
    if (trackingMode !== 'quantity') {
      ensureDefaultInventoryStatuses(store, material.id);
      if (trackingMode === 'stateful') createAggregateUnit(store, material.id);
    }
    await writeStore({ operation: 'syncStore', store });
    return sendJson(response, 201, { material });
  }

  const materialActionMatch = url.pathname.match(/^\/api\/materials\/([^/]+)$/);
  if (materialActionMatch && request.method === 'PATCH') {
    if (!canManageInventory(user)) return sendJson(response, 403, { error: '只有库存管理员及以上身份可以维护耗材信息' });
    const material = store.materials.find((candidate) => candidate.id === decodeURIComponent(materialActionMatch[1]));
    if (!material) return sendJson(response, 404, { error: '耗材不存在' });
    const input = await readJsonBody(request);
    const name = String(input.name ?? '').trim();
    const category = String(input.category ?? '').trim();
    const spec = String(input.spec ?? '').trim();
    const unit = String(input.unit ?? '').trim();
    const safetyStock = Number(input.safetyStock);
    const trackingMode = input.trackingMode === undefined ? material.trackingMode : String(input.trackingMode);
    const positionCodeHelp = String(input.positionCodeHelp ?? material.positionCodeHelp ?? '').trim();
    const usageContextHelp = String(input.usageContextHelp ?? material.usageContextHelp ?? '').trim();
    if (!name || name.length > 120) return sendJson(response, 400, { error: '耗材名称需为 1-120 个字符' });
    if (!category || category.length > 80) return sendJson(response, 400, { error: '请填写有效分类' });
    if (spec.length > 120) return sendJson(response, 400, { error: '规格、型号不能超过 120 个字符' });
    if (!unit || unit.length > 20) return sendJson(response, 400, { error: '请填写有效单位' });
    if (!Number.isFinite(safetyStock) || safetyStock < 0) return sendJson(response, 400, { error: '安全库存必须是大于或等于 0 的数字' });
    if (!['quantity', 'stateful', 'tracked'].includes(trackingMode)) return sendJson(response, 400, { error: '请选择有效的库存追踪模式' });
    if (positionCodeHelp.length > 200 || usageContextHelp.length > 200) return sendJson(response, 400, { error: '登记字段说明不能超过 200 个字符' });
    const duplicate = similarMaterial(store, name, material.id);
    if (duplicate) return sendJson(response, 409, { error: `可能与已有耗材“${duplicate.name}”重复；请在名称中保留清楚的规格差异` });
    if (unit !== material.unit && material.quantity !== 0) {
      return sendJson(response, 409, { error: `当前仍有 ${material.quantity} ${material.unit} 库存，不能直接更改单位；请先将库存调整为 0` });
    }
    Object.assign(material, { name, category, spec, unit, safetyStock, positionCodeHelp, usageContextHelp, updatedAt: new Date().toISOString() });
    configureMaterialTracking(store, material, trackingMode, user, String(input.initialStatusId ?? ''));
    material.updatedAt = new Date().toISOString();
    await writeStore({ operation: 'syncStore', store });
    return sendJson(response, 200, { material });
  }

  const materialStatusMatch = url.pathname.match(/^\/api\/materials\/([^/]+)\/status$/);
  if (materialStatusMatch && request.method === 'PATCH') {
    if (!canManageInventory(user)) return sendJson(response, 403, { error: '只有库存管理员及以上身份可以管理耗材状态' });
    const material = store.materials.find((candidate) => candidate.id === decodeURIComponent(materialStatusMatch[1]));
    if (!material) return sendJson(response, 404, { error: '耗材不存在' });
    const input = await readJsonBody(request);
    const status = ['active', 'archived'].includes(input.status) ? input.status : null;
    if (!status) return sendJson(response, 400, { error: '请选择有效的耗材状态' });
    if (status !== 'active' && material.quantity !== 0) {
      return sendJson(response, 409, { error: `当前仍有 ${material.quantity} ${material.unit} 库存，请先通过出库或库存调整归零` });
    }
    material.active = status === 'active';
    material.updatedAt = new Date().toISOString();
    await writeStore({ operation: 'syncStore', store });
    return sendJson(response, 200, { material });
  }

  if (materialActionMatch && request.method === 'DELETE') {
    if (!isSystemAdmin(user)) return sendJson(response, 403, { error: '只有系统所有者或系统管理员可以彻底删除耗材' });
    const material = store.materials.find((candidate) => candidate.id === decodeURIComponent(materialActionMatch[1]));
    if (!material) return sendJson(response, 404, { error: '耗材不存在' });
    if (material.quantity !== 0) return sendJson(response, 409, { error: '仍有库存的耗材不能彻底删除' });
    const unitIds = new Set(store.inventoryUnits.filter((unit) => unit.materialId === material.id).map((unit) => unit.id));
    if (store.inventoryUnitBalances.some((balance) => unitIds.has(balance.inventoryUnitId))) {
      return sendJson(response, 409, { error: '该耗材仍有库存单元明细，请先完成出库或处置' });
    }
    store.materials = store.materials.filter((candidate) => candidate.id !== material.id);
    store.inventoryStatuses = store.inventoryStatuses.filter((status) => status.materialId !== material.id);
    store.inventoryUnits = store.inventoryUnits.filter((unit) => unit.materialId !== material.id);
    await writeStore({ operation: 'syncStore', store });
    return sendJson(response, 200, { ok: true });
  }

  if (url.pathname === '/api/inventory-statuses' && request.method === 'POST') {
    if (!canManageInventory(user)) return sendJson(response, 403, { error: '只有库存管理员及以上身份可以新增库存状态' });
    const input = await readJsonBody(request);
    const material = store.materials.find((candidate) => candidate.id === String(input.materialId ?? ''));
    if (!material) return sendJson(response, 404, { error: '耗材不存在' });
    if (material.trackingMode === 'quantity') return sendJson(response, 409, { error: '请先为该耗材启用状态管理' });
    const name = String(input.name ?? '').trim();
    const requestedCode = String(input.code ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    const code = requestedCode || `status-${randomUUID().slice(0, 8)}`;
    if (!name || name.length > 30) return sendJson(response, 400, { error: '状态名称需为 1-30 个字符' });
    if (statusesForMaterial(store, material.id, { includeInactive: true }).length >= 20) return sendJson(response, 409, { error: '单个耗材最多配置 20 个状态' });
    if (store.inventoryStatuses.some((status) => status.materialId === material.id && (status.code === code || status.name.toLowerCase() === name.toLowerCase()))) {
      return sendJson(response, 409, { error: '该耗材已存在同名或同代码状态' });
    }
    const status = {
      id: randomUUID(), materialId: material.id, code, name,
      usable: input.terminal === true ? false : input.usable !== false, terminal: input.terminal === true, active: true,
      sortOrder: Number.isInteger(Number(input.sortOrder)) ? Number(input.sortOrder) : 100,
    };
    store.inventoryStatuses.push(status);
    await writeStore({ operation: 'syncStore', store });
    return sendJson(response, 201, { status });
  }

  const inventoryStatusMatch = url.pathname.match(/^\/api\/inventory-statuses\/([^/]+)$/);
  if (inventoryStatusMatch && request.method === 'PATCH') {
    if (!canManageInventory(user)) return sendJson(response, 403, { error: '只有库存管理员及以上身份可以维护库存状态' });
    const status = store.inventoryStatuses.find((candidate) => candidate.id === decodeURIComponent(inventoryStatusMatch[1]));
    if (!status) return sendJson(response, 404, { error: '库存状态不存在' });
    const input = await readJsonBody(request);
    const name = String(input.name ?? status.name).trim();
    if (!name || name.length > 30) return sendJson(response, 400, { error: '状态名称需为 1-30 个字符' });
    if (store.inventoryStatuses.some((candidate) => candidate.id !== status.id && candidate.materialId === status.materialId && candidate.name.toLowerCase() === name.toLowerCase())) {
      return sendJson(response, 409, { error: '该耗材已存在同名状态' });
    }
    const hasBalance = store.inventoryUnitBalances.some((balance) => balance.statusId === status.id);
    const nextTerminal = input.terminal === undefined ? status.terminal : input.terminal === true;
    const nextUsable = nextTerminal ? false : input.usable === undefined ? status.usable : input.usable === true;
    if (hasBalance && (nextUsable !== status.usable || nextTerminal !== status.terminal)) {
      return sendJson(response, 409, { error: '该状态仍有库存，不能改变可用性语义；请先将库存转入其他状态' });
    }
    if (input.active === false && hasBalance) return sendJson(response, 409, { error: '该状态仍有库存，不能停用；请先完成状态变更' });
    status.name = name;
    status.usable = nextUsable;
    status.terminal = nextTerminal;
    if (input.active !== undefined) status.active = input.active === true;
    if (!status.active && !statusesForMaterial(store, status.materialId).some((candidate) => candidate.id !== status.id)) {
      return sendJson(response, 409, { error: '至少需要保留一个启用中的库存状态' });
    }
    if (input.sortOrder !== undefined && Number.isInteger(Number(input.sortOrder))) status.sortOrder = Number(input.sortOrder);
    await writeStore({ operation: 'syncStore', store });
    return sendJson(response, 200, { status });
  }

  if (url.pathname === '/api/inventory-anomalies' && request.method === 'GET') {
    if (!isSystemAdmin(user)) return sendJson(response, 403, { error: '只有系统所有者或系统管理员可以查看库存数据异常' });
    const materialId = String(url.searchParams.get('materialId') ?? '');
    if (materialId && !store.materials.some((material) => material.id === materialId)) {
      return sendJson(response, 404, { error: '耗材不存在' });
    }
    const anomalies = inventoryAnomaliesForStore(store, { materialId });
    return sendJson(response, 200, {
      anomalies,
      total: anomalies.length,
      affectedBalanceCount: anomalies.reduce((sum, anomaly) => sum + anomaly.entries.length, 0),
    });
  }

  if (url.pathname === '/api/inventory-anomalies/position/resolve' && request.method === 'POST') {
    if (!isSystemAdmin(user)) return sendJson(response, 403, { error: '只有系统所有者或系统管理员可以修复库存数据异常' });
    const input = await readJsonBody(request);
    const unit = store.inventoryUnits.find((candidate) => candidate.id === String(input.inventoryUnitId ?? ''));
    if (!unit) return sendJson(response, 404, { error: '库存单元不存在' });
    const material = store.materials.find((candidate) => candidate.id === unit.materialId);
    if (!material) return sendJson(response, 404, { error: '库存单元对应的耗材不存在' });
    const fromPositionCode = normalizedPositionCode(input.fromPositionCode);
    const toPositionCode = normalizedPositionCode(input.toPositionCode);
    const reason = String(input.reason ?? '').trim();
    if (!fromPositionCode) return sendJson(response, 400, { error: '原位置编号不能为空' });
    if (!toPositionCode) return sendJson(response, 400, { error: '请填写新的位置编号' });
    if (toPositionCode === fromPositionCode) return sendJson(response, 400, { error: '新位置不能与异常位置相同' });
    if (!reason || reason.length > 300) return sendJson(response, 400, { error: '请填写 1-300 个字符的修复原因' });

    const fromAccess = validateAccessSource(store, input.fromAccessScope === 'user' ? 'user' : 'shared', input.fromOwnerUserId);
    const status = store.inventoryStatuses.find((candidate) => candidate.id === String(input.fromStatusId ?? '') && candidate.materialId === material.id);
    if (!status) return sendJson(response, 409, { error: '异常明细对应的库存状态已不存在，请刷新后重试' });
    const fromIdentity = {
      inventoryUnitId: unit.id,
      statusId: status.id,
      accessScope: fromAccess.accessScope,
      ownerUserId: fromAccess.ownerUserId,
      positionCode: fromPositionCode,
    };
    const sourceBalance = store.inventoryUnitBalances.find((balance) => balanceIdentity(balance) === balanceIdentity(fromIdentity));
    if (!sourceBalance || sourceBalance.quantity < 1 - 1e-9 || Math.abs(sourceBalance.quantity - Math.round(sourceBalance.quantity)) > 1e-9) {
      return sendJson(response, 409, { error: '异常明细已变化或数量不足，请刷新后重试' });
    }
    const positionBalances = balancesForUnit(store, unit.id)
      .filter((balance) => balance.positionCode === fromPositionCode && balance.quantity > 1e-9);
    if (positionBalances.length < 2 && Math.abs(sourceBalance.quantity - 1) <= 1e-9) {
      return sendJson(response, 409, { error: '该位置异常已经处理，请刷新库存明细' });
    }

    const targetIdentity = { ...fromIdentity, positionCode: toPositionCode };
    assertPositionBalance(store, targetIdentity, 1);
    upsertInventoryBalance(store, fromIdentity, -1);
    upsertInventoryBalance(store, targetIdentity, 1);
    const occurredAt = new Date().toISOString();
    const event = appendInventoryEvent(store, user, {
      materialId: material.id,
      materialName: material.name,
      inventoryUnitId: unit.id,
      inventoryUnitLabel: inventoryUnitDisplayLabel(unit, toPositionCode),
      quantity: 1,
      eventType: 'adjustment',
      fromStatusId: status.id,
      fromStatusName: status.name,
      toStatusId: status.id,
      toStatusName: status.name,
      fromAccessScope: fromAccess.accessScope,
      fromOwnerUserId: fromAccess.ownerUserId,
      fromOwnerName: fromAccess.owner?.name ?? '',
      fromPositionCode,
      toAccessScope: fromAccess.accessScope,
      toOwnerUserId: fromAccess.ownerUserId,
      toOwnerName: fromAccess.owner?.name ?? '',
      toPositionCode,
      counterparty: '旧数据异常修复',
      note: `位置异常修复：${reason}`,
      occurredAt,
    });
    unit.updatedAt = occurredAt;
    refreshTrackedMaterialQuantity(store, material);
    await writeStore({ operation: 'syncStore', store });
    return sendJson(response, 200, {
      event,
      unit: inventoryUnitPayload(store, unit),
      remainingAnomalies: inventoryAnomaliesForStore(store, { materialId: material.id }).length,
    });
  }

  if (url.pathname === '/api/inventory-units' && request.method === 'GET') {
    const materialId = String(url.searchParams.get('materialId') ?? '');
    const unitId = String(url.searchParams.get('unitId') ?? '');
    const query = String(url.searchParams.get('q') ?? '').trim().toLocaleLowerCase('zh-CN');
    const material = materialId ? store.materials.find((candidate) => candidate.id === materialId) : null;
    if (materialId && !material) return sendJson(response, 404, { error: '耗材不存在' });
    if (unitId && !store.inventoryUnits.some((unit) => unit.id === unitId)) return sendJson(response, 404, { error: '库存单元不存在，可能已被删除或不属于当前系统' });
    const units = store.inventoryUnits
      .filter((unit) => (!materialId || unit.materialId === materialId) && (!unitId || unit.id === unitId) && (unit.active || canManageInventory(user) || unitId === unit.id))
      .map((unit) => inventoryUnitPayload(store, unit))
      .filter((unit) => !query || matchesInventorySearch(`${unit.displayLabel} ${unit.label} ${unit.positionCode} ${unit.note} ${unit.balances.map((balance) => `${balance.displayCode} ${balance.statusName} ${balance.ownerName}`).join(' ')}`, query))
      .sort((left, right) => left.displayLabel.localeCompare(right.displayLabel, 'zh-CN', { numeric: true }));
    const resolvedMaterial = material ?? (unitId ? store.materials.find((candidate) => candidate.id === units[0]?.materialId) : null);
    return sendJson(response, 200, {
      material: resolvedMaterial ?? null,
      summary: resolvedMaterial ? inventorySummary(store, resolvedMaterial.id) : null,
      statuses: resolvedMaterial ? statusesForMaterial(store, resolvedMaterial.id, { includeInactive: canManageInventory(user) }) : store.inventoryStatuses.filter((status) => status.active || canManageInventory(user)),
      units,
      total: units.length,
    });
  }

  if (url.pathname === '/api/inventory-units' && request.method === 'POST') {
    const input = await readJsonBody(request);
    const material = store.materials.find((candidate) => candidate.id === String(input.materialId ?? ''));
    if (!material) return sendJson(response, 404, { error: '耗材不存在' });
    if (!material.active) return sendJson(response, 409, { error: '已归档耗材不能新增库存单元，请先恢复' });
    if (material.trackingMode !== 'tracked') return sendJson(response, 409, { error: '只有按库存单元追踪的耗材可以新增盒、批次或序列单元' });
    const unitType = ['lot', 'container', 'position'].includes(input.unitType) ? input.unitType : material.trackingMode === 'tracked' ? 'container' : 'aggregate';
    const label = String(input.label ?? '').trim();
    const positionCode = String(input.positionCode ?? '').trim();
    const note = String(input.note ?? '').trim();
    const counterparty = String(input.counterparty ?? '').trim();
    const capacity = Number(input.capacity ?? 0);
    if (label.length > 80 || positionCode.length > 40) return sendJson(response, 400, { error: '批次或盒标签不能超过 80 个字符，位置编号不能超过 40 个字符' });
    if (unitType !== 'aggregate' && !label && !positionCode) return sendJson(response, 400, { error: '库存单元需要填写批次、盒标签或位置编号' });
    if (!Number.isFinite(capacity) || capacity < 0) return sendJson(response, 400, { error: '容量必须是大于或等于 0 的数字' });
    if (note.length > 500) return sendJson(response, 400, { error: '库存单元备注不能超过 500 个字符' });
    if (counterparty.length > 120) return sendJson(response, 400, { error: '来源不能超过 120 个字符' });
    if (store.inventoryUnits.some((unit) => unit.materialId === material.id && unit.label === label && unit.positionCode === positionCode)) return sendJson(response, 409, { error: '该耗材已存在同名库存单元' });
    const statuses = statusesForMaterial(store, material.id);
    if (!statuses.length) return sendJson(response, 409, { error: '该耗材还没有可用状态，请先配置状态' });
    const rawBalances = Array.isArray(input.balances) ? input.balances : [{ statusId: input.statusId, quantity: input.quantity, accessScope: input.accessScope, ownerUserId: input.ownerUserId, positionCode: input.balancePositionCode }];
    const statusById = new Map(statuses.map((status) => [status.id, status]));
    const balances = [];
    for (const raw of rawBalances) {
      const status = statusById.get(String(raw?.statusId ?? ''));
      const quantity = Number(raw?.quantity);
      if (!status || !Number.isFinite(quantity) || quantity <= 0) return sendJson(response, 400, { error: '库存单元的状态或数量无效' });
      const access = validateAccessTarget(store, raw?.accessScope === 'user' ? 'user' : 'shared', raw?.ownerUserId);
      if (user.role !== 'admin' && access.accessScope === 'user' && access.ownerUserId !== user.id) return sendJson(response, 403, { error: '只有系统管理员可以把自用库存登记给其他成员' });
      if (!canManageInventory(user) && status.terminal) return sendJson(response, 403, { error: '不可用状态只能由库存管理员直接入库' });
      const positionCode = normalizedPositionCode(raw?.positionCode);
      const identity = { inventoryUnitId: '', statusId: status.id, accessScope: access.accessScope, ownerUserId: access.ownerUserId, positionCode };
      if (positionCode && Math.abs(quantity - 1) > 1e-9) return sendJson(response, 400, { error: '填写位置编号时，每个位置的数量必须为 1' });
      if (positionCode && balances.some((balance) => balance.positionCode === positionCode)) return sendJson(response, 409, { error: `位置“${positionCode}”在当前库存单元中重复` });
      const existing = balances.find((balance) => balanceIdentity(balance) === balanceIdentity(identity));
      if (existing) existing.quantity += quantity;
      else balances.push({ ...identity, quantity, status, owner: access.owner });
    }
    const totalQuantity = balances.reduce((sum, balance) => sum + balance.quantity, 0);
    if (capacity > 0 && totalQuantity > capacity) return sendJson(response, 400, { error: '库存单元数量不能超过容量' });
    const occurredAt = occurredAtFromInput(input.occurredAt);
    const now = new Date().toISOString();
    const unit = { id: randomUUID(), materialId: material.id, unitType, label, positionCode, capacity, note, active: true, createdAt: now, updatedAt: now };
    store.inventoryUnits.push(unit);
    for (const balance of balances) {
      upsertInventoryBalance(store, { inventoryUnitId: unit.id, statusId: balance.status.id, accessScope: balance.accessScope, ownerUserId: balance.ownerUserId, positionCode: balance.positionCode }, balance.quantity);
      const group = transactionGroupSnapshot(store, user);
      store.transactions.push({
        id: randomUUID(), type: 'in', materialId: material.id, materialName: material.name, quantity: balance.quantity, unit: material.unit,
        userId: user.id, userName: user.name, ...group, sourceType: 'manual', counterparty, note: note || '新增库存单元', occurredAt,
        ...inventoryTransactionSnapshot(store, unit, balance.status, balance.accessScope, balance.owner, balance.positionCode),
      });
    }
    refreshTrackedMaterialQuantity(store, material);
    await writeStore({ operation: 'syncStore', store });
    return sendJson(response, 201, { unit: inventoryUnitPayload(store, unit), material, summary: inventorySummary(store, material.id) });
  }

  const inventoryUnitOperationMatch = url.pathname.match(/^\/api\/inventory-units\/([^/]+)\/operation$/);
  if (inventoryUnitOperationMatch && request.method === 'POST') {
    const unit = store.inventoryUnits.find((candidate) => candidate.id === decodeURIComponent(inventoryUnitOperationMatch[1]));
    if (!unit) return sendJson(response, 404, { error: '库存单元不存在' });
    const material = store.materials.find((candidate) => candidate.id === unit.materialId);
    if (!material) return sendJson(response, 404, { error: '库存单元对应的耗材不存在' });
    if (!material.active) return sendJson(response, 409, { error: '耗材已归档，请先恢复耗材档案' });
    if (!unit.active) return sendJson(response, 409, { error: '该库存单元已归档，请先恢复后再登记' });
    const input = await readJsonBody(request);
    const operation = ['in', 'use', 'out', 'state_change', 'access_change', 'position_change', 'dispose'].includes(input.operation) ? input.operation : null;
    const quantity = Number(input.quantity);
    if (!operation || !Number.isFinite(quantity) || quantity <= 0) return sendJson(response, 400, { error: '库存单元操作或数量无效' });
    const statuses = statusesForMaterial(store, material.id);
    const statusById = new Map(statuses.map((status) => [status.id, status]));
    const isInbound = operation === 'in';
    const occurredAt = occurredAtFromInput(input.occurredAt);
    const note = String(input.note ?? '').trim();
    const counterparty = String(input.counterparty ?? '').trim();
    if (note.length > 500) return sendJson(response, 400, { error: '备注不能超过 500 个字符' });
    if (counterparty.length > 120) return sendJson(response, 400, { error: '来源或去向不能超过 120 个字符' });
    let fromStatus = null;
    let fromAccess = null;
    let fromPositionCode = '';
    let sourceBalance = null;
    let targetStatus = null;
    let targetAccess = null;
    let targetPositionCode = '';

    if (isInbound) {
      targetStatus = statusById.get(String(input.toStatusId ?? input.statusId ?? ''));
      if (!targetStatus) return sendJson(response, 400, { error: '请选择有效的入库状态' });
      targetAccess = validateAccessTarget(store, input.toAccessScope === 'user' || input.accessScope === 'user' ? 'user' : 'shared', input.toOwnerUserId ?? input.ownerUserId);
      targetPositionCode = normalizedPositionCode(input.toPositionCode ?? input.positionCode);
      if (user.role !== 'admin' && targetAccess.accessScope === 'user' && targetAccess.ownerUserId !== user.id) return sendJson(response, 403, { error: '只有系统管理员可以把自用库存登记给其他成员' });
      if (!canManageInventory(user) && targetStatus.terminal) return sendJson(response, 403, { error: '不可用状态只能由库存管理员直接入库' });
      assertUnitCapacity(store, unit, quantity);
      const targetIdentity = {
        inventoryUnitId: unit.id,
        statusId: targetStatus.id,
        accessScope: targetAccess.accessScope,
        ownerUserId: targetAccess.ownerUserId,
        positionCode: targetPositionCode,
      };
      assertPositionBalance(store, targetIdentity, quantity);
      upsertInventoryBalance(store, targetIdentity, quantity);
    } else {
      fromStatus = statusById.get(String(input.fromStatusId ?? ''));
      if (!fromStatus) return sendJson(response, 400, { error: '请选择有效的原状态' });
      fromAccess = validateAccessSource(store, input.fromAccessScope === 'user' ? 'user' : 'shared', input.fromOwnerUserId);
      fromPositionCode = normalizedPositionCode(input.fromPositionCode);
      const fromIdentity = {
        inventoryUnitId: unit.id,
        statusId: fromStatus.id,
        accessScope: fromAccess.accessScope,
        ownerUserId: fromAccess.ownerUserId,
        positionCode: fromPositionCode,
      };
      sourceBalance = store.inventoryUnitBalances.find((balance) => balanceIdentity(balance) === balanceIdentity(fromIdentity));
      if (!sourceBalance || sourceBalance.quantity < quantity) return sendJson(response, 409, { error: `该明细只有 ${sourceBalance?.quantity ?? 0} ${material.unit}` });
      if (fromPositionCode && (Math.abs(sourceBalance.quantity - 1) > 1e-9 || Math.abs(quantity - sourceBalance.quantity) > 1e-9)) {
        return sendJson(response, 409, { error: '按位置追踪的库存必须是一件且整条登记；旧数据异常请联系系统管理员处理' });
      }
      const firstUseStatus = operation === 'use' && fromStatus.code === 'new'
        ? statuses.find((status) => status.code === 'active' && status.active && status.usable && !status.terminal)
          ?? statuses.find((status) => status.id !== fromStatus.id && status.active && status.usable && !status.terminal)
        : null;
      if (operation === 'use' && fromStatus.code === 'new' && !firstUseStatus) {
        return sendJson(response, 409, { error: '全新库存首次使用后必须进入另一个可用状态，请先启用或新增“已启用”状态' });
      }
      targetStatus = operation === 'state_change' ? statusById.get(String(input.toStatusId ?? '')) : firstUseStatus ?? fromStatus;
      if (!targetStatus) return sendJson(response, 400, { error: '请选择有效的新状态' });
      targetAccess = operation === 'access_change'
        ? validateAccessTarget(store, input.toAccessScope === 'user' ? 'user' : 'shared', input.toOwnerUserId)
        : fromAccess;
      targetPositionCode = normalizedPositionCode(input.toPositionCode ?? fromPositionCode);
      const requiresContainerPosition = unit.unitType === 'container' && !fromPositionCode
        && ['use', 'state_change', 'access_change', 'position_change'].includes(operation);
      if (requiresContainerPosition) {
        if (!targetPositionCode) return sendJson(response, 400, { error: '操作盒内单件时必须填写唯一位置或单件编号，例如 2-2' });
        if (Math.abs(quantity - 1) > 1e-9) return sendJson(response, 400, { error: '操作盒内具体位置时数量必须为 1' });
      }
      if (fromPositionCode && operation !== 'position_change' && targetPositionCode !== fromPositionCode) {
        return sendJson(response, 400, { error: '当前操作不能同时调整格位，请单独选择“调整格位”' });
      }

      if (operation === 'access_change') {
        if (!canChangeInventoryAccess(user, sourceBalance, targetAccess)) return sendJson(response, 403, { error: '普通成员只能把开放库存设为本人自用，或把本人自用库存重新开放' });
      } else if (operation === 'use' && !canRegisterInventoryUse(user, sourceBalance)) {
        return sendJson(response, 403, { error: '该库存明细属于其他成员自用，只有自用人可以登记使用' });
      } else if (!canUseInventoryBalance(user, sourceBalance)) {
        return sendJson(response, 403, { error: '该库存明细属于其他成员自用，不能登记' });
      }
      if (['use', 'out'].includes(operation) && !fromStatus.usable) return sendJson(response, 409, { error: '不可用库存不能登记使用，请选择处置或由管理员修正状态' });
      if (operation === 'dispose' && fromStatus.usable && !canManageInventory(user)) return sendJson(response, 409, { error: '请先将状态改为不可用，再登记处置' });
      if (fromStatus.terminal && !canManageInventory(user) && operation !== 'dispose') return sendJson(response, 403, { error: '不可用状态只能由库存管理员修正或由成员处置' });
      if (['state_change', 'access_change', 'position_change'].includes(operation)
        && targetStatus.id === fromStatus.id
        && targetAccess.accessScope === fromAccess.accessScope
        && targetAccess.ownerUserId === fromAccess.ownerUserId
        && targetPositionCode === fromPositionCode) {
        return sendJson(response, 400, { error: '状态、使用范围或位置没有变化' });
      }

      const targetIdentity = {
        inventoryUnitId: unit.id,
        statusId: targetStatus.id,
        accessScope: targetAccess.accessScope,
        ownerUserId: targetAccess.ownerUserId,
        positionCode: targetPositionCode,
      };
      const movesBalance = ['state_change', 'access_change', 'position_change'].includes(operation)
        || (operation === 'use' && balanceIdentity(targetIdentity) !== balanceIdentity(fromIdentity));
      if (movesBalance) {
        assertPositionBalance(store, targetIdentity, quantity, { ignoreIdentity: fromIdentity });
      }

      if (operation !== 'use' || movesBalance) upsertInventoryBalance(store, fromIdentity, -quantity);
      if (movesBalance) {
        upsertInventoryBalance(store, targetIdentity, quantity);
      }
    }

    let transaction = null;
    if (operation === 'out' || operation === 'in' || operation === 'dispose') {
      const group = transactionGroupSnapshot(store, user);
      const snapshotStatus = isInbound ? targetStatus : fromStatus;
      const snapshotAccess = isInbound ? targetAccess : fromAccess;
      const snapshotPositionCode = isInbound ? targetPositionCode : fromPositionCode;
      transaction = {
        id: randomUUID(), type: isInbound ? 'in' : 'out', materialId: material.id, materialName: material.name, quantity, unit: material.unit,
        userId: user.id, userName: user.name, ...group, sourceType: 'manual', counterparty, note, occurredAt,
        ...inventoryTransactionSnapshot(store, unit, snapshotStatus, snapshotAccess.accessScope, snapshotAccess.owner, snapshotPositionCode),
        operation: operation === 'dispose' ? 'dispose' : 'stock',
      };
      store.transactions.push(transaction);
    }
    let inventoryEvent = null;
    if (['use', 'state_change', 'access_change', 'position_change', 'dispose'].includes(operation)) {
      inventoryEvent = appendInventoryEvent(store, user, {
        materialId: material.id, materialName: material.name, inventoryUnitId: unit.id, inventoryUnitLabel: inventoryUnitDisplayLabel(unit, operation === 'dispose' ? fromPositionCode : targetPositionCode || fromPositionCode), quantity,
        eventType: operation === 'position_change' ? 'transfer' : operation,
        fromStatusId: fromStatus.id, fromStatusName: fromStatus.name,
        toStatusId: operation === 'dispose' ? '' : targetStatus.id, toStatusName: operation === 'dispose' ? '' : targetStatus.name,
        fromAccessScope: fromAccess.accessScope, fromOwnerUserId: fromAccess.ownerUserId, fromOwnerName: fromAccess.owner?.name ?? '',
        fromPositionCode,
        toAccessScope: operation === 'dispose' ? '' : targetAccess.accessScope,
        toOwnerUserId: operation === 'dispose' ? '' : targetAccess.ownerUserId,
        toOwnerName: operation === 'dispose' ? '' : targetAccess.owner?.name ?? '',
        toPositionCode: operation === 'dispose' ? '' : targetPositionCode,
        counterparty, note, occurredAt,
      });
    }
    unit.updatedAt = new Date().toISOString();
    refreshTrackedMaterialQuantity(store, material);
    await writeStore({ operation: 'syncStore', store });
    return sendJson(response, 200, { unit: inventoryUnitPayload(store, unit), material, transaction, inventoryEvent, summary: inventorySummary(store, material.id) });
  }

  const inventoryUnitStatusMatch = url.pathname.match(/^\/api\/inventory-units\/([^/]+)\/status$/);
  if (inventoryUnitStatusMatch && request.method === 'PATCH') {
    if (!canManageInventory(user)) return sendJson(response, 403, { error: '只有库存管理员及以上身份可以归档或恢复库存单元' });
    const unit = store.inventoryUnits.find((candidate) => candidate.id === decodeURIComponent(inventoryUnitStatusMatch[1]));
    if (!unit) return sendJson(response, 404, { error: '库存单元不存在' });
    if (unit.unitType === 'aggregate') return sendJson(response, 409, { error: '按状态统计的总库存单元不能单独归档' });
    const input = await readJsonBody(request);
    const status = input.status === 'active' ? 'active' : input.status === 'archived' ? 'archived' : '';
    if (!status) return sendJson(response, 400, { error: '请选择有效的库存单元状态' });
    if (status === 'archived' && totalForUnit(store, unit.id) > 0) return sendJson(response, 409, { error: '库存单元仍有数量，清零后才能归档' });
    const material = store.materials.find((candidate) => candidate.id === unit.materialId);
    if (status === 'active' && !material?.active) return sendJson(response, 409, { error: '请先恢复对应的耗材档案' });
    unit.active = status === 'active';
    unit.updatedAt = new Date().toISOString();
    await writeStore({ operation: 'syncStore', store });
    return sendJson(response, 200, { unit: inventoryUnitPayload(store, unit) });
  }

  if (url.pathname === '/api/inventory-events' && request.method === 'GET') {
    const materialId = String(url.searchParams.get('materialId') ?? '');
    const unitId = String(url.searchParams.get('unitId') ?? '');
    const query = String(url.searchParams.get('q') ?? '').trim().toLocaleLowerCase('zh-CN');
    const requestedLimit = Number(url.searchParams.get('limit') ?? 200);
    const limit = Number.isInteger(requestedLimit) ? Math.min(500, Math.max(1, requestedLimit)) : 200;
    const events = [...store.inventoryEvents]
      .filter((event) => (!materialId || event.materialId === materialId) && (!unitId || event.inventoryUnitId === unitId))
      .filter((event) => !query || `${event.materialName} ${event.inventoryUnitLabel} ${event.fromPositionCode} ${event.toPositionCode} ${event.fromStatusName} ${event.toStatusName} ${event.fromOwnerName} ${event.toOwnerName} ${event.userName} ${event.counterparty} ${event.note}`.toLocaleLowerCase('zh-CN').includes(query))
      .sort((left, right) => new Date(right.occurredAt) - new Date(left.occurredAt));
    return sendJson(response, 200, { events: events.slice(0, limit), total: events.length });
  }

  const inventoryEventCorrectionMatch = url.pathname.match(/^\/api\/inventory-events\/([^/]+)\/correction$/);
  if (inventoryEventCorrectionMatch && request.method === 'POST') {
    const original = store.inventoryEvents.find((event) => event.id === decodeURIComponent(inventoryEventCorrectionMatch[1]));
    if (!original) return sendJson(response, 404, { error: '原始使用登记不存在' });
    if (original.userId !== user.id && user.role !== 'admin') return sendJson(response, 403, { error: '成员只能更正自己的使用登记；系统管理员可以更正全部登记' });
    if (original.eventType !== 'use' || original.correctionOfId) return sendJson(response, 409, { error: '只有原始使用登记可以更正' });
    if (store.inventoryEvents.some((event) => event.correctionOfId === original.id)) return sendJson(response, 409, { error: '这笔使用登记已经更正，不能重复操作' });
    const input = await readJsonBody(request);
    const reason = String(input.reason ?? '').trim();
    if (!reason || reason.length > 300) return sendJson(response, 400, { error: '请填写 1-300 个字符的更正原因' });
    const correction = appendInventoryEvent(store, user, {
      materialId: original.materialId,
      materialName: original.materialName,
      inventoryUnitId: original.inventoryUnitId,
      inventoryUnitLabel: original.inventoryUnitLabel,
      quantity: original.quantity,
      eventType: 'use_correction',
      fromStatusId: original.fromStatusId,
      fromStatusName: original.fromStatusName,
      toStatusId: original.toStatusId,
      toStatusName: original.toStatusName,
      fromAccessScope: original.fromAccessScope,
      fromOwnerUserId: original.fromOwnerUserId,
      fromOwnerName: original.fromOwnerName,
      fromPositionCode: original.fromPositionCode,
      toAccessScope: original.toAccessScope,
      toOwnerUserId: original.toOwnerUserId,
      toOwnerName: original.toOwnerName,
      toPositionCode: original.toPositionCode,
      counterparty: original.counterparty,
      note: `更正 ${original.id.slice(0, 8)}：${reason}`,
      correctionOfId: original.id,
      occurredAt: new Date().toISOString(),
    });
    await writeStore({ operation: 'syncStore', store });
    return sendJson(response, 201, { event: correction });
  }

  const transactionCorrectionMatch = url.pathname.match(/^\/api\/transactions\/([^/]+)\/correction$/);
  if (transactionCorrectionMatch && request.method === 'POST') {
    const original = store.transactions.find((record) => record.id === decodeURIComponent(transactionCorrectionMatch[1]));
    if (!original) return sendJson(response, 404, { error: '原始登记不存在' });
    if (original.userId !== user.id && user.role !== 'admin') return sendJson(response, 403, { error: '成员只能更正自己的登记；系统管理员可以更正全部登记' });
    if (original.sourceType !== 'manual' || original.correctionOfId) return sendJson(response, 409, { error: '只有原始手工登记可以更正' });
    if (store.transactions.some((record) => record.correctionOfId === original.id)) return sendJson(response, 409, { error: '这笔登记已经更正，不能重复操作' });
    const input = await readJsonBody(request);
    const quantity = Number(input.quantity ?? original.quantity);
    const reason = String(input.reason ?? '').trim();
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > original.quantity + 1e-9) return sendJson(response, 400, { error: `更正数量应大于 0 且不超过原登记的 ${original.quantity} ${original.unit}` });
    if (!reason || reason.length > 300) return sendJson(response, 400, { error: '请填写 1-300 个字符的更正原因' });
    const material = store.materials.find((candidate) => candidate.id === original.materialId);
    if (!material || !material.active) return sendJson(response, 409, { error: '原耗材已归档或删除，不能在线反向更正，请联系系统管理员' });
    const correctionType = original.type === 'in' ? 'out' : 'in';
    const occurredAt = new Date().toISOString();

    if (original.inventoryUnitId) {
      const unit = store.inventoryUnits.find((candidate) => candidate.id === original.inventoryUnitId && candidate.active);
      const status = store.inventoryStatuses.find((candidate) => candidate.id === original.statusId && candidate.materialId === original.materialId);
      if (!unit || !status) return sendJson(response, 409, { error: '原库存单元或状态已不存在，不能自动更正' });
      const access = validateAccessSource(store, original.accessScope === 'user' ? 'user' : 'shared', original.ownerUserId);
      const identity = { inventoryUnitId: unit.id, statusId: status.id, accessScope: access.accessScope, ownerUserId: access.ownerUserId, positionCode: normalizedPositionCode(original.positionCode) };
      if (correctionType === 'out') {
        const source = store.inventoryUnitBalances.find((balance) => balanceIdentity(balance) === balanceIdentity(identity));
        if (!source || source.quantity < quantity) return sendJson(response, 409, { error: '原入库库存已被后续使用或变更，当前无法自动冲销，请联系系统管理员处理' });
        if (!canUseInventoryBalance(user, source) && user.role !== 'admin') return sendJson(response, 403, { error: '该库存现已属于其他成员自用，不能自动冲销' });
        upsertInventoryBalance(store, identity, -quantity);
      } else {
        if (original.positionCode && Math.abs(quantity - original.quantity) > 1e-9) return sendJson(response, 409, { error: '按位置追踪的单件只能整笔更正' });
        if (identity.accessScope === 'user' && identity.ownerUserId !== user.id && user.role !== 'admin') {
          return sendJson(response, 403, { error: '只有系统管理员可以通过更正把库存补回其他成员名下' });
        }
        if (identity.accessScope === 'user' && !validInventoryOwner(store, identity.ownerUserId)) {
          return sendJson(response, 409, { error: '原自用成员已停用或删除，不能自动补回其名下，请联系系统管理员按当前情况登记' });
        }
        assertUnitCapacity(store, unit, quantity);
        assertPositionBalance(store, identity, quantity);
        upsertInventoryBalance(store, identity, quantity);
      }
      refreshTrackedMaterialQuantity(store, material);
      unit.updatedAt = occurredAt;
    } else {
      if (material.trackingMode !== 'quantity') return sendJson(response, 409, { error: '原登记与当前库存管理方式不一致，不能自动更正' });
      if (correctionType === 'out' && material.quantity < quantity) return sendJson(response, 409, { error: `当前库存只有 ${material.quantity} ${material.unit}，不足以冲销原入库` });
      material.quantity += correctionType === 'in' ? quantity : -quantity;
      material.updatedAt = occurredAt;
    }

    const group = transactionGroupSnapshot(store, user);
    const correction = {
      id: randomUUID(), type: correctionType, materialId: original.materialId, materialName: original.materialName, quantity, unit: original.unit,
      userId: user.id, userName: user.name, ...group, sourceType: 'manual', counterparty: '更正原登记',
      note: `更正 ${original.id.slice(0, 8)}：${reason}`, occurredAt, operation: 'stock',
      inventoryUnitId: original.inventoryUnitId, inventoryUnitLabel: original.inventoryUnitLabel,
      statusId: original.statusId, statusName: original.statusName, accessScope: original.accessScope,
      ownerUserId: original.ownerUserId, ownerName: original.ownerName, positionCode: original.positionCode,
      correctionOfId: original.id,
    };
    store.transactions.push(correction);
    await writeStore({ operation: 'syncStore', store });
    return sendJson(response, 201, { transaction: correction, material });
  }

  if (url.pathname === '/api/password' && request.method === 'POST') {
    const input = await readJsonBody(request);
    const currentPassword = String(input.currentPassword ?? '');
    const newPassword = String(input.newPassword ?? '');
    if (!verifyPassword(currentPassword, user)) return sendJson(response, 400, { error: '当前密码不正确' });
    if (newPassword.length < minimumPasswordLength) return sendJson(response, 400, { error: `新密码至少需要 ${minimumPasswordLength} 位` });
    if (newPassword.length > 128) return sendJson(response, 400, { error: '新密码不能超过 128 位' });
    Object.assign(user, hashPassword(newPassword));
    clearSessionsForUser(user.id, parseCookies(request)[sessionCookieName]);
    await writeStore({ operation: 'syncStore', store });
    return sendJson(response, 200, { ok: true });
  }

  if (url.pathname === '/api/profile' && request.method === 'PATCH') {
    const input = await readJsonBody(request);
    const name = String(input.name ?? '').trim();
    const note = String(input.note ?? '').trim();
    if (!name || name.length > 40) return sendJson(response, 400, { error: '姓名需为 1-40 个字符' });
    if (note.length > 300) return sendJson(response, 400, { error: '成员备注不能超过 300 个字符' });
    let groupId = user.groupId;
    if (input.groupId !== undefined && String(input.groupId) !== user.groupId) {
      if (!isSystemAdmin(user)) return sendJson(response, 403, { error: '组织归属请联系系统管理员修改' });
      const group = store.groups.find((candidate) => candidate.id === String(input.groupId));
      if (!group) return sendJson(response, 400, { error: '请选择有效的组织分组' });
      groupId = group.id;
    }
    const tagIds = validatedTagIds(store, input.tagIds, user.tagIds);
    Object.assign(user, { name, note, groupId, tagIds });
    await writeStore({ operation: 'syncStore', store });
    return sendJson(response, 200, { user: publicUser(user) });
  }

  if (url.pathname === '/api/users' && request.method === 'POST') {
    if (!canManageMembers(user)) return sendJson(response, 403, { error: '只有系统所有者或系统管理员可以添加成员' });
    const input = await readJsonBody(request);
    const username = String(input.username ?? '').trim();
    const password = String(input.password ?? '');
    const name = String(input.name ?? '').trim();
    const note = String(input.note ?? '').trim();
    const role = ['admin', 'inventory', 'member'].includes(input.role) ? input.role : 'member';
    if (role === 'admin' && !isOwner(user)) return sendJson(response, 403, { error: '只有系统所有者可以任命系统管理员' });
    const group = store.groups.find((candidate) => candidate.id === input.groupId) ?? store.groups.find((candidate) => candidate.isDefault);
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) return sendJson(response, 400, { error: '账号需为 3-32 位字母、数字、点、下划线或短横线' });
    if (password.length < minimumPasswordLength || password.length > 128) return sendJson(response, 400, { error: `密码需为 ${minimumPasswordLength}-128 位` });
    if (!name || name.length > 40) return sendJson(response, 400, { error: '成员姓名需为 1-40 个字符' });
    if (note.length > 300) return sendJson(response, 400, { error: '成员备注不能超过 300 个字符' });
    if (store.users.some((candidate) => candidate.username.toLowerCase() === username.toLowerCase())) return sendJson(response, 409, { error: '该账号已存在' });
    const created = makeUser(username, password, name, role, group.id);
    created.note = note;
    created.tagIds = validatedTagIds(store, input.tagIds);
    store.users.push(created);
    await writeStore({ operation: 'syncStore', store });
    return sendJson(response, 201, { user: publicUser(created) });
  }

  const memberActionMatch = url.pathname.match(/^\/api\/users\/([^/]+)(?:\/(reset-password|status|group))?$/);
  if (memberActionMatch && request.method !== 'GET') {
    if (!canManageMembers(user)) return sendJson(response, 403, { error: '只有系统所有者或系统管理员可以管理成员' });
    const targetId = decodeURIComponent(memberActionMatch[1]);
    const action = memberActionMatch[2] ?? '';
    const target = store.users.find((candidate) => candidate.id === targetId);
    if (!target) return sendJson(response, 404, { error: '成员不存在' });
    if (!canManageUser(user, target)) return sendJson(response, 403, { error: '系统管理员不能管理系统所有者或其他系统管理员' });

    if (!action && request.method === 'PATCH') {
      const input = await readJsonBody(request);
      const username = String(input.username ?? '').trim();
      const name = String(input.name ?? '').trim();
      const note = String(input.note ?? '').trim();
      const role = ['admin', 'inventory', 'member'].includes(input.role) ? input.role : null;
      const group = store.groups.find((candidate) => candidate.id === input.groupId);
      if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) return sendJson(response, 400, { error: '账号需为 3-32 位字母、数字、点、下划线或短横线' });
      if (!name || name.length > 40) return sendJson(response, 400, { error: '成员姓名需为 1-40 个字符' });
      if (note.length > 300) return sendJson(response, 400, { error: '成员备注不能超过 300 个字符' });
      if (!role) return sendJson(response, 400, { error: '请选择有效角色' });
      if (!group) return sendJson(response, 400, { error: '请选择有效分组' });
      if (role === 'admin' && !isOwner(user)) return sendJson(response, 403, { error: '只有系统所有者可以授予系统管理员权限' });
      if (isOwner(target) && role !== 'admin') return sendJson(response, 400, { error: '系统所有者不能通过角色菜单降级，请先转移所有权' });
      if (target.id === user.id && role !== target.role) return sendJson(response, 400, { error: '不能修改当前登录账号的角色' });
      if (store.users.some((candidate) => candidate.id !== target.id && candidate.username.toLowerCase() === username.toLowerCase())) return sendJson(response, 409, { error: '该登录账号已存在' });
      const tagIds = validatedTagIds(store, input.tagIds, target.tagIds);
      Object.assign(target, { username, name, note, role, groupId: group.id, tagIds });
      await writeStore({ operation: 'syncStore', store });
      return sendJson(response, 200, { user: publicUser(target) });
    }

    if (action === 'reset-password' && request.method === 'POST') {
      const input = await readJsonBody(request);
      const newPassword = String(input.newPassword ?? '');
      if (isOwner(target)) return sendJson(response, 403, { error: '系统所有者密码只能由本人修改；忘记密码时请使用服务器恢复工具' });
      if (target.id === user.id) return sendJson(response, 400, { error: '请在系统设置中修改当前账号密码' });
      if (newPassword.length < minimumPasswordLength) return sendJson(response, 400, { error: `新密码至少需要 ${minimumPasswordLength} 位` });
      if (newPassword.length > 128) return sendJson(response, 400, { error: '新密码不能超过 128 位' });
      Object.assign(target, hashPassword(newPassword));
      clearSessionsForUser(target.id);
      await writeStore({ operation: 'syncStore', store });
      return sendJson(response, 200, { user: publicUser(target) });
    }

    if (action === 'status' && request.method === 'PATCH') {
      const input = await readJsonBody(request);
      const active = Boolean(input.active);
      if (isOwner(target)) return sendJson(response, 403, { error: '系统所有者账号不能停用' });
      if (target.id === user.id && !active) return sendJson(response, 400, { error: '不能停用当前登录账号' });
      target.active = active;
      if (!active) clearSessionsForUser(target.id);
      await writeStore({ operation: 'syncStore', store });
      return sendJson(response, 200, { user: publicUser(target) });
    }

    if (action === 'group' && request.method === 'PATCH') {
      const input = await readJsonBody(request);
      const group = store.groups.find((candidate) => candidate.id === input.groupId);
      if (!group) return sendJson(response, 400, { error: '请选择有效分组' });
      target.groupId = group.id;
      await writeStore({ operation: 'syncStore', store });
      return sendJson(response, 200, { user: publicUser(target) });
    }

    if (!action && request.method === 'DELETE') {
      if (isOwner(target)) return sendJson(response, 403, { error: '系统所有者账号不能删除，请先转移所有权' });
      if (target.id === user.id) return sendJson(response, 400, { error: '不能删除当前登录账号' });
      const reservedQuantity = store.inventoryUnitBalances
        .filter((balance) => balance.accessScope === 'user' && balance.ownerUserId === target.id)
        .reduce((sum, balance) => sum + balance.quantity, 0);
      if (reservedQuantity > 0) {
        return sendJson(response, 409, { error: `该成员仍有 ${reservedQuantity} 个自用库存明细，请先由库存管理员重新开放、转交或处置后再删除账号` });
      }
      store.users = store.users.filter((candidate) => candidate.id !== target.id);
      clearSessionsForUser(target.id);
      await writeStore({ operation: 'syncStore', store });
      return sendJson(response, 200, { ok: true });
    }
  }

  if (url.pathname === '/api/owner/transfer' && request.method === 'POST') {
    if (!isOwner(user)) return sendJson(response, 403, { error: '只有系统所有者可以转移所有权' });
    const input = await readJsonBody(request);
    if (!verifyPassword(String(input.currentPassword ?? ''), user)) return sendJson(response, 400, { error: '当前密码不正确' });
    const target = store.users.find((candidate) => candidate.id === input.targetUserId);
    if (!target || !target.active || !isSystemAdmin(target) || target.id === user.id) {
      return sendJson(response, 400, { error: '请选择另一位可登录的系统管理员' });
    }
    store.users.forEach((candidate) => { candidate.isOwner = candidate.id === target.id; });
    await writeStore({ operation: 'syncStore', store });
    return sendJson(response, 200, { user: publicUser(user), owner: publicUser(target) });
  }

  return sendJson(response, 404, { error: '接口不存在' });
}

async function sendStaticFile(request, response, filePath) {
  let cached = staticFileCache.get(filePath);
  if (!cached) {
    const body = await readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const revalidate = extension === '.html' || extension === '.webmanifest' || path.basename(filePath) === 'sw.js';
    cached = {
      body,
      etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`,
      contentType: mimeTypes[extension] ?? 'application/octet-stream',
      cacheControl: revalidate ? 'no-cache' : 'public, max-age=31536000, immutable',
    };
    staticFileCache.set(filePath, cached);
  }
  const headers = {
    ...securityHeaders,
    'Content-Type': cached.contentType,
    'Content-Length': cached.body.length,
    'Cache-Control': cached.cacheControl,
    ETag: cached.etag,
  };
  if (request.headers['if-none-match'] === cached.etag) {
    response.writeHead(304, headers);
    return response.end();
  }
  response.writeHead(200, headers);
  if (request.method === 'HEAD') return response.end();
  response.end(cached.body);
}

async function serveStatic(request, response, url) {
  let requestedPath = decodeURIComponent(url.pathname);
  if (requestedPath === '/') requestedPath = '/index.html';
  const resolvedPath = path.resolve(distDir, `.${requestedPath}`);
  if (!resolvedPath.startsWith(`${distDir}${path.sep}`)) return sendJson(response, 403, { error: '禁止访问' });
  try {
    const info = await stat(resolvedPath);
    const filePath = info.isDirectory() ? path.join(resolvedPath, 'index.html') : resolvedPath;
    return sendStaticFile(request, response, filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return sendStaticFile(request, response, path.join(distDir, 'index.html'));
  }
}

storage = await openStorage({ dataDir, createDefaultStore, normalizeStore, busyTimeoutMs: sqliteBusyTimeoutMs });
await readStore();
function enqueueMutation(task) {
  const result = mutationQueue.then(task, task);
  mutationQueue = result.catch(() => undefined);
  return result;
}

function auditEntitySnapshot(type, value) {
  if (!value) return null;
  if (type === 'settings') return { appName: value.appName, labName: value.labName, customIcon: Boolean(value.brandIcon) };
  if (type === 'group') return { id: value.id, name: value.name, isDefault: Boolean(value.isDefault) };
  if (type === 'tag') return { id: value.id, name: value.name };
  if (type === 'user') return {
    id: value.id, username: value.username, name: value.name, note: value.note ?? '', role: value.role,
    groupId: value.groupId, tagIds: value.tagIds ?? [], active: Boolean(value.active), isOwner: Boolean(value.isOwner),
  };
  if (type === 'material') return {
    id: value.id, name: value.name, category: value.category, safetyStock: value.safetyStock, unit: value.unit,
    spec: value.spec, trackingMode: value.trackingMode, positionCodeHelp: value.positionCodeHelp ?? '',
    usageContextHelp: value.usageContextHelp ?? '', active: Boolean(value.active),
  };
  if (type === 'inventory_status') return {
    id: value.id, materialId: value.materialId, code: value.code, name: value.name,
    usable: Boolean(value.usable), terminal: Boolean(value.terminal), active: Boolean(value.active), sortOrder: value.sortOrder,
  };
  if (type === 'inventory_unit') return {
    id: value.id, materialId: value.materialId, unitType: value.unitType, label: value.label,
    positionCode: value.positionCode, capacity: value.capacity, note: value.note ?? '', active: Boolean(value.active),
  };
  return auditSnapshot(value);
}

function auditEntityFromStore(store, targetType, targetId) {
  if (targetType === 'settings') return store.settings;
  if (targetType === 'group') return store.groups.find((item) => item.id === targetId);
  if (targetType === 'tag') return store.tags.find((item) => item.id === targetId);
  if (targetType === 'user') return store.users.find((item) => item.id === targetId);
  if (targetType === 'material') return store.materials.find((item) => item.id === targetId);
  if (targetType === 'inventory_status') return store.inventoryStatuses.find((item) => item.id === targetId);
  if (targetType === 'inventory_unit') return store.inventoryUnits.find((item) => item.id === targetId);
  return null;
}

function captureManagementAudit(request, url) {
  const method = request.method ?? '';
  const pathName = url.pathname;
  const view = requestStorage.getStore();
  const session = getSession(request);
  const actor = session ? view?.readActiveUser(session.userId) : null;
  if (!actor) return null;
  const input = parsedBodies.get(request) ?? {};
  let descriptor = null;
  const match = (pattern) => pathName.match(pattern);

  if (pathName === '/api/settings' && method === 'PATCH') descriptor = { action: 'settings.update', targetType: 'settings', targetId: '1' };
  else if (pathName === '/api/groups' && method === 'POST') descriptor = { action: 'group.create', targetType: 'group' };
  else if (match(/^\/api\/groups\/([^/]+)$/) && method === 'PATCH') descriptor = { action: 'group.update', targetType: 'group', targetId: decodeURIComponent(match(/^\/api\/groups\/([^/]+)$/)[1]) };
  else if (match(/^\/api\/groups\/([^/]+)$/) && method === 'DELETE') descriptor = { action: 'group.delete', targetType: 'group', targetId: decodeURIComponent(match(/^\/api\/groups\/([^/]+)$/)[1]) };
  else if (pathName === '/api/tags' && method === 'POST') descriptor = { action: 'tag.create', targetType: 'tag' };
  else if (match(/^\/api\/tags\/([^/]+)$/) && method === 'PATCH') descriptor = { action: 'tag.update', targetType: 'tag', targetId: decodeURIComponent(match(/^\/api\/tags\/([^/]+)$/)[1]) };
  else if (match(/^\/api\/tags\/([^/]+)$/) && method === 'DELETE') descriptor = { action: 'tag.delete', targetType: 'tag', targetId: decodeURIComponent(match(/^\/api\/tags\/([^/]+)$/)[1]) };
  else if (pathName === '/api/materials' && method === 'POST') descriptor = { action: 'material.create', targetType: 'material' };
  else if (match(/^\/api\/materials\/([^/]+)$/) && method === 'PATCH') descriptor = { action: 'material.update', targetType: 'material', targetId: decodeURIComponent(match(/^\/api\/materials\/([^/]+)$/)[1]) };
  else if (match(/^\/api\/materials\/([^/]+)$/) && method === 'DELETE') descriptor = { action: 'material.delete', targetType: 'material', targetId: decodeURIComponent(match(/^\/api\/materials\/([^/]+)$/)[1]) };
  else if (match(/^\/api\/materials\/([^/]+)\/status$/) && method === 'PATCH') descriptor = {
    action: input.status === 'active' ? 'material.restore' : 'material.archive', targetType: 'material',
    targetId: decodeURIComponent(match(/^\/api\/materials\/([^/]+)\/status$/)[1]),
  };
  else if (pathName === '/api/inventory-statuses' && method === 'POST') descriptor = { action: 'inventory_status.create', targetType: 'inventory_status' };
  else if (match(/^\/api\/inventory-statuses\/([^/]+)$/) && method === 'PATCH') descriptor = { action: 'inventory_status.update', targetType: 'inventory_status', targetId: decodeURIComponent(match(/^\/api\/inventory-statuses\/([^/]+)$/)[1]) };
  else if (pathName === '/api/inventory-units' && method === 'POST') descriptor = { action: 'inventory_unit.create', targetType: 'inventory_unit' };
  else if (match(/^\/api\/inventory-units\/([^/]+)\/status$/) && method === 'PATCH') descriptor = {
    action: input.status === 'active' ? 'inventory_unit.restore' : 'inventory_unit.archive', targetType: 'inventory_unit',
    targetId: decodeURIComponent(match(/^\/api\/inventory-units\/([^/]+)\/status$/)[1]),
  };
  else if (pathName === '/api/inventory-anomalies/position/resolve' && method === 'POST') descriptor = {
    action: 'inventory_anomaly.resolve', targetType: 'inventory_anomaly', targetId: String(input.inventoryUnitId ?? ''),
    specialBefore: { inventoryUnitId: input.inventoryUnitId, fromPositionCode: input.fromPositionCode, toPositionCode: input.toPositionCode },
  };
  else if (pathName === '/api/users' && method === 'POST') descriptor = { action: 'user.create', targetType: 'user' };
  else if (match(/^\/api\/users\/([^/]+)$/) && method === 'PATCH') descriptor = { action: 'user.update', targetType: 'user', targetId: decodeURIComponent(match(/^\/api\/users\/([^/]+)$/)[1]) };
  else if (match(/^\/api\/users\/([^/]+)$/) && method === 'DELETE') descriptor = { action: 'user.delete', targetType: 'user', targetId: decodeURIComponent(match(/^\/api\/users\/([^/]+)$/)[1]) };
  else if (match(/^\/api\/users\/([^/]+)\/reset-password$/) && method === 'POST') descriptor = { action: 'user.password_reset', targetType: 'user', targetId: decodeURIComponent(match(/^\/api\/users\/([^/]+)\/reset-password$/)[1]), suppressSnapshots: true };
  else if (match(/^\/api\/users\/([^/]+)\/status$/) && method === 'PATCH') descriptor = { action: input.active ? 'user.enable' : 'user.disable', targetType: 'user', targetId: decodeURIComponent(match(/^\/api\/users\/([^/]+)\/status$/)[1]) };
  else if (match(/^\/api\/users\/([^/]+)\/group$/) && method === 'PATCH') descriptor = { action: 'user.group_change', targetType: 'user', targetId: decodeURIComponent(match(/^\/api\/users\/([^/]+)\/group$/)[1]) };
  else if (pathName === '/api/owner/transfer' && method === 'POST') descriptor = { action: 'owner.transfer', targetType: 'user', targetId: String(input.targetUserId ?? '') };
  else if (pathName === '/api/password' && method === 'POST') descriptor = { action: 'account.password_change', targetType: 'user', targetId: actor.id, suppressSnapshots: true };
  else if (pathName === '/api/profile' && method === 'PATCH' && isSystemAdmin(actor)) descriptor = { action: 'user.profile_update', targetType: 'user', targetId: actor.id };
  else if (pathName === '/api/admin/database-restore/authorize' && method === 'POST') descriptor = { action: 'database.restore_authorize', targetType: 'database', targetId: 'primary', suppressSnapshots: true };
  if (!descriptor) return null;

  const store = view.readCurrentInventoryStore();
  const beforeEntity = descriptor.targetId ? auditEntityFromStore(store, descriptor.targetType, descriptor.targetId) : null;
  return {
    ...descriptor,
    actor,
    before: descriptor.suppressSnapshots ? null : descriptor.specialBefore ?? auditEntitySnapshot(descriptor.targetType, beforeEntity),
    originalTargetName: beforeEntity?.name ?? beforeEntity?.label ?? '',
  };
}

const auditActionLabels = Object.freeze({
  'settings.update': '修改实验室与品牌设置', 'group.create': '新增组织分组', 'group.update': '修改组织分组', 'group.delete': '删除组织分组',
  'tag.create': '新增成员标签', 'tag.update': '修改成员标签', 'tag.delete': '删除成员标签',
  'material.create': '新增耗材档案', 'material.update': '修改耗材档案', 'material.archive': '归档耗材档案', 'material.restore': '恢复耗材档案', 'material.delete': '永久删除耗材档案',
  'inventory_status.create': '新增库存状态', 'inventory_status.update': '修改库存状态', 'inventory_unit.create': '新增库存单元', 'inventory_unit.archive': '归档库存单元', 'inventory_unit.restore': '恢复库存单元',
  'inventory_anomaly.resolve': '修复库存位置异常', 'user.create': '新增成员账号', 'user.update': '修改成员账号', 'user.delete': '删除成员账号',
  'user.password_reset': '重置成员密码', 'user.enable': '启用成员账号', 'user.disable': '停用成员账号', 'user.group_change': '调整成员分组', 'user.profile_update': '修改管理员个人资料',
  'owner.transfer': '转移系统所有权', 'account.password_change': '修改自己的密码', 'database.restore_authorize': '授权数据库恢复',
  'database.backup_download': '下载数据库备份', 'database.restore': '恢复主数据库',
  'stocktake.create': '创建盘点任务', 'stocktake.count_update': '登记盘点数量', 'stocktake.complete': '完成盘点任务', 'stocktake.cancel': '取消盘点任务',
});

async function finalizeManagementAudit(request, _url, context, payload) {
  if (!context) return;
  const responseEntity = payload.settings ?? payload.group ?? payload.tag ?? payload.material ?? payload.status ?? payload.unit ?? payload.user ?? payload.owner ?? null;
  const targetId = context.targetId || responseEntity?.id || '';
  const store = requestStorage.getStore().readCurrentInventoryStore();
  const currentEntity = targetId ? auditEntityFromStore(store, context.targetType, targetId) : null;
  const after = context.suppressSnapshots
    ? null
    : context.action === 'inventory_anomaly.resolve'
      ? { resolved: true, eventId: payload.event?.id ?? '' }
      : auditEntitySnapshot(context.targetType, currentEntity ?? responseEntity);
  const targetName = currentEntity?.name ?? currentEntity?.label ?? responseEntity?.name ?? responseEntity?.label ?? context.originalTargetName ?? '';
  const label = auditActionLabels[context.action] ?? context.action;
  await appendAuditLog(request, context.actor, {
    action: context.action,
    targetType: context.targetType,
    targetId,
    targetName,
    summary: targetName ? `${label}：${targetName}` : label,
    before: context.before,
    after,
  });
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`);
    if (maintenanceMode && url.pathname !== '/api/health') {
      return sendJson(response, 503, { error: '系统正在恢复数据库，请稍后重试' }, { 'Retry-After': '5' });
    }
    if (url.pathname === '/api/admin/database-backup' && request.method === 'GET') {
      return await enqueueMutation(() => handleDatabaseBackup(request, response));
    }
    if (url.pathname === '/api/admin/database-restore' && request.method === 'POST') {
      if (!allowsStateChange(request)) return sendJson(response, 403, { error: '请求来源不受信任' });
      cleanupRestoreAuthorizations();
      const restoreToken = String(request.headers['x-openlabstock-restore-token'] ?? '');
      const authorization = restoreAuthorizations.get(restoreToken);
      if (!authorization || authorization.expiresAt <= Date.now()) return sendJson(response, 401, { error: '恢复授权已失效，请重新输入当前密码' });
      const body = await readBinaryBody(request);
      restoreAuthorizations.delete(restoreToken);
      maintenanceMode = true;
      try {
        return await enqueueMutation(() => handleDatabaseRestore(request, response, body, authorization));
      } finally {
        maintenanceMode = false;
      }
    }
    if (url.pathname.startsWith('/api/')) {
      const mutatesState = ['POST', 'PATCH', 'DELETE'].includes(request.method ?? '');
      if (mutatesState) {
        if (!allowsStateChange(request)) return sendJson(response, 403, { error: '请求来源不受信任' });
        await readJsonBody(request);
        const buffered = createBufferedResponse();
        await enqueueMutation(() => requestStorage.run(storage.writeView, async () => {
          storage.beginWrite();
          try {
            const auditContext = captureManagementAudit(request, url);
            await handleApi(request, buffered.response, url);
            const result = buffered.result();
            if (result.statusCode >= 200 && result.statusCode < 300) {
              await finalizeManagementAudit(request, url, auditContext, result.payload);
            }
            storage.commitWrite();
          } catch (error) {
            storage.rollbackWrite();
            throw error;
          }
        }));
        buffered.flush(response);
      } else {
        await requestStorage.run(storage.readView, () => handleApi(request, response, url));
      }
    }
    else if (request.method === 'GET' || request.method === 'HEAD') await serveStatic(request, response, url);
    else sendJson(response, 405, { error: '请求方法不支持' });
  } catch (error) {
    console.error(error);
    if (isDatabaseBusy(error)) {
      return sendJson(response, 503, { error: '当前登记较多，数据库正在处理其他提交；本次操作未保存，请稍后重试' }, { 'Retry-After': '2' });
    }
    sendJson(response, error.statusCode ?? 500, { error: error.statusCode ? error.message : '服务器内部错误' });
  }
});

const auditTargetTypes = new Set(['settings', 'group', 'tag', 'user', 'material', 'inventory_status', 'inventory_unit', 'inventory_anomaly', 'stocktake', 'database']);
const auditSensitiveKey = /password|passwordHash|salt|token|session|brandIcon|database|backup|body|file/i;

function auditRequestId(request) {
  if (!requestIds.has(request)) requestIds.set(request, randomUUID());
  return requestIds.get(request);
}

function auditSnapshot(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.slice(0, 50).map(auditSnapshot);
  if (typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 500) : value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (auditSensitiveKey.test(key)) return [];
    return [[key, auditSnapshot(item)]];
  }));
}

async function appendAuditLog(request, actor, { action, targetType, targetId = '', targetName = '', summary, before = null, after = null }) {
  if (!auditTargetTypes.has(targetType)) throw new Error(`Unsupported audit target type: ${targetType}`);
  const log = {
    id: randomUUID(),
    actorUserId: actor.id,
    actorName: actor.name,
    actorRole: actor.isOwner ? 'owner' : actor.role,
    action,
    targetType,
    targetId: String(targetId),
    targetName: String(targetName).slice(0, 200),
    summary: String(summary).slice(0, 500),
    before: auditSnapshot(before),
    after: auditSnapshot(after),
    sourceIp: clientAddress(request).slice(0, 100),
    requestId: auditRequestId(request),
    occurredAt: new Date().toISOString(),
  };
  await writeStore({ operation: 'auditLog', log });
  return log;
}

function standaloneAuditLog(request, actor, { action, targetType, targetId = '', targetName = '', summary, before = null, after = null }) {
  return {
    id: randomUUID(), actorUserId: actor.id, actorName: actor.name, actorRole: actor.isOwner ? 'owner' : actor.role,
    action, targetType, targetId: String(targetId), targetName: String(targetName).slice(0, 200), summary: String(summary).slice(0, 500),
    before: auditSnapshot(before), after: auditSnapshot(after), sourceIp: clientAddress(request).slice(0, 100),
    requestId: auditRequestId(request), occurredAt: new Date().toISOString(),
  };
}

function writeStandaloneAuditLog(log) {
  storage.beginWrite();
  try {
    storage.writeView.writeStore({ operation: 'auditLog', log });
    storage.commitWrite();
  } catch (error) {
    storage.rollbackWrite();
    throw error;
  }
}

function encodeAuditCursor(cursor) {
  return cursor ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : '';
}

function auditPageOptions(url) {
  const pageSize = Number(url.searchParams.get('pageSize') ?? 60);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw Object.assign(new Error('每页数量需为 1-100'), { statusCode: 400 });
  const query = String(url.searchParams.get('q') ?? '').trim();
  if (query.length > 100) throw Object.assign(new Error('搜索内容不能超过 100 个字符'), { statusCode: 400 });
  const targetType = String(url.searchParams.get('type') ?? 'all');
  if (targetType !== 'all' && !auditTargetTypes.has(targetType)) throw Object.assign(new Error('审计对象类型无效'), { statusCode: 400 });
  const actorUserId = String(url.searchParams.get('actor') ?? '');
  const from = String(url.searchParams.get('from') ?? '');
  if (from && Number.isNaN(new Date(from).valueOf())) throw Object.assign(new Error('起始时间无效'), { statusCode: 400 });
  let cursor = null;
  const encodedCursor = String(url.searchParams.get('cursor') ?? '');
  if (encodedCursor) {
    try {
      const decoded = JSON.parse(Buffer.from(encodedCursor, 'base64url').toString('utf8'));
      if (!decoded?.occurredAt || !decoded?.id || Number.isNaN(new Date(decoded.occurredAt).valueOf())) throw new Error();
      cursor = { occurredAt: String(decoded.occurredAt), id: String(decoded.id) };
    } catch {
      throw Object.assign(new Error('审计分页位置无效，请重新打开记录页'), { statusCode: 400 });
    }
  }
  return { pageSize, query, targetType, actorUserId, from, cursor };
}

server.listen(port, host, () => console.log(`OpenLabStock is running at http://${host}:${port}`));

let shutdownStarted = false;
function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  maintenanceMode = true;
  console.log(`Received ${signal}; waiting for active requests to finish`);
  const forceExit = setTimeout(() => {
    console.error('Graceful shutdown timed out');
    process.exit(1);
  }, 15_000);
  forceExit.unref();
  server.close(() => {
    clearTimeout(forceExit);
    try { storage.close(); } catch (error) { console.error(error); }
    process.exit(0);
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
