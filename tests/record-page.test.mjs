import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRecordPageUrl, createRecordPageState, recordRangeStart } from '../src/scripts/record-page.mjs';

test('记录页 URL 只携带当前筛选、时间范围与游标', () => {
  const url = buildRecordPageUrl({
    cursor: 'next-page',
    pageSize: 25,
    type: 'use',
    scope: 'mine',
    query: '2-3',
    from: '2026-07-15T12:00:00.000Z',
  });
  assert.equal(url, '/api/transactions?mode=page&pageSize=25&type=use&scope=mine&q=2-3&from=2026-07-15T12%3A00%3A00.000Z&cursor=next-page');
});

test('记录页状态集中维护游标历史、翻页和范围重置', () => {
  const state = createRecordPageState({ pageSize: 2 });
  state.reset({ from: '2026-08-01T00:00:00.000Z', scope: 'mine' });
  state.applyResult({ items: ['a', 'b'], total: 5, hasMore: true, nextCursor: 'cursor-2' });

  assert.deepEqual(state.summary(), { from: 1, to: 2, totalPages: 3 });
  assert.equal(state.currentCursor(), '');
  assert.equal(state.next(), true);
  assert.equal(state.page, 2);
  assert.equal(state.currentCursor(), 'cursor-2');

  state.applyResult({ items: ['c', 'd'], total: 5, hasMore: true, nextCursor: 'cursor-3' });
  assert.deepEqual(state.summary(), { from: 3, to: 4, totalPages: 3 });
  assert.equal(state.previous(), true);
  assert.equal(state.page, 1);
  assert.equal(state.previous(), false);

  state.reset({ scope: 'all' });
  assert.equal(state.scope, 'all');
  assert.equal(state.page, 1);
  assert.equal(state.total, 0);
  assert.equal(state.currentCursor(), '');
  state.setScope('mine');
  assert.equal(state.scope, 'mine');
  assert.throws(() => state.setScope('team'), /scope must be all or mine/);
});

test('记录时间范围保持全部、最近天数和本年三种口径', () => {
  const now = new Date(2026, 7, 14, 20, 30, 0, 0);
  assert.equal(recordRangeStart('all', now), '');

  const recent = new Date(recordRangeStart('30', now));
  const expectedRecent = new Date(now);
  expectedRecent.setDate(now.getDate() - 30);
  assert.equal(recent.toISOString(), expectedRecent.toISOString());

  const year = new Date(recordRangeStart('year', now));
  const expectedYear = new Date(now);
  expectedYear.setMonth(0, 1);
  expectedYear.setHours(0, 0, 0, 0);
  assert.equal(year.toISOString(), expectedYear.toISOString());
});
