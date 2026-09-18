import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A small, deployment-agnostic contract for a future private instance control
 * plane. It deliberately exposes an allow-list of operations instead of an
 * arbitrary shell command runner.
 */

const scriptPath = fileURLToPath(import.meta.url);
const appRoot = path.dirname(path.dirname(scriptPath));
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+\-]{0,63}$/;
const sha256Pattern = /^[A-Fa-f0-9]{64}$/;
const artifactPattern = /^[A-Za-z0-9][A-Za-z0-9._\-]{0,127}$/;
const taskIdPattern = /^task-[A-Za-z0-9][A-Za-z0-9._\-]{0,127}$/;
const instanceIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const manifestPattern = /^labstock-\d{8}T\d{9}Z\.sqlite\.json$/;
export const TASK_TTL_MS = 24 * 60 * 60 * 1000;

export const AGENT_FORMAT = 1;
export const ALLOWED_ACTIONS = Object.freeze(['status', 'backup', 'update', 'rollback']);
export const TASK_STATUSES = Object.freeze(['planned', 'approved', 'running', 'succeeded', 'failed', 'expired']);

const TASK_TRANSITIONS = Object.freeze({
  planned: Object.freeze(['approved', 'failed', 'expired']),
  approved: Object.freeze(['running', 'failed', 'expired']),
  running: Object.freeze(['succeeded', 'failed', 'expired']),
  succeeded: Object.freeze([]),
  failed: Object.freeze([]),
  expired: Object.freeze([]),
});

const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'expired']);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export class AgentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
  }
}

export function parseArgs(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    const raw = argument.slice(2);
    if (!raw) throw new AgentError('INVALID_ARGUMENT', '参数名不能为空');
    const equalsIndex = raw.indexOf('=');
    if (equalsIndex >= 0) {
      options[raw.slice(0, equalsIndex)] = raw.slice(equalsIndex + 1);
      continue;
    }
    if (raw === 'pretty' || raw === 'compact' || raw === 'help') {
      options[raw] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new AgentError('INVALID_ARGUMENT', `参数 --${raw} 需要值`);
    }
    options[raw] = value;
    index += 1;
  }
  return { positionals, options };
}

function nonEmptyOption(options, key) {
  const value = options[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgentError('INVALID_ARGUMENT', `缺少参数 --${key}`);
  }
  return value;
}

function validateVersion(value, label = '版本') {
  if (!versionPattern.test(value)) throw new AgentError('INVALID_TASK', `${label}格式无效`);
  return value;
}

function validateSha256(value) {
  if (!sha256Pattern.test(value)) throw new AgentError('INVALID_TASK', 'SHA-256 必须是 64 位十六进制字符串');
  return value.toUpperCase();
}

function validateArtifact(value) {
  if (!artifactPattern.test(value) || value === '.' || value === '..') {
    throw new AgentError('INVALID_TASK', '发布包只能使用不含路径分隔符的文件名');
  }
  return value;
}

export function validatePlan(action, options) {
  if (!ALLOWED_ACTIONS.includes(action) || action === 'status' || action === 'backup') {
    throw new AgentError('INVALID_TASK', '只能为 update 或 rollback 创建任务');
  }
  if (action === 'update') {
    const version = validateVersion(nonEmptyOption(options, 'version'));
    const sha256 = validateSha256(nonEmptyOption(options, 'sha256'));
    const artifact = options.artifact === undefined ? undefined : validateArtifact(options.artifact);
    return {
      version,
      sha256,
      ...(artifact ? { artifact } : {}),
    };
  }

  const targetVersion = validateVersion(nonEmptyOption(options, 'target-version'), '目标版本');
  const reason = options.reason === undefined ? undefined : String(options.reason);
  if (reason && (reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason))) {
    throw new AgentError('INVALID_TASK', '回滚原因长度或字符无效');
  }
  return {
    targetVersion,
    ...(reason ? { reason } : {}),
  };
}

export function createTask({ instanceId, action, parameters, now = new Date(), taskId = `task-${Date.now()}-${randomUUID().slice(0, 12)}` }) {
  if (!taskIdPattern.test(taskId)) throw new AgentError('INVALID_TASK', '任务 ID 格式无效');
  if (!instanceIdPattern.test(instanceId)) throw new AgentError('INVALID_TASK', '实例 ID 格式无效');
  if (!ALLOWED_ACTIONS.includes(action) || action === 'status' || action === 'backup') throw new AgentError('INVALID_TASK', '任务动作无效');
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new AgentError('INVALID_TASK', '任务参数必须是对象');
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new AgentError('INVALID_TASK', '任务创建时间无效');
  const idempotencyKey = createHash('sha256')
    .update(stableJson({ instanceId, action, parameters }))
    .digest('hex')
    .toUpperCase();
  return {
    format: AGENT_FORMAT,
    kind: 'openlabstock.instance-task',
    taskId,
    idempotencyKey,
    instanceId,
    action,
    status: 'planned',
    approvalRequired: true,
    executor: 'deployment-adapter',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.valueOf() + TASK_TTL_MS).toISOString(),
    preconditions: {
      backupRequired: true,
      healthCheckRequired: true,
    },
    parameters,
  };
}

function taskTimestamp(value, field) {
  const timestamp = Date.parse(String(value ?? ''));
  if (!Number.isFinite(timestamp)) throw new AgentError('INVALID_TASK', `${field} 不是有效时间`);
  return timestamp;
}

function assertTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new AgentError('INVALID_TASK', '任务必须是对象');
  }
  if (task.format !== AGENT_FORMAT || task.kind !== 'openlabstock.instance-task') {
    throw new AgentError('INVALID_TASK', '任务格式或类型无效');
  }
  if (!taskIdPattern.test(String(task.taskId ?? '')) || !instanceIdPattern.test(String(task.instanceId ?? ''))) {
    throw new AgentError('INVALID_TASK', '任务 ID 或实例 ID 无效');
  }
  if (!TASK_STATUSES.includes(task.status)) throw new AgentError('INVALID_TASK', '任务状态无效');
  taskTimestamp(task.createdAt, 'createdAt');
  taskTimestamp(task.expiresAt, 'expiresAt');
}

function transitionTimestamp(task, key, now) {
  if (task[key] !== undefined) return task[key];
  return now.toISOString();
}

function normalizeTaskError(error) {
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    throw new AgentError('INVALID_TASK', '失败状态必须包含错误摘要');
  }
  const code = String(error.code ?? '').trim();
  const message = String(error.message ?? '').trim();
  if (!code || !message || code.length > 80 || message.length > 500 || /[\u0000-\u001f\u007f]/.test(code + message)) {
    throw new AgentError('INVALID_TASK', '错误摘要无效');
  }
  return { code, message };
}

/**
 * Apply one explicit state transition to a planned instance task.
 * The returned task is immutable-by-convention: callers receive a new object,
 * and terminal tasks cannot be changed by a later retry.
 */
export function transitionTask(task, nextStatus, { now = new Date(), error, result } = {}) {
  assertTask(task);
  if (!TASK_STATUSES.includes(nextStatus)) throw new AgentError('INVALID_TASK', '目标任务状态无效');
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new AgentError('INVALID_TASK', '状态变更时间无效');
  if (task.status === nextStatus) return { ...task };
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    throw new AgentError('INVALID_TASK_TRANSITION', '终态任务不能再次变更');
  }
  const expiresAt = taskTimestamp(task.expiresAt, 'expiresAt');
  const taskIsExpired = now.valueOf() >= expiresAt;
  if (taskIsExpired && nextStatus !== 'expired') {
    throw new AgentError('TASK_EXPIRED', '任务已过期，不能批准或执行');
  }
  if (nextStatus === 'expired' && !taskIsExpired) {
    throw new AgentError('TASK_NOT_EXPIRED', '任务尚未到期，不能标记为 expired');
  }
  if (!TASK_TRANSITIONS[task.status].includes(nextStatus)) {
    throw new AgentError('INVALID_TASK_TRANSITION', `${task.status} 不能变更为 ${nextStatus}`);
  }
  if (nextStatus === 'failed' && !error) {
    throw new AgentError('INVALID_TASK', '失败状态必须包含错误摘要');
  }

  const updated = { ...task, status: nextStatus };
  if (nextStatus === 'approved') updated.approvedAt = transitionTimestamp(task, 'approvedAt', now);
  if (nextStatus === 'running') updated.startedAt = transitionTimestamp(task, 'startedAt', now);
  if (TERMINAL_TASK_STATUSES.has(nextStatus)) updated.completedAt = now.toISOString();
  if (nextStatus === 'expired') updated.expiredAt = now.toISOString();
  if (nextStatus === 'failed') updated.error = normalizeTaskError(error);
  if (nextStatus === 'succeeded' && result !== undefined) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new AgentError('INVALID_TASK', '成功结果必须是对象');
    }
    updated.result = result;
  }
  return updated;
}

export function expireTask(task, now = new Date()) {
  assertTask(task);
  if (TERMINAL_TASK_STATUSES.has(task.status) || !isTaskExpired(task, now)) return { ...task };
  return transitionTask(task, 'expired', { now });
}

export function isTaskExpired(task, now = new Date()) {
  const expiresAt = Date.parse(String(task?.expiresAt ?? ''));
  return !Number.isFinite(expiresAt) || !(now instanceof Date) || Number.isNaN(now.valueOf()) || now.valueOf() >= expiresAt;
}

export function validateBackupManifest(manifest, databaseStats) {
  if (!manifest || manifest.format !== 1 || typeof manifest.database !== 'string' || path.basename(manifest.database) !== manifest.database || !manifest.database.endsWith('.sqlite')) {
    throw new AgentError('BACKUP_INVALID_MANIFEST', '备份清单数据库字段无效');
  }
  if (!sha256Pattern.test(String(manifest.sha256 ?? '')) || !Number.isInteger(manifest.bytes) || manifest.bytes < 1) {
    throw new AgentError('BACKUP_INVALID_MANIFEST', '备份清单校验字段无效');
  }
  if (!databaseStats || databaseStats.size !== manifest.bytes || databaseStats.sha256.toUpperCase() !== String(manifest.sha256).toUpperCase()) {
    throw new AgentError('BACKUP_MISMATCH', '备份清单与 SQLite 文件不一致');
  }
  return {
    database: manifest.database,
    createdAt: manifest.createdAt,
    bytes: manifest.bytes,
    sha256: String(manifest.sha256).toUpperCase(),
    schemaVersion: manifest.schemaVersion,
    integrity: manifest.integrity,
    foreignKeys: manifest.foreignKeys,
  };
}

function instanceConfig(options = {}) {
  const dataDir = path.resolve(options['data-dir'] ?? process.env.OPENLABSTOCK_DATA_DIR ?? process.env.DATA_DIR ?? path.join(appRoot, 'data'));
  const backupDir = path.resolve(options['backup-dir'] ?? process.env.OPENLABSTOCK_BACKUP_DIR ?? process.env.BACKUP_DIR ?? path.join(dataDir, 'backups'));
  const appDir = path.resolve(options['app-dir'] ?? process.env.OPENLABSTOCK_APP_DIR ?? appRoot);
  const taskDir = path.resolve(options['task-dir'] ?? process.env.OPENLABSTOCK_TASK_DIR ?? path.join(dataDir, 'instance-tasks'));
  const healthUrl = options['health-url'] ?? process.env.OPENLABSTOCK_HEALTH_URL ?? `http://${process.env.HOST ?? '127.0.0.1'}:${process.env.PORT ?? '4388'}/api/health`;
  const instanceId = options['instance-id'] ?? process.env.OPENLABSTOCK_INSTANCE_ID ?? process.env.INSTANCE_ID ?? 'local';
  if (!instanceIdPattern.test(instanceId)) {
    throw new AgentError('INVALID_CONFIG', 'INSTANCE_ID 必须是小写字母、数字和连字符组成的稳定标识');
  }
  return {
    appDir,
    dataDir,
    backupDir,
    taskDir,
    healthUrl,
    instanceId,
    healthToken: process.env.OPENLABSTOCK_HEALTH_DETAIL_TOKEN ?? process.env.HEALTH_DETAIL_TOKEN ?? '',
  };
}

async function writeReceipt(taskDir, receipt) {
  await mkdir(taskDir, { recursive: true, mode: 0o700 });
  const destination = path.join(taskDir, `${receipt.taskId}.json`);
  const temporary = `${destination}.partial-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, destination);
  return destination;
}

function baseReceipt(config, action, taskId, requestedAt) {
  return {
    format: AGENT_FORMAT,
    kind: 'openlabstock.instance-receipt',
    taskId,
    instanceId: config.instanceId,
    action,
    requestedAt,
  };
}

function failureReceipt(base, error) {
  return {
    ...base,
    status: 'failed',
    completedAt: new Date().toISOString(),
    error: {
      code: error?.code ?? 'AGENT_ERROR',
      message: error instanceof AgentError ? error.message : '实例操作失败',
    },
  };
}

async function fetchHealth(config) {
  const url = new URL(config.healthUrl);
  const headers = {};
  if (config.healthToken) {
    url.searchParams.set('detail', '1');
    headers['X-OpenLabStock-Health-Token'] = config.healthToken;
  }
  let response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new AgentError('HEALTH_UNREACHABLE', '无法连接实例健康检查地址');
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new AgentError('HEALTH_INVALID_RESPONSE', '健康检查返回了无效 JSON');
  }
  if (!response.ok || payload?.ok !== true) {
    throw new AgentError('HEALTH_FAILED', `健康检查失败（HTTP ${response.status}）`);
  }
  return payload;
}

async function latestBackupManifest(backupDir) {
  if (!existsSync(backupDir)) return null;
  const candidates = [];
  for (const entry of await readdir(backupDir, { withFileTypes: true })) {
    if (!entry.isFile() || !manifestPattern.test(entry.name)) continue;
    const filePath = path.join(backupDir, entry.name);
    candidates.push({ filePath, modifiedAt: (await stat(filePath)).mtimeMs });
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  if (!candidates[0]) return null;
  let manifest;
  try {
    manifest = JSON.parse(await readFile(candidates[0].filePath, 'utf8'));
  } catch {
    throw new AgentError('BACKUP_INVALID_MANIFEST', '最新备份清单无法读取');
  }
  if (!manifest || typeof manifest.database !== 'string' || path.basename(manifest.database) !== manifest.database || !manifest.database.endsWith('.sqlite')) {
    throw new AgentError('BACKUP_INVALID_MANIFEST', '备份清单数据库字段无效');
  }
  const databasePath = path.join(backupDir, manifest.database);
  if (path.dirname(databasePath) !== path.resolve(backupDir)) {
    throw new AgentError('BACKUP_INVALID_MANIFEST', '备份清单数据库路径无效');
  }
  if (!existsSync(databasePath)) throw new AgentError('BACKUP_MISSING_FILE', '最新备份清单对应的 SQLite 文件不存在');
  const databaseBytes = await readFile(databasePath);
  const databaseStats = { size: databaseBytes.byteLength, sha256: createHash('sha256').update(databaseBytes).digest('hex') };
  return validateBackupManifest(manifest, databaseStats);
}

function runBackup(config) {
  const backupScript = path.join(config.appDir, 'scripts', 'backup.mjs');
  if (!existsSync(backupScript)) throw new AgentError('BACKUP_SCRIPT_MISSING', '部署目录缺少 scripts/backup.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [backupScript], {
      cwd: config.appDir,
      env: { ...process.env, DATA_DIR: config.dataDir, BACKUP_DIR: config.backupDir },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new AgentError('BACKUP_TIMEOUT', '备份操作超时'));
    }, 120_000);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new AgentError('BACKUP_FAILED', '无法启动备份操作'));
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new AgentError('BACKUP_FAILED', `备份操作未成功完成${signal ? `（${signal}）` : ''}`));
    });
  });
}

async function runCommand(parsed, taskId, requestedAt) {
  const config = instanceConfig(parsed.options);
  const command = parsed.positionals[0];
  if ((command === 'status' || command === 'backup') && parsed.positionals.length !== 1) {
    throw new AgentError('INVALID_ARGUMENT', `${command} 不接受额外位置参数`);
  }
  if (command === 'plan' && parsed.positionals.length !== 2) {
    throw new AgentError('INVALID_ARGUMENT', 'plan 只接受 update 或 rollback 一个动作');
  }
  const action = command === 'plan' ? parsed.positionals[1] : command;
  const base = baseReceipt(config, action, taskId, requestedAt);

  if (command === 'status') {
    const health = await fetchHealth(config);
    return { ...base, status: 'succeeded', completedAt: new Date().toISOString(), health };
  }

  if (command === 'backup') {
    await runBackup(config);
    const backup = await latestBackupManifest(config.backupDir);
    if (!backup) throw new AgentError('BACKUP_MISSING', '备份命令完成但没有找到校验清单');
    return { ...base, status: 'succeeded', completedAt: new Date().toISOString(), backup };
  }

  if (command === 'plan') {
    const action = parsed.positionals[1];
    const parameters = validatePlan(action, parsed.options);
    const plan = createTask({ instanceId: config.instanceId, action, parameters, taskId });
    await writeReceipt(config.taskDir, plan);
    return plan;
  }

  throw new AgentError('INVALID_ARGUMENT', '用法：instance-agent.mjs status | backup | plan update | plan rollback');
}

function print(value, compact) {
  process.stdout.write(`${JSON.stringify(value, null, compact ? 0 : 2)}\n`);
}

function usage() {
  process.stdout.write([
    '用法：node scripts/instance-agent.mjs <命令>',
    '',
    '  status                                                     查看健康摘要',
    '  backup                                                     生成并校验一致性备份',
    '  plan update --version <版本> --sha256 <SHA-256>             生成待批准更新任务',
    '  plan rollback --target-version <版本> [--reason <原因>]      生成待批准回滚任务',
    '',
  ].join('\n'));
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const command = parsed.positionals[0];
  if (parsed.options.help) { usage(); return 0; }
  if (!command) throw new AgentError('USAGE', '用法：node scripts/instance-agent.mjs status | backup | plan update | plan rollback');
  const config = instanceConfig(parsed.options);
  const taskId = `task-${Date.now()}-${randomUUID().slice(0, 12)}`;
  const requestedAt = new Date().toISOString();
  let result;
  try {
    result = await runCommand(parsed, taskId, requestedAt);
  } catch (error) {
    const action = command === 'plan' ? parsed.positionals[1] ?? 'plan' : command;
    const base = baseReceipt(config, action, taskId, requestedAt);
    result = failureReceipt(base, error);
    await writeReceipt(config.taskDir, result).catch(() => undefined);
    print(result, Boolean(parsed.options.compact));
    return 1;
  }
  if (command === 'status' || command === 'backup') await writeReceipt(config.taskDir, result);
  print(result, Boolean(parsed.options.compact));
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === scriptPath;
if (isMain) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    print({ format: AGENT_FORMAT, kind: 'openlabstock.instance-receipt', status: 'failed', error: { code: error?.code ?? 'AGENT_ERROR', message: error instanceof AgentError ? error.message : '实例操作失败' } }, false);
    process.exitCode = 1;
  });
}
