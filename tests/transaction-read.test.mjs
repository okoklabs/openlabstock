import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeRecordCursor } from '../src/server/record-query.mjs';
import { readTransactionsResponse } from '../src/server/transaction-read.mjs';

const admin = { id: 'admin-1', role: 'admin', active: true };
const member = { id: 'member-1', role: 'member', active: true };

function dependencies(overrides = {}) {
  return {
    session: { userId: admin.id },
    canViewAllTransactions: (user) => user.role === 'admin',
    formatExportSnapshot: (store, user, exportedAt) => ({ marker: 'snapshot', store, user, exportedAt }),
    ...overrides,
  };
}

test('记录读取控制器使用同一快照生成完整导出', () => {
  const store = { users: [admin], transactions: [{ id: 'record-1' }] };
  const result = readTransactionsResponse(dependencies({
    url: new URL('http://localhost/api/transactions?mode=export'),
    view: { readStoreSnapshot: () => ({ store, exportedAt: '2026-08-14T12:00:00.000Z' }) },
  }));

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.marker, 'snapshot');
  assert.equal(result.body.store, store);
  assert.equal(result.body.user, admin);
  assert.equal(result.body.exportedAt, '2026-08-14T12:00:00.000Z');
});

test('记录读取控制器保持分页筛选、成员范围与游标协议', () => {
  let options;
  const nextCursor = { occurredAt: '2026-08-14T11:00:00.000Z', sourceOrder: 2, id: 'event-2' };
  const result = readTransactionsResponse(dependencies({
    session: { userId: member.id },
    url: new URL('http://localhost/api/transactions?mode=page&scope=all&type=use&pageSize=25&q=2-3'),
    view: {
      readActiveUser: () => member,
      queryRecordPage: (input) => {
        options = input;
        return { items: [{ kind: 'event', occurredAt: nextCursor.occurredAt }], total: 3, hasMore: true, nextCursor };
      },
    },
  }));

  assert.equal(result.statusCode, 200);
  assert.equal(options.userId, member.id);
  assert.equal(options.type, 'use');
  assert.equal(options.pageSize, 25);
  assert.equal(options.query, '2-3');
  assert.equal(result.body.total, 3);
  assert.equal(result.body.hasMore, true);
  assert.deepEqual(decodeRecordCursor(result.body.nextCursor), nextCursor);
});

test('记录读取控制器兼容旧版列表并按权限限制本人记录', () => {
  const calls = [];
  const transactions = [{ id: 'transaction-1' }];
  const inventoryEvents = [{ id: 'event-1' }];
  const result = readTransactionsResponse(dependencies({
    session: { userId: member.id },
    url: new URL('http://localhost/api/transactions?includeInventoryEvents=1'),
    view: {
      readActiveUser: () => member,
      queryTransactions: (query) => { calls.push(['transactions', query]); return transactions; },
      queryInventoryEvents: (query) => { calls.push(['events', query]); return inventoryEvents; },
    },
  }));

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { transactions, total: 1, inventoryEvents, eventTotal: 1 });
  assert.deepEqual(calls, [
    ['transactions', { userId: member.id }],
    ['events', { userId: member.id }],
  ]);
});

test('记录读取控制器拒绝已停用账号', () => {
  const result = readTransactionsResponse(dependencies({
    url: new URL('http://localhost/api/transactions?mode=page'),
    view: { readActiveUser: () => null },
  }));
  assert.deepEqual(result, { statusCode: 401, body: { error: '账号已停用' } });
});
