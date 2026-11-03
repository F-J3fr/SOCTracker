// Shared, encrypted data layer. Everything is encrypted in the browser before it reaches the server.
import { rpc, ApiError } from './api.js';
import * as C from './crypto.js';

export const ROLES = { analyst: 'Analyst', teamlead: 'Team lead', admin: 'Admin' };
export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
export const SHIFT_CODES = ['M', 'A', 'O', 'AL'];
export const SHIFT_LABELS = { M: 'Morning', A: 'Afternoon', O: 'Off', AL: 'Annual leave' };
export const INCIDENT_STATUSES = ['Open', 'Contained', 'Eradicated', 'Recovered', 'Closed'];
export const INCIDENT_CATEGORIES = ['Phishing', 'Malware', 'Unauthorized access', 'Account compromise', 'Data leakage', 'Denial of service', 'Fraud', 'Insider threat', 'Vulnerability exploitation', 'Policy violation', 'Other'];
export const FIELD_TYPES = { text: 'Short text', textarea: 'Long text', number: 'Number', datetime: 'Date and time', select: 'Pick from a list', yesno: 'Yes or no', user: 'Team member' };
export const REQUIRED_MODES = { no: 'Optional', always: 'Required', close: 'Required to close' };
export const CORE_FIELDS = { escalatedTo: 'Escalated team or user', reportedAt: 'Reported date and time', ackAt: 'Acknowledgement date and time', source: 'Source', notes: 'Notes' };

const SETTINGS_ID = '00000000-0000-4000-8000-000000000001';
const SESSION_KEY = 'soctracker.session.v2';
const DEFAULT_SETTINGS = {
  teamName: 'SOC Team',
  sla: { Critical: 15, High: 30, Medium: 60, Low: 240 },
  shiftTimes: { M: { start: '07:00', end: '15:00' }, A: { start: '15:00', end: '23:00' } },
  reportCutoff: '18:00',
  sessionTimeoutMin: 30,
};

function emptyData() {
  return { users: [], cases: [], incidents: [], handovers: [], notices: [], templates: [], schedule: { months: {} }, settings: structuredClone(DEFAULT_SETTINGS) };
}

let cfg = null;
const session = { token: null, dek: null, me: null, since: null, usersStamp: null };
let store = emptyData();
const meta = new Map();
const listeners = new Set();
let status = 'idle';

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(reason = 'data') { for (const fn of listeners) { try { fn(reason); } catch (e) { console.error(e); } } }
export function syncStatus() { return status; }
function setStatus(s) { if (s !== status) { status = s; emit('status'); } }

export function data() { return store; }
export function currentUser() { return session.me; }
export function isLoggedIn() { return !!session.dek; }
export function isInitialized() { return !!cfg?.initialized; }
export function metaOf(id) { return meta.get(id); }

export async function loadConfig() { cfg = await rpc('soc_config'); return cfg; }

// ------------------------------------------------------------- session

async function saveSession() {
  try {
    const raw = await crypto.subtle.exportKey('raw', session.dek);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: session.token, dek: C.b64(raw), me: session.me }));
  } catch { /* storage may be unavailable */ }
}
function clearSession() { try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } }

/** Resume a session after a page refresh in the same tab. */
export async function resume() {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { saved = null; }
  if (!saved?.token) return false;
  try {
    session.token = saved.token;
    session.dek = await crypto.subtle.importKey('raw', C.unb64(saved.dek), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    session.me = saved.me;
    if (!session.me.mustChange) await fullSync();
    startSync();
    return true;
  } catch (e) {
    resetLocal(); clearSession();
    return false;
  }
}

function resetLocal() {
  stopSync();
  session.token = null; session.dek = null; session.me = null; session.since = null; session.usersStamp = null;
  store = emptyData(); meta.clear();
}

export async function logout() {
  const t = session.token;
  resetLocal(); clearSession();
  if (t) rpc('soc_logout', { p_token: t }).catch(() => {});
  emit('signedout');
}

export function validatePassword(pw) {
  if (!pw || pw.length < 12) return 'Use at least 12 characters.';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 3) return 'Mix at least three of: lowercase, uppercase, numbers, symbols.';
  return null;
}
function validateUsername(u) {
  if (!/^[A-Za-z0-9._-]{3,32}$/.test((u || '').trim())) throw new Error('Usernames are 3 to 32 characters: letters, numbers, dot, dash, underscore.');
}

export async function setup({ code, username, displayName, password, teamName }) {
  validateUsername(username);
  const pe = validatePassword(password); if (pe) throw new Error(pe);
  if (!cfg) await loadConfig();
  const lookupId = await C.usernameLookupId(username, cfg.app_salt);
  const { authKey, kek } = await C.deriveUserKeys(password, lookupId);
  const dek = await C.generateDek();
  const settings = { ...structuredClone(DEFAULT_SETTINGS), teamName: (teamName || '').trim() || DEFAULT_SETTINGS.teamName };
  await rpc('soc_setup', {
    p_code: code, p_lookup_id: lookupId, p_auth_key: authKey,
    p_key_slot: await C.wrapDek(dek, kek, lookupId),
    p_enc_profile: await C.encryptJson(dek, { username: username.trim(), displayName: (displayName || username).trim() }, 'profile'),
    p_settings_id: SETTINGS_ID,
    p_settings: await C.encryptJson(dek, settings, `settings:${SETTINGS_ID}`),
  });
  cfg.initialized = true;
  await login(username, password);
}

export async function login(username, password) {
  if (!cfg) await loadConfig();
  const lookupId = await C.usernameLookupId(username, cfg.app_salt);
  const { authKey, kek } = await C.deriveUserKeys(password, lookupId);
  const r = await rpc('soc_login', { p_lookup_id: lookupId, p_auth_key: authKey });
  if (r.error === 'locked') throw new Error(`Too many failed attempts. Try again in ${r.minutes} minute${r.minutes > 1 ? 's' : ''}.`);
  if (r.error === 'disabled') throw new Error('This account is disabled. Contact your team lead or admin.');
  if (r.error) throw new Error('Wrong username or password.');
  const dek = await C.unwrapDek(r.user.key_slot, kek, lookupId);
  const profile = await C.decryptJson(dek, r.user.enc_profile, 'profile');
  resetLocal();
  session.token = r.token; session.dek = dek;
  session.me = { id: r.user.id, role: r.user.role, mustChange: r.user.must_change, username: profile.username, displayName: profile.displayName, lookupId };
  await saveSession();
  if (!session.me.mustChange) { await fullSync(); startSync(); }
  return session.me;
}

export async function changeOwnPassword(current, next) {
  const me = session.me;
  if (current === next) throw new Error('Pick a new password that is different from the current one.');
  const pe = validatePassword(next); if (pe) throw new Error(pe);
  const oldKeys = await C.deriveUserKeys(current, me.lookupId);
  const newKeys = await C.deriveUserKeys(next, me.lookupId);
  await rpc('soc_change_password', {
    p_token: session.token, p_old_auth_key: oldKeys.authKey, p_new_auth_key: newKeys.authKey,
    p_key_slot: await C.wrapDek(session.dek, newKeys.kek, me.lookupId),
  });
  const first = me.mustChange;
  me.mustChange = false;
  await saveSession();
  if (first) { await fullSync(); startSync(); }
}

// ------------------------------------------------------------- sync

let timer = null;
let syncing = null;
export function startSync() {
  stopSync();
  const tick = async () => {
    try { await sync(); } catch { /* status already set */ }
    if (session.token) timer = setTimeout(tick, document.hidden ? 60000 : 8000);
  };
  timer = setTimeout(tick, 8000);
}
export function stopSync() { if (timer) clearTimeout(timer); timer = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden && session.token && !session.me?.mustChange) sync().catch(() => {}); });

async function fullSync() { session.since = null; session.usersStamp = null; await sync(true); }

export function sync(force = false) {
  if (!session.token || session.me?.mustChange) return Promise.resolve(false);
  if (syncing && !force) return syncing;
  syncing = (async () => {
    try {
      setStatus('syncing');
      const since = session.since ? new Date(Date.parse(session.since) - 30000).toISOString() : null;
      const r = await rpc('soc_sync', { p_token: session.token, p_since: since });
      let changed = false;
      if (r.me.role !== session.me.role) { session.me.role = r.me.role; changed = true; await saveSession(); }
      for (const rec of r.records) changed = (await applyRecord(rec)) || changed;
      if (r.users_stamp !== session.usersStamp) { await refreshUsers(); session.usersStamp = r.users_stamp; changed = true; }
      session.since = r.now;
      setStatus('live');
      if (changed) emit('data');
      return changed;
    } catch (e) {
      if (e.code === 'unauthorized') { await logout(); emit('expired'); }
      else setStatus('offline');
      throw e;
    } finally { syncing = null; }
  })();
  return syncing;
}

const COLL = { case: 'cases', incident: 'incidents', handover: 'handovers', notice: 'notices', template: 'templates' };

async function applyRecord(rec) {
  const m = meta.get(rec.id);
  if (m && m.version >= rec.version) return false;
  if (rec.deleted) {
    removeLocal(rec.kind, rec.id);
    meta.set(rec.id, { kind: rec.kind, version: rec.version, deleted: true });
    return true;
  }
  let obj;
  try { obj = await C.decryptJson(session.dek, rec.enc, `${rec.kind}:${rec.id}`); }
  catch { console.warn('Skipped a record that could not be decrypted', rec.id); return false; }
  const mm = { kind: rec.kind, version: rec.version, createdBy: rec.created_by, updatedBy: rec.updated_by, createdAt: Date.parse(rec.created_at), updatedAt: Date.parse(rec.updated_at) };
  meta.set(rec.id, mm);
  putLocal(rec.kind, rec.id, obj, mm);
  return true;
}

function putLocal(kind, id, obj, mm) {
  obj.id = id;
  obj.updatedAt = mm.updatedAt;
  obj.updatedBy = mm.updatedBy;
  // server-recorded creator is authoritative
  if (kind === 'case') obj.createdBy = mm.createdBy;
  if (kind === 'handover') obj.author = mm.createdBy;
  if (kind === 'incident') obj.declaredBy = mm.createdBy;
  if (kind === 'notice') obj.author = mm.createdBy;
  if (kind === 'settings') { store.settings = { ...structuredClone(DEFAULT_SETTINGS), ...obj }; return; }
  if (kind === 'schedule') { store.schedule.months[obj.monthKey] = obj; return; }
  const arr = store[COLL[kind]];
  const i = arr.findIndex((x) => x.id === id);
  if (i >= 0) arr[i] = obj; else arr.push(obj);
}
function removeLocal(kind, id) {
  if (kind === 'schedule') { for (const [k, v] of Object.entries(store.schedule.months)) if (v.id === id) delete store.schedule.months[k]; return; }
  if (!COLL[kind]) return;
  store[COLL[kind]] = store[COLL[kind]].filter((x) => x.id !== id);
}
function getLocal(kind, id) {
  if (kind === 'settings') return meta.has(id) ? store.settings : null;
  if (kind === 'schedule') return Object.values(store.schedule.months).find((m) => m.id === id) || null;
  return store[COLL[kind]].find((x) => x.id === id) || null;
}

async function put(kind, id, obj) {
  const m = meta.get(id);
  const body = { ...obj }; delete body.id; delete body.updatedAt; delete body.updatedBy;
  const r = await rpc('soc_put', {
    p_token: session.token, p_id: id, p_kind: kind,
    p_enc: await C.encryptJson(session.dek, body, `${kind}:${id}`),
    p_expected: m && !m.deleted ? m.version : 0,
  });
  const mm = { kind, version: r.version, createdBy: r.created_by, updatedBy: session.me.id, createdAt: Date.parse(r.created_at), updatedAt: Date.parse(r.updated_at) };
  meta.set(id, mm);
  putLocal(kind, id, structuredClone(obj), mm);
  emit('data');
  return getLocal(kind, id);
}

/** Read-modify-write with automatic retry when someone else saved first. fn gets a copy; return null for "no change". */
async function mutate(kind, id, fn) {
  for (let attempt = 0; ; attempt++) {
    const cur = getLocal(kind, id);
    const next = await fn(cur ? structuredClone(cur) : null);
    if (next === null) return cur;
    try { return await put(kind, id, next); }
    catch (e) {
      if (e.code === 'conflict' && attempt < 3) { await sync(true); continue; }
      throw e;
    }
  }
}

async function remove(id) {
  await rpc('soc_delete', { p_token: session.token, p_id: id });
  const m = meta.get(id);
  if (m) { removeLocal(m.kind, id); meta.set(id, { ...m, deleted: true, version: m.version + 1 }); }
  emit('data');
}

async function nextRef(prefix, ts) {
  const d = new Date(ts || Date.now());
  const key = `${prefix}-${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const n = await rpc('soc_next_ref', { p_token: session.token, p_key: key });
  return `${key}-${String(n).padStart(3, '0')}`;
}

// ------------------------------------------------------------- permissions

const isLead = (u = session.me) => !!u && (u.role === 'admin' || u.role === 'teamlead');
export const can = {
  manageUsers: () => isLead(),
  manageSchedule: () => isLead(),
  postNotices: () => isLead(),
  viewAudit: () => isLead(),
  editSettings: () => isLead(),
  deleteCases: () => isLead(),
  deleteIncidents: () => isLead(),
  manageTemplates: () => isLead(),
  manageTarget: (target) => !!session.me && !!target && (session.me.role === 'admin' || (session.me.role === 'teamlead' && target.role !== 'admin')),
  assignRole: (role) => !!session.me && (session.me.role === 'admin' || (session.me.role === 'teamlead' && role !== 'admin')),
};

// ------------------------------------------------------------- audit

export function addAudit(action, detail) {
  if (!session.token) return;
  (async () => {
    try { await rpc('soc_audit_add', { p_token: session.token, p_action: action, p_enc: await C.encryptJson(session.dek, { detail }, 'audit') }); }
    catch (e) { console.warn('audit', e.message); }
  })();
}

const SERVER_ACTIONS = {
  'login': () => 'Signed in',
  'login.failed': (t) => t ? `Failed sign-in for ${t}` : 'Failed sign-in with an unknown username',
  'setup': () => 'Set up the tracker',
  'user.create': (t) => `Created account for ${t}`,
  'user.reset': (t) => `Reset password for ${t}`,
  'user.enable': (t) => `Re-enabled ${t} with a temporary password`,
  'user.disable': (t) => `Disabled ${t}`,
  'user.update': (t) => `Updated account for ${t}`,
  'user.password': () => 'Changed own password',
};
export async function listAudit() {
  const rows = await rpc('soc_audit_list', { p_token: session.token, p_limit: 3000 });
  const out = [];
  for (const r of rows) {
    let detail = '';
    if (r.enc) { try { detail = (await C.decryptJson(session.dek, r.enc, 'audit')).detail; } catch { detail = '(unreadable)'; } }
    else detail = (SERVER_ACTIONS[r.action] || (() => r.action))(r.target ? userName(r.target) : '');
    out.push({ id: r.id, at: Date.parse(r.at), by: r.user_id ? userName(r.user_id) : 'Unknown', action: r.action, detail, server: !r.enc });
  }
  return out;
}

// ------------------------------------------------------------- users

async function refreshUsers() {
  const rows = await rpc('soc_users', { p_token: session.token });
  const users = [];
  for (const r of rows) {
    let p = { username: '?', displayName: 'Unknown user' };
    try { p = await C.decryptJson(session.dek, r.enc_profile, 'profile'); } catch { /* ignore */ }
    users.push({ id: r.id, role: r.role, mustChange: r.must_change, disabled: r.disabled, username: p.username, displayName: p.displayName,
      createdAt: Date.parse(r.created_at), createdBy: r.created_by, updatedAt: Date.parse(r.updated_at), lastLoginAt: r.last_login_at ? Date.parse(r.last_login_at) : null });
  }
  store.users = users;
  const me = users.find((u) => u.id === session.me.id);
  if (me) { session.me.displayName = me.displayName; session.me.role = me.role; }
}
export function userName(id) { return store.users.find((u) => u.id === id)?.displayName || '—'; }

async function userKeys(username, password) {
  const lookupId = await C.usernameLookupId(username, cfg.app_salt);
  const { authKey, kek } = await C.deriveUserKeys(password, lookupId);
  return { lookupId, authKey, slot: await C.wrapDek(session.dek, kek, lookupId) };
}

export async function createUser({ username, displayName, role, password }) {
  if (!can.manageUsers()) throw new ApiError('forbidden');
  if (!ROLES[role]) throw new Error('Pick a role.');
  if (!can.assignRole(role)) throw new Error('Only an admin can create admin accounts.');
  validateUsername(username);
  const pe = validatePassword(password); if (pe) throw new Error(pe);
  username = username.trim();
  const k = await userKeys(username, password);
  const r = await rpc('soc_create_user', {
    p_token: session.token, p_lookup_id: k.lookupId, p_role: role, p_auth_key: k.authKey, p_key_slot: k.slot,
    p_enc_profile: await C.encryptJson(session.dek, { username, displayName: (displayName || username).trim() }, 'profile'),
  });
  await refreshUsers(); emit('data');
  return store.users.find((u) => u.id === r.id) || { id: r.id, username, role };
}

export async function resetPassword(userId, tempPassword) {
  const t = store.users.find((u) => u.id === userId);
  if (!t || !can.manageTarget(t)) throw new ApiError('forbidden');
  const pe = validatePassword(tempPassword); if (pe) throw new Error(pe);
  const k = await userKeys(t.username, tempPassword);
  await rpc('soc_reset_user', { p_token: session.token, p_user_id: userId, p_auth_key: k.authKey, p_key_slot: k.slot });
  await refreshUsers(); emit('data');
}
export const enableUserWithPassword = resetPassword;

export async function updateUser(userId, { displayName, role, disabled }) {
  const t = store.users.find((u) => u.id === userId);
  if (!t || !can.manageTarget(t)) throw new ApiError('forbidden');
  const args = { p_token: session.token, p_user_id: userId, p_role: null, p_disabled: null, p_enc_profile: null };
  if (role && role !== t.role) args.p_role = role;
  if (disabled !== undefined && disabled !== t.disabled) args.p_disabled = disabled;
  if (displayName && displayName.trim() && displayName.trim() !== t.displayName) {
    args.p_enc_profile = await C.encryptJson(session.dek, { username: t.username, displayName: displayName.trim() }, 'profile');
  }
  if (args.p_role === null && args.p_disabled === null && args.p_enc_profile === null) return;
  await rpc('soc_update_user', args);
  await refreshUsers(); emit('data');
}

// ------------------------------------------------------------- SLA

export function slaTargetMin(sev) { return Number(store.settings.sla[sev]) || 60; }
export function computeSla(c, now = Date.now()) {
  if (!c.detectedAt) return 'N';
  const limit = c.detectedAt + slaTargetMin(c.severity) * 60000;
  if (c.ackAt) return c.ackAt > limit ? 'Y' : 'N';
  return now > limit ? 'Y' : 'N';
}
export function effectiveSla(c) { return c.slaManual ? c.slaBreach : computeSla(c); }

// ------------------------------------------------------------- templates

const isEmpty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** Labels of mandated fields that are still empty. */
export function missingRequired(c, closing) {
  const t = c.template;
  if (!t) return [];
  const out = [];
  for (const [k, mode] of Object.entries(t.core || {})) {
    if ((mode === 'always' || (mode === 'close' && closing)) && isEmpty(c[k])) out.push(CORE_FIELDS[k]);
  }
  for (const f of t.fields || []) {
    if ((f.required === 'always' || (f.required === 'close' && closing)) && isEmpty(c.fieldValues?.[f.id])) out.push(f.label);
  }
  return out;
}

export async function saveTemplate(t) {
  if (!can.manageTemplates()) throw new ApiError('forbidden');
  const name = (t.name || '').trim();
  if (!name) throw new Error('Give the template a name.');
  if (store.templates.some((x) => x.id !== t.id && x.name.toLowerCase() === name.toLowerCase())) throw new Error('Another template already has that name.');
  const labels = new Set();
  for (const f of t.fields) {
    f.label = (f.label || '').trim();
    if (!f.label) throw new Error('Every field needs a label.');
    if (labels.has(f.label.toLowerCase())) throw new Error(`Two fields are called "${f.label}".`);
    labels.add(f.label.toLowerCase());
    if (f.type === 'select' && !(f.options || []).length) throw new Error(`Add at least one option to "${f.label}".`);
  }
  const id = t.id || C.uuid();
  const isNew = !t.id;
  await mutate('template', id, (cur) => ({
    ...(cur || { createdAt: Date.now() }),
    name, description: (t.description || '').trim(), defaultSeverity: t.defaultSeverity || 'Medium',
    active: t.active !== false, core: t.core || {}, fields: t.fields,
  }));
  addAudit(isNew ? 'template.create' : 'template.update', `${isNew ? 'Created' : 'Updated'} case template "${name}"`);
  return id;
}
export async function deleteTemplate(id) {
  const t = store.templates.find((x) => x.id === id);
  await remove(id);
  addAudit('template.delete', `Deleted case template "${t?.name}"`);
}
function templateSnapshot(templateId) {
  const t = store.templates.find((x) => x.id === templateId);
  if (!t) return null;
  return { id: t.id, name: t.name, core: structuredClone(t.core || {}), fields: structuredClone(t.fields || []) };
}

// ------------------------------------------------------------- cases

const CASE_FIELDS = ['name', 'escalatedTo', 'severity', 'detectedAt', 'reportedAt', 'ackAt', 'slaBreach', 'slaManual', 'status', 'notes', 'source'];
const FIELD_LABEL = { name: 'Case name', escalatedTo: 'Escalated to', severity: 'Severity', detectedAt: 'Detected', reportedAt: 'Reported', ackAt: 'Acknowledged', slaBreach: 'SLA breach', slaManual: 'SLA override', status: 'Status', notes: 'Notes', source: 'Source' };

function validateCase(input) {
  if (!input.name?.trim()) throw new Error('Give the case a name.');
  if (!SEVERITIES.includes(input.severity)) throw new Error('Pick a severity.');
  if (!input.detectedAt) throw new Error('Add the detection date and time.');
  if (input.reportedAt && input.reportedAt < input.detectedAt) throw new Error('Reported time is before detection time.');
  if (input.ackAt && input.ackAt < input.detectedAt) throw new Error('Acknowledgement time is before detection time.');
  const miss = missingRequired(input, input.status === 'Closed');
  if (miss.length) throw new Error(`This case type needs: ${miss.join(', ')}.`);
}

export async function saveCase(input) {
  const me = session.me;
  if (input.id) {
    const res = await mutate('case', input.id, (c) => {
      if (!c) throw new ApiError('deleted');
      const merged = { ...c, ...input, template: c.template, fieldValues: { ...(c.fieldValues || {}), ...(input.fieldValues || {}) } };
      validateCase(merged);
      const changes = [];
      for (const f of CASE_FIELDS) {
        if (input[f] !== undefined && input[f] !== c[f]) { changes.push({ field: FIELD_LABEL[f], from: c[f] ?? '', to: input[f] ?? '' }); c[f] = input[f]; }
      }
      for (const fd of c.template?.fields || []) {
        const nv = input.fieldValues?.[fd.id];
        if (nv !== undefined && nv !== (c.fieldValues?.[fd.id] ?? '')) {
          changes.push({ field: fd.label, from: c.fieldValues?.[fd.id] ?? '', to: nv });
          c.fieldValues = { ...(c.fieldValues || {}), [fd.id]: nv };
        }
      }
      if (!changes.length) return null;
      if (changes.some((ch) => ch.field === 'Status')) {
        if (c.status === 'Closed') { c.closedAt = Date.now(); c.closedBy = me.id; } else { c.closedAt = null; c.closedBy = null; }
      }
      c.history.push({ at: Date.now(), by: me.id, action: 'updated', changes });
      return c;
    });
    addAudit('case.update', `Updated ${res.ref}`);
    return res;
  }
  const template = input.templateId ? templateSnapshot(input.templateId) : null;
  const draft = { ...input, template };
  validateCase(draft);
  const now = Date.now();
  const c = {
    ref: await nextRef('SOC', input.detectedAt), createdAt: now, closedAt: null, closedBy: null, history: [], comments: [], incidentId: null,
    templateId: template?.id || null, template, fieldValues: input.fieldValues || {},
  };
  for (const f of CASE_FIELDS) c[f] = input[f] ?? (f === 'status' ? 'WIP' : f === 'slaManual' ? false : f === 'slaBreach' ? 'N' : '');
  if (c.status === 'Closed') { c.closedAt = now; c.closedBy = me.id; }
  c.history.push({ at: now, by: me.id, action: 'opened' });
  const saved = await put('case', C.uuid(), c);
  addAudit('case.create', `Opened ${saved.ref} "${saved.name}" (${saved.severity})${template ? `, type ${template.name}` : ''}`);
  return saved;
}

export async function setCaseStatus(id, status, extra = {}) {
  const me = session.me;
  const res = await mutate('case', id, (c) => {
    if (!c) throw new ApiError('deleted');
    Object.assign(c, extra.patch || {});
    if (extra.fieldValues) c.fieldValues = { ...(c.fieldValues || {}), ...extra.fieldValues };
    if (status === 'Closed') {
      const miss = missingRequired(c, true);
      if (miss.length) throw new Error(`Fill in before closing: ${miss.join(', ')}.`);
    }
    if (c.status === status && !extra.patch && !extra.fieldValues) return null;
    c.history.push({ at: Date.now(), by: me.id, action: 'updated', changes: [{ field: 'Status', from: c.status, to: status }] });
    c.status = status;
    if (status === 'Closed') { c.closedAt = Date.now(); c.closedBy = me.id; } else { c.closedAt = null; c.closedBy = null; }
    return c;
  });
  addAudit('case.update', `${status === 'Closed' ? 'Closed' : 'Reopened'} ${res.ref}`);
  return res;
}

export async function addCaseComment(id, body) {
  if (!body.trim()) throw new Error('Write something first.');
  const res = await mutate('case', id, (c) => {
    if (!c) throw new ApiError('deleted');
    c.comments = c.comments || [];
    c.comments.push({ id: C.uuid(), at: Date.now(), by: session.me.id, body: body.trim() });
    return c;
  });
  addAudit('case.comment', `Commented on ${res.ref}`);
}

export async function deleteCase(id) {
  const c = store.cases.find((x) => x.id === id);
  await remove(id);
  addAudit('case.delete', `Deleted ${c?.ref} "${c?.name}"`);
}

// ------------------------------------------------------------- incidents

function logEntry(kind, text) { return { id: C.uuid(), at: Date.now(), by: session.me.id, kind, text }; }

export async function createIncident(input, caseIds = []) {
  if (!input.title?.trim()) throw new Error('Give the incident a title.');
  if (!SEVERITIES.includes(input.severity)) throw new Error('Pick a severity.');
  const now = Date.now();
  const cases = caseIds.map((id) => store.cases.find((c) => c.id === id)).filter(Boolean);
  const inc = {
    ref: await nextRef('INC', now), title: input.title.trim(), severity: input.severity, category: input.category || 'Other',
    status: 'Open', ownerId: input.ownerId || session.me.id, summary: (input.summary || '').trim(), affectedAssets: (input.affectedAssets || '').trim(),
    rootCause: '', lessonsLearned: '', declaredAt: now,
    startedAt: input.startedAt || (cases.length ? Math.min(...cases.map((c) => c.detectedAt)) : now),
    containedAt: null, eradicatedAt: null, recoveredAt: null, closedAt: null, closedBy: null,
    caseIds: cases.map((c) => c.id),
    log: [{ ...logEntry('created', cases.length ? `Declared from ${cases.map((c) => c.ref).join(', ')}` : 'Declared'), to: 'Open' }],
  };
  const id = C.uuid();
  const saved = await put('incident', id, inc);
  for (const c of cases) await attachCase(c.id, saved);
  addAudit('incident.create', `Declared ${saved.ref} "${saved.title}" (${saved.severity})`);
  return saved;
}

async function attachCase(caseId, inc) {
  await mutate('case', caseId, (c) => {
    if (!c) return null;
    c.incidentId = inc.id;
    c.history.push({ at: Date.now(), by: session.me.id, action: 'updated', changes: [{ field: 'Incident', from: '', to: inc.ref }] });
    return c;
  });
}

export async function linkCaseToIncident(caseId, incidentId) {
  const c = store.cases.find((x) => x.id === caseId);
  const inc = await mutate('incident', incidentId, (i) => {
    if (!i) throw new ApiError('deleted');
    if (i.caseIds.includes(caseId)) return null;
    i.caseIds.push(caseId);
    i.log.push(logEntry('link', `Linked ${c?.ref}`));
    return i;
  });
  await attachCase(caseId, inc);
  addAudit('incident.update', `Linked ${c?.ref} to ${inc.ref}`);
  return inc;
}

const INC_FIELDS = { title: 'Title', severity: 'Severity', category: 'Category', ownerId: 'Owner', summary: 'Summary and impact', affectedAssets: 'Affected assets', rootCause: 'Root cause', lessonsLearned: 'Lessons learned', startedAt: 'Started' };
export async function updateIncident(id, patch) {
  const res = await mutate('incident', id, (i) => {
    if (!i) throw new ApiError('deleted');
    const changed = [];
    for (const [k, label] of Object.entries(INC_FIELDS)) {
      if (patch[k] !== undefined && patch[k] !== i[k]) { changed.push(label); i[k] = typeof patch[k] === 'string' ? patch[k].trim() : patch[k]; }
    }
    if (!i.title) throw new Error('Give the incident a title.');
    if (!changed.length) return null;
    i.log.push(logEntry('edit', `Updated ${changed.join(', ')}`));
    return i;
  });
  addAudit('incident.update', `Updated ${res.ref}`);
  return res;
}

const STATUS_STAMP = { Contained: 'containedAt', Eradicated: 'eradicatedAt', Recovered: 'recoveredAt', Closed: 'closedAt' };
export async function setIncidentStatus(id, status, note = '', patch = {}) {
  if (!INCIDENT_STATUSES.includes(status)) throw new Error('Pick a status.');
  const res = await mutate('incident', id, (i) => {
    if (!i) throw new ApiError('deleted');
    Object.assign(i, patch);
    if (status === 'Closed') {
      const miss = [];
      if (!i.summary?.trim()) miss.push('Summary and impact');
      if (!i.rootCause?.trim()) miss.push('Root cause');
      if (miss.length) throw new Error(`Fill in before closing: ${miss.join(', ')}.`);
      i.closedBy = session.me.id;
    }
    if (i.status === status && !note) return null;
    const from = i.status;
    i.status = status;
    if (STATUS_STAMP[status] && !i[STATUS_STAMP[status]]) i[STATUS_STAMP[status]] = Date.now();
    if (status !== 'Closed') { i.closedAt = null; i.closedBy = null; }
    i.log.push({ ...logEntry('status', `${from} → ${status}${note ? `: ${note.trim()}` : ''}`), to: status });
    return i;
  });
  addAudit('incident.status', `${res.ref} is now ${status}`);
  return res;
}

export async function addIncidentLog(id, text) {
  if (!text.trim()) throw new Error('Write something first.');
  const res = await mutate('incident', id, (i) => {
    if (!i) throw new ApiError('deleted');
    i.log.push(logEntry('note', text.trim()));
    return i;
  });
  addAudit('incident.log', `Logged an update on ${res.ref}`);
}

export async function deleteIncident(id) {
  const inc = store.incidents.find((x) => x.id === id);
  await remove(id);
  for (const cid of inc?.caseIds || []) {
    await mutate('case', cid, (c) => { if (!c || c.incidentId !== id) return null; c.incidentId = null; return c; }).catch(() => {});
  }
  addAudit('incident.delete', `Deleted ${inc?.ref} "${inc?.title}"`);
}

// ------------------------------------------------------------- handovers

export async function saveHandover({ id, shift, date, body, openCaseIds }) {
  if (!body?.trim()) throw new Error('Write the handover first.');
  if (id) {
    const h = store.handovers.find((x) => x.id === id);
    if (h.author !== session.me.id && !isLead()) throw new Error('You can only edit your own handovers.');
    await mutate('handover', id, (x) => ({ ...x, shift, date, body: body.trim() }));
    addAudit('handover.update', `Edited ${SHIFT_LABELS[shift]} handover for ${date}`);
  } else {
    await put('handover', C.uuid(), { shift, date, body: body.trim(), createdAt: Date.now(), openCaseIds: openCaseIds || [], readBy: [session.me.id] });
    addAudit('handover.create', `Wrote ${SHIFT_LABELS[shift]} handover for ${date}`);
  }
}
export async function deleteHandover(id) {
  const h = store.handovers.find((x) => x.id === id);
  await remove(id);
  addAudit('handover.delete', `Deleted handover for ${h?.date}`);
}
export async function markHandoverRead(id) {
  await mutate('handover', id, (h) => {
    if (!h) return null;
    h.readBy = h.readBy || [];
    if (h.readBy.includes(session.me.id)) return null;
    h.readBy.push(session.me.id);
    return h;
  });
}

// ------------------------------------------------------------- notices

export async function saveNotice({ id, title, body, priority, expiresAt }) {
  if (!can.postNotices()) throw new ApiError('forbidden');
  if (!title?.trim()) throw new Error('Give the notice a title.');
  const nid = id || C.uuid();
  await mutate('notice', nid, (n) => ({ ...(n || { createdAt: Date.now(), acks: [] }), title: title.trim(), body: (body || '').trim(), priority, expiresAt: expiresAt || null }));
  addAudit(id ? 'notice.update' : 'notice.create', `${id ? 'Edited' : 'Posted'} notice "${title.trim()}"`);
}
export async function deleteNotice(id) {
  const n = store.notices.find((x) => x.id === id);
  await remove(id);
  addAudit('notice.delete', `Removed notice "${n?.title}"`);
}
export async function ackNotice(id) {
  const res = await mutate('notice', id, (n) => {
    if (!n) return null;
    if (n.acks.some((a) => a.userId === session.me.id)) return null;
    n.acks.push({ userId: session.me.id, at: Date.now() });
    return n;
  });
  if (res) addAudit('notice.ack', `Acknowledged notice "${res.title}"`);
}
/** Incident status as it stood at time t (for reports). */
export function incidentStatusAt(i, t) {
  let st = null;
  for (const e of [...i.log].sort((a, b) => a.at - b.at)) if (e.to && e.at < t) st = e.to;
  return st || (i.declaredAt < t ? 'Open' : null);
}

export function activeNotices() {
  const now = Date.now();
  return store.notices.filter((n) => !n.expiresAt || n.expiresAt > now)
    .sort((a, b) => (b.priority === 'important') - (a.priority === 'important') || b.createdAt - a.createdAt);
}

// ------------------------------------------------------------- schedule

export function monthKey(y, m) { return `${y}-${String(m + 1).padStart(2, '0')}`; }
export function getMonth(key) { return store.schedule.months[key] || { rows: [], updatedAt: 0 }; }
export async function saveMonth(key, month, auditMsg) {
  if (!can.manageSchedule()) throw new ApiError('forbidden');
  const id = await C.uuidFromString('schedule:' + key);
  await mutate('schedule', id, () => ({ monthKey: key, rows: month.rows }));
  addAudit('schedule.update', auditMsg || `Updated schedule for ${key}`);
}
export function rosterFor(date) {
  const m = store.schedule.months[monthKey(date.getFullYear(), date.getMonth())];
  const out = { M: [], A: [], O: [], AL: [] };
  if (!m) return out;
  for (const r of m.rows) { const v = r.cells[String(date.getDate())]; if (out[v]) out[v].push(r.name); }
  return out;
}

// ------------------------------------------------------------- settings

export async function saveSettings(patch) {
  if (!can.editSettings()) throw new ApiError('forbidden');
  await mutate('settings', SETTINGS_ID, (s) => ({ ...structuredClone(DEFAULT_SETTINGS), ...(s || {}), ...patch }));
  addAudit('settings.update', `Changed settings: ${Object.keys(patch).join(', ')}`);
}
