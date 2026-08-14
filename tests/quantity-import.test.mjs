import assert from 'node:assert/strict';
import test from 'node:test';
import { planQuantityImport } from '../src/server/quantity-import.mjs';

const user = { id: 'user-1', name: '测试成员' };
const group = { id: 'group-1', name: '测试组' };
const existing = {
  id: 'material-1', name: '测试滤膜', category: '过滤耗材', quantity: 5, safetyStock: 1,
  unit: '盒', spec: '50 片/盒', trackingMode: 'quantity', positionCodeHelp: '', usageContextHelp: '',
  active: true, updatedAt: '2026-01-01T00:00:00.000Z',
};

test('数量导入先规划完整批次并生成差额流水', () => {
  let sequence = 0;
  const result = planQuantityImport({
    rows: [
      { name: '测试滤膜', category: '过滤耗材', quantity: 8, safetyStock: 2, unit: '盒', spec: '新规格' },
      { name: '新耗材', category: '', quantity: 0, safetyStock: '', unit: '', spec: '' },
    ],
    materials: [existing], user, group, occurredAt: '2026-08-12T00:00:00.000Z',
    createId: () => `new-${++sequence}`,
  });
  assert.equal(result.ok, true);
  assert.equal(result.imported, 2);
  assert.equal(result.adjustments, 1);
  assert.equal(result.materials[0].quantity, 8);
  assert.equal(result.materials[1].unit, '件');
  assert.equal(result.transactions[0].sourceType, 'inventory_adjustment');
  assert.equal(result.transactions[0].quantity, 3);
});

test('数量导入任一行冲突时不产生部分计划', () => {
  const result = planQuantityImport({
    rows: [
      { name: '可新增耗材', quantity: 2 },
      { name: '测试 滤膜', quantity: 3 },
    ],
    materials: [existing], user, group,
  });
  assert.deepEqual(result, {
    ok: false,
    status: 409,
    error: '耗材“测试 滤膜”可能与已有耗材“测试滤膜”重复，请统一名称后再导入',
  });
});
