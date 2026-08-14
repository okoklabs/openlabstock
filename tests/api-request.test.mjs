import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeJsonRequestBody } from '../src/scripts/api-request.mjs';

test('JSON API 请求体统一序列化且不会重复编码字符串', () => {
  assert.equal(serializeJsonRequestBody(undefined), undefined);
  assert.equal(serializeJsonRequestBody(null), null);
  assert.equal(serializeJsonRequestBody('{"already":"encoded"}'), '{"already":"encoded"}');
  assert.deepEqual(JSON.parse(serializeJsonRequestBody({ inventoryUnitId: 'unit-1', reason: '核对实物' })), {
    inventoryUnitId: 'unit-1',
    reason: '核对实物',
  });
});
