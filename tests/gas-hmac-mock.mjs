import { createHmac } from 'node:crypto';

// Model the GAS overloads and signed byte arrays instead of silently accepting mixed types.
export function gasHmac(value, key) {
  const strings = typeof value === 'string' && typeof key === 'string';
  const bytes = Array.isArray(value) && Array.isArray(key);
  if (!strings && !bytes) throw new TypeError('Invalid GAS HMAC signature');
  if (bytes && [...value, ...key].some(b => !Number.isInteger(b) || b < -128 || b > 127)) {
    throw new TypeError('Invalid GAS signed byte');
  }
  const input = strings ? Buffer.from(value, 'utf8') : Buffer.from(value.map(b => b & 255));
  const secret = strings ? Buffer.from(key, 'utf8') : Buffer.from(key.map(b => b & 255));
  return Array.from(createHmac('sha256', secret).update(input).digest(), b => b > 127 ? b - 256 : b);
}
export function gasBlob(value) {
  return { getBytes: () => Array.from(Buffer.from(String(value), 'utf8'), b => b > 127 ? b - 256 : b) };
}
