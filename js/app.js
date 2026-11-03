import * as S from './store.js';
import { generateTempPassword } from './crypto.js';
import { importScheduleWorkbook, downloadScheduleTemplate, exportScheduleXlsx, downloadReportXlsx, downloadReportCsv } from './excel.js';
import {
  esc, pad, fmt, ymd, hm, toInput, fromInput, dur, SEV_RANK, csvCell, toast, guard, download, pickFile, busy,
  openModal, closeModal, modalOpen, setRender, refresh, forceRender, markClean, markDirty, settings, windowEnding, currentWindow, currentShift,
} from './ui.js';
import { viewCases, caseForm, caseDetail, bindCaseLinks, incidentBadge } from './cases.js';
import { viewIncidents, incidentDetail, incStatus } from './incidents.js';
import { viewTemplates } from './templates.js';
import { viewSearch } from './search.js';

const $app = document.getElementById('app');

// ================= report helpers =================
export function casesInWindow(w, includeCarry) {
  const inW = (t) => t && t >= w.start && t < w.end;
  return S.data().cases.filter((c) =>
    inW(c.detectedAt) || inW(c.reportedAt) || inW(c.createdAt) || inW(c.closedAt) ||
    (includeCarry && c.detectedAt < w.start && (!c.closedAt || c.closedAt >= w.end)));
}
export function incidentsInWindow(w, includeCarry) {
  const inW = (t) => t && t >= w.start && t < w.end;
  return S.data().incidents.filter((i) =>
    inW(i.declaredAt) || inW(i.closedAt) || inW(i.containedAt) || i.log.some((e) => inW(e.at)) ||
    (includeCarry && i.declaredAt < w.start && (!i.closedAt || i.closedAt >= w.end)));
}
export function statusAt(c, t) { return c.closedAt && c.closedAt < t ? 'Closed' : (c.status === 'Closed' && !c.closedAt ? 'Closed' : 'WIP'); }

// ================= idle lock =================
let lastActivity = Date.now();
['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true }));
setInterval(() => {
  if (!S.isLoggedIn()) return;
  const limit = (Number(settings().sessionTimeoutMin) || 30) * 60000;
  if (Date.now() - lastActivity > limit) { S.logout(); closeModal(); forceRender(); toast('Signed out after inactivity.'); return; }
  const clock = document.querySelector('.clock');
  if (clock) clock.textContent = hm(Date.now());
  if (route() === 'dashboard') refresh();
}, 30000);

S.onChange((reason) => {
  if (reason === 'status') return updateStatusPill();
  if (reason === 'expired') { closeModal(); forceRender(); toast('Your session ended. Sign in again.', true); return; }
  if (reason === 'signedout') return;
  if (S.isLoggedIn()) refresh();
});

// ================= routing =================
const ROUTES = {
  dashboard: { title: 'Dashboard', view: viewDashboard },
  cases: { title: 'Case tracker', view: viewCases },
  incidents: { title: 'Incident tracker', view: viewIncidents },
  search: { title: 'Search history', view: viewSearch },
  handover: { title: 'Shift handover', view: viewHandover },
  notices: { title: 'Notices', view: viewNotices },
  schedule: { title: 'Shift schedule', view: viewSchedule },
  reports: { title: 'Daily report', view: viewReports },
  templates: { title: 'Case templates', view: viewTemplates, allow: () => S.can.manageTemplates() },
  users: { title: 'Users', view: viewUsers, allow: () => S.can.manageUsers() },
  audit: { title: 'Audit log', view: viewAudit, allow: () => S.can.viewAudit() },
  settings: { title: 'Settings', view: viewSettings, allow: () => S.can.editSettings() },
  account: { title: 'My account', view: viewAccount },
};
function route() { const r = location.hash.replace(/^#\/?/, '').split('?')[0]; return ROUTES[r] ? r : 'dashboard'; }
addEventListener('hashchange', () => { closeModal(); forceRender(); });

let bootError = null;
function render() {
  markClean();
  if (bootError) return viewBootError();
  if (!S.isInitialized()) return viewSetup();
  if (!S.isLoggedIn()) return viewLogin();
  if (S.currentUser().mustChange) return viewForceChange();
  const r = route();
  const def = ROUTES[r];
  if (def.allow && !def.allow()) { location.hash = '#/dashboard'; return; }
  const scrollY = window.scrollY;
  $app.innerHTML = shell(r, def.title);
  bindShell();
  const content = document.getElementById('content');
  def.view(content);
  content.addEventListener('input', (e) => { if (!e.target.closest('[data-live]') && !e.target.closest('dialog')) markDirty(); });
  window.scrollTo(0, scrollY);
  updateStatusPill();
}
setRender(render);

// ================= shell =================
const LOGO = `<svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="#141414" stroke="#2a2a2a"/><path d="M7 22 L13 10 L19 18 L25 8" stroke="#FF7A1A" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function shell(active, title) {
  const d = S.data(); const me = S.currentUser();
  const open = d.cases.filter((c) => c.status !== 'Closed').length;
  const activeInc = d.incidents.filter((i) => i.status !== 'Closed').length;
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
        ${item('incidents', 'Incidents', activeInc, activeInc > 0)}
        ${item('search', 'Search history')}
        ${item('handover', 'Shift handover', unreadHand, unreadHand > 0)}
        ${item('notices', 'Notices', unackd, unackd > 0)}
        ${item('schedule', 'Shift schedule')}
        ${item('reports', 'Daily report')}
        ${S.can.manageTemplates() ? '<div class="nav-sep"></div>' + item('templates', 'Case templates') : ''}
        ${S.can.manageUsers() ? item('users', 'Users') : ''}
        ${S.can.viewAudit() ? item('audit', 'Audit log') : ''}
        ${S.can.editSettings() ? item('settings', 'Settings') : ''}
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
        <button class="sm hidden" id="updates">New updates. Show them</button>
        <span class="sync" id="sync" role="status"></span>
        <div class="shift-chip">${shift ? `<span class="shift-dot"></span><span><b>${S.SHIFT_LABELS[shift]} shift</b> <span class="long">${st.start}–${st.end}</span></span>` : '<span class="muted">Outside shift hours</span>'}</div>
        <time class="clock" aria-label="Current time">${hm(Date.now())}</time>
      </header>
      <main class="content" id="content"></main>
    </div>
  </div>`;
}
function bindShell() {
  document.getElementById('signout').onclick = async () => { await S.logout(); location.hash = ''; forceRender(); };
  const sh = document.querySelector('.shell');
  document.getElementById('menu').onclick = () => sh.classList.toggle('nav-open');
  document.querySelectorAll('.nav a').forEach((a) => a.addEventListener('click', () => sh.classList.remove('nav-open')));
  document.getElementById('updates').onclick = () => {
    if (!confirm('Show the latest updates? Anything you have typed but not saved on this page will be cleared.')) return;
    forceRender();
  };
}
function updateStatusPill() {
  const el = document.getElementById('sync'); if (!el) return;
  const s = S.syncStatus();
  const map = { live: ['live', 'Live'], syncing: ['live', 'Live'], offline: ['off', 'Offline, retrying'], idle: ['', ''] };
  const [cls, label] = map[s] || map.idle;
  el.className = `sync ${cls}`;
  el.textContent = label;
}

// ================= boot & auth screens =================
function authFrame(inner, sub) {
  return `<div class="auth"><div class="auth-card">
    <div class="auth-mark">${LOGO}<div><h1>SOC Tracker</h1><div class="muted">${sub}</div></div></div>
    ${inner}
  </div></div>`;
}

function viewBootError() {
  const notInstalled = bootError.code === 'not_installed';
  $app.innerHTML = authFrame(`<div class="panel">
    <h2 style="margin-bottom:8px">${notInstalled ? 'The database is not set up yet' : "Can't reach the server"}</h2>
    <p class="muted">${notInstalled
      ? 'An admin needs to run <b>supabase/setup.sql</b> once in the Supabase SQL Editor. Then reload this page.'
      : esc(bootError.message) + ' If you are on the office network, the proxy may be blocking supabase.co.'}</p>
    <button class="primary" id="retry">Try again</button></div>`, 'Connection problem');
  document.getElementById('retry').onclick = () => { bootError = null; boot(); };
}

function viewSetup() {
  $app.innerHTML = authFrame(`
    <form id="setup" novalidate>
      <h2 style="margin-bottom:6px">Set up the tracker</h2>
      <p class="muted small">This creates the first admin account for the whole team. Everything your team adds is encrypted in the browser before it's saved, so the server only stores scrambled data.</p>
      <div class="field"><label for="code">Setup code</label><input id="code" autocomplete="off" placeholder="From the SQL Editor result"><div class="hint">Shown at the bottom of the result when the setup script ran in Supabase.</div></div>
      <div class="field"><label for="team">Team name</label><input id="team" value="SOC Team" maxlength="40"></div>
      <div class="field"><label for="dn">Your name</label><input id="dn" autocomplete="name"></div>
      <div class="field"><label for="un">Admin username</label><input id="un" autocomplete="username"></div>
      <div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="new-password">
        <div class="hint">At least 12 characters, mixing three of: lowercase, uppercase, numbers, symbols. There's no recovery: if every admin forgets their password, the data can't be decrypted.</div></div>
      <div class="field"><label for="pw2">Confirm password</label><input id="pw2" type="password" autocomplete="new-password"></div>
      <button class="primary" type="submit">Create admin and open tracker</button>
      <p class="error" id="err"></p>
    </form>`, 'First-time setup');
  const f = document.getElementById('setup');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById('err'); err.textContent = '';
    const v = (id) => document.getElementById(id).value;
    if (v('pw') !== v('pw2')) { err.textContent = 'The passwords do not match.'; return; }
    const btn = f.querySelector('button'); busy(btn, true, 'Encrypting…');
    try { await S.setup({ code: v('code'), username: v('un'), displayName: v('dn'), password: v('pw'), teamName: v('team') }); lastActivity = Date.now(); location.hash = '#/dashboard'; forceRender(); }
    catch (ex) { err.textContent = ex.message; busy(btn, false); }
  };
}

function viewLogin() {
  $app.innerHTML = authFrame(`
    <form id="login" novalidate>
      <div class="field"><label for="un">Username</label><input id="un" autocomplete="username"></div>
      <div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password"></div>
      <button class="primary" type="submit">Sign in</button>
      <p class="error" id="err"></p>
    </form>
    <div class="auth-foot">Forgot your password? Ask your team lead or admin to reset it.</div>
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
      forceRender();
    } catch (ex) { err.textContent = ex.message; busy(btn, false); document.getElementById('pw').select(); }
  };
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
    try { await S.changeOwnPassword(v('cur'), v('pw')); location.hash = '#/dashboard'; forceRender(); toast('Password saved.'); }
    catch (ex) { err.textContent = ex.message; busy(btn, false); }
  };
  document.getElementById('out').onclick = async (e) => { e.preventDefault(); await S.logout(); forceRender(); };
}

// ================= dashboard =================
function viewDashboard(el) {
  const d = S.data(); const me = S.currentUser();
  const w = currentWindow();
  const inWin = casesInWindow(w, false);
  const detectedInWin = d.cases.filter((c) => c.detectedAt >= w.start && c.detectedAt < w.end);
  const open = d.cases.filter((c) => c.status !== 'Closed').sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.detectedAt - b.detectedAt);
  const activeInc = d.incidents.filter((i) => i.status !== 'Closed').sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.declaredAt - a.declaredAt);
  const breaches = inWin.filter((c) => S.effectiveSla(c) === 'Y').length;
  const closedInWin = d.cases.filter((c) => c.closedAt >= w.start && c.closedAt < w.end).length;
  const now = Date.now();
  const pct = (t) => Math.max(0, Math.min(100, ((t - w.start) / (w.end - w.start)) * 100));
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
    ${unacked.length ? `<section aria-label="Notices to acknowledge" style="margin-bottom:16px">${unacked.map((n) => noticeCard(n)).join('')}</section>` : ''}
    ${activeInc.length ? `<section class="inc-strip" aria-label="Active incidents">
      <b>${activeInc.length} active incident${activeInc.length > 1 ? 's' : ''}</b>
      ${activeInc.slice(0, 4).map((i) => `<button type="button" class="inc-chip" data-incident="${i.id}"><span class="sev sev-${i.severity}"></span>${esc(i.ref)} ${esc(i.title)} ${incStatus(i.status)}</button>`).join('')}
      ${activeInc.length > 4 ? '<a href="#/incidents" class="small">All incidents</a>' : ''}
    </section>` : ''}
    <section class="window" aria-label="Current report window">
      <div class="window-head">
        <div><h2>Report window ${fmt(w.start)} to ${fmt(w.end)}</h2>
          <div class="muted small">${dur(w.end - now)} until the ${settings().reportCutoff} cutoff. Each dot is a case at its detection time.</div></div>
        <div class="window-stats">
          <div><b>${detectedInWin.length}</b>detected</div>
          <div><b>${open.length}</b>open now</div>
          <div><b class="${breaches ? 'warn' : ''}">${breaches}</b>SLA breaches</div>
          <div><b>${closedInWin}</b>closed</div>
          <div><b class="${activeInc.length ? 'warn' : ''}">${activeInc.length}</b>active incidents</div>
        </div>
      </div>
      <div class="track">
        <div class="track-bar"></div>
        <div class="track-elapsed" style="width:${pct(now)}%"></div>
        ${shiftMarks.map((s) => `<div class="track-shift" style="left:${pct(s.at)}%">${esc(s.label)}</div>`).join('')}
        <div class="track-now" style="left:${pct(now)}%"><span>Now ${hm(now)}</span></div>
        ${detectedInWin.map((c) => `<button type="button" class="pin bg-${c.severity} ${c.status === 'Closed' ? 'closed' : ''} ${c.incidentId ? 'inc' : ''}" style="left:${pct(c.detectedAt)}%" data-case="${c.id}" title="${esc(`${c.ref} ${c.name} (${c.severity}, ${c.status}) detected ${hm(c.detectedAt)}`)}" aria-label="${esc(`${c.name}, ${c.severity}, detected ${hm(c.detectedAt)}`)}"></button>`).join('')}
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
              <div class="ref">${esc(c.ref)}${c.template ? ` · ${esc(c.template.name)}` : ''} · open ${dur(now - c.detectedAt)}${c.escalatedTo ? ` · ${esc(c.escalatedTo)}` : ''} ${incidentBadge(c)}</div></div>
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
  const out = []; let any = false;
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

// ================= reports =================
const reportState = { date: ymd(new Date()), carry: true };
export function buildReport(dateStr, carry) {
  const w = windowEnding(dateStr);
  const rows = casesInWindow(w, carry).sort((a, b) => a.detectedAt - b.detectedAt).map((c) => ({
    ref: c.ref, name: c.name, escalatedTo: c.escalatedTo || '', severity: c.severity,
    detectedAt: c.detectedAt, reportedAt: c.reportedAt, ackAt: c.ackAt,
    sla: S.effectiveSla(c), status: statusAt(c, w.end),
    openedBy: S.userName(c.createdBy), closedBy: c.closedBy && c.closedAt < w.end ? S.userName(c.closedBy) : '',
    caseType: c.template?.name || '', incident: S.data().incidents.find((i) => i.id === c.incidentId)?.ref || '',
    carried: c.detectedAt < w.start, id: c.id,
  }));
  const incidents = incidentsInWindow(w, carry).filter((i) => i.declaredAt < w.end).sort((a, b) => a.declaredAt - b.declaredAt).map((i) => ({
    id: i.id, ref: i.ref, title: i.title, severity: i.severity, category: i.category, status: S.incidentStatusAt(i, w.end) || i.status,
    owner: S.userName(i.ownerId), declaredAt: i.declaredAt, containedAt: i.containedAt && i.containedAt < w.end ? i.containedAt : null,
    closedAt: i.closedAt && i.closedAt < w.end ? i.closedAt : null,
    cases: i.caseIds.map((cid) => S.data().cases.find((c) => c.id === cid)?.ref).filter(Boolean).join(', '),
    updates: i.log.filter((e) => e.at >= w.start && e.at < w.end).length,
  }));
  const handovers = S.data().handovers.filter((h) => h.createdAt >= w.start && h.createdAt < w.end).sort((a, b) => a.createdAt - b.createdAt)
    .map((h) => ({ ...h, authorName: S.userName(h.author) }));
  return { w, rows, incidents, handovers };
}
function viewReports(el) {
  const r = buildReport(reportState.date, reportState.carry);
  const sum = { total: r.rows.length, open: r.rows.filter((x) => x.status === 'WIP').length, closed: r.rows.filter((x) => x.status === 'Closed').length, breach: r.rows.filter((x) => x.sla === 'Y').length };
  const bySev = S.SEVERITIES.map((s) => `${r.rows.filter((x) => x.severity === s).length} ${s}`).join(', ');
  const partial = Date.now() < r.w.end;
  el.innerHTML = `
    <div class="toolbar" data-live>
      <div class="field"><label for="rd">Report for</label><input type="date" id="rd" value="${reportState.date}"></div>
      <div class="field"><label class="check" style="margin-top:22px"><input type="checkbox" id="rc" ${reportState.carry ? 'checked' : ''}> Include cases and incidents still open from earlier days</label></div>
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
      <p class="small">${sum.total} cases (${bySev}). ${sum.open} WIP, ${sum.closed} closed, <span class="${sum.breach ? 'sla-Y' : ''}">${sum.breach} SLA breaches</span>. ${r.incidents.length} incident${r.incidents.length === 1 ? '' : 's'}.</p>
      ${r.rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Case name</th><th>Escalated team or user</th><th>Severity</th><th>Detection</th><th>Reported</th><th>Acknowledgement</th><th>SLA breach</th><th>Status</th></tr></thead>
        <tbody>${r.rows.map((x, i) => `<tr>
          <td class="t">${i + 1}</td>
          <td><button type="button" class="case-name" data-case="${x.id}">${esc(x.name)}</button><div class="ref">${esc(x.ref)}${x.caseType ? ` · ${esc(x.caseType)}` : ''}${x.incident ? ` · ${esc(x.incident)}` : ''}${x.carried ? ' · carried over' : ''}</div></td>
          <td>${esc(x.escalatedTo) || '—'}</td><td><span class="sev sev-${x.severity}">${x.severity}</span></td>
          <td class="t">${fmt(x.detectedAt)}</td><td class="t">${fmt(x.reportedAt)}</td><td class="t">${fmt(x.ackAt)}</td>
          <td class="sla-${x.sla}">${x.sla}</td><td><span class="status status-${x.status}">${x.status}</span></td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No cases in this window.</div>'}
      ${r.incidents.length ? `<h3 style="margin:20px 0 8px">Incidents</h3><div class="table-wrap"><table>
        <thead><tr><th>Incident</th><th>Severity</th><th>Category</th><th>Status at cutoff</th><th>Owner</th><th>Declared</th><th>Linked cases</th></tr></thead>
        <tbody>${r.incidents.map((x) => `<tr><td><button type="button" class="case-name" data-incident="${x.id}">${esc(x.title)}</button><div class="ref">${esc(x.ref)}</div></td>
          <td><span class="sev sev-${x.severity}">${x.severity}</span></td><td>${esc(x.category)}</td><td>${incStatus(x.status)}</td><td>${esc(x.owner)}</td><td class="t">${fmt(x.declaredAt)}</td><td class="small">${esc(x.cases) || '—'}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${r.handovers.length ? `<h3 style="margin:20px 0 6px">Handovers in this window</h3><div class="list">${r.handovers.map((h) => `<div class="list-item"><div class="meta"><b style="color:var(--text)">${S.SHIFT_LABELS[h.shift]}</b>${esc(h.authorName)}, ${fmt(h.createdAt)}</div><div class="body">${esc(h.body)}</div></div>`).join('')}</div>` : ''}
    </section>`;
  el.querySelector('#rd').oninput = (e) => { if (e.target.value) { reportState.date = e.target.value; forceRender(); } };
  el.querySelector('#rc').oninput = (e) => { reportState.carry = e.target.checked; forceRender(); };
  const meta = () => ({ team: settings().teamName, by: S.currentUser().displayName, at: Date.now() });
  el.querySelector('#dlx').onclick = () => { downloadReportXlsx(r, meta()); S.addAudit('report.download', `Downloaded daily report ending ${fmt(r.w.end)}`); };
  el.querySelector('#dlc').onclick = () => { downloadReportCsv(r, meta(), download); };
  el.querySelector('#prt').onclick = () => print();
  el.querySelectorAll('[data-incident]').forEach((b) => (b.onclick = () => incidentDetail(b.dataset.incident)));
  bindCaseLinks(el);
}

// ================= audit =================
let auditQ = '';
let auditCache = null;
function viewAudit(el) {
  el.innerHTML = `<div class="toolbar" data-live><div class="field grow"><label for="aq">Search</label><input id="aq" type="search" value="${esc(auditQ)}" placeholder="Person, action or detail"></div>
    <button id="ar">Refresh</button><button id="ax">Export CSV</button></div><div id="alist"><div class="panel empty">Loading the audit log…</div></div>
    <p class="small faint" style="margin-top:8px">Sign-ins, failed sign-ins and account changes are recorded by the database itself and can't be edited from the app.</p>`;
  const draw = () => {
    const host = el.querySelector('#alist'); if (!host || !auditCache) return;
    const q = auditQ.toLowerCase();
    const rows = auditCache.filter((a) => !q || `${a.by} ${a.action} ${a.detail}`.toLowerCase().includes(q));
    host.innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
      <tbody>${rows.slice(0, 500).map((a) => `<tr><td class="t">${fmt(a.at)}</td><td>${esc(a.by)}</td><td><span class="tag ${a.server ? 'kind-srv' : ''}">${esc(a.action)}</span></td><td>${esc(a.detail)}</td></tr>`).join('')}</tbody></table></div>
      <p class="small faint" style="margin-top:8px">${rows.length} entries${rows.length > 500 ? ', showing the latest 500' : ''}.</p>` : '<div class="panel empty">No matching entries.</div>';
  };
  const load = async () => { auditCache = await S.listAudit().catch((e) => { toast(e.message, true); return []; }); draw(); };
  el.querySelector('#aq').oninput = (e) => { auditQ = e.target.value; draw(); };
  el.querySelector('#ar').onclick = load;
  el.querySelector('#ax').onclick = () => {
    if (!auditCache) return;
    const lines = [['When', 'Who', 'Action', 'Detail'], ...auditCache.map((a) => [fmt(a.at), a.by, a.action, a.detail])];
    download(`audit-log-${ymd(new Date())}.csv`, lines.map((l) => l.map(csvCell).join(',')).join('\r\n'), 'text/csv');
  };
  if (auditCache) draw();
  load();
}

// ================= handover =================
let handoverFilter = '';
let handoverDraft = '';
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
          <div class="field"><label for="hb">Notes for the next shift</label><textarea id="hb" style="min-height:160px" maxlength="8000" placeholder="What's in progress, who you're waiting on, anything to watch">${esc(handoverDraft)}</textarea></div>
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
    if (ok) { handoverDraft = ''; forceRender(); }
  };
  el.querySelector('#hb').addEventListener('input', (e) => { handoverDraft = e.target.value; });
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
  root.querySelectorAll('[data-hread]').forEach((b) => (b.onclick = () => guard(() => S.markHandoverRead(b.dataset.hread))));
  root.querySelectorAll('[data-hdel]').forEach((b) => (b.onclick = async () => { if (confirm('Delete this handover?')) await guard(() => S.deleteHandover(b.dataset.hdel), 'Handover deleted.'); }));
  root.querySelectorAll('[data-hedit]').forEach((b) => (b.onclick = () => {
    const h = S.data().handovers.find((x) => x.id === b.dataset.hedit);
    openModal({
      title: 'Edit handover',
      body: `<div class="field-row"><div class="field"><label for="ed">Date</label><input type="date" id="ed" value="${h.date}"></div>
        <div class="field"><label for="es">Shift</label><select id="es"><option value="M" ${h.shift === 'M' ? 'selected' : ''}>Morning</option><option value="A" ${h.shift === 'A' ? 'selected' : ''}>Afternoon</option></select></div></div>
        <div class="field"><label for="eb">Notes</label><textarea id="eb" style="min-height:200px">${esc(h.body)}</textarea></div><p class="error"></p>`,
      foot: '<button type="button" data-close>Cancel</button><button class="primary" type="submit">Save changes</button>',
      onSubmit: async (f) => { await S.saveHandover({ id: h.id, date: f.querySelector('#ed').value, shift: f.querySelector('#es').value, body: f.querySelector('#eb').value }); toast('Handover saved.'); },
    });
  }));
}

// ================= notices =================
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
  root.querySelectorAll('[data-ack]').forEach((b) => (b.onclick = () => guard(() => S.ackNotice(b.dataset.ack))));
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
  el.querySelectorAll('[data-ndel]').forEach((b) => (b.onclick = async () => { if (confirm('Remove this notice?')) await guard(() => S.deleteNotice(b.dataset.ndel), 'Notice removed.'); }));
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
      toast(n ? 'Notice saved.' : 'Notice posted.');
    },
  });
}

// ================= schedule =================
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

  const go = (dm) => { const d = new Date(schedState.y, schedState.m + dm, 1); schedState.y = d.getFullYear(); schedState.m = d.getMonth(); forceRender(); };
  el.querySelector('#prev').onclick = () => go(-1);
  el.querySelector('#next').onclick = () => go(1);
  el.querySelector('#thism').onclick = () => { schedState.y = today.getFullYear(); schedState.m = today.getMonth(); forceRender(); };
  el.querySelector('#exp').onclick = () => { if (!month.rows.length) return toast('Nothing to export for this month.', true); exportScheduleXlsx(month, schedState.y, schedState.m, settings().teamName); };
  if (!canEdit) return;
  el.querySelector('#edit').onclick = () => { schedState.edit = !schedState.edit; forceRender(); };
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
    if (await guard(() => S.saveMonth(key, { rows }, `Copied previous month's schedule into ${key}`), 'Copied. Shifts line up with the same weekdays four weeks earlier.')) forceRender();
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
        toast('Schedule imported.');
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
    if (await guard(() => S.saveMonth(key, month, `Removed ${r.name} from ${key}`))) forceRender();
  }));
  const add = async () => {
    const name = el.querySelector('#newrow').value.trim(); if (!name) return;
    if (month.rows.some((r) => r.name.toLowerCase() === name.toLowerCase())) return toast(`${name} is already on this month.`, true);
    const u = S.data().users.find((x) => x.displayName.toLowerCase() === name.toLowerCase());
    month.rows.push({ name, userId: u?.id || null, cells: {} });
    if (await guard(() => S.saveMonth(key, month, `Added ${name} to ${key}`))) { forceRender(); document.getElementById('newrow')?.focus(); }
  };
  el.querySelector('#addrow').onclick = add;
  el.querySelector('#newrow').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
}

// ================= reports =================
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
          <td class="t">${fmt(u.createdAt)}<div class="faint small">${esc(u.createdBy ? S.userName(u.createdBy) : 'setup')}</div></td>
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
      onSubmit: async (f) => { const pw = f.querySelector('#tp').value; await S.resetPassword(u.id, pw); showCredentials(u.username, pw, 'Password reset'); return true; },
    });
  }));
  el.querySelectorAll('[data-udisable]').forEach((b) => (b.onclick = async () => {
    const u = S.data().users.find((x) => x.id === b.dataset.udisable);
    if (!confirm(`Disable ${u.displayName}? Their password stops working right away. Their cases and notes stay.`)) return;
    await guard(() => S.updateUser(u.id, { disabled: true }), `${u.displayName} disabled.`);
  }));
  el.querySelectorAll('[data-uenable]').forEach((b) => (b.onclick = () => {
    const u = S.data().users.find((x) => x.id === b.dataset.uenable);
    const temp = generateTempPassword();
    openModal({
      title: `Enable ${esc(u.displayName)}`,
      body: `<p>Re-enabling needs a new temporary password, because disabling removed the old one.</p><div class="field"><label for="tp">Temporary password</label><input id="tp" value="${esc(temp)}"></div><p class="error"></p>`,
      foot: '<button type="button" data-close>Cancel</button><button class="primary" type="submit">Enable account</button>',
      onSubmit: async (f) => { const pw = f.querySelector('#tp').value; await S.enableUserWithPassword(u.id, pw); showCredentials(u.username, pw, 'Account enabled'); return true; },
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
        toast('User saved.'); return;
      }
      const pw = f.querySelector('#up').value;
      const nu = await S.createUser({ username: f.querySelector('#uu').value, displayName: f.querySelector('#ud').value, role: f.querySelector('#ur').value, password: pw });
      showCredentials(nu.username, pw, `${S.ROLES[nu.role]} account added`);
      return true;
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
    }), 'Settings saved.')) forceRender();
  };
}

// ================= backup & sync =================
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


// ================= boot =================
async function boot() {
  $app.innerHTML = '<div class="auth"><div class="muted">Connecting…</div></div>';
  try { await S.loadConfig(); } catch (e) { bootError = e; render(); return; }
  if (S.isInitialized()) await S.resume();
  lastActivity = Date.now();
  render();
}
boot();
