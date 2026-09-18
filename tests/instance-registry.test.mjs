import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstanceRecord, createTaskSummary, recordHealth, validateInstanceRecord } from '../scripts/instance-registry.mjs';

test('instance registry keeps deployment metadata separate from business data', () => {
  const record = createInstanceRecord({
    instanceId: 'lab-a-prod',
    displayName: '实验室 A',
    domain: 'Inventory.Example.org',
    desiredVersion: '2026.9.3-r3',
    now: new Date('2026-09-18T00:00:00.000Z'),
  });
  assert.deepEqual(record, {
    format: 1,
    kind: 'openlabstock.instance',
    instanceId: 'lab-a-prod',
    displayName: '实验室 A',
    domain: 'inventory.example.org',
    lifecycle: 'provisioning',
    desiredVersion: '2026.9.3-r3',
    observedVersion: null,
    health: { status: 'unknown', observedAt: null, latencyMs: null },
    backup: { status: 'unknown', observedAt: null, ageSeconds: null, bytes: null, schemaVersion: null },
    task: null,
    updatedAt: '2026-09-18T00:00:00.000Z',
  });
  assert.equal('materials' in record, false);
  assert.equal('transactions' in record, false);
  assert.equal('members' in record, false);
});

test('instance registry records health and backup observations without changing desired state', () => {
  const record = createInstanceRecord({ instanceId: 'lab-a-prod', displayName: 'A', domain: 'a.example.org', desiredVersion: '2026.9.3-r3' });
  const task = createTaskSummary({ action: 'update', status: 'running', taskId: 'task-update-1', now: new Date('2026-09-18T01:00:00.000Z') });
  const observed = recordHealth({ ...record, task }, {
    observedVersion: '2026.9.3-r2',
    health: { status: 'healthy', observedAt: '2026-09-18T02:00:00.000Z', latencyMs: 42 },
    backup: { status: 'ok', observedAt: '2026-09-18T01:55:00.000Z', ageSeconds: 300, bytes: 4096, schemaVersion: 16 },
    now: new Date('2026-09-18T02:00:01.000Z'),
  });
  assert.equal(observed.desiredVersion, '2026.9.3-r3');
  assert.equal(observed.observedVersion, '2026.9.3-r2');
  assert.equal(observed.health.latencyMs, 42);
  assert.equal(observed.backup.bytes, 4096);
  assert.equal(observed.task.status, 'running');
});

test('instance registry rejects secrets, paths, and malformed health records', () => {
  const record = createInstanceRecord({ instanceId: 'lab-a-prod', displayName: 'A', domain: 'a.example.org' });
  assert.throws(() => validateInstanceRecord({ ...record, domain: 'https://a.example.org/path' }), /domain/);
  assert.throws(() => validateInstanceRecord({ ...record, instanceId: '../prod' }), /instanceId/);
  assert.throws(() => validateInstanceRecord({ ...record, health: { status: 'healthy', observedAt: 'bad', latencyMs: 1 } }), /health.observedAt/);
  assert.throws(() => validateInstanceRecord({ ...record, health: { status: 'healthy', observedAt: null, latencyMs: 1 } }), /必须有observedAt/);
  assert.throws(() => validateInstanceRecord({ ...record, task: { taskId: 'task-1', action: 'update', status: 'shell', createdAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:00:00Z' } }), /task.status/);
  assert.throws(() => validateInstanceRecord({ ...record, apiToken: 'secret' }), /实例记录/);
  assert.throws(() => createTaskSummary({ action: 'shell', status: 'running' }), /task.action/);
});
