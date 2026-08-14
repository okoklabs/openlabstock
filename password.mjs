import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, passwordHash: scryptSync(password, salt, 64).toString('hex') };
}

export function verifyPassword(password, user) {
  const expected = Buffer.from(user.passwordHash, 'hex');
  const actual = scryptSync(password, user.salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
