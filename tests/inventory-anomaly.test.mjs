import assert from 'node:assert/strict';
import test from 'node:test';
import { inventoryAnomalyEntryLabel, inventoryAnomalyResolutionBody } from '../src/scripts/inventory-anomaly.mjs';

test('库存异常修复请求使用有效 JSON，并区分开放和自用明细', () => {
  const anomaly = { inventoryUnitId: 'unit-1' };
  const shared = {
    statusId: 'status-new', statusName: '全新', accessScope: 'shared', ownerUserId: '', ownerName: '', positionCode: '2-1',
  };
  const reserved = {
    statusId: 'status-new', statusName: '全新', accessScope: 'user', ownerUserId: 'user-1', ownerName: '郝春霖', positionCode: '2-1',
  };

  assert.equal(inventoryAnomalyEntryLabel(shared), '全新 · 开放使用');
  assert.equal(inventoryAnomalyEntryLabel(reserved), '全新 · 自用 · 郝春霖');
  assert.deepEqual(
    JSON.parse(inventoryAnomalyResolutionBody({ anomaly, entry: reserved }, '2-3', '旧表数据修复')),
    {
      inventoryUnitId: 'unit-1',
      fromStatusId: 'status-new',
      fromAccessScope: 'user',
      fromOwnerUserId: 'user-1',
      fromPositionCode: '2-1',
      toPositionCode: '2-3',
      reason: '旧表数据修复',
    },
  );
});
