import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoginAttemptLimiter, createLoginProtection } from '../src/server/login-attempts.mjs';

test('登录失败限制保持固定窗口并清理成功或过期记录', () => {
  let currentTime = 1_000;
  const limiter = createLoginAttemptLimiter({ windowMs: 10_000, maxAttempts: 2, maxEntries: 10, now: () => currentTime });

  assert.deepEqual(limiter.check('client|user'), { limited: false, retryAfterSeconds: 0 });
  assert.equal(limiter.recordFailure('client|user'), 1);
  assert.equal(limiter.recordFailure('client|user'), 2);
  assert.deepEqual(limiter.check('client|user'), { limited: true, retryAfterSeconds: 10 });

  limiter.reset('client|user');
  assert.equal(limiter.check('client|user').limited, false);
  limiter.recordFailure('client|user');
  currentTime += 10_001;
  assert.equal(limiter.check('client|user').limited, false);
  assert.equal(limiter.size, 0);
});

test('登录失败限制在随机账号名攻击下保持有界并优先保留高风险记录', () => {
  let currentTime = 1_000;
  const limiter = createLoginAttemptLimiter({ windowMs: 10_000, maxAttempts: 2, maxEntries: 3, now: () => currentTime });
  limiter.recordFailure('client|admin');
  limiter.recordFailure('client|admin');
  limiter.recordFailure('client|random-1');
  limiter.recordFailure('client|random-2');
  limiter.recordFailure('client|random-3');

  assert.equal(limiter.size, 3);
  assert.equal(limiter.check('client|admin').limited, true);
  assert.equal(limiter.check('client|random-1').limited, false);

  currentTime += 10_001;
  limiter.recordFailure('client|new');
  assert.equal(limiter.size, 1);
});

test('登录保护同时限制单账号和轮换账号名的客户端总量', () => {
  let currentTime = 1_000;
  const protection = createLoginProtection({
    windowMs: 10_000,
    maxAccountAttempts: 2,
    maxClientAttempts: 3,
    maxEntries: 10,
    now: () => currentTime,
  });

  const first = protection.check('client-1', 'client-1|user-a');
  protection.recordFailure(first);
  protection.recordFailure(first);
  assert.equal(protection.check('client-1', 'client-1|user-a').limited, true);
  assert.equal(protection.check('client-1', 'client-1|user-b').limited, false);

  const second = protection.check('client-1', 'client-1|user-b');
  protection.recordFailure(second);
  assert.equal(protection.check('client-1', 'client-1|user-c').limited, true);

  protection.resetAccount(first);
  assert.equal(protection.check('client-1', 'client-1|user-a').limited, true);
  currentTime += 10_001;
  assert.equal(protection.check('client-1', 'client-1|user-a').limited, false);
});
