import * as S from './store.js';
import { generateTempPassword } from './crypto.js';
import { seedDemo, DEMO_ACCOUNTS } from './demo.js';
import { importScheduleWorkbook, downloadScheduleTemplate, exportScheduleXlsx, downloadReportXlsx, downloadReportCsv } from './excel.js';

const $app = document.getElementById('app');
const $modal = document.getElementById('modal');
const $toasts = document.getElementById('toasts');

// ================= helpers =================
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
export function fmt(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const toInput = (ts) => (ts ? fmt(ts).replace(' ', 'T') : '');
const fromInput = (v) => (v ? new Date(v).getTime() : null);
function dur(ms) {
  if (ms == null) return '—';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
const minutesOf = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const SEV_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };

export function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $toasts.appendChild(el);
  setTimeout(() => el.remove(), err ? 6000 : 3500);
}
async function guard(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r ?? true; }
  catch (e) { console.error(e); toast(e.message || String(e), true); return false; }
}
function download(name, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept;
    inp.onchange = () => resolve(inp.files[0] || null);
    inp.click();
  });
}
function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Working…'; btn.disabled = true; }
  else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
}

// ---------- modal ----------
function openModal({ title, body, foot = '', onMount, onSubmit, width }) {
  $modal.style.width = width || '';
  $modal.innerHTML = `<form class="modal-form" novalidate>
    <div class="modal-head"><h2>${title}</h2><button type="button" class="ghost" data-close aria-label="Close">✕</button></div>
    <div class="modal-body">${body}</div>
    ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
  </form>`;
  const form = $modal.querySelector('form');
  $modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return;
    const btn = form.querySelector('button[type="submit"]');
    const errEl = form.querySelector('.error');
    if (errEl) errEl.textContent = '';
    busy(btn, true);
    try { const keep = await onSubmit(form); if (keep !== true) closeModal(); }
    catch (err) { console.error(err); if (errEl) errEl.textContent = err.message; else toast(err.message, true); }
    finally { busy(btn, false); }
  });
  if (!$modal.open) $modal.showModal();
  onMount?.(form);
  const first = form.querySelector('input:not([type=hidden]):not([readonly]), select, textarea');
  first?.focus();
}
function closeModal() { if ($modal.open) $modal.close(); $modal.innerHTML = ''; if (pendingRender) { pendingRender = false; render(); } }
$modal.addEventListener('close', () => { $modal.innerHTML = ''; });
let pendingRender = false;

// ================= time / shifts / report window =================
function settings() { return S.data().settings; }
export function windowEnding(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = settings().reportCutoff.split(':').map(Number);
  const end = new Date(y, m - 1, d, hh, mm).getTime();
  return { start: end - 86400000, end };
}
function currentWindow() {
  const now = new Date();
  let w = windowEnding(ymd(now));
  if (Date.now() >= w.end) { const t = new Date(now); t.setDate(t.getDate() + 1); w = windowEnding(ymd(t)); }
  return w;
}
function currentShift(now = new Date()) {
  const n = now.getHours() * 60 + now.getMinutes();
  for (const code of ['M', 'A']) {
    const t = settings().shiftTimes[code];
    const s = minutesOf(t.start), e = minutesOf(t.end);
    const inside = s < e ? n >= s && n < e : n >= s || n < e;
    if (inside) return code;
  }
  return null;
}
export function casesInWindow(w, includeCarry) {
  const inW = (t) => t && t >= w.start && t < w.end;
  return S.data().cases.filter((c) =>
    inW(c.detectedAt) || inW(c.reportedAt) || inW(c.createdAt) || inW(c.closedAt) ||
    (includeCarry && c.detectedAt < w.start && (!c.closedAt || c.closedAt >= w.end) ));
}
export function statusAt(c, t) { return c.closedAt && c.closedAt < t ? 'Closed' : (c.status === 'Closed' && (!c.closedAt || c.closedAt < t) ? 'Closed' : 'WIP'); }

// ================= idle lock & cross-tab sync =================
let lastActivity = Date.now();
['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true }));
setInterval(() => {
  if (!S.isLoggedIn()) return;
  const limit = (Number(settings().sessionTimeoutMin) || 20) * 60000;
  if (Date.now() - lastActivity > limit) { S.logout(); closeModal(); render(); toast('Signed out after inactivity. Your data is locked.'); return; }
  const clock = document.querySelector('.clock');
  if (clock) clock.textContent = hm(Date.now());
  if (route() === 'dashboard' && !$modal.open && !document.activeElement?.matches('input,textarea,select')) render();
}, 30000);

addEventListener('storage', async (e) => {
  if (e.key !== 'soctracker.v1') return;
  if (!S.isLoggedIn()) { render(); return; }
  const ok = await S.reloadFromStorage().catch(() => false);
  if (!ok) { closeModal(); render(); toast('Your session ended because the tracker changed in another tab.'); return; }
  if ($modal.open) pendingRender = true; else render();
});

// ================= routing =================
const ROUTES = {
  dashboard: { title: 'Dashboard', view: viewDashboard },
  cases: { title: 'Case tracker', view: viewCases },
  handover: { title: 'Shift handover', view: viewHandover },
  notices: { title: 'Notices', view: viewNotices },
  schedule: { title: 'Shift schedule', view: viewSchedule },
  reports: { title: 'Daily report', view: viewReports },
  users: { title: 'Users', view: viewUsers, allow: () => S.can.manageUsers() },
  audit: { title: 'Audit log', view: viewAudit, allow: () => S.can.viewAudit() },
  settings: { title: 'Settings', view: viewSettings, allow: () => S.can.editSettings() },
  backup: { title: 'Backup and sync', view: viewBackup },
  account: { title: 'My account', view: viewAccount },
};
function route() { const r = location.hash.replace(/^#\/?/, '').split('?')[0]; return ROUTES[r] ? r : 'dashboard'; }
addEventListener('hashchange', () => { closeModal(); render(); });

function render() {
  if (!S.isInitialized()) return viewSetup();
  if (!S.isLoggedIn()) return viewLogin();
  if (S.currentUser().mustChange) return viewForceChange();
  const r = route();
  const def = ROUTES[r];
  if (def.allow && !def.allow()) { location.hash = '#/dashboard'; return; }
  $app.innerHTML = shell(r, def.title);
  bindShell();
  def.view(document.getElementById('content'));
}

// ================= shell =================
const LOGO = `<svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="#141414" stroke="#2a2a2a"/><path d="M7 22 L13 10 L19 18 L25 8" stroke="#FF7A1A" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function shell(active, title) {
  const d = S.data(); const me = S.currentUser();
  const open = d.cases.filter((c) => c.status !== 'Closed').length;
  const unreadHand = d.handovers.filter((h) => !(h.readBy || []).includes(me.id) && Date.now() - h.createdAt < 3 * 86400000).length;
  const unackd = S.activeNotices().filter((n) => !n.acks.some((a) => a.userId === me.id)).length;
  const item = (key, label, badge, hot) => `<a href="#/${key}" ${active === key ? 'aria-current="page"' : ''}><span>${label}</span>${badge ? `<span class="badge ${hot ? 'hot' : ''}">${badge}</span>` : ''}</a>`;
  const shift = currentShift();
  const st = shift ? settings().shiftTimes[shift] : null;
  return `<div class="shell">
    <aside class="sidebar" aria-label="Main">
      <div class="brand">${LOGO}<div><strong>${esc(d.settings.teamName)}</strong><span>SOC Tracker</span></div></div>
      <nav class="nav">
        ${item('dashboard', 'Dashboard')}
        ${item('cases', 'Case tracker', open, false)}
        ${item('handover', 'Shift handover', unreadHand, unreadHand > 0)}
        ${item('notices', 'Notices', unackd, unackd > 0)}
        ${item('schedule', 'Shift schedule')}
        ${item('reports', 'Daily report')}
        ${S.can.manageUsers() ? '<div class="nav-sep"></div>' + item('users', 'Users') : ''}
        ${S.can.viewAudit() ? item('audit', 'Audit log') : ''}
        ${S.can.editSettings() ? item('settings', 'Settings') : ''}
        <div class="nav-sep"></div>
        ${item('backup', 'Backup and sync')}
      </nav>
      <div class="me">
        <strong>${esc(me.displayName)}</strong>
        <span class="role">${S.ROLES[me.role]} · @${esc(me.username)}</span>
        <div class="row"><a class="btn sm" href="#/account">Account</a><button class="sm" id="signout">Sign out</button></div>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="menu-btn ghost" id="menu" aria-label="Open menu">☰</button>
        <h1>${esc(title)}</h1>
        <div class="shift-chip">${shift ? `<span class="shift-dot"></span><span><b>${S.SHIFT_LABELS[shift]} shift</b> <span class="long">${st.start}–${st.end}</span></span>` : '<span class="muted">Outside shift hours</span>'}</div>
        <time class="clock" aria-label="Current time">${hm(Date.now())}</time>
      </header>
      <main class="content" id="content"></main>
    </div>
  </div>`;
}
function bindShell() {
  document.getElementById('signout').onclick = () => { S.logout(); location.hash = ''; render(); };
  const sh = document.querySelector('.shell');
  document.getElementById('menu').onclick = () => sh.classList.toggle('nav-open');
  document.querySelectorAll('.nav a').forEach((a) => a.addEventListener('click', () => sh.classList.remove('nav-open')));
}

// ================= auth screens =================
function authFrame(inner, sub) {
  return `<div class="auth"><div class="auth-card">
    <div class="auth-mark">${LOGO}<div><h1>SOC Tracker</h1><div class="muted">${sub}</div></div></div>
    ${inner}
  </div></div>`;
}

function viewSetup() {
  $app.innerHTML = authFrame(`
    <form id="setup" novalidate>
      <h2 style="margin-bottom:6px">Set up the tracker</h2>
      <p class="muted small">This creates the first admin account. Everything you add is encrypted in this browser with a key only your team's passwords can unlock.</p>
      <div class="field"><label for="team">Team name</label><input id="team" value="SOC Team" maxlength="40"></div>
      <div class="field"><label for="dn">Your name</label><input id="dn" autocomplete="name" required></div>
      <div class="field"><label for="un">Admin username</label><input id="un" autocomplete="username" required></div>
      <div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="new-password" required>
        <div class="hint">At least 12 characters, mixing three of: lowercase, uppercase, numbers, symbols.</div></div>
      <div class="field"><label for="pw2">Confirm password</label><input id="pw2" type="password" autocomplete="new-password" required></div>
      <button class="primary" type="submit">Create admin and open tracker</button>
      <p class="error" id="err"></p>
    </form>
    <div class="demo-box"><b>Just looking?</b> Load a demo team with sample cases, a schedule and three accounts you can sign in as.
      <div><button type="button" id="demo">Try the demo</button></div></div>
    <div class="auth-foot">Joining an existing team on a new machine? <a href="#" id="restore">Load your team's backup file</a> instead.</div>
  `, 'First-time setup');
  const f = document.getElementById('setup');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById('err'); err.textContent = '';
    const v = (id) => document.getElementById(id).value;
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(v('un').trim())) { err.textContent = 'Usernames are 3–32 characters: letters, numbers, dot, dash, underscore.'; return; }
    const pe = S.validatePassword(v('pw')); if (pe) { err.textContent = pe; return; }
    if (v('pw') !== v('pw2')) { err.textContent = 'The passwords do not match.'; return; }
    const btn = f.querySelector('button'); busy(btn, true, 'Encrypting…');
    try { await S.initialize({ username: v('un'), displayName: v('dn'), password: v('pw'), teamName: v('team').trim() }); location.hash = '#/dashboard'; render(); }
    catch (ex) { err.textContent = ex.message; busy(btn, false); }
  };
  document.getElementById('restore').onclick = (e) => { e.preventDefault(); restoreFromFile(false); };
  document.getElementById('demo').onclick = async (e) => {
    busy(e.target, true, 'Building demo…');
    try { await seedDemo(); render(); toast('Demo loaded. Pick an account below to sign in.'); }
    catch (ex) { console.error(ex); toast(ex.message, true); busy(e.target, false); }
  };
}

function demoBox() {
  if (!S.isDemo()) return '';
  return `<div class="demo-box"><b>Demo mode.</b> Sign in as any of these to see what each role can do.
    <table><tbody>${DEMO_ACCOUNTS.map((a) => `<tr><td>${S.ROLES[a.role]}</td><td><b>${a.username}</b></td><td>${esc(a.password)}</td><td><button type="button" class="sm" data-demo="${a.username}">Use</button></td></tr>`).join('')}</tbody></table>
    <button type="button" class="sm ghost" id="demo-reset">Erase demo and start fresh</button></div>`;
}

function viewLogin() {
  $app.innerHTML = authFrame(`
    <form id="login" novalidate>
      <div class="field"><label for="un">Username</label><input id="un" autocomplete="username" required></div>
      <div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required></div>
      <button class="primary" type="submit">Sign in</button>
      <p class="error" id="err"></p>
    </form>
    <div class="auth-foot">Forgot your password? Ask your team lead or admin to reset it.<br>
    New machine or out of date? <a href="#" id="restore">Load the latest team backup</a>.</div>
    ${demoBox()}
  `, 'Sign in to your shift');
  const f = document.getElementById('login');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById('err'); err.textContent = '';
    const btn = f.querySelector('button'); busy(btn, true, 'Unlocking…');
    try {
      await S.login(document.getElementById('un').value, document.getElementById('pw').value);
      lastActivity = Date.now();
      if (!location.hash || location.hash === '#') location.hash = '#/dashboard';
      render();
    } catch (ex) { err.textContent = ex.message; busy(btn, false); document.getElementById('pw').select(); }
  };
  document.getElementById('restore').onclick = (e) => { e.preventDefault(); restoreFromFile(true); };
  document.querySelectorAll('[data-demo]').forEach((b) => (b.onclick = () => {
    const a = DEMO_ACCOUNTS.find((x) => x.username === b.dataset.demo);
    document.getElementById('un').value = a.username; document.getElementById('pw').value = a.password;
    f.requestSubmit();
  }));
  document.getElementById('demo-reset')?.addEventListener('click', () => {
    if (confirm('Erase the demo data from this browser?')) { S.wipeLocal(); render(); }
  });
}

async function restoreFromFile(hasLocal) {
  const file = await pickFile('.soctracker,.json,application/json');
  if (!file) return;
  if (hasLocal && !confirm('This replaces the tracker data in this browser with the backup. Anything not in the backup is lost. Continue?')) return;
  await guard(async () => { S.replaceWithBackup(await file.text()); render(); }, 'Backup loaded. Sign in with your usual username and password.');
}

function viewForceChange() {
  const me = S.currentUser();
  $app.innerHTML = authFrame(`
    <form id="chg" novalidate>
      <h2 style="margin-bottom:6px">Choose your own password</h2>
      <p class="muted small">Hi ${esc(me.displayName)}. You signed in with a temporary password, so set a new one before you continue.</p>
      <div class="field"><label for="cur">Temporary password</label><input id="cur" type="password" autocomplete="current-password"></div>
      <div class="field"><label for="pw">New password</label><input id="pw" type="password" autocomplete="new-password">
        <div class="hint">At least 12 characters, mixing three of: lowercase, uppercase, numbers, symbols.</div></div>
      <div class="field"><label for="pw2">Confirm new password</label><input id="pw2" type="password" autocomplete="new-password"></div>
      <button class="primary" type="submit">Save password and continue</button>
      <p class="error" id="err"></p>
    </form>
    <div class="auth-foot"><a href="#" id="out">Sign out</a></div>
  `, 'Password change required');
  const f = document.getElementById('chg');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById('err'); err.textContent = '';
    const v = (id) => document.getElementById(id).value;
    if (v('pw') !== v('pw2')) { err.textContent = 'The new passwords do not match.'; return; }
    const btn = f.querySelector('button'); busy(btn, true, 'Saving…');
    try { await S.changeOwnPassword(v('cur'), v('pw')); location.hash = '#/dashboard'; render(); toast('Password saved.'); }
    catch (ex) { err.textContent = ex.message; busy(btn, false); }
  };
  document.getElementById('out').onclick = (e) => { e.preventDefault(); S.logout(); render(); };
}

// ================= dashboard =================
function viewDashboard(el) {
  const d = S.data(); const me = S.currentUser();
  const w = currentWindow();
  const inWin = casesInWindow(w, false);
  const detectedInWin = d.cases.filter((c) => c.detectedAt >= w.start && c.detectedAt < w.end);
  const open = d.cases.filter((c) => c.status !== 'Closed').sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.detectedAt - b.detectedAt);
  const breaches = inWin.filter((c) => S.effectiveSla(c) === 'Y').length;
  const closedInWin = d.cases.filter((c) => c.closedAt >= w.start && c.closedAt < w.end).length;
  const now = Date.now();
  const pct = (t) => Math.max(0, Math.min(100, ((t - w.start) / (w.end - w.start)) * 100));

  // shift boundaries inside the window
  const shiftMarks = [];
  for (const code of ['M', 'A']) {
    const t = settings().shiftTimes[code];
    for (const base of [w.start, w.end]) {
      const b = new Date(base); const [hh, mm] = t.start.split(':').map(Number); b.setHours(hh, mm, 0, 0);
      if (b.getTime() > w.start && b.getTime() < w.end) shiftMarks.push({ at: b.getTime(), label: `${S.SHIFT_LABELS[code]} ${t.start}` });
    }
  }
  const ticks = [0, 6, 12, 18, 24].map((h) => hm(w.start + h * 3600000));

  const unacked = S.activeNotices().filter((n) => !n.acks.some((a) => a.userId === me.id));
  const roster = S.rosterFor(new Date());
  const latestHand = [...d.handovers].sort((a, b) => b.createdAt - a.createdAt)[0];
  const myRow = myScheduleRow(new Date());

  el.innerHTML = `
    ${unacked.length ? `<section aria-label="Notices to acknowledge" style="margin-bottom:16px">${unacked.map(noticeCard).join('')}</section>` : ''}
    <section class="window" aria-label="Current report window">
      <div class="window-head">
        <div><h2>Report window ${fmt(w.start)} to ${fmt(w.end)}</h2>
          <div class="muted small">${dur(w.end - now)} until the ${settings().reportCutoff} cutoff. Each dot is a case at its detection time.</div></div>
        <div class="window-stats">
          <div><b>${detectedInWin.length}</b>detected</div>
          <div><b>${open.length}</b>open now</div>
          <div><b class="${breaches ? 'warn' : ''}">${breaches}</b>SLA breaches</div>
          <div><b>${closedInWin}</b>closed</div>
        </div>
      </div>
      <div class="track">
        <div class="track-bar"></div>
        <div class="track-elapsed" style="width:${pct(now)}%"></div>
        ${shiftMarks.map((s) => `<div class="track-shift" style="left:${pct(s.at)}%">${esc(s.label)}</div>`).join('')}
        <div class="track-now" style="left:${pct(now)}%"><span>Now ${hm(now)}</span></div>
        ${detectedInWin.map((c) => `<button type="button" class="pin bg-${c.severity} ${c.status === 'Closed' ? 'closed' : ''}" style="left:${pct(c.detectedAt)}%" data-case="${c.id}" title="${esc(`${c.ref} ${c.name} (${c.severity}, ${c.status}) detected ${hm(c.detectedAt)}`)}" aria-label="${esc(`${c.name}, ${c.severity}, detected ${hm(c.detectedAt)}`)}"></button>`).join('')}
      </div>
      <div class="track-ticks">${ticks.map((t) => `<span>${t}</span>`).join('')}</div>
    </section>

    <div class="grid-2">
      <section class="panel" aria-label="Open cases">
        <div class="panel-head"><h2>Open cases</h2><div><button class="primary sm" id="new-case">New case</button></div></div>
        ${open.length ? `<div>${open.slice(0, 12).map((c) => `
          <div class="open-case-row">
            <span class="sev sev-${c.severity}">${c.severity}</span>
            <div><button type="button" class="case-name" data-case="${c.id}">${esc(c.name)}</button>
              <div class="ref">${esc(c.ref)} · open ${dur(now - c.detectedAt)}${c.escalatedTo ? ` · ${esc(c.escalatedTo)}` : ''}</div></div>
            <span>${S.effectiveSla(c) === 'Y' ? '<span class="sla-Y small">SLA breached</span>' : ''}</span>
          </div>`).join('')}</div>
          ${open.length > 12 ? `<p class="small" style="margin-top:10px"><a href="#/cases">All ${open.length} open cases</a></p>` : ''}`
        : '<div class="empty"><b>No open cases.</b> New cases you log will show here until someone closes them.</div>'}
      </section>
      <div class="stack">
        <section class="panel" aria-label="Today's roster">
          <div class="panel-head"><h2>On shift today</h2><a class="small" href="#/schedule">Schedule</a></div>
          ${rosterHtml(roster)}
          ${myRow ? `<p class="small muted" style="margin:12px 0 0">Your next 7 days: ${myRow}</p>` : ''}
        </section>
        <section class="panel" aria-label="Latest handover">
          <div class="panel-head"><h2>Latest handover</h2><a class="small" href="#/handover">All handovers</a></div>
          ${latestHand ? handoverItem(latestHand, true) : '<div class="empty">No handovers yet. <a href="#/handover">Write the first one</a> at the end of your shift.</div>'}
        </section>
      </div>
    </div>`;
  bindCaseLinks(el);
  bindNoticeAcks(el);
  bindHandoverItems(el);
  el.querySelector('#new-case').onclick = () => caseForm();
}

function rosterHtml(r) {
  const names = (arr) => arr.length ? arr.map(esc).join(', ') : '<span class="faint">Nobody</span>';
  const t = settings().shiftTimes;
  if (!r.M.length && !r.A.length && !r.AL.length && !r.O.length) return '<div class="empty">No schedule for today yet.</div>';
  return `<dl class="roster">
    <dt>Morning ${t.M.start}</dt><dd>${names(r.M)}</dd>
    <dt>Afternoon ${t.A.start}</dt><dd>${names(r.A)}</dd>
    ${r.AL.length ? `<dt>Annual leave</dt><dd>${names(r.AL)}</dd>` : ''}
    ${r.O.length ? `<dt>Off</dt><dd class="muted">${names(r.O)}</dd>` : ''}
  </dl>`;
}
function myScheduleRow(from) {
  const me = S.currentUser();
  const out = [];
  let any = false;
  for (let i = 0; i < 7; i++) {
    const dt = new Date(from); dt.setDate(dt.getDate() + i);
    const m = S.getMonth(S.monthKey(dt.getFullYear(), dt.getMonth()));
    const row = m.rows.find((r) => r.userId === me.id || r.name.toLowerCase() === me.displayName.toLowerCase());
    const v = row?.cells[String(dt.getDate())] || '';
    if (row) any = true;
    out.push(`${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()]} ${v || '–'}`);
  }
  return any ? esc(out.join(', ')) : '';
}

// ================= cases =================
const caseFilters = { q: '', status: 'open', severity: '', sla: '', sort: 'priority' };

function viewCases(el) {
  el.innerHTML = `
    <div class="toolbar">
      <div class="field grow"><label for="q">Search</label><input id="q" type="search" placeholder="Case name, reference, team, notes" value="${esc(caseFilters.q)}"></div>
      <div class="field"><label for="fs">Status</label><select id="fs">
        <option value="open">Open (WIP)</option><option value="Closed">Closed</option><option value="">All</option></select></div>
      <div class="field"><label for="fv">Severity</label><select id="fv"><option value="">All</option>${S.SEVERITIES.map((s) => `<option>${s}</option>`).join('')}</select></div>
      <div class="field"><label for="fl">SLA</label><select id="fl"><option value="">All</option><option value="Y">Breached</option><option value="N">Within SLA</option></select></div>
      <div class="field"><label for="so">Sort</label><select id="so"><option value="priority">Severity, then oldest</option><option value="newest">Newest detected</option><option value="updated">Recently updated</option></select></div>
      <button class="primary" id="new-case">New case</button>
    </div>
    <div id="case-table"></div>`;
  const set = (id, key) => { const i = el.querySelector(id); i.value = caseFilters[key]; i.addEventListener('input', () => { caseFilters[key] = i.value; drawCaseTable(); }); };
  set('#q', 'q'); set('#fs', 'status'); set('#fv', 'severity'); set('#fl', 'sla'); set('#so', 'sort');
  el.querySelector('#new-case').onclick = () => caseForm();
  drawCaseTable();
}
function drawCaseTable() {
  const host = document.getElementById('case-table'); if (!host) return;
  const f = caseFilters; const q = f.q.trim().toLowerCase();
  let rows = S.data().cases.filter((c) =>
    (f.status === '' || (f.status === 'open' ? c.status !== 'Closed' : c.status === f.status)) &&
    (!f.severity || c.severity === f.severity) &&
    (!f.sla || S.effectiveSla(c) === f.sla) &&
    (!q || [c.name, c.ref, c.escalatedTo, c.notes, c.source].some((x) => (x || '').toLowerCase().includes(q))));
  const sorters = {
    priority: (a, b) => (a.status === 'Closed') - (b.status === 'Closed') || SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.detectedAt - b.detectedAt,
    newest: (a, b) => b.detectedAt - a.detectedAt,
    updated: (a, b) => b.updatedAt - a.updatedAt,
  };
  rows.sort(sorters[f.sort]);
  if (!rows.length) {
    host.innerHTML = S.data().cases.length
      ? '<div class="panel empty">No cases match these filters. Clear the search or set Status to All.</div>'
      : '<div class="panel empty"><b>No cases yet.</b> Select New case to log the first one.</div>';
    return;
  }
  host.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Case</th><th>Escalated to</th><th>Severity</th><th>Detected</th><th>Reported</th><th>Acknowledged</th><th>SLA breach</th><th>Status</th><th>Opened by</th><th></th></tr></thead>
    <tbody>${rows.slice(0, 500).map((c) => `<tr>
      <td><button type="button" class="case-name" data-case="${c.id}">${esc(c.name)}</button><div class="ref">${esc(c.ref)}</div></td>
      <td>${esc(c.escalatedTo) || '<span class="faint">—</span>'}</td>
      <td><span class="sev sev-${c.severity}">${c.severity}</span></td>
      <td class="t">${fmt(c.detectedAt)}</td><td class="t">${fmt(c.reportedAt)}</td><td class="t">${fmt(c.ackAt)}</td>
      <td class="sla-${S.effectiveSla(c)}">${S.effectiveSla(c) === 'Y' ? 'Y' : 'N'}</td>
      <td><span class="status status-${c.status}">${c.status}</span></td>
      <td class="small">${esc(S.userName(c.createdBy))}${c.closedBy ? `<div class="faint">closed by ${esc(S.userName(c.closedBy))}</div>` : ''}</td>
      <td class="actions">${c.status === 'Closed'
        ? `<button class="sm" data-reopen="${c.id}">Reopen</button>`
        : `<button class="sm" data-close-case="${c.id}">Close</button>`}
        <button class="sm ghost" data-edit="${c.id}">Edit</button></td>
    </tr>`).join('')}</tbody></table></div>
    <p class="small faint" style="margin-top:8px">${rows.length} case${rows.length === 1 ? '' : 's'}${rows.length > 500 ? ', showing the first 500' : ''}.</p>`;
  bindCaseLinks(host);
  host.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => caseForm(S.data().cases.find((c) => c.id === b.dataset.edit))));
  host.querySelectorAll('[data-close-case]').forEach((b) => (b.onclick = () => confirmClose(b.dataset.closeCase)));
  host.querySelectorAll('[data-reopen]').forEach((b) => (b.onclick = async () => { if (await guard(() => S.setCaseStatus(b.dataset.reopen, 'WIP'), 'Case reopened.')) refresh(); }));
}
function refresh() { if ($modal.open) { pendingRender = true; return; } render(); }

function bindCaseLinks(root) {
  root.querySelectorAll('[data-case]').forEach((b) => b.addEventListener('click', () => caseDetail(b.dataset.case)));
}

function confirmClose(id) {
  const c = S.data().cases.find((x) => x.id === id);
  openModal({
    title: `Close ${esc(c.ref)}`,
    body: `<p><b>${esc(c.name)}</b></p>
      ${!c.ackAt ? '<div class="field"><label class="check"><input type="checkbox" id="setack" checked> Set acknowledgement time to now (none recorded yet)</label></div>' : ''}
      <div class="field"><label for="cm">Closing note (optional)</label><textarea id="cm" placeholder="Resolution, root cause, ticket number"></textarea></div>`,
    foot: '<button type="button" data-close>Cancel</button><button class="primary" type="submit">Close case</button>',
    onSubmit: async (f) => {
      const note = f.querySelector('#cm').value.trim();
      const setAck = f.querySelector('#setack')?.checked;
      if (setAck) await S.saveCase({ ...c, id, ackAt: Date.now() });
      if (note) await S.addCaseComment(id, `Closing note: ${note}`);
      await S.setCaseStatus(id, 'Closed');
      toast(`${c.ref} closed.`);
      pendingRender = true;
    },
  });
}

const ESCALATION_SUGGESTIONS = ['IT Infrastructure', 'Network Team', 'Fraud Team', 'Application Support', 'IAM Team', 'Service Desk', 'Third-party vendor'];
const SOURCE_SUGGESTIONS = ['SIEM', 'EDR', 'Email gateway', 'Firewall / IPS', 'User report', 'Threat intel', 'Fraud monitoring', 'Vulnerability scan'];

function caseForm(c = null) {
  const d = S.data();
  const prevEsc = [...new Set([...d.cases.map((x) => x.escalatedTo).filter(Boolean), ...d.users.filter((u) => !u.disabled).map((u) => u.displayName), ...ESCALATION_SUGGESTIONS])];
  const v = c || { severity: 'Medium', status: 'WIP', detectedAt: Date.now(), slaManual: false, slaBreach: 'N' };
  openModal({
    title: c ? `Edit ${esc(c.ref)}` : 'New case',
    body: `
      <div class="field"><label for="cn">Case name</label><input id="cn" maxlength="160" value="${esc(v.name)}" placeholder="e.g. Multiple failed logins on core banking admin" required></div>
      <div class="field-row">
        <div class="field"><label for="ce">Escalated team or user</label><input id="ce" list="esc-list" maxlength="120" value="${esc(v.escalatedTo)}"><datalist id="esc-list">${prevEsc.map((x) => `<option value="${esc(x)}">`).join('')}</datalist></div>
        <div class="field"><label for="cv">Severity</label><select id="cv">${S.SEVERITIES.map((s) => `<option ${s === v.severity ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="field"><label for="csrc">Source</label><input id="csrc" list="src-list" maxlength="60" value="${esc(v.source)}"><datalist id="src-list">${SOURCE_SUGGESTIONS.map((x) => `<option value="${esc(x)}">`).join('')}</datalist></div>
      </div>
      <div class="field-row">
        ${dtField('cd', 'Detection date and time', v.detectedAt)}
        ${dtField('cr', 'Reported date and time', v.reportedAt)}
        ${dtField('ca', 'Acknowledgement date and time', v.ackAt)}
      </div>
      <div class="field-row">
        <div class="field"><label>SLA breach</label>
          <div id="sla-auto" class="small" style="padding:8px 0"></div>
          <label class="check"><input type="checkbox" id="slo" ${v.slaManual ? 'checked' : ''}> Override</label>
          <select id="slv" style="margin-top:6px" ${v.slaManual ? '' : 'disabled'}><option value="N" ${v.slaBreach === 'N' ? 'selected' : ''}>N</option><option value="Y" ${v.slaBreach === 'Y' ? 'selected' : ''}>Y</option></select>
        </div>
        <div class="field"><label for="cs">Status</label><select id="cs"><option ${v.status === 'WIP' ? 'selected' : ''}>WIP</option><option ${v.status === 'Closed' ? 'selected' : ''}>Closed</option></select>
          <div class="hint">Stays WIP until someone confirms it's closed. Any analyst can close a case.</div></div>
      </div>
      <div class="field"><label for="cnotes">Notes</label><textarea id="cnotes" maxlength="5000" placeholder="What happened, what you checked, next steps">${esc(v.notes)}</textarea></div>
      <p class="error"></p>`,
    foot: '<button type="button" data-close>Cancel</button><button class="primary" type="submit">' + (c ? 'Save changes' : 'Log case') + '</button>',
    onMount: (f) => {
      f.querySelectorAll('[data-now]').forEach((b) => (b.onclick = () => { f.querySelector('#' + b.dataset.now).value = toInput(Date.now()); updSla(); }));
      const updSla = () => {
        const tmp = { severity: f.querySelector('#cv').value, detectedAt: fromInput(f.querySelector('#cd').value), ackAt: fromInput(f.querySelector('#ca').value) };
        const auto = S.computeSla(tmp);
        f.querySelector('#sla-auto').innerHTML = `Auto: <b class="sla-${auto}">${auto}</b> <span class="faint">(target ${S.slaTargetMin(tmp.severity)} min to acknowledge)</span>`;
        f.querySelector('#slv').disabled = !f.querySelector('#slo').checked;
        if (!f.querySelector('#slo').checked) f.querySelector('#slv').value = auto;
      };
      ['#cv', '#cd', '#ca', '#slo'].forEach((s) => f.querySelector(s).addEventListener('input', updSla));
      updSla();
    },
    onSubmit: async (f) => {
      const g = (id) => f.querySelector('#' + id).value;
      const manual = f.querySelector('#slo').checked;
      const saved = await S.saveCase({
        id: c?.id, name: g('cn').trim(), escalatedTo: g('ce').trim(), severity: g('cv'), source: g('csrc').trim(),
        detectedAt: fromInput(g('cd')), reportedAt: fromInput(g('cr')), ackAt: fromInput(g('ca')),
        slaManual: manual, slaBreach: manual ? g('slv') : S.computeSla({ severity: g('cv'), detectedAt: fromInput(g('cd')), ackAt: fromInput(g('ca')) }),
        status: g('cs'), notes: g('cnotes').trim(),
      });
      toast(c ? `${saved.ref} saved.` : `${saved.ref} logged.`);
      pendingRender = true;
    },
  });
}
function dtField(id, label, ts) {
  return `<div class="field"><label for="${id}">${label}</label><div class="with-now"><input type="datetime-local" id="${id}" value="${toInput(ts)}"><button type="button" class="sm" data-now="${id}">Now</button></div></div>`;
}

function caseDetail(id) {
  const c = S.data().cases.find((x) => x.id === id);
  if (!c) { toast('That case no longer exists.', true); return; }
  const timeToAck = c.ackAt && c.detectedAt ? dur(c.ackAt - c.detectedAt) : '—';
  const events = [
    ...c.history.map((h) => ({ at: h.at, html: `<b>${esc(S.userName(h.by))}</b> ${h.action === 'opened' ? 'opened the case' : 'changed ' + h.changes.map((ch) => `${esc(ch.field)}${ch.field === 'Notes' ? '' : ` (${esc(fmtVal(ch.from))} → ${esc(fmtVal(ch.to))})`}`).join(', ')}` })),
    ...(c.comments || []).map((cm) => ({ at: cm.at, c: true, html: `<b>${esc(S.userName(cm.by))}</b><div style="white-space:pre-wrap">${esc(cm.body)}</div>` })),
  ].sort((a, b) => a.at - b.at);
  openModal({
    title: `${esc(c.ref)}`,
    width: '760px',
    body: `
      <h2 style="margin-bottom:10px">${esc(c.name)}</h2>
      <dl class="kv">
        <dt>Status</dt><dd><span class="status status-${c.status}">${c.status}</span>${c.closedBy ? ` <span class="small muted">by ${esc(S.userName(c.closedBy))} at ${fmt(c.closedAt)}</span>` : ''}</dd>
        <dt>Severity</dt><dd><span class="sev sev-${c.severity}">${c.severity}</span></dd>
        <dt>Escalated to</dt><dd>${esc(c.escalatedTo) || '—'}</dd>
        ${c.source ? `<dt>Source</dt><dd>${esc(c.source)}</dd>` : ''}
        <dt>Detected</dt><dd>${fmt(c.detectedAt)}</dd>
        <dt>Reported</dt><dd>${fmt(c.reportedAt)}</dd>
        <dt>Acknowledged</dt><dd>${fmt(c.ackAt)} <span class="small muted">${c.ackAt ? `(${timeToAck} after detection)` : ''}</span></dd>
        <dt>SLA breach</dt><dd class="sla-${S.effectiveSla(c)}">${S.effectiveSla(c)}${c.slaManual ? ' <span class="small faint">(set manually)</span>' : ` <span class="small faint">(auto, target ${S.slaTargetMin(c.severity)} min)</span>`}</dd>
        <dt>Opened by</dt><dd>${esc(S.userName(c.createdBy))} at ${fmt(c.createdAt)}</dd>
      </dl>
      ${c.notes ? `<h3 style="margin-bottom:6px">Notes</h3><div class="body" style="white-space:pre-wrap;margin-bottom:16px;overflow-wrap:anywhere">${esc(c.notes)}</div>` : ''}
      <h3 style="margin-bottom:8px">Activity</h3>
      <div class="timeline">${events.map((e) => `<div class="${e.c ? 'c' : ''}"><span class="faint small">${fmt(e.at)}</span><div>${e.html}</div></div>`).join('')}</div>
      <div class="field" style="margin-top:8px"><label for="cmt">Add a comment</label><textarea id="cmt" placeholder="Update for the next analyst"></textarea></div>
      <button type="button" class="sm" id="add-cmt">Add comment</button>`,
    foot: `${S.can.deleteCases() ? '<button type="button" class="danger left" id="del">Delete</button>' : ''}
      <button type="button" id="edit">Edit</button>
      ${c.status === 'Closed' ? '<button type="button" id="reopen">Reopen</button>' : '<button type="button" class="primary" id="close">Close case</button>'}`,
    onMount: (f) => {
      f.querySelector('#add-cmt').onclick = async () => {
        if (await guard(() => S.addCaseComment(id, f.querySelector('#cmt').value), 'Comment added.')) { pendingRender = true; caseDetail(id); }
      };
      f.querySelector('#edit').onclick = () => caseForm(c);
      f.querySelector('#close')?.addEventListener('click', () => confirmClose(id));
      f.querySelector('#reopen')?.addEventListener('click', async () => { if (await guard(() => S.setCaseStatus(id, 'WIP'), 'Case reopened.')) { pendingRender = true; caseDetail(id); } });
      f.querySelector('#del')?.addEventListener('click', async () => {
        if (!confirm(`Delete ${c.ref}? This removes it from reports. The deletion is kept in the audit log.`)) return;
        if (await guard(() => S.deleteCase(id), 'Case deleted.')) { pendingRender = true; closeModal(); }
      });
    },
  });
}
function fmtVal(v) {
  if (v === '' || v == null) return 'empty';
  if (typeof v === 'number' && v > 1e11) return fmt(v);
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return String(v).length > 40 ? String(v).slice(0, 40) + '…' : String(v);
}

// ================= handover =================
let handoverFilter = '';
function viewHandover(el) {
  const d = S.data(); const now = new Date();
  const shift = currentShift(now) || 'A';
  const open = d.cases.filter((c) => c.status !== 'Closed').sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  el.innerHTML = `
    <div class="grid-2">
      <section class="panel" aria-label="Write handover">
        <div class="panel-head"><h2>Write a handover</h2></div>
        <form id="hf" novalidate>
          <div class="field-row">
            <div class="field"><label for="hd">Date</label><input type="date" id="hd" value="${ymd(now)}"></div>
            <div class="field"><label for="hs">Shift</label><select id="hs"><option value="M" ${shift === 'M' ? 'selected' : ''}>Morning</option><option value="A" ${shift === 'A' ? 'selected' : ''}>Afternoon</option></select></div>
          </div>
          <div class="field"><label for="hb">Notes for the next shift</label><textarea id="hb" style="min-height:160px" maxlength="8000" placeholder="What's in progress, who you're waiting on, anything to watch"></textarea></div>
          ${open.length ? `<div class="field"><label>Open cases to hand over</label>
            ${open.map((c) => `<label class="check" style="margin:4px 0"><input type="checkbox" value="${c.id}" checked> <span class="sev sev-${c.severity}">${c.severity}</span> ${esc(c.name)} <span class="ref">${esc(c.ref)}</span></label>`).join('')}</div>` : '<p class="small muted">No open cases to attach.</p>'}
          <button class="primary" type="submit">Post handover</button>
        </form>
      </section>
      <section class="panel" aria-label="Previous handovers">
        <div class="panel-head"><h2>Previous handovers</h2><input type="date" id="hfilter" value="${handoverFilter}" style="width:auto" aria-label="Filter by date"></div>
        <div id="hlist"></div>
      </section>
    </div>`;
  el.querySelector('#hf').onsubmit = async (e) => {
    e.preventDefault();
    const ids = [...el.querySelectorAll('#hf input[type=checkbox]:checked')].map((i) => i.value);
    const ok = await guard(() => S.saveHandover({ shift: el.querySelector('#hs').value, date: el.querySelector('#hd').value, body: el.querySelector('#hb').value, openCaseIds: ids }), 'Handover posted.');
    if (ok) render();
  };
  el.querySelector('#hfilter').oninput = (e) => { handoverFilter = e.target.value; drawHandovers(); };
  drawHandovers();
}
function drawHandovers() {
  const host = document.getElementById('hlist'); if (!host) return;
  let list = [...S.data().handovers].sort((a, b) => b.createdAt - a.createdAt);
  if (handoverFilter) list = list.filter((h) => h.date === handoverFilter);
  host.innerHTML = list.length ? `<div class="list">${list.slice(0, 60).map((h) => handoverItem(h)).join('')}</div>` : '<div class="empty">No handovers for this date.</div>';
  bindHandoverItems(host);
}
function handoverItem(h, compact = false) {
  const me = S.currentUser();
  const read = (h.readBy || []).includes(me.id);
  const cases = (h.openCaseIds || []).map((id) => S.data().cases.find((c) => c.id === id)).filter(Boolean);
  const mine = h.author === me.id || S.can.postNotices();
  return `<div class="list-item">
    <div class="meta"><b style="color:var(--text)">${h.date} ${S.SHIFT_LABELS[h.shift]}</b><span>${esc(S.userName(h.author))} at ${fmt(h.createdAt)}</span>${!read ? '<span class="tag" style="background:var(--orange);color:var(--orange-ink)">Unread</span>' : ''}</div>
    <div class="body">${esc(compact && h.body.length > 500 ? h.body.slice(0, 500) + '…' : h.body)}</div>
    ${cases.length ? `<div class="small" style="margin-top:8px">${cases.map((c) => `<button type="button" class="sm ghost" data-case="${c.id}"><span class="sev sev-${c.severity}"></span>${esc(c.ref)} ${c.status === 'Closed' ? '(now closed)' : ''}</button>`).join(' ')}</div>` : ''}
    <div class="meta" style="margin-top:8px">
      ${!read ? `<button class="sm" data-hread="${h.id}">Mark as read</button>` : ''}
      <span class="faint">Read by ${(h.readBy || []).length}</span>
      ${!compact && mine ? `<button class="sm ghost" data-hedit="${h.id}">Edit</button><button class="sm ghost" data-hdel="${h.id}">Delete</button>` : ''}
    </div>
  </div>`;
}
function bindHandoverItems(root) {
  bindCaseLinks(root);
  root.querySelectorAll('[data-hread]').forEach((b) => (b.onclick = async () => { await guard(() => S.markHandoverRead(b.dataset.hread)); render(); }));
  root.querySelectorAll('[data-hdel]').forEach((b) => (b.onclick = async () => { if (confirm('Delete this handover?') && await guard(() => S.deleteHandover(b.dataset.hdel), 'Handover deleted.')) render(); }));
  root.querySelectorAll('[data-hedit]').forEach((b) => (b.onclick = () => {
    const h = S.data().handovers.find((x) => x.id === b.dataset.hedit);
    openModal({
      title: 'Edit handover',
      body: `<div class="field-row"><div class="field"><label for="ed">Date</label><input type="date" id="ed" value="${h.date}"></div>
        <div class="field"><label for="es">Shift</label><select id="es"><option value="M" ${h.shift === 'M' ? 'selected' : ''}>Morning</option><option value="A" ${h.shift === 'A' ? 'selected' : ''}>Afternoon</option></select></div></div>
        <div class="field"><label for="eb">Notes</label><textarea id="eb" style="min-height:200px">${esc(h.body)}</textarea></div><p class="error"></p>`,
      foot: '<button type="button" data-close>Cancel</button><button class="primary" type="submit">Save changes</button>',
      onSubmit: async (f) => { await S.saveHandover({ id: h.id, date: f.querySelector('#ed').value, shift: f.querySelector('#es').value, body: f.querySelector('#eb').value }); toast('Handover saved.'); pendingRender = true; },
    });
  }));
}

// ================= notices =================
function noticeCard(n, withAdmin = false) {
  const me = S.currentUser();
  const acked = n.acks.some((a) => a.userId === me.id);
  const active = S.data().users.filter((u) => !u.disabled);
  return `<div class="notice ${n.priority === 'important' ? 'important' : ''}">
    <div class="grow">
      <h3>${esc(n.title)}</h3>
      ${n.body ? `<div class="body">${esc(n.body)}</div>` : ''}
      <div class="small muted" style="margin-top:6px">${esc(S.userName(n.author))}, ${fmt(n.createdAt)}${n.expiresAt ? `. Shows until ${fmt(n.expiresAt)}` : ''}${withAdmin ? `. Acknowledged by ${n.acks.length} of ${active.length}` : ''}</div>
      ${withAdmin && n.acks.length ? `<div class="small faint">${n.acks.map((a) => esc(S.userName(a.userId))).join(', ')}</div>` : ''}
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
      ${!acked ? `<button class="primary sm" data-ack="${n.id}">Acknowledge</button>` : '<span class="small faint">Acknowledged</span>'}
      ${withAdmin && S.can.postNotices() ? `<button class="sm ghost" data-nedit="${n.id}">Edit</button><button class="sm ghost" data-ndel="${n.id}">Remove</button>` : ''}
    </div>
  </div>`;
}
function bindNoticeAcks(root) {
  root.querySelectorAll('[data-ack]').forEach((b) => (b.onclick = async () => { if (await guard(() => S.ackNotice(b.dataset.ack))) render(); }));
}
function viewNotices(el) {
  const all = [...S.data().notices].sort((a, b) => b.createdAt - a.createdAt);
  const active = S.activeNotices();
  const expired = all.filter((n) => !active.includes(n));
  el.innerHTML = `
    ${S.can.postNotices() ? '<div class="toolbar"><div class="grow muted small">Notices show on every analyst\'s dashboard until they acknowledge them.</div><button class="primary" id="new-n">Post a notice</button></div>' : ''}
    ${active.length ? active.map((n) => noticeCard(n, true)).join('') : '<div class="panel empty"><b>No active notices.</b>' + (S.can.postNotices() ? ' Post one to flag something every analyst should know.' : ' Your team lead will post anything you need to pay attention to here.') + '</div>'}
    ${expired.length ? `<h2 style="margin:24px 0 10px">Expired</h2>${expired.map((n) => noticeCard(n, true)).join('')}` : ''}`;
  bindNoticeAcks(el);
  el.querySelector('#new-n')?.addEventListener('click', () => noticeForm());
  el.querySelectorAll('[data-nedit]').forEach((b) => (b.onclick = () => noticeForm(S.data().notices.find((n) => n.id === b.dataset.nedit))));
  el.querySelectorAll('[data-ndel]').forEach((b) => (b.onclick = async () => { if (confirm('Remove this notice?') && await guard(() => S.deleteNotice(b.dataset.ndel), 'Notice removed.')) render(); }));
}
function noticeForm(n = null) {
  openModal({
    title: n ? 'Edit notice' : 'Post a notice',
    body: `<div class="field"><label for="nt">Title</label><input id="nt" maxlength="120" value="${esc(n?.title)}" placeholder="e.g. Change freeze on payment gateway until Thursday"></div>
      <div class="field"><label for="nb">Details</label><textarea id="nb" maxlength="4000">${esc(n?.body)}</textarea></div>
      <div class="field-row">
        <div class="field"><label for="np">Priority</label><select id="np"><option value="info">Normal</option><option value="important" ${n?.priority === 'important' ? 'selected' : ''}>Important</option></select></div>
        <div class="field"><label for="nx">Show until (optional)</label><input type="datetime-local" id="nx" value="${toInput(n?.expiresAt)}"></div>
      </div><p class="error"></p>`,
    foot: `<button type="button" data-close>Cancel</button><button class="primary" type="submit">${n ? 'Save changes' : 'Post notice'}</button>`,
    onSubmit: async (f) => {
      await S.saveNotice({ id: n?.id, title: f.querySelector('#nt').value, body: f.querySelector('#nb').value, priority: f.querySelector('#np').value, expiresAt: fromInput(f.querySelector('#nx').value) });
      toast(n ? 'Notice saved.' : 'Notice posted.'); pendingRender = true;
    },
  });
}

// ================= schedule =================
const schedState = { y: new Date().getFullYear(), m: new Date().getMonth(), edit: false };
const CYCLE = ['M', 'A', 'O', 'AL', ''];
function viewSchedule(el) {
  const key = S.monthKey(schedState.y, schedState.m);
  const month = structuredClone(S.getMonth(key));
  const days = new Date(schedState.y, schedState.m + 1, 0).getDate();
  const today = new Date();
  const isThisMonth = today.getFullYear() === schedState.y && today.getMonth() === schedState.m;
  const me = S.currentUser();
  const canEdit = S.can.manageSchedule();
  const label = new Date(schedState.y, schedState.m, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekend = (dow) => dow === 5 || dow === 6; // Fri/Sat weekend
  const t = settings().shiftTimes;

  el.innerHTML = `
    <div class="toolbar">
      <button id="prev" aria-label="Previous month">‹</button>
      <h2 style="min-width:170px;text-align:center">${label}</h2>
      <button id="next" aria-label="Next month">›</button>
      <button class="ghost" id="thism">This month</button>
      <div class="grow"></div>
      ${canEdit ? `
        <button id="tpl">Download template</button>
        <button id="imp">Import Excel</button>
        <button id="copy">Copy last month</button>
        <button class="${schedState.edit ? 'primary' : ''}" id="edit">${schedState.edit ? 'Done editing' : 'Edit schedule'}</button>` : ''}
      <button id="exp">Export Excel</button>
    </div>
    <div class="legend">
      <span><span class="cell c-M">M</span>Morning ${t.M.start}–${t.M.end}</span>
      <span><span class="cell c-A">A</span>Afternoon ${t.A.start}–${t.A.end}</span>
      <span><span class="cell c-O">O</span>Off</span>
      <span><span class="cell c-AL">AL</span>Annual leave</span>
      ${schedState.edit ? '<span class="faint">Click a cell to cycle M, A, O, AL, blank. Changes save as you go.</span>' : ''}
    </div>
    ${month.rows.length || schedState.edit ? `
    <div class="sched-wrap"><table class="sched">
      <thead><tr><th class="name">Analyst</th>${Array.from({ length: days }, (_, i) => {
        const dt = new Date(schedState.y, schedState.m, i + 1); const dw = dt.getDay();
        return `<th class="${weekend(dw) ? 'we' : ''} ${isThisMonth && today.getDate() === i + 1 ? 'today' : ''}">${dows[dw].slice(0, 2)}<br>${i + 1}</th>`;
      }).join('')}</tr></thead>
      <tbody>${month.rows.map((r, ri) => `<tr>
        <td class="name" ${r.userId === me.id ? 'style="color:var(--orange-hi)"' : ''}>${esc(r.name)}${schedState.edit ? `<button class="sm ghost rm" data-rm="${ri}" aria-label="Remove ${esc(r.name)}">✕</button>` : ''}</td>
        ${Array.from({ length: days }, (_, i) => {
          const v = r.cells[String(i + 1)] || '';
          const cls = `cell ${v ? 'c-' + v : ''}`;
          const td = isThisMonth && today.getDate() === i + 1 ? 'today' : '';
          return schedState.edit
            ? `<td class="${td}"><button type="button" class="${cls}" data-r="${ri}" data-d="${i + 1}" aria-label="${esc(r.name)} day ${i + 1}: ${v || 'blank'}">${v}</button></td>`
            : `<td class="${td}"><span class="${cls}">${v}</span></td>`;
        }).join('')}
      </tr>`).join('')}
      ${schedState.edit ? `<tr><td class="name" colspan="${days + 1}" style="position:static"><div style="display:flex;gap:8px;align-items:center;max-width:520px">
        <input id="newrow" list="ulist" placeholder="Add an analyst (pick a user or type a name)"><datalist id="ulist">${S.data().users.filter((u) => !u.disabled && !month.rows.some((r) => r.userId === u.id)).map((u) => `<option value="${esc(u.displayName)}">`).join('')}</datalist>
        <button class="sm" id="addrow">Add row</button></div></td></tr>` : ''}
      </tbody></table></div>` : `<div class="panel empty"><b>No schedule for ${label}.</b> ${canEdit ? 'Select Edit schedule to build it here, or Import Excel to load one. Download template gives you a sheet with your team and the right days.' : 'Your team lead hasn\'t published it yet.'}</div>`}
    ${month.updatedAt ? `<p class="small faint" style="margin-top:8px">Last updated ${fmt(month.updatedAt)}.</p>` : ''}`;

  const go = (dm) => { const d = new Date(schedState.y, schedState.m + dm, 1); schedState.y = d.getFullYear(); schedState.m = d.getMonth(); render(); };
  el.querySelector('#prev').onclick = () => go(-1);
  el.querySelector('#next').onclick = () => go(1);
  el.querySelector('#thism').onclick = () => { schedState.y = today.getFullYear(); schedState.m = today.getMonth(); render(); };
  el.querySelector('#exp').onclick = () => { if (!month.rows.length) return toast('Nothing to export for this month.', true); exportScheduleXlsx(month, schedState.y, schedState.m, settings().teamName); };
  if (!canEdit) return;
  el.querySelector('#edit').onclick = () => { schedState.edit = !schedState.edit; render(); };
  el.querySelector('#tpl').onclick = () => downloadScheduleTemplate(schedState.y, schedState.m, month.rows.length ? month.rows.map((r) => r.name) : S.data().users.filter((u) => !u.disabled && u.role !== 'admin').map((u) => u.displayName));
  el.querySelector('#copy').onclick = async () => {
    const pd = new Date(schedState.y, schedState.m - 1, 1);
    const prev = S.getMonth(S.monthKey(pd.getFullYear(), pd.getMonth()));
    if (!prev.rows.length) return toast('Last month has no schedule to copy.', true);
    if (month.rows.length && !confirm(`Replace ${label} with last month's names and pattern?`)) return;
    const rows = prev.rows.map((r) => {
      const cells = {};
      // keep the weekday pattern: align by day of week from the same week of last month
      for (let dnum = 1; dnum <= days; dnum++) {
        const target = new Date(schedState.y, schedState.m, dnum);
        const src = new Date(target); src.setDate(src.getDate() - 28);
        if (src.getMonth() === pd.getMonth() && r.cells[String(src.getDate())]) cells[String(dnum)] = r.cells[String(src.getDate())];
      }
      return { name: r.name, userId: r.userId || null, cells };
    });
    if (await guard(() => S.saveMonth(key, { rows }, `Copied previous month's schedule into ${key}`), 'Copied. Shifts line up with the same weekdays four weeks earlier.')) render();
  };
  el.querySelector('#imp').onclick = async () => {
    const file = await pickFile('.xlsx,.xls,.csv');
    if (!file) return;
    let parsed;
    try { parsed = importScheduleWorkbook(await file.arrayBuffer()); } catch (e) { return toast(e.message, true); }
    const ty = parsed.year ?? schedState.y; const tm = parsed.month ?? schedState.m;
    const counts = { M: 0, A: 0, O: 0, AL: 0 };
    parsed.rows.forEach((r) => Object.values(r.cells).forEach((v) => counts[v]++));
    openModal({
      title: 'Import schedule',
      body: `<p>Found <b>${parsed.rows.length}</b> analysts and <b>${parsed.dayCount}</b> day columns in <b>${esc(file.name)}</b>.</p>
        <p class="small muted">${counts.M} morning, ${counts.A} afternoon, ${counts.O} off and ${counts.AL} annual leave entries.${parsed.skipped ? ` ${parsed.skipped} cells weren't M, A, O or AL and were left blank.` : ''}</p>
        <div class="field"><label for="im">Import into month</label><input type="month" id="im" value="${ty}-${pad(tm + 1)}"></div>
        <div class="small muted">Names: ${parsed.rows.map((r) => esc(r.name)).join(', ')}</div>
        <p class="error"></p>`,
      foot: '<button type="button" data-close>Cancel</button><button class="primary" type="submit">Import and replace month</button>',
      onSubmit: async (f) => {
        const [yy, mm] = f.querySelector('#im').value.split('-').map(Number);
        const users = S.data().users;
        const rows = parsed.rows.map((r) => ({ ...r, userId: users.find((u) => u.displayName.toLowerCase() === r.name.toLowerCase() || u.username.toLowerCase() === r.name.toLowerCase())?.id || null }));
        await S.saveMonth(S.monthKey(yy, mm - 1), { rows }, `Imported schedule for ${yy}-${pad(mm)} from ${file.name}`);
        schedState.y = yy; schedState.m = mm - 1;
        toast('Schedule imported.'); pendingRender = true;
      },
    });
  };
  if (!schedState.edit) return;
  el.querySelectorAll('button.cell').forEach((b) => (b.onclick = async () => {
    const r = month.rows[+b.dataset.r]; const dk = b.dataset.d;
    const next = CYCLE[(CYCLE.indexOf(r.cells[dk] || '') + 1) % CYCLE.length];
    if (next) r.cells[dk] = next; else delete r.cells[dk];
    b.className = `cell ${next ? 'c-' + next : ''}`; b.textContent = next;
    b.setAttribute('aria-label', `${r.name} day ${dk}: ${next || 'blank'}`);
    await guard(() => S.saveMonth(key, month, `Edited ${r.name} on ${key}-${pad(dk)}: ${next || 'blank'}`));
  }));
  el.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => {
    const r = month.rows[+b.dataset.rm];
    if (!confirm(`Remove ${r.name} from ${label}?`)) return;
    month.rows.splice(+b.dataset.rm, 1);
    if (await guard(() => S.saveMonth(key, month, `Removed ${r.name} from ${key}`))) render();
  }));
  const add = async () => {
    const name = el.querySelector('#newrow').value.trim(); if (!name) return;
    if (month.rows.some((r) => r.name.toLowerCase() === name.toLowerCase())) return toast(`${name} is already on this month.`, true);
    const u = S.data().users.find((x) => x.displayName.toLowerCase() === name.toLowerCase());
    month.rows.push({ name, userId: u?.id || null, cells: {} });
    if (await guard(() => S.saveMonth(key, month, `Added ${name} to ${key}`))) { render(); document.getElementById('newrow')?.focus(); }
  };
  el.querySelector('#addrow').onclick = add;
  el.querySelector('#newrow').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
}

// ================= reports =================
const reportState = { date: ymd(new Date()), carry: true };
export function buildReport(dateStr, carry) {
  const w = windowEnding(dateStr);
  const rows = casesInWindow(w, carry).sort((a, b) => a.detectedAt - b.detectedAt).map((c) => ({
    ref: c.ref, name: c.name, escalatedTo: c.escalatedTo || '', severity: c.severity,
    detectedAt: c.detectedAt, reportedAt: c.reportedAt, ackAt: c.ackAt,
    sla: S.effectiveSla(c), status: statusAt(c, w.end),
    openedBy: S.userName(c.createdBy), closedBy: c.closedBy && c.closedAt < w.end ? S.userName(c.closedBy) : '',
    carried: c.detectedAt < w.start, id: c.id,
  }));
  const handovers = S.data().handovers.filter((h) => h.createdAt >= w.start && h.createdAt < w.end).sort((a, b) => a.createdAt - b.createdAt)
    .map((h) => ({ ...h, authorName: S.userName(h.author) }));
  return { w, rows, handovers };
}
function viewReports(el) {
  const r = buildReport(reportState.date, reportState.carry);
  const sum = { total: r.rows.length, open: r.rows.filter((x) => x.status === 'WIP').length, closed: r.rows.filter((x) => x.status === 'Closed').length, breach: r.rows.filter((x) => x.sla === 'Y').length };
  const bySev = S.SEVERITIES.map((s) => `${r.rows.filter((x) => x.severity === s).length} ${s}`).join(', ');
  const partial = Date.now() < r.w.end;
  el.innerHTML = `
    <div class="toolbar">
      <div class="field"><label for="rd">Report for</label><input type="date" id="rd" value="${reportState.date}"></div>
      <div class="field"><label class="check" style="margin-top:22px"><input type="checkbox" id="rc" ${reportState.carry ? 'checked' : ''}> Include cases still open from earlier days</label></div>
      <div class="grow"></div>
      <button class="primary" id="dlx">Download Excel</button>
      <button id="dlc">Download CSV</button>
      <button id="prt">Print or save PDF</button>
    </div>
    <section class="panel">
      <div class="panel-head"><div>
        <h2>${esc(settings().teamName)} daily report</h2>
        <div class="muted small">${fmt(r.w.start)} to ${fmt(r.w.end)}${partial ? '. This window is still in progress, so the report is partial.' : ''}</div>
      </div></div>
      <p class="small">${sum.total} cases (${bySev}). ${sum.open} WIP, ${sum.closed} closed, <span class="${sum.breach ? 'sla-Y' : ''}">${sum.breach} SLA breaches</span>.</p>
      ${r.rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Case name</th><th>Escalated team or user</th><th>Severity</th><th>Detection</th><th>Reported</th><th>Acknowledgement</th><th>SLA breach</th><th>Status</th></tr></thead>
        <tbody>${r.rows.map((x, i) => `<tr>
          <td class="t">${i + 1}</td>
          <td><button type="button" class="case-name" data-case="${x.id}">${esc(x.name)}</button><div class="ref">${esc(x.ref)}${x.carried ? ' · carried over' : ''}</div></td>
          <td>${esc(x.escalatedTo) || '—'}</td><td><span class="sev sev-${x.severity}">${x.severity}</span></td>
          <td class="t">${fmt(x.detectedAt)}</td><td class="t">${fmt(x.reportedAt)}</td><td class="t">${fmt(x.ackAt)}</td>
          <td class="sla-${x.sla}">${x.sla}</td><td><span class="status status-${x.status}">${x.status}</span></td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No cases in this window.</div>'}
      ${r.handovers.length ? `<h3 style="margin:20px 0 6px">Handovers in this window</h3><div class="list">${r.handovers.map((h) => `<div class="list-item"><div class="meta"><b style="color:var(--text)">${S.SHIFT_LABELS[h.shift]}</b>${esc(S.userName(h.author))}, ${fmt(h.createdAt)}</div><div class="body">${esc(h.body)}</div></div>`).join('')}</div>` : ''}
    </section>`;
  el.querySelector('#rd').oninput = (e) => { if (e.target.value) { reportState.date = e.target.value; render(); } };
  el.querySelector('#rc').oninput = (e) => { reportState.carry = e.target.checked; render(); };
  const meta = () => ({ team: settings().teamName, by: S.currentUser().displayName, at: Date.now() });
  el.querySelector('#dlx').onclick = () => { downloadReportXlsx(r, meta()); S.addAudit('report.download', `Downloaded daily report ending ${fmt(r.w.end)}`); };
  el.querySelector('#dlc').onclick = () => { downloadReportCsv(r, meta(), download); };
  el.querySelector('#prt').onclick = () => print();
  bindCaseLinks(el);
}

// ================= users =================
function viewUsers(el) {
  const users = [...S.data().users].sort((a, b) => a.disabled - b.disabled || ['admin', 'teamlead', 'analyst'].indexOf(a.role) - ['admin', 'teamlead', 'analyst'].indexOf(b.role) || a.displayName.localeCompare(b.displayName));
  const me = S.currentUser();
  el.innerHTML = `
    <div class="toolbar"><div class="grow muted small">${S.currentUser().role === 'teamlead' ? 'Team leads can add and manage analysts and team leads. Only admins can manage admin accounts.' : 'Admins can manage every account.'} New accounts get a temporary password and must change it at first sign-in.</div>
      <button class="primary" id="new-u">Add user</button></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Last sign-in</th><th>Created</th><th></th></tr></thead>
      <tbody>${users.map((u) => {
        const manage = S.can.manageTarget(u);
        return `<tr>
          <td><b>${esc(u.displayName)}</b>${u.id === me.id ? ' <span class="faint small">(you)</span>' : ''}</td>
          <td>@${esc(u.username)}</td>
          <td><span class="tag role-${u.role}">${S.ROLES[u.role]}</span></td>
          <td>${u.disabled ? '<span class="tag off">Disabled</span>' : u.mustChange ? '<span class="tag">Temp password</span>' : '<span class="small muted">Active</span>'}</td>
          <td class="t">${fmt(u.lastLoginAt)}</td>
          <td class="t">${fmt(u.createdAt)}<div class="faint small">${esc(u.createdBy)}</div></td>
          <td class="actions">${manage ? `
            <button class="sm" data-uedit="${u.id}">Edit</button>
            ${!u.disabled ? `<button class="sm" data-ureset="${u.id}">Reset password</button>` : ''}
            ${u.id !== me.id ? (u.disabled ? `<button class="sm" data-uenable="${u.id}">Enable</button>` : `<button class="sm danger" data-udisable="${u.id}">Disable</button>`) : ''}` : '<span class="faint small">Admin only</span>'}
          </td></tr>`;
      }).join('')}</tbody></table></div>`;
  el.querySelector('#new-u').onclick = () => userForm();
  el.querySelectorAll('[data-uedit]').forEach((b) => (b.onclick = () => userForm(S.data().users.find((u) => u.id === b.dataset.uedit))));
  el.querySelectorAll('[data-ureset]').forEach((b) => (b.onclick = () => {
    const u = S.data().users.find((x) => x.id === b.dataset.ureset);
    const temp = generateTempPassword();
    openModal({
      title: `Reset password for ${esc(u.displayName)}`,
      body: `<p>This replaces ${esc(u.displayName)}'s password with the temporary one below. They'll have to choose a new one when they sign in.</p>
        <div class="field"><label for="tp">Temporary password</label><input id="tp" value="${esc(temp)}"></div><p class="error"></p>`,
      foot: '<button type="button" data-close>Cancel</button><button class="primary" type="submit">Reset password</button>',
      onSubmit: async (f) => { const pw = f.querySelector('#tp').value; await S.resetPassword(u.id, pw); showCredentials(u.username, pw, 'Password reset'); pendingRender = true; return true; },
    });
  }));
  el.querySelectorAll('[data-udisable]').forEach((b) => (b.onclick = async () => {
    const u = S.data().users.find((x) => x.id === b.dataset.udisable);
    if (!confirm(`Disable ${u.displayName}? Their password stops working right away. Their cases and notes stay.`)) return;
    if (await guard(() => S.updateUser(u.id, { disabled: true }), `${u.displayName} disabled.`)) render();
  }));
  el.querySelectorAll('[data-uenable]').forEach((b) => (b.onclick = () => {
    const u = S.data().users.find((x) => x.id === b.dataset.uenable);
    const temp = generateTempPassword();
    openModal({
      title: `Enable ${esc(u.displayName)}`,
      body: `<p>Re-enabling needs a new temporary password, because disabling removed the old one.</p><div class="field"><label for="tp">Temporary password</label><input id="tp" value="${esc(temp)}"></div><p class="error"></p>`,
      foot: '<button type="button" data-close>Cancel</button><button class="primary" type="submit">Enable account</button>',
      onSubmit: async (f) => { const pw = f.querySelector('#tp').value; await S.enableUserWithPassword(u.id, pw); showCredentials(u.username, pw, 'Account enabled'); pendingRender = true; return true; },
    });
  }));
}
function userForm(u = null) {
  const roles = Object.entries(S.ROLES).filter(([k]) => S.can.assignRole(k) || u?.role === k);
  const temp = generateTempPassword();
  openModal({
    title: u ? `Edit ${esc(u.displayName)}` : 'Add user',
    body: `
      <div class="field"><label for="ud">Full name</label><input id="ud" maxlength="60" value="${esc(u?.displayName)}"></div>
      ${u ? `<div class="field"><label>Username</label><input value="${esc(u.username)}" readonly><div class="hint">Usernames can't change because they're part of the account's encryption.</div></div>`
          : '<div class="field"><label for="uu">Username</label><input id="uu" maxlength="32" autocomplete="off" placeholder="e.g. a.alharthy"></div>'}
      <div class="field"><label for="ur">Role</label><select id="ur" ${u && u.id === S.currentUser().id ? 'disabled' : ''}>${roles.map(([k, l]) => `<option value="${k}" ${(u?.role || 'analyst') === k ? 'selected' : ''} ${!S.can.assignRole(k) ? 'disabled' : ''}>${l}</option>`).join('')}</select>
        <div class="hint">Analysts work cases and handovers. Team leads also manage users, the schedule, notices and settings. Admins can do everything.</div></div>
      ${u ? '' : `<div class="field"><label for="up">Temporary password</label><input id="up" value="${esc(temp)}"><div class="hint">Share it with them directly, not by email. They'll replace it at first sign-in.</div></div>`}
      <p class="error"></p>`,
    foot: `<button type="button" data-close>Cancel</button><button class="primary" type="submit">${u ? 'Save changes' : 'Add user'}</button>`,
    onSubmit: async (f) => {
      if (u) {
        await S.updateUser(u.id, { displayName: f.querySelector('#ud').value, role: f.querySelector('#ur').disabled ? undefined : f.querySelector('#ur').value });
        toast('User saved.'); pendingRender = true; return;
      }
      const pw = f.querySelector('#up').value;
      const nu = await S.createUser({ username: f.querySelector('#uu').value, displayName: f.querySelector('#ud').value, role: f.querySelector('#ur').value, password: pw });
      showCredentials(nu.username, pw, `${S.ROLES[nu.role]} account added`);
      pendingRender = true; return true;
    },
  });
}
function showCredentials(username, pw, title) {
  openModal({
    title,
    body: `<p>Give these to the user. This is the only time the password is shown. It isn't stored anywhere.</p>
      <dl class="kv"><dt>Username</dt><dd>${esc(username)}</dd></dl>
      <div class="secret" id="sec">${esc(pw)}</div>`,
    foot: '<button type="button" id="cp">Copy password</button><button type="button" class="primary" data-close>Done</button>',
    onMount: (f) => { f.querySelector('#cp').onclick = async () => { try { await navigator.clipboard.writeText(pw); toast('Password copied.'); } catch { toast('Copy failed. Select the password and copy it manually.', true); } }; },
  });
}

// ================= audit =================
let auditQ = '';
function viewAudit(el) {
  el.innerHTML = `<div class="toolbar"><div class="field grow"><label for="aq">Search</label><input id="aq" type="search" value="${esc(auditQ)}" placeholder="Person, action or detail"></div>
    <button id="ax">Export CSV</button></div><div id="alist"></div>`;
  const draw = () => {
    const q = auditQ.toLowerCase();
    const rows = S.data().audit.filter((a) => !q || `${a.by} ${a.action} ${a.detail}`.toLowerCase().includes(q));
    el.querySelector('#alist').innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
      <tbody>${rows.slice(0, 400).map((a) => `<tr><td class="t">${fmt(a.at)}</td><td>${esc(a.by)}</td><td><span class="tag">${esc(a.action)}</span></td><td>${esc(a.detail)}</td></tr>`).join('')}</tbody></table></div>
      <p class="small faint" style="margin-top:8px">${rows.length} entries${rows.length > 400 ? ', showing the latest 400' : ''}. The log keeps the latest 3,000.</p>` : '<div class="panel empty">No matching entries.</div>';
  };
  el.querySelector('#aq').oninput = (e) => { auditQ = e.target.value; draw(); };
  el.querySelector('#ax').onclick = () => {
    const lines = [['When', 'Who', 'Action', 'Detail'], ...S.data().audit.map((a) => [fmt(a.at), a.by, a.action, a.detail])];
    download(`audit-log-${ymd(new Date())}.csv`, lines.map((l) => l.map(csvCell).join(',')).join('\r\n'), 'text/csv');
  };
  draw();
}
export function csvCell(v) { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

// ================= settings =================
function viewSettings(el) {
  const s = settings();
  el.innerHTML = `<form id="sf" class="panel" style="max-width:760px" novalidate>
    <h2 style="margin-bottom:14px">Team</h2>
    <div class="field"><label for="tn">Team name</label><input id="tn" maxlength="40" value="${esc(s.teamName)}"></div>
    <h2 style="margin:22px 0 6px">SLA targets</h2>
    <p class="small muted">Minutes allowed from detection to acknowledgement. Cases past the target are marked as SLA breaches automatically, unless an analyst overrides it.</p>
    <div class="field-row">${S.SEVERITIES.map((v) => `<div class="field"><label for="sla-${v}"><span class="sev sev-${v}">${v}</span></label><input type="number" min="1" max="10080" id="sla-${v}" value="${s.sla[v]}"></div>`).join('')}</div>
    <h2 style="margin:22px 0 6px">Shifts and reporting</h2>
    <div class="field-row">
      <div class="field"><label for="ms">Morning starts</label><input type="time" id="ms" value="${s.shiftTimes.M.start}"></div>
      <div class="field"><label for="me">Morning ends</label><input type="time" id="me" value="${s.shiftTimes.M.end}"></div>
      <div class="field"><label for="as">Afternoon starts</label><input type="time" id="as" value="${s.shiftTimes.A.start}"></div>
      <div class="field"><label for="ae">Afternoon ends</label><input type="time" id="ae" value="${s.shiftTimes.A.end}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label for="rc">Daily report cutoff</label><input type="time" id="rc" value="${s.reportCutoff}"><div class="hint">The report covers the 24 hours ending at this time.</div></div>
      <div class="field"><label for="to">Sign out after inactivity (minutes)</label><input type="number" min="5" max="240" id="to" value="${s.sessionTimeoutMin}"></div>
    </div>
    <button class="primary" type="submit">Save settings</button>
  </form>`;
  el.querySelector('#sf').onsubmit = async (e) => {
    e.preventDefault();
    const g = (id) => el.querySelector('#' + id).value;
    const sla = {}; for (const v of S.SEVERITIES) sla[v] = Math.max(1, parseInt(g('sla-' + v), 10) || s.sla[v]);
    const times = [g('ms'), g('me'), g('as'), g('ae'), g('rc')];
    if (times.some((t) => !/^\d{2}:\d{2}$/.test(t))) return toast('Fill in every shift time.', true);
    if (await guard(() => S.saveSettings({
      teamName: g('tn').trim() || 'SOC Team', sla,
      shiftTimes: { M: { start: g('ms'), end: g('me') }, A: { start: g('as'), end: g('ae') } },
      reportCutoff: g('rc'), sessionTimeoutMin: Math.min(240, Math.max(5, parseInt(g('to'), 10) || 20)),
    }), 'Settings saved.')) render();
  };
}

// ================= backup & sync =================
function viewBackup(el) {
  el.innerHTML = `
    <section class="panel" style="max-width:820px">
      <h2 style="margin-bottom:8px">How data is shared in this version</h2>
      <p class="muted">This proof of concept has no server. Data lives encrypted in this browser only. To share work between machines, download a backup here and load it on the other machine. The file is fully encrypted. Opening it still needs a valid username and password.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
        <button class="primary" id="exp">Download encrypted backup</button>
        <button id="merge">Merge a teammate's backup</button>
      </div>
      <p class="small faint" style="margin-top:10px">Merge keeps the newest version of every case, handover, notice and schedule month from both copies. It only works with backups from this same tracker.</p>
    </section>
    ${S.can.replaceVault() ? `<section class="panel" style="max-width:820px">
      <h2 style="margin-bottom:8px">Admin</h2>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button id="replace">Replace with a backup</button>
        <button class="danger" id="wipe">Erase this browser's copy</button>
      </div>
      <p class="small faint" style="margin-top:10px">Replace overwrites everything here with the backup file, even one from a different tracker. Erase removes the encrypted data from this browser. Download a backup first if you want to keep it.</p>
    </section>` : ''}`;
  el.querySelector('#exp').onclick = () => {
    S.addAudit('backup.export', 'Downloaded encrypted backup');
    const stamp = fmt(Date.now()).replace(/[: ]/g, '-');
    download(`soc-tracker-backup-${stamp}.soctracker`, S.exportContainer());
    toast('Encrypted backup downloaded.');
  };
  el.querySelector('#merge').onclick = async () => {
    const file = await pickFile('.soctracker,.json,application/json'); if (!file) return;
    const stats = await guard(async () => S.mergeFromBackup(await file.text()));
    if (stats && stats !== true) {
      const s = (k) => `${stats[k].added} new, ${stats[k].updated} updated`;
      toast(`Merged. Cases: ${s('cases')}. Handovers: ${s('handovers')}. Notices: ${s('notices')}. Users: ${s('users')}.`);
      render();
    }
  };
  el.querySelector('#replace')?.addEventListener('click', () => restoreFromFile(true));
  el.querySelector('#wipe')?.addEventListener('click', () => {
    if (prompt('Type ERASE to remove all tracker data from this browser.') !== 'ERASE') return;
    S.wipeLocal(); location.hash = ''; render(); toast('Tracker data erased from this browser.');
  });
}

// ================= account =================
function viewAccount(el) {
  const me = S.currentUser();
  el.innerHTML = `<div class="panel" style="max-width:560px">
    <dl class="kv"><dt>Name</dt><dd>${esc(me.displayName)}</dd><dt>Username</dt><dd>@${esc(me.username)}</dd><dt>Role</dt><dd>${S.ROLES[me.role]}</dd><dt>Last sign-in</dt><dd>${fmt(me.lastLoginAt)}</dd></dl>
    <form id="pf" novalidate>
      <h2 style="margin-bottom:12px">Change password</h2>
      <div class="field"><label for="c1">Current password</label><input type="password" id="c1" autocomplete="current-password"></div>
      <div class="field"><label for="c2">New password</label><input type="password" id="c2" autocomplete="new-password"><div class="hint">At least 12 characters, mixing three of: lowercase, uppercase, numbers, symbols.</div></div>
      <div class="field"><label for="c3">Confirm new password</label><input type="password" id="c3" autocomplete="new-password"></div>
      <button class="primary" type="submit">Change password</button>
      <p class="error" id="perr"></p>
    </form></div>`;
  el.querySelector('#pf').onsubmit = async (e) => {
    e.preventDefault();
    const g = (id) => el.querySelector('#' + id).value; const err = el.querySelector('#perr'); err.textContent = '';
    if (g('c2') !== g('c3')) { err.textContent = 'The new passwords do not match.'; return; }
    const btn = e.target.querySelector('button'); busy(btn, true);
    try { await S.changeOwnPassword(g('c1'), g('c2')); toast('Password changed.'); e.target.reset(); }
    catch (ex) { err.textContent = ex.message; }
    finally { busy(btn, false); }
  };
}

render();
