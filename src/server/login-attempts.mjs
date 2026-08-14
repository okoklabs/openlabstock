export function createLoginAttemptLimiter({
  windowMs = 15 * 60_000,
  maxAttempts = 8,
  maxEntries = 10_000,
  now = Date.now,
} = {}) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('windowMs must be positive');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be a positive integer');
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('maxEntries must be a positive integer');

  const attempts = new Map();

  function activeAttempt(key, at = now()) {
    const attempt = attempts.get(key);
    if (!attempt || attempt.expiresAt <= at) {
      attempts.delete(key);
      return null;
    }
    return attempt;
  }

  function cleanupExpired(at = now()) {
    for (const [key, attempt] of attempts) {
      if (attempt.expiresAt <= at) attempts.delete(key);
    }
  }

  function makeRoom(at) {
    if (attempts.size < maxEntries) return;
    cleanupExpired(at);
    if (attempts.size < maxEntries) return;

    let evictionKey = '';
    let evictionAttempt = null;
    for (const [key, attempt] of attempts) {
      if (!evictionAttempt
        || attempt.count < evictionAttempt.count
        || (attempt.count === evictionAttempt.count && attempt.expiresAt < evictionAttempt.expiresAt)) {
        evictionKey = key;
        evictionAttempt = attempt;
      }
    }
    if (evictionKey) attempts.delete(evictionKey);
  }

  return {
    check(key) {
      const at = now();
      const attempt = activeAttempt(key, at);
      return {
        limited: Boolean(attempt && attempt.count >= maxAttempts),
        retryAfterSeconds: attempt ? Math.max(1, Math.ceil((attempt.expiresAt - at) / 1000)) : 0,
      };
    },
    recordFailure(key) {
      const at = now();
      let attempt = activeAttempt(key, at);
      if (!attempt) {
        makeRoom(at);
        attempt = { count: 0, expiresAt: at + windowMs };
      }
      attempt.count += 1;
      attempts.set(key, attempt);
      return attempt.count;
    },
    reset(key) {
      attempts.delete(key);
    },
    get size() {
      cleanupExpired();
      return attempts.size;
    },
  };
}

export function createLoginProtection({
  windowMs = 15 * 60_000,
  maxAccountAttempts = 8,
  maxClientAttempts = 80,
  maxEntries = 10_000,
  now = Date.now,
} = {}) {
  const accounts = createLoginAttemptLimiter({ windowMs, maxAttempts: maxAccountAttempts, maxEntries, now });
  const clients = createLoginAttemptLimiter({ windowMs, maxAttempts: maxClientAttempts, maxEntries, now });

  return {
    check(clientKey, accountKey) {
      const account = accounts.check(accountKey);
      const client = clients.check(clientKey);
      return {
        clientKey,
        accountKey,
        limited: account.limited || client.limited,
        retryAfterSeconds: Math.max(account.retryAfterSeconds, client.retryAfterSeconds),
      };
    },
    recordFailure(attempt) {
      accounts.recordFailure(attempt.accountKey);
      clients.recordFailure(attempt.clientKey);
    },
    resetAccount(attempt) {
      accounts.reset(attempt.accountKey);
    },
  };
}
