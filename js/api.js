// Thin client for the database functions (PostgREST RPC endpoint).
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const MESSAGES = {
  network: "Can't reach the server. Check your connection and try again.",
  not_installed: "The database isn't set up yet. Run supabase/setup.sql in the Supabase SQL Editor.",
  unauthorized: 'Your session ended. Sign in again.',
  forbidden: "You don't have permission to do that.",
  conflict: 'Someone else changed this at the same moment. The latest version has been loaded, so try again.',
  deleted: 'This item was deleted by someone else.',
  not_found: 'This item no longer exists.',
  username_taken: 'That username is already taken.',
  last_admin: 'Keep at least one active admin.',
  self_change: "You can't disable your own account or change your own role.",
  use_reset: 'Re-enable the account by setting a new temporary password.',
  bad_setup_code: "That setup code doesn't match. Copy it again from the SQL Editor result.",
  already_initialized: 'This tracker is already set up. Sign in instead.',
  must_change: 'Choose a new password first.',
  wrong_password: 'Current password is wrong.',
  too_large: 'That item is too large to save.',
  bad_role: 'Pick a valid role.',
};

export class ApiError extends Error {
  constructor(code, message) { super(message || MESSAGES[code] || code); this.code = code; }
}

export async function rpc(fn, args = {}) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', apikey: SUPABASE_KEY },
      body: JSON.stringify(args),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new ApiError('network');
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    if (res.status === 404 || body?.code === 'PGRST202') throw new ApiError('not_installed');
    const code = String(body?.message || `http_${res.status}`);
    throw new ApiError(code, MESSAGES[code] || (res.status >= 500 ? 'The server had a problem. Try again in a moment.' : `Request failed (${code}).`));
  }
  return body;
}
