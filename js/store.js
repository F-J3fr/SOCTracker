// Encrypted persistence + domain logic. Nothing readable is ever written to localStorage.
import {
  b64, randomBytes, usernameLookupId, generateDek, wrapDekForPassword,
  unwrapDekWithPassword, encryptJson, decryptJson, uuid,
} from './crypto.js';

const LS_KEY = 'soctracker.v1';
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;
const AUDIT_CAP = 3000;

export const ROLES = { analyst: 'Analyst', teamlead: 'Team lead', admin: 'Admin' };
export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
export const SHIFT_CODES = ['M', 'A', 'O', 'AL'];
export const SHIFT_LABELS = { M: 'Morning', A: 'Afternoon', O: 'Off', AL: 'Annual leave' };

const DEFAULT_SETTINGS = {
  teamName: 'SOC Team',
  sla: { Critical: 15, High: 30, Medium: 60, Low: 240 }, // minutes, detection → acknowledgement
  shiftTimes: { M: { start: '07:00', end: '15:00' }, A: { start: '15:00', end: '23:00' } },
  reportCutoff: '18:00',
  sessionTimeoutMin: 20,
};

function emptyData() {
  return {
    schemaVersion: 1, users: [], cases: [], handovers: [], notices: [],
    schedule: { months: {} }, settings: structuredClone(DEFAULT_SETTINGS), audit: [], seq: {},
  };
}

// ---------- raw container ----------
function readContainer() {
  const raw = localStorage.getItem(LS_KEY);
  return raw ? JSON.parse(raw) : null;
}
function writeContainer(c) { localStorage.setItem(LS_KEY, JSON.stringify(c)); }

export function isInitialized() { const c = readContainer(); return !!(c && c.vault); }

// ---------- session state (memory only — refresh = locked) ----------
const session = { dek: null, user: null, data: null, container: null };
export function currentUser() { return session.user; }
export function data() { return session.data; }
export function isLoggedIn() { return !!session.dek; }

export function logout() { session.dek = null; session.user = null; session.data = null; session.container = null; }

async function persist() {
  session.data.updatedAt = Date.now();
  session.container.vault = await encryptJson(session.dek, session.data);
  writeContainer(session.container);
}

/** Re-read from storage (another tab saved). */
export async function reloadFromStorage() {
  if (!session.dek) return false;
  const c = readContainer();
  if (!c) { logout(); return false; }
  session.container = c;
  session.data = await decryptJson(session.dek, c.vault);
  normalize(session.data);
  const me = session.data.users.find(u => u.id === session.user.id);
  if (!me || me.disabled || !c.keyring[me.lookupId]) { logout(); return false; }
  session.user = me;
  return true;
}

function normalize(d) {
  const base = emptyData();
  for (const k of Object.keys(base)) if (d[k] === undefined) d[k] = base[k];
  d.settings = { ...structuredClone(DEFAULT_SETTINGS), ...d.settings };
}

// ---------- first-run setup ----------
export async function initialize({ username, displayName, password, teamName }) {
  const appSalt = b64(randomBytes(16));
  const dek = await generateDek();
  const lookupId = await usernameLookupId(username, appSalt);
  const d = emptyData();
  if (teamName) d.settings.teamName = teamName;
  const user = {
    id: uuid(), lookupId, username: username.trim(), displayName: displayName.trim() || username.trim(),
    role: 'admin', mustChange: false, disabled: false, createdAt: Date.now(), createdBy: 'setup', updatedAt: Date.now(),
  };
  d.users.push(user);
  const container = {
    format: 'soctracker', version: 1, appSalt,
    keyring: { [lookupId]: await wrapDekForPassword(dek, password, lookupId) },
    lockout: {}, vault: null,
  };
  session.dek = dek; session.container = container; session.data = d; session.user = user;
  addAudit('setup', 'Created tracker and first admin account');
  await persist();
}

// ---------- login ----------
export async function login(username, password) {
  const c = readContainer();
  if (!c) throw new Error('Tracker is not set up yet.');
  const lookupId = await usernameLookupId(username, c.appSalt);
  const lock = c.lockout?.[lookupId];
  if (lock && lock.until > Date.now()) {
    const mins = Math.ceil((lock.until - Date.now()) / 60000);
    throw new Error(`Too many failed attempts. Try again in ${mins} minute${mins > 1 ? 's' : ''}.`);
  }
  const fail = () => {
    c.lockout = c.lockout || {};
    const l = c.lockout[lookupId] || { fails: 0, until: 0 };
    l.fails += 1;
    if (l.fails >= MAX_FAILS) { l.until = Date.now() + LOCK_MS; l.fails = 0; }
    c.lockout[lookupId] = l;
    writeContainer(c);
    return new Error('Wrong username or password.');
  };
  const entry = c.keyring[lookupId];
  if (!entry) throw fail();
  let dek;
  try { dek = await unwrapDekWithPassword(entry, password, lookupId); } catch { throw fail(); }
  const d = await decryptJson(dek, c.vault);
  normalize(d);
  const user = d.users.find(u => u.lookupId === lookupId);
  if (!user || user.disabled) throw new Error('This account is disabled. Contact your team lead or admin.');
  if (c.lockout?.[lookupId]) { delete c.lockout[lookupId]; writeContainer(c); }
  session.dek = dek; session.container = c; session.data = d; session.user = user;
  user.lastLoginAt = Date.now();
  addAudit('login', `Signed in`);
  await persist();
  return user;
}

// ---------- permissions ----------
export const can = {
  manageUsers: (u = session.user) => u && (u.role === 'admin' || u.role === 'teamlead'),
  manageSchedule: (u = session.user) => u && (u.role === 'admin' || u.role === 'teamlead'),
  postNotices: (u = session.user) => u && (u.role === 'admin' || u.role === 'teamlead'),
  viewAudit: (u = session.user) => u && (u.role === 'admin' || u.role === 'teamlead'),
  editSettings: (u = session.user) => u && (u.role === 'admin' || u.role === 'teamlead'),
  deleteCases: (u = session.user) => u && (u.role === 'admin' || u.role === 'teamlead'),
  replaceVault: (u = session.user) => u && u.role === 'admin',
  /** Team leads manage analysts + team leads; only admins can touch admin accounts. */
  manageTarget: (target, u = session.user) => {
    if (!u || !target) return false;
    if (u.role === 'admin') return true;
    if (u.role === 'teamlead') return target.role !== 'admin';
    return false;
  },
  assignRole: (role, u = session.user) => u && (u.role === 'admin' || (u.role === 'teamlead' && role !== 'admin')),
};

// ---------- audit ----------
export function addAudit(action, detail, target = '') {
  const d = session.data;
  d.audit.unshift({ id: uuid(), at: Date.now(), by: session.user?.displayName || 'system', byId: session.user?.id || '', action, detail, target });
  if (d.audit.length > AUDIT_CAP) d.audit.length = AUDIT_CAP;
}

// ---------- users ----------
export function validatePassword(pw) {
  if (!pw || pw.length < 12) return 'Use at least 12 characters.';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  if (classes < 3) return 'Mix at least three of: lowercase, uppercase, numbers, symbols.';
  return null;
}

export async function createUser({ username, displayName, role, password }) {
  if (!can.manageUsers()) throw new Error('You do not have permission to create users.');
  if (!ROLES[role]) throw new Error('Pick a role.');
  if (!can.assignRole(role)) throw new Error('Only an admin can create admin accounts.');
  username = username.trim();
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) throw new Error('Usernames are 3–32 characters: letters, numbers, dot, dash, underscore.');
  const lookupId = await usernameLookupId(username, session.container.appSalt);
  if (session.container.keyring[lookupId] || session.data.users.some(u => u.lookupId === lookupId)) throw new Error('That username is already taken.');
  const pwErr = validatePassword(password); if (pwErr) throw new Error(pwErr);
  const user = {
    id: uuid(), lookupId, username, displayName: (displayName || username).trim(), role,
    mustChange: true, disabled: false, createdAt: Date.now(), createdBy: session.user.displayName, updatedAt: Date.now(),
  };
  session.container.keyring[lookupId] = await wrapDekForPassword(session.dek, password, lookupId);
  session.data.users.push(user);
  addAudit('user.create', `Created ${ROLES[role]} account "${user.displayName}"`, user.id);
  await persist();
  return user;
}

export async function resetPassword(userId, tempPassword) {
  const t = session.data.users.find(u => u.id === userId);
  if (!can.manageUsers() || !can.manageTarget(t)) throw new Error('You do not have permission to reset this account.');
  const pwErr = validatePassword(tempPassword); if (pwErr) throw new Error(pwErr);
  session.container.keyring[t.lookupId] = await wrapDekForPassword(session.dek, tempPassword, t.lookupId);
  if (session.container.lockout) delete session.container.lockout[t.lookupId];
  t.mustChange = t.id !== session.user.id; t.updatedAt = Date.now();
  addAudit('user.reset', `Reset password for "${t.displayName}"`, t.id);
  await persist();
}

export async function changeOwnPassword(current, next) {
  const me = session.user;
  try { await unwrapDekWithPassword(session.container.keyring[me.lookupId], current, me.lookupId); }
  catch { throw new Error('Current password is wrong.'); }
  if (current === next) throw new Error('Pick a new password that is different from the current one.');
  const pwErr = validatePassword(next); if (pwErr) throw new Error(pwErr);
  session.container.keyring[me.lookupId] = await wrapDekForPassword(session.dek, next, me.lookupId);
  me.mustChange = false; me.updatedAt = Date.now();
  addAudit('user.password', 'Changed own password', me.id);
  await persist();
}

export async function updateUser(userId, patch) {
  const t = session.data.users.find(u => u.id === userId);
  if (!can.manageUsers() || !can.manageTarget(t)) throw new Error('You do not have permission to edit this account.');
  if (patch.role && !can.assignRole(patch.role)) throw new Error('Only an admin can grant the admin role.');
  if (t.id === session.user.id && (patch.disabled || (patch.role && patch.role !== t.role))) throw new Error('You cannot disable yourself or change your own role.');
  if (patch.role === undefined && patch.disabled === undefined && patch.displayName === undefined) return;
  const changes = [];
  if (patch.displayName !== undefined && patch.displayName.trim() && patch.displayName.trim() !== t.displayName) { changes.push(`name → ${patch.displayName.trim()}`); t.displayName = patch.displayName.trim(); }
  if (patch.role !== undefined && patch.role !== t.role) {
    if (t.role === 'admin' && activeAdmins().length <= 1) throw new Error('Keep at least one active admin.');
    changes.push(`role ${ROLES[t.role]} → ${ROLES[patch.role]}`); t.role = patch.role;
  }
  if (patch.disabled !== undefined && patch.disabled !== t.disabled) {
    if (patch.disabled && t.role === 'admin' && activeAdmins().length <= 1) throw new Error('Keep at least one active admin.');
    t.disabled = patch.disabled; changes.push(patch.disabled ? 'disabled' : 'enabled');
    // Disabling removes the user's key slot, so their password can no longer unlock the vault.
    if (patch.disabled) delete session.container.keyring[t.lookupId];
  }
  t.updatedAt = Date.now();
  if (changes.length) addAudit('user.update', `Updated "${t.displayName}": ${changes.join(', ')}`, t.id);
  await persist();
}

export async function enableUserWithPassword(userId, tempPassword) {
  const t = session.data.users.find(u => u.id === userId);
  if (!can.manageUsers() || !can.manageTarget(t)) throw new Error('You do not have permission to edit this account.');
  const pwErr = validatePassword(tempPassword); if (pwErr) throw new Error(pwErr);
  session.container.keyring[t.lookupId] = await wrapDekForPassword(session.dek, tempPassword, t.lookupId);
  t.disabled = false; t.mustChange = true; t.updatedAt = Date.now();
  addAudit('user.update', `Re-enabled "${t.displayName}" with a temporary password`, t.id);
  await persist();
}

function activeAdmins() { return session.data.users.filter(u => u.role === 'admin' && !u.disabled); }
export function userName(id) { return session.data.users.find(u => u.id === id)?.displayName || '—'; }

// ---------- cases ----------
export function slaTargetMin(sev) { return Number(session.data.settings.sla[sev]) || 60; }

/** Auto SLA: breached if acknowledgement came later than the severity target after detection. */
export function computeSla(c, now = Date.now()) {
  if (!c.detectedAt) return 'N';
  const limit = c.detectedAt + slaTargetMin(c.severity) * 60000;
  if (c.ackAt) return c.ackAt > limit ? 'Y' : 'N';
  return now > limit ? 'Y' : 'N';
}
export function effectiveSla(c) { return c.slaManual ? c.slaBreach : computeSla(c); }

function nextCaseRef(ts) {
  const dt = new Date(ts);
  const key = `${String(dt.getFullYear()).slice(2)}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
  const d = session.data;
  let n = (d.seq[key] || 0) + 1;
  // guard against collisions after merges
  while (d.cases.some(c => c.ref === `SOC-${key}-${String(n).padStart(3, '0')}`)) n++;
  d.seq[key] = n;
  return `SOC-${key}-${String(n).padStart(3, '0')}`;
}

const CASE_FIELDS = ['name', 'escalatedTo', 'severity', 'detectedAt', 'reportedAt', 'ackAt', 'slaBreach', 'slaManual', 'status', 'notes', 'source'];
const FIELD_LABEL = { name: 'Case name', escalatedTo: 'Escalated to', severity: 'Severity', detectedAt: 'Detected', reportedAt: 'Reported', ackAt: 'Acknowledged', slaBreach: 'SLA breach', slaManual: 'SLA override', status: 'Status', notes: 'Notes', source: 'Source' };

export async function saveCase(input) {
  const d = session.data; const me = session.user; const now = Date.now();
  if (!input.name?.trim()) throw new Error('Give the case a name.');
  if (!SEVERITIES.includes(input.severity)) throw new Error('Pick a severity.');
  if (!input.detectedAt) throw new Error('Add the detection date and time.');
  if (input.reportedAt && input.reportedAt < input.detectedAt) throw new Error('Reported time is before detection time.');
  if (input.ackAt && input.ackAt < input.detectedAt) throw new Error('Acknowledgement time is before detection time.');
  if (input.id) {
    const c = d.cases.find(x => x.id === input.id);
    if (!c) throw new Error('Case not found.');
    const changes = [];
    for (const f of CASE_FIELDS) {
      if (input[f] !== undefined && input[f] !== c[f]) {
        changes.push({ field: FIELD_LABEL[f], from: c[f] ?? '', to: input[f] ?? '' });
        c[f] = input[f];
      }
    }
    if (!changes.length) return c;
    if (changes.some(ch => ch.field === 'Status')) {
      if (c.status === 'Closed') { c.closedAt = now; c.closedBy = me.id; }
      else { c.closedAt = null; c.closedBy = null; }
    }
    c.updatedAt = now; c.updatedBy = me.id;
    c.history.push({ at: now, by: me.id, action: 'updated', changes });
    addAudit('case.update', `Updated ${c.ref}: ${changes.map(x => x.field).join(', ')}`, c.id);
    await persist();
    return c;
  }
  const c = {
    id: uuid(), ref: nextCaseRef(input.detectedAt || now), createdAt: now, createdBy: me.id,
    updatedAt: now, updatedBy: me.id, closedAt: null, closedBy: null, history: [], comments: [],
  };
  for (const f of CASE_FIELDS) c[f] = input[f] ?? (f === 'status' ? 'WIP' : f === 'slaManual' ? false : f === 'slaBreach' ? 'N' : '');
  if (c.status === 'Closed') { c.closedAt = now; c.closedBy = me.id; }
  c.history.push({ at: now, by: me.id, action: 'opened' });
  d.cases.push(c);
  addAudit('case.create', `Opened ${c.ref} "${c.name}" (${c.severity})`, c.id);
  await persist();
  return c;
}

export async function setCaseStatus(id, status) {
  const c = session.data.cases.find(x => x.id === id);
  return saveCase({ ...pickCase(c), id, status });
}
function pickCase(c) { const o = {}; for (const f of CASE_FIELDS) o[f] = c[f]; return o; }

export async function addCaseComment(id, body) {
  const c = session.data.cases.find(x => x.id === id);
  if (!body.trim()) throw new Error('Write something first.');
  c.comments = c.comments || [];
  c.comments.push({ id: uuid(), at: Date.now(), by: session.user.id, body: body.trim() });
  c.updatedAt = Date.now();
  addAudit('case.comment', `Commented on ${c.ref}`, c.id);
  await persist();
}

export async function deleteCase(id) {
  if (!can.deleteCases()) throw new Error('Only team leads and admins can delete cases.');
  const d = session.data; const c = d.cases.find(x => x.id === id);
  d.cases = d.cases.filter(x => x.id !== id);
  d.tombstones = d.tombstones || {}; d.tombstones[id] = Date.now();
  addAudit('case.delete', `Deleted ${c?.ref} "${c?.name}"`, id);
  await persist();
}

// ---------- handovers ----------
export async function saveHandover({ id, shift, date, body, openCaseIds }) {
  const d = session.data; const me = session.user; const now = Date.now();
  if (!body?.trim()) throw new Error('Write the handover first.');
  if (id) {
    const h = d.handovers.find(x => x.id === id);
    if (h.author !== me.id && !can.postNotices()) throw new Error('You can only edit your own handovers.');
    Object.assign(h, { shift, date, body: body.trim(), updatedAt: now });
    addAudit('handover.update', `Edited ${SHIFT_LABELS[shift]} handover for ${date}`, id);
  } else {
    d.handovers.push({ id: uuid(), shift, date, body: body.trim(), author: me.id, createdAt: now, updatedAt: now, openCaseIds: openCaseIds || [], readBy: [me.id] });
    addAudit('handover.create', `Wrote ${SHIFT_LABELS[shift]} handover for ${date}`);
  }
  await persist();
}
export async function deleteHandover(id) {
  const d = session.data; const h = d.handovers.find(x => x.id === id);
  if (h.author !== session.user.id && !can.postNotices()) throw new Error('You can only delete your own handovers.');
  d.handovers = d.handovers.filter(x => x.id !== id);
  d.tombstones = d.tombstones || {}; d.tombstones[id] = Date.now();
  addAudit('handover.delete', `Deleted handover for ${h.date}`, id);
  await persist();
}
export async function markHandoverRead(id) {
  const h = session.data.handovers.find(x => x.id === id);
  h.readBy = h.readBy || [];
  if (!h.readBy.includes(session.user.id)) { h.readBy.push(session.user.id); h.updatedAt = Date.now(); await persist(); }
}

// ---------- notices ----------
export async function saveNotice({ id, title, body, priority, expiresAt }) {
  if (!can.postNotices()) throw new Error('Only team leads and admins can post notices.');
  const d = session.data; const now = Date.now();
  if (!title?.trim()) throw new Error('Give the notice a title.');
  if (id) {
    const n = d.notices.find(x => x.id === id);
    Object.assign(n, { title: title.trim(), body: (body || '').trim(), priority, expiresAt: expiresAt || null, updatedAt: now });
    addAudit('notice.update', `Edited notice "${n.title}"`, id);
  } else {
    d.notices.push({ id: uuid(), title: title.trim(), body: (body || '').trim(), priority, expiresAt: expiresAt || null, author: session.user.id, createdAt: now, updatedAt: now, acks: [] });
    addAudit('notice.create', `Posted notice "${title.trim()}"`);
  }
  await persist();
}
export async function deleteNotice(id) {
  if (!can.postNotices()) throw new Error('Only team leads and admins can remove notices.');
  const d = session.data; const n = d.notices.find(x => x.id === id);
  d.notices = d.notices.filter(x => x.id !== id);
  d.tombstones = d.tombstones || {}; d.tombstones[id] = Date.now();
  addAudit('notice.delete', `Removed notice "${n?.title}"`, id);
  await persist();
}
export async function ackNotice(id) {
  const n = session.data.notices.find(x => x.id === id);
  if (!n.acks.some(a => a.userId === session.user.id)) {
    n.acks.push({ userId: session.user.id, at: Date.now() }); n.updatedAt = Date.now();
    addAudit('notice.ack', `Acknowledged notice "${n.title}"`, id);
    await persist();
  }
}
export function activeNotices() {
  const now = Date.now();
  return session.data.notices.filter(n => !n.expiresAt || n.expiresAt > now)
    .sort((a, b) => (b.priority === 'important') - (a.priority === 'important') || b.createdAt - a.createdAt);
}

// ---------- schedule ----------
export function monthKey(y, m) { return `${y}-${String(m + 1).padStart(2, '0')}`; }
export function getMonth(key) { return session.data.schedule.months[key] || { rows: [], updatedAt: 0 }; }
export async function saveMonth(key, month, auditMsg) {
  if (!can.manageSchedule()) throw new Error('Only team leads and admins can edit the schedule.');
  month.updatedAt = Date.now();
  session.data.schedule.months[key] = month;
  addAudit('schedule.update', auditMsg || `Updated schedule for ${key}`);
  await persist();
}
export function rosterFor(date) {
  const key = monthKey(date.getFullYear(), date.getMonth());
  const m = session.data.schedule.months[key];
  const out = { M: [], A: [], O: [], AL: [] };
  if (!m) return out;
  for (const r of m.rows) { const v = r.cells[String(date.getDate())]; if (out[v]) out[v].push(r.name); }
  return out;
}

// ---------- settings ----------
export async function saveSettings(patch) {
  if (!can.editSettings()) throw new Error('Only team leads and admins can change settings.');
  Object.assign(session.data.settings, patch);
  addAudit('settings.update', `Changed settings: ${Object.keys(patch).join(', ')}`);
  await persist();
}

// ---------- backup / sync ----------
export function exportContainer() { return JSON.stringify(readContainer()); }

/**
 * Merge another copy of the SAME team vault (encrypted with the same DEK) into this one.
 * Newest record wins per id. Lets analysts on different machines combine their work.
 */
export async function mergeFromBackup(text) {
  let other;
  try { other = JSON.parse(text); } catch { throw new Error('That file is not a tracker backup.'); }
  if (other?.format !== 'soctracker' || !other.vault) throw new Error('That file is not a tracker backup.');
  let od;
  try { od = await decryptJson(session.dek, other.vault); }
  catch { throw new Error('This backup belongs to a different tracker (different encryption key). An admin can replace the whole tracker with it instead.'); }
  normalize(od);
  const d = session.data;
  const tomb = { ...(od.tombstones || {}), ...(d.tombstones || {}) };
  const stats = {};
  for (const coll of ['users', 'cases', 'handovers', 'notices']) {
    const map = new Map(d[coll].map(x => [x.id, x]));
    let added = 0, updated = 0;
    for (const x of od[coll]) {
      if (tomb[x.id]) continue;
      const mine = map.get(x.id);
      if (!mine) { map.set(x.id, x); added++; }
      else if ((x.updatedAt || 0) > (mine.updatedAt || 0)) { map.set(x.id, x); updated++; }
    }
    d[coll] = [...map.values()].filter(x => !tomb[x.id]);
    stats[coll] = { added, updated };
  }
  d.tombstones = tomb;
  for (const [k, m] of Object.entries(od.schedule.months)) {
    const mine = d.schedule.months[k];
    if (!mine || (m.updatedAt || 0) > (mine.updatedAt || 0)) d.schedule.months[k] = m;
  }
  for (const [k, v] of Object.entries(od.seq || {})) d.seq[k] = Math.max(d.seq[k] || 0, v);
  const seen = new Set(d.audit.map(a => a.id));
  d.audit = [...d.audit, ...od.audit.filter(a => !seen.has(a.id))].sort((a, b) => b.at - a.at).slice(0, AUDIT_CAP);
  if ((od.updatedAt || 0) > (d.updatedAt || 0)) d.settings = { ...d.settings, ...od.settings };
  // key slots: newest wins, and drop slots of users disabled in the merged result
  for (const [lid, e] of Object.entries(other.keyring || {})) {
    const mine = session.container.keyring[lid];
    if (!mine || (e.updatedAt || 0) > (mine.updatedAt || 0)) session.container.keyring[lid] = e;
  }
  for (const u of d.users) if (u.disabled) delete session.container.keyring[u.lookupId];
  addAudit('backup.merge', `Merged backup: ${Object.entries(stats).map(([k, s]) => `${k} +${s.added}/~${s.updated}`).join(', ')}`);
  await persist();
  return stats;
}

export function replaceWithBackup(text) {
  const other = JSON.parse(text);
  if (other?.format !== 'soctracker' || !other.vault || !other.keyring || !other.appSalt) throw new Error('That file is not a tracker backup.');
  writeContainer(other);
  logout();
}

/** Save after direct edits (used by demo seeding). */
export async function commit() { await persist(); }
export function markDemo() { session.container.demo = true; }
export function isDemo() { return !!readContainer()?.demo; }

export function wipeLocal() { localStorage.removeItem(LS_KEY); logout(); }
