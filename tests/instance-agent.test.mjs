import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask, expireTask, isTaskExpired, parseArgs, summarizeDoctorReadiness, transitionTask, validateBackupManifest, validatePlan, AGENT_FORMAT, TASK_TTL_MS } from '../scripts/instance-agent.mjs';

const sha256 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('instance agent parses flag values without accepting an arbitrary command', () => {
  const parsed = parseArgs(['--', 'plan', 'update', '--version', '2026.9.1-r66', '--sha256', sha256, '--compact']);
  assert.deepEqual(parsed.positionals, ['plan', 'update']);
  assert.equal(parsed.options.version, '2026.9.1-r66');
  assert.equal(parsed.options.sha256, sha256);
  assert.equal(parsed.options.compact, true);
});

test('instance agent exposes help without touching the instance', async () => {
  const { main } = await import('../scripts/instance-agent.mjs');
  assert.equal(await main(['--help']), 0);
});

test('instance doctor distinguishes ready, degraded and blocked checks', () => {
  assert.equal(summarizeDoctorReadiness([{ key: 'health', status: 'ok' }]), 'ready');
  assert.equal(summarizeDoctorReadiness([{ key: 'backup', status: 'degraded' }]), 'degraded');
  assert.equal(summarizeDoctorReadiness([{ key: 'health', status: 'blocked' }, { key: 'backup', status: 'degraded' }]), 'blocked');
});

test('instance agent validates update and rollback plans', () => {
  assert.deepEqual(validatePlan('update', { version: '2026.9.1-r66', sha256 }), {
    version: '2026.9.1-r66',
    sha256: sha256.toUpperCase(),
  });
  assert.deepEqual(validatePlan('rollback', { 'target-version': '2026.9.1-r57', reason: 'health check failed' }), {
    targetVersion: '2026.9.1-r57',
    reason: 'health check failed',
  });
  assert.throws(() => validatePlan('update', { version: '2026.9.1-r66', sha256: 'bad' }), /SHA-256/);
  assert.throws(() => validatePlan('update', { version: '2026.9.1-r66', sha256, artifact: '../run.sh' }), /文件名/);
  assert.throws(() => validatePlan('status', {}), /只能为 update 或 rollback/);
});

test('instance task is explicit, auditable, and approval-gated', () => {
  const task = createTask({
    instanceId: 'example-lab-prod',
    action: 'update',
    parameters: { version: '2026.9.1-r66', sha256: sha256.toUpperCase() },
    taskId: 'task-test-001',
    now: new Date('2026-09-18T00:00:00.000Z'),
  });
  assert.equal(task.format, AGENT_FORMAT);
  assert.equal(task.kind, 'openlabstock.instance-task');
  assert.equal(task.status, 'planned');
  assert.equal(task.approvalRequired, true);
  assert.equal(task.executor, 'deployment-adapter');
  assert.equal(task.instanceId, 'example-lab-prod');
  assert.equal(task.createdAt, '2026-09-18T00:00:00.000Z');
  assert.equal(task.expiresAt, new Date(Date.parse(task.createdAt) + TASK_TTL_MS).toISOString());
  assert.match(task.idempotencyKey, /^[A-F0-9]{64}$/);
  assert.deepEqual(task.preconditions, { backupRequired: true, healthCheckRequired: true });
  assert.equal(isTaskExpired(task, new Date('2026-09-18T23:59:59.999Z')), false);
  assert.equal(isTaskExpired(task, new Date('2026-09-19T00:00:00.000Z')), true);
  assert.equal(isTaskExpired({}), true);
  const sameIntent = createTask({
    instanceId: 'example-lab-prod', action: 'update', parameters: { sha256: sha256.toUpperCase(), version: '2026.9.1-r66' }, taskId: 'task-test-002', now: new Date('2026-09-18T00:05:00.000Z'),
  });
  assert.equal(sameIntent.idempotencyKey, task.idempotencyKey);
  assert.notEqual(sameIntent.taskId, task.taskId);
  assert.throws(() => createTask({ instanceId: 'Bad ID', action: 'update', parameters: {}, taskId: 'task-test-003' }), /实例 ID/);
});

test('backup receipt requires the manifest to match the actual SQLite artifact', () => {
  const manifest = {
    format: 1,
    database: 'labstock-20260918T000000000Z.sqlite',
    bytes: 3,
    sha256: 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD',
    integrity: 'ok',
    foreignKeys: true,
  };
  assert.equal(validateBackupManifest(manifest, {
    size: 3,
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  }).sha256, manifest.sha256);
  assert.throws(() => validateBackupManifest(manifest, { size: 4, sha256: manifest.sha256 }), /不一致/);
  assert.throws(() => validateBackupManifest({ ...manifest, database: '../outside.sqlite' }, { size: 3, sha256: manifest.sha256 }), /数据库字段无效/);
});

test('instance task transitions enforce approval and preserve timestamps', () => {
  const created = createTask({
    instanceId: 'example-lab-prod',
    action: 'update',
    parameters: { version: '2026.9.1-r66', sha256 },
    taskId: 'task-transition-001',
    now: new Date('2026-09-18T00:00:00.000Z'),
  });
  const approved = transitionTask(created, 'approved', { now: new Date('2026-09-18T01:00:00.000Z') });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approvedAt, '2026-09-18T01:00:00.000Z');
  assert.equal(created.status, 'planned');
  assert.throws(() => transitionTask(created, 'running', { now: new Date('2026-09-18T01:00:00.000Z') }), /不能变更/);
  assert.throws(() => transitionTask(created, 'expired', { now: new Date('2026-09-18T01:00:00.000Z') }), /尚未到期/);

  const running = transitionTask(approved, 'running', { now: new Date('2026-09-18T02:00:00.000Z') });
  const succeeded = transitionTask(running, 'succeeded', {
    now: new Date('2026-09-18T02:05:00.000Z'),
    result: { version: '2026.9.1-r66', health: 'ok' },
  });
  assert.equal(succeeded.startedAt, '2026-09-18T02:00:00.000Z');
  assert.equal(succeeded.completedAt, '2026-09-18T02:05:00.000Z');
  assert.deepEqual(succeeded.result, { version: '2026.9.1-r66', health: 'ok' });
  assert.throws(() => transitionTask(succeeded, 'failed', { now: new Date('2026-09-18T03:00:00.000Z'), error: { code: 'LATE', message: 'late retry' } }), /终态/);
});

test('instance task failure and expiration are explicit and terminal', () => {
  const created = createTask({
    instanceId: 'example-lab-prod',
    action: 'rollback',
    parameters: { targetVersion: '2026.9.1-r57' },
    taskId: 'task-transition-002',
    now: new Date('2026-09-18T00:00:00.000Z'),
  });
  const failed = transitionTask(created, 'failed', {
    now: new Date('2026-09-18T01:00:00.000Z'),
    error: { code: 'APPROVAL_DENIED', message: '维护者拒绝执行该任务' },
  });
  assert.deepEqual(failed.error, { code: 'APPROVAL_DENIED', message: '维护者拒绝执行该任务' });
  assert.throws(() => transitionTask(created, 'failed', { now: new Date('2026-09-18T01:00:00.000Z') }), /错误摘要/);

  const expiring = createTask({
    instanceId: 'example-lab-prod', action: 'update', parameters: { version: '2026.9.1-r66', sha256 },
    taskId: 'task-transition-003', now: new Date('2026-09-18T00:00:00.000Z'),
  });
  const expired = expireTask(expiring, new Date('2026-09-19T00:00:00.000Z'));
  assert.equal(expired.status, 'expired');
  assert.equal(expired.expiredAt, '2026-09-19T00:00:00.000Z');
  assert.throws(() => transitionTask(expired, 'approved', { now: new Date('2026-09-19T00:01:00.000Z') }), /终态/);
});
