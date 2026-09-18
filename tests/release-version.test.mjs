import test from 'node:test';
import assert from 'node:assert/strict';
import { compareReleaseVersions, releaseTuple } from '../scripts/release-version.mjs';

test('release versions compare dotted and compact tags consistently', () => {
  assert.deepEqual(releaseTuple('2026.9.3-r2'), [2026, 9, 3, 2]);
  assert.deepEqual(releaseTuple('20260903-r2'), [2026, 9, 3, 2]);
  assert.equal(compareReleaseVersions('2026.9.3-r2', '20260903-r1'), 1);
  assert.equal(compareReleaseVersions('2026.9.1-r43', '2026.9.3-r2'), -1);
  assert.equal(compareReleaseVersions('2026.9.3-r2', '2026.9.3-r2'), 0);
});
