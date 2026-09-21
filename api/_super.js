import { createHash, timingSafeEqual, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

import { accountId } from '../scripts/runtime-config.mjs';
export { accountId };
export const isSuperId = id => typeof id === 'string' && [accountId, `${accountId}@vsbadge.local`].includes(id.trim().toLowerCase());
const digest = text => createHash('sha256').update(text).digest();
export function equalSecret(a, b) {
  return typeof a === 'string' && typeof b === 'string' && timingSafeEqual(digest(a), digest(b));
}
export function superConfigured() {
  return typeof process.env.SUPER_KEY === 'string' && process.env.SUPER_KEY.length >= 16;
}
export function checkSuperPassword(password) {
  return superConfigured() && equalSecret(password, process.env.SUPER_KEY);
}
function key() {
  if (!superConfigured()) throw new Error('Authentication unavailable');
  return digest('vsbadge-super-v1\0' + process.env.SUPER_KEY);
}
export function sealSuper(kind, data, ttlSeconds) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(kind));
  const content = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + ttlSeconds * 1000 }));
  const encrypted = Buffer.concat([cipher.update(content), cipher.final()]);
  return 'vs1.' + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
export function openSuper(kind, token) {
  try {
    if (typeof token !== 'string' || !token.startsWith('vs1.') || token.length > 4096) return null;
    const bytes = Buffer.from(token.slice(4), 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(kind));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const value = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
    return Number.isFinite(value.exp) && value.exp > Date.now() ? value : null;
  } catch { return null; }
}
