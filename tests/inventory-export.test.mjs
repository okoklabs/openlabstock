import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveManualOutboundTransactions, groupConsumptionRows } from '../src/scripts/inventory-export.mjs';

const material = { id: 'material-1', name: '探针', category: '测试耗材', spec: 'A 型' };

test('分组消耗使用流水发生时组织快照并扣除全部冲销数量', () => {
  const transactions = [
    {
      id: 'out-old', type: 'out', sourceType: 'manual', materialId: material.id, materialName: material.name,
      quantity: 5, unit: '根', userName: '成员甲', groupId: 'group-1', groupName: '改名前课题组', occurredAt: '2026-08-01T01:00:00.000Z',
    },
    {
      id: 'correction-1', type: 'in', sourceType: 'manual', materialId: material.id, materialName: material.name,
      quantity: 2, unit: '根', userName: '成员甲', groupId: 'group-1', groupName: '改名后课题组', correctionOfId: 'out-old', occurredAt: '2026-08-01T02:00:00.000Z',
    },
    {
      id: 'correction-2', type: 'in', sourceType: 'manual', materialId: material.id, materialName: material.name,
      quantity: 1, unit: '根', userName: '管理员', groupId: 'group-1', groupName: '改名后课题组', correctionOfId: 'out-old', occurredAt: '2026-08-01T03:00:00.000Z',
    },
    {
      id: 'out-new', type: 'out', sourceType: 'manual', materialId: material.id, materialName: material.name,
      quantity: 4, unit: '根', userName: '成员乙', groupId: 'group-1', groupName: '改名后课题组', occurredAt: '2026-08-02T01:00:00.000Z',
    },
    {
      id: 'adjustment', type: 'out', sourceType: 'inventory_adjustment', materialId: material.id, materialName: material.name,
      quantity: 99, unit: '根', userName: '管理员', groupId: 'group-1', groupName: '改名后课题组', occurredAt: '2026-08-03T01:00:00.000Z',
    },
  ];

  const effective = effectiveManualOutboundTransactions(transactions);
  assert.deepEqual(effective.map((record) => [record.id, record.quantity]), [['out-old', 2], ['out-new', 4]]);

  const rows = groupConsumptionRows(transactions, [material]);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    Object.fromEntries(rows.map((row) => [row.groupName, { quantity: row.quantity, records: row.records }])),
    {
      改名前课题组: { quantity: 2, records: 1 },
      改名后课题组: { quantity: 4, records: 1 },
    },
  );
});
