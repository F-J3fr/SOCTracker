// Browser-side cryptography (WebCrypto only).
//
// Keys
//   DEK         random AES-256-GCM key shared by the team; encrypts every record before upload.
//   master      PBKDF2-SHA256(password, salt = lookup id, 310,000 iterations).
//   authKey     HKDF(master, "auth")  -> sent to the server, which stores only a bcrypt hash of it.
//   KEK         HKDF(master, "kek")   -> never leaves the browser; wraps the DEK for this user.
//   lookup id   PBKDF2(lowercased username, per-team salt) -> the server never sees usernames.
// The server can check a sign-in but cannot derive the KEK, so it can't read any data.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const PBKDF2_ITER_PASSWORD = 310000;
export const PBKDF2_ITER_USERNAME = 100000;

export function b64(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function randomBytes(n) { return crypto.getRandomValues(new Uint8Array(n)); }
export function uuid() { return crypto.randomUUID(); }

async function pbkdf2(secret, saltBytes, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, base, 256);
}

export async function usernameLookupId(username, appSaltB64) {
  return b64(await pbkdf2(username.trim().toLowerCase(), unb64(appSaltB64), PBKDF2_ITER_USERNAME));
}

/** Derive the sign-in key (for the server) and the key-encryption key (stays here). */
export async function deriveUserKeys(password, lookupId) {
  const master = await pbkdf2(password, enc.encode('soctracker|' + lookupId), PBKDF2_ITER_PASSWORD);
  const hk = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const salt = new Uint8Array(32);
  const authBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('soctracker-auth') }, hk, 256);
  const kek = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('soctracker-kek') },
    hk, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  return { authKey: b64(authBits), kek };
}

export async function generateDek() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function wrapDek(dek, kek, lookupId) {
  const iv = randomBytes(12);
  const wrapped = await crypto.subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv, additionalData: enc.encode(lookupId) });
  return { v: 2, iv: b64(iv), wrapped: b64(wrapped) };
}

export async function unwrapDek(slot, kek, lookupId) {
  return crypto.subtle.unwrapKey(
    'raw', unb64(slot.wrapped), kek,
    { name: 'AES-GCM', iv: unb64(slot.iv), additionalData: enc.encode(lookupId) },
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/** Encrypt a JSON value. `aad` (e.g. the record id) binds the ciphertext to its row. */
export async function encryptJson(key, obj, aad = '') {
  const iv = randomBytes(12);
  const params = { name: 'AES-GCM', iv };
  if (aad) params.additionalData = enc.encode(aad);
  const ct = await crypto.subtle.encrypt(params, key, enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: b64(ct) };
}
export async function decryptJson(key, box, aad = '') {
  const params = { name: 'AES-GCM', iv: unb64(box.iv) };
  if (aad) params.additionalData = enc.encode(aad);
  const pt = await crypto.subtle.decrypt(params, key, unb64(box.ct));
  return JSON.parse(dec.decode(pt));
}

/** Deterministic UUID for singleton records (settings, one schedule per month). */
export async function uuidFromString(s) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('soctracker:' + s))).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = [...h].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function generateTempPassword(len = 14) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%*?';
  for (;;) {
    const bytes = randomBytes(len);
    let s = '';
    for (let i = 0; i < len; i++) s += alphabet[bytes[i] % alphabet.length];
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length;
    if (classes >= 3) return s;
  }
}
