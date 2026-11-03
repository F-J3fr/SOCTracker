// Crypto primitives — all via the browser's native WebCrypto API (no third-party crypto).
//
// Design (envelope encryption):
//   • One random 256-bit Data Encryption Key (DEK) encrypts the whole team vault with AES-GCM.
//   • Each user gets a Key Encryption Key (KEK) derived from their password with PBKDF2-SHA256.
//     The DEK is wrapped (encrypted) with each user's KEK. Wrong password => unwrap fails.
//   • Usernames are never stored in clear outside the vault: the keyring is indexed by a
//     PBKDF2 hash of the lowercased username + a random per-install salt.
//   • Passwords are never stored at all — not even hashed. Only the wrapped DEK exists.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const PBKDF2_ITER_PASSWORD = 310000; // OWASP 2023 guidance for PBKDF2-SHA256
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

async function pbkdf2Bits(secret, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256);
}

/** Stable, non-reversible lookup id for a username (case-insensitive). */
export async function usernameLookupId(username, appSaltB64) {
  const bits = await pbkdf2Bits(username.trim().toLowerCase(), unb64(appSaltB64), PBKDF2_ITER_USERNAME);
  return b64(bits);
}

async function deriveKek(password, saltBytes, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']
  );
}

export async function generateDek() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/** Wrap the DEK for one user. lookupId is bound as AAD so entries can't be swapped between users. */
export async function wrapDekForPassword(dek, password, lookupId) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const kek = await deriveKek(password, salt, PBKDF2_ITER_PASSWORD);
  const wrapped = await crypto.subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv, additionalData: enc.encode(lookupId) });
  return { salt: b64(salt), iv: b64(iv), wrapped: b64(wrapped), iter: PBKDF2_ITER_PASSWORD, updatedAt: Date.now() };
}

/** Returns the DEK, or throws if the password is wrong / entry tampered. */
export async function unwrapDekWithPassword(entry, password, lookupId) {
  const kek = await deriveKek(password, unb64(entry.salt), entry.iter || PBKDF2_ITER_PASSWORD);
  return crypto.subtle.unwrapKey(
    'raw', unb64(entry.wrapped), kek,
    { name: 'AES-GCM', iv: unb64(entry.iv), additionalData: enc.encode(lookupId) },
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  );
}

export async function encryptJson(dek, obj) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: b64(ct) };
}
export async function decryptJson(dek, box) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, dek, unb64(box.ct));
  return JSON.parse(dec.decode(pt));
}

/** Readable random temp password (no ambiguous chars). */
export function generateTempPassword(len = 14) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%*?';
  const bytes = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

export function uuid() { return crypto.randomUUID(); }
