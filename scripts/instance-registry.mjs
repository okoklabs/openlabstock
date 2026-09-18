import { randomUUID } from 'node:crypto';

export const REGISTRY_FORMAT = 1;
export const INSTANCE_KIND = 'openlabstock.instance';
export const LIFECYCLE_STATES = Object.freeze(['provisioning', 'active', 'suspended', 'retired']);
export const HEALTH_STATES = Object.freeze(['unknown', 'healthy', 'degraded', 'unreachable']);
export const BACKUP_STATES = Object.freeze(['unknown', 'ok', 'stale', 'invalid']);
export const TASK_STATES = Object.freeze(['planned', 'approved', 'running', 'succeeded', 'failed', 'expired']);

const instanceIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+\-]{0,63}$/;
const hostPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const taskIdPattern = /^task-[A-Za-z0-9][A-Za-z0-9._\-]{0,127}$/;
const actionPattern = /^(?:update|rollback)$/;
const INSTANCE_KEYS = new Set(['format', 'kind', 'instanceId', 'displayName', 'domain', 'lifecycle', 'desiredVersion', 'observedVersion', 'health', 'backup', 'task', 'updatedAt']);
const HEALTH_KEYS = new Set(['status', 'observedAt', 'latencyMs']);
const BACKUP_KEYS = new Set(['status', 'observedAt', 'ageSeconds', 'bytes', 'schemaVersion']);
const TASK_KEYS = new Set(['taskId', 'action', 'status', 'createdAt', 'updatedAt']);

export class RegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
  }
}

function reject(message) {
  throw new RegistryError('INVALID_INSTANCE_RECORD', message);
}

function assertKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) reject(`${label}包含不允许的字段：${key}`);
  }
}

function optionalString(value, label, { pattern, max = 120 } = {}) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    reject(`${label} 无效`);
  }
  if (pattern && !pattern.test(value)) reject(`${label} 格式无效`);
  return value;
}

function requiredString(value, label, options) {
  const result = optionalString(value, label, options);
  if (result === null) reject(`${label}不能为空`);
  return result;
}

function isoTime(value, label, { nullable = true } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    reject(`${label}不能为空`);
  }
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) reject(`${label}不是有效时间`);
  return new Date(Date.parse(value)).toISOString();
}

function nonNegativeInteger(value, label, { nullable = true } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    reject(`${label}不能为空`);
  }
  if (!Number.isSafeInteger(value) || value < 0) reject(`${label}必须是非负整数`);
  return value;
}

function validateHealth(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('health必须是对象');
  assertKeys(value, HEALTH_KEYS, 'health');
  if (!HEALTH_STATES.includes(value.status)) reject('health.status无效');
  const observedAt = isoTime(value.observedAt, 'health.observedAt');
  if (value.status !== 'unknown' && observedAt === null) reject('非unknown健康状态必须有observedAt');
  return {
    status: value.status,
    observedAt,
    latencyMs: nonNegativeInteger(value.latencyMs, 'health.latencyMs'),
  };
}

function validateBackup(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('backup必须是对象');
  assertKeys(value, BACKUP_KEYS, 'backup');
  const observedAt = isoTime(value.observedAt, 'backup.observedAt');
  if (value.status !== 'unknown' && observedAt === null) reject('非unknown备份状态必须有observedAt');
  return {
    status: BACKUP_STATES.includes(value.status) ? value.status : reject('backup.status无效'),
    observedAt,
    ageSeconds: nonNegativeInteger(value.ageSeconds, 'backup.ageSeconds'),
    bytes: nonNegativeInteger(value.bytes, 'backup.bytes'),
    schemaVersion: nonNegativeInteger(value.schemaVersion, 'backup.schemaVersion'),
  };
}

function validateTask(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('task必须是对象或null');
  assertKeys(value, TASK_KEYS, 'task');
  if (!TASK_STATES.includes(value.status)) reject('task.status无效');
  return {
    taskId: requiredString(value.taskId, 'task.taskId', { pattern: taskIdPattern, max: 140 }),
    action: requiredString(value.action, 'task.action', { pattern: actionPattern, max: 20 }),
    status: requiredString(value.status, 'task.status', { max: 20 }),
    createdAt: isoTime(value.createdAt, 'task.createdAt', { nullable: false }),
    updatedAt: isoTime(value.updatedAt, 'task.updatedAt', { nullable: false }),
  };
}

export function validateInstanceRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('实例记录必须是对象');
  assertKeys(value, INSTANCE_KEYS, '实例记录');
  if (value.format !== REGISTRY_FORMAT || value.kind !== INSTANCE_KIND) reject('实例记录格式或类型无效');
  const instanceId = requiredString(value.instanceId, 'instanceId', { pattern: instanceIdPattern, max: 64 });
  const displayName = requiredString(value.displayName, 'displayName', { max: 120 });
  const domain = requiredString(value.domain, 'domain', { pattern: hostPattern, max: 253 }).toLowerCase();
  if (!LIFECYCLE_STATES.includes(value.lifecycle)) reject('lifecycle无效');
  const desiredVersion = optionalString(value.desiredVersion, 'desiredVersion', { pattern: versionPattern, max: 64 });
  const observedVersion = optionalString(value.observedVersion, 'observedVersion', { pattern: versionPattern, max: 64 });
  const health = validateHealth(value.health);
  const backup = validateBackup(value.backup);
  const task = validateTask(value.task);
  const updatedAt = isoTime(value.updatedAt, 'updatedAt', { nullable: false });
  return {
    format: REGISTRY_FORMAT,
    kind: INSTANCE_KIND,
    instanceId,
    displayName,
    domain,
    lifecycle: value.lifecycle,
    desiredVersion,
    observedVersion,
    health,
    backup,
    task,
    updatedAt,
  };
}

export function createInstanceRecord({ instanceId, displayName, domain, desiredVersion = null, now = new Date() }) {
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) reject('创建时间无效');
  const timestamp = now.toISOString();
  return validateInstanceRecord({
    format: REGISTRY_FORMAT,
    kind: INSTANCE_KIND,
    instanceId,
    displayName,
    domain,
    lifecycle: 'provisioning',
    desiredVersion,
    observedVersion: null,
    health: { status: 'unknown', observedAt: null, latencyMs: null },
    backup: { status: 'unknown', observedAt: null, ageSeconds: null, bytes: null, schemaVersion: null },
    task: null,
    updatedAt: timestamp,
  });
}

export function recordHealth(record, { health, backup = record.backup, observedVersion = record.observedVersion, now = new Date() }) {
  const current = validateInstanceRecord(record);
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) reject('观测时间无效');
  const nextHealth = validateHealth(health);
  const nextBackup = validateBackup(backup);
  const nextVersion = optionalString(observedVersion, 'observedVersion', { pattern: versionPattern, max: 64 });
  return validateInstanceRecord({
    ...current,
    observedVersion: nextVersion,
    health: nextHealth,
    backup: nextBackup,
    updatedAt: now.toISOString(),
  });
}

export function createTaskSummary({ action, status, now = new Date(), taskId = `task-${randomUUID()}` }) {
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) reject('任务时间无效');
  if (!TASK_STATES.includes(status)) reject('task.status无效');
  const timestamp = now.toISOString();
  return validateTask({ taskId, action, status, createdAt: timestamp, updatedAt: timestamp });
}
