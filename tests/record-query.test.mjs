import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeRecordCursor, encodeRecordCursor, recordPageOptions } from '../src/server/record-query.mjs';

test('服务端记录分页协议校验游标、筛选与本人范围', () => {
  const cursor = { occurredAt: '2026-08-12T12:00:00.000Z', sourceOrder: 2, id: 'event-1' };
  assert.deepEqual(decodeRecordCursor(encodeRecordCursor(cursor)), cursor);

  const all = recordPageOptions(new URL('http://localhost/api/transactions?mode=page'), {
    userId: 'user-1',
    canViewAll: true,
  });
  assert.deepEqual(all, { pageSize: 60, query: '', type: 'all', from: '', userId: '', cursor: null });

  const mine = recordPageOptions(new URL('http://localhost/api/transactions?mode=page&scope=mine&type=use&pageSize=25'), {
    userId: 'user-1',
    canViewAll: true,
  });
  assert.equal(mine.userId, 'user-1');
  assert.equal(mine.type, 'use');
  assert.equal(mine.pageSize, 25);

  const restricted = recordPageOptions(new URL('http://localhost/api/transactions?mode=page'), {
    userId: 'user-2',
    canViewAll: false,
  });
  assert.equal(restricted.userId, 'user-2');
  assert.throws(() => decodeRecordCursor('invalid'), /记录分页游标无效/);
  assert.throws(() => recordPageOptions(new URL('http://localhost/api/transactions?pageSize=101'), { userId: 'user-1', canViewAll: true }), /1-100/);
  assert.throws(() => recordPageOptions(new URL('http://localhost/api/transactions?scope=team'), { userId: 'user-1', canViewAll: true }), /记录范围筛选无效/);
});
