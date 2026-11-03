// Incident tracker: list, declare (optionally from a case), detail with log, lifecycle.
import * as S from './store.js';
import { esc, fmt, toInput, fromInput, dur, SEV_RANK, toast, guard, openModal, closeModal } from './ui.js';
import { caseDetail } from './cases.js';

export const incFilters = { q: '', status: 'active', severity: '', category: '' };
const STATUS_CLASS = { Open: 'inc-open', Contained: 'inc-contained', Eradicated: 'inc-contained', Recovered: 'inc-recovered', Closed: 'Closed' };
export const incStatus = (s) => `<span class="status status-${STATUS_CLASS[s] || 'inc-open'}">${esc(s)}</span>`;

/** Stage dropdown used on the incident and on every case escalated to it. */
export function stageControl(i, idPrefix = 'stg') {
  return `<div class="stage-ctl">
    <label for="${idPrefix}-sel">Incident stage</label>
    <div class="with-now">
      <select id="${idPrefix}-sel">${S.INCIDENT_STATUSES.map((s) => `<option ${s === i.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <button type="button" class="sm primary" id="${idPrefix}-go" disabled>Change stage</button>
    </div>
    <div class="hint">Every change needs a note explaining why.</div>
  </div>`;
}
export function bindStageControl(root, i, idPrefix = 'stg', after = () => incidentDetail(i.id)) {
  const sel = root.querySelector(`#${idPrefix}-sel`);
  const go = root.querySelector(`#${idPrefix}-go`);
  if (!sel || !go) return;
  sel.addEventListener('change', () => { go.disabled = sel.value === i.status; });
  go.addEventListener('click', () => statusForm(i, sel.value, after));
}
export function lastStageChange(i) {
  return [...i.log].filter((e) => e.kind === 'status').sort((a, b) => b.at - a.at)[0] || null;
}

export function viewIncidents(el) {
  el.innerHTML = `
    <div class="toolbar" data-live>
      <div class="field grow"><label for="iq">Search</label><input id="iq" type="search" placeholder="Title, reference, assets, summary"></div>
      <div class="field"><label for="is">Status</label><select id="is"><option value="active">Active (not closed)</option>${S.INCIDENT_STATUSES.map((s) => `<option>${s}</option>`).join('')}<option value="">All</option></select></div>
      <div class="field"><label for="iv">Severity</label><select id="iv"><option value="">All</option>${S.SEVERITIES.map((s) => `<option>${s}</option>`).join('')}</select></div>
      <div class="field"><label for="ic">Category</label><select id="ic"><option value="">All</option>${S.INCIDENT_CATEGORIES.map((s) => `<option>${s}</option>`).join('')}</select></div>
      <button class="primary" id="new-inc">Declare incident</button>
    </div>
    <div id="inc-table"></div>`;
  const set = (id, key) => { const i = el.querySelector(id); i.value = incFilters[key]; i.addEventListener('input', () => { incFilters[key] = i.value; draw(); }); };
  set('#iq', 'q'); set('#is', 'status'); set('#iv', 'severity'); set('#ic', 'category');
  el.querySelector('#new-inc').onclick = () => incidentForm();
  draw();
}

function draw() {
  const host = document.getElementById('inc-table'); if (!host) return;
  const f = incFilters; const q = f.q.trim().toLowerCase();
  const rows = S.data().incidents.filter((i) =>
    (f.status === '' || (f.status === 'active' ? i.status !== 'Closed' : i.status === f.status)) &&
    (!f.severity || i.severity === f.severity) && (!f.category || i.category === f.category) &&
    (!q || [i.title, i.ref, i.summary, i.affectedAssets, i.rootCause].some((x) => (x || '').toLowerCase().includes(q))))
    .sort((a, b) => (a.status === 'Closed') - (b.status === 'Closed') || SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.declaredAt - a.declaredAt);
  if (!rows.length) {
    host.innerHTML = S.data().incidents.length
      ? '<div class="panel empty">No incidents match these filters. Set Status to All to see closed ones.</div>'
      : '<div class="panel empty"><b>No incidents.</b> Declare one here, or open a case and select Escalate to incident.</div>';
    return;
  }
  host.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Incident</th><th>Severity</th><th>Category</th><th>Status</th><th>Owner</th><th>Declared</th><th>Duration</th><th>Cases</th></tr></thead>
    <tbody>${rows.map((i) => `<tr>
      <td><button type="button" class="case-name" data-incident="${i.id}">${esc(i.title)}</button><div class="ref">${esc(i.ref)}</div></td>
      <td><span class="sev sev-${i.severity}">${i.severity}</span></td>
      <td>${esc(i.category)}</td><td>${incStatus(i.status)}</td>
      <td>${esc(S.userName(i.ownerId))}</td>
      <td class="t">${fmt(i.declaredAt)}</td>
      <td class="t">${dur((i.closedAt || Date.now()) - i.startedAt)}</td>
      <td class="t">${i.caseIds.length}</td>
    </tr>`).join('')}</tbody></table></div>`;
  host.querySelectorAll('[data-incident]').forEach((b) => (b.onclick = () => incidentDetail(b.dataset.incident)));
}

function ownerOptions(sel) {
  return S.data().users.filter((u) => !u.disabled || u.id === sel).map((u) => `<option value="${u.id}" ${u.id === sel ? 'selected' : ''}>${esc(u.displayName)}</option>`).join('');
}

/** Declare (inc = null) or edit an incident. fromCase pre-fills and links the case. */
export function incidentForm(inc = null, fromCase = null) {
  const lead = S.canEditLocked();
  const locked = !!inc && !lead;
  const v = inc || {
    title: fromCase?.name || '', severity: fromCase?.severity || 'High', category: 'Other', ownerId: S.currentUser().id,
    summary: fromCase?.notes || '', affectedAssets: '', startedAt: fromCase?.detectedAt || Date.now(), rootCause: '', lessonsLearned: '',
  };
  openModal({
    title: inc ? `Edit ${esc(inc.ref)}` : fromCase ? `Declare incident from ${esc(fromCase.ref)}` : 'Declare incident',
    width: '760px',
    body: `
      ${locked ? `<div class="field"><label for="it">Incident title <span class="lock">locked</span></label><input id="it" value="${esc(v.title)}" disabled></div>`
        : inc ? `<div class="field"><label for="it">Incident title<span class="req">*</span></label><input id="it" maxlength="160" value="${esc(v.title)}"><div class="hint">Locked for analysts. Changes to the title, owner and start time are recorded in the incident log.</div></div>`
        : `<div class="field"><label for="it">Incident title<span class="req">*</span></label><input id="it" maxlength="160" value="${esc(v.title)}"><div class="hint">The title, owner and start time can't be changed once the incident is declared.</div></div>`}
      <div class="field-row">
        <div class="field"><label for="isv">Severity<span class="req">*</span></label><select id="isv">${S.SEVERITIES.map((s) => `<option ${s === v.severity ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="field"><label for="ict">Category</label><select id="ict">${S.INCIDENT_CATEGORIES.map((s) => `<option ${s === v.category ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="field"><label for="io">Owner${locked ? ' <span class="lock">locked</span>' : ''}</label><select id="io" ${locked ? 'disabled' : ''}>${ownerOptions(v.ownerId)}</select></div>
      </div>
      <div class="field-row">
        ${locked ? `<div class="field"><label for="ist">Incident start <span class="lock">locked</span></label><input type="datetime-local" id="ist" value="${toInput(v.startedAt)}" disabled></div>`
          : `<div class="field"><label for="ist">Incident start</label><div class="with-now"><input type="datetime-local" id="ist" value="${toInput(v.startedAt)}"><button type="button" class="sm" data-now="ist">Now</button></div>
          <div class="hint">When the activity began. Defaults to the case's detection time.</div></div>`}
      </div>
      ${inc && lead ? `<div class="field hidden" id="ownr-wrap"><label for="ownr">Reason for reassigning the owner<span class="req">*</span></label><textarea id="ownr" style="min-height:64px" placeholder="e.g. Ahmed is on annual leave from tomorrow, Sara takes over"></textarea><div class="hint">Saved to the incident log.</div></div>` : ''}
      <div class="field"><label for="isum">Summary and impact</label><textarea id="isum" maxlength="8000" placeholder="What happened, who and what is affected">${esc(v.summary)}</textarea></div>
      <div class="field"><label for="ias">Affected assets</label><textarea id="ias" maxlength="4000" style="min-height:64px" placeholder="Hosts, accounts, applications">${esc(v.affectedAssets)}</textarea></div>
      ${inc ? `<div class="field"><label for="irc">Root cause</label><textarea id="irc" maxlength="8000">${esc(v.rootCause)}</textarea></div>
        <div class="field"><label for="ill">Lessons learned</label><textarea id="ill" maxlength="8000">${esc(v.lessonsLearned)}</textarea></div>` : ''}
      ${fromCase ? `<p class="small muted">${esc(fromCase.ref)} will be linked to this incident.</p>` : ''}
      <p class="error"></p>`,
    foot: `<button type="button" data-close>Cancel</button><button class="primary" type="submit">${inc ? 'Save changes' : 'Declare incident'}</button>`,
    onMount: (f) => {
      f.querySelectorAll('[data-now]').forEach((b) => (b.onclick = () => { f.querySelector('#' + b.dataset.now).value = toInput(Date.now()); }));
      const io = f.querySelector('#io'); const wrap = f.querySelector('#ownr-wrap');
      if (inc && wrap) io.addEventListener('change', () => wrap.classList.toggle('hidden', io.value === inc.ownerId));
    },
    onSubmit: async (f) => {
      const g = (id) => f.querySelector('#' + id)?.value;
      const data = { title: g('it'), severity: g('isv'), category: g('ict'), ownerId: g('io'), startedAt: fromInput(g('ist')) || Date.now(), summary: g('isum'), affectedAssets: g('ias') };
      if (inc) {
        const patch = { severity: data.severity, category: data.category, summary: data.summary, affectedAssets: data.affectedAssets, rootCause: g('irc'), lessonsLearned: g('ill') };
        if (lead) Object.assign(patch, { title: data.title, ownerId: data.ownerId, startedAt: data.startedAt });
        await S.updateIncident(inc.id, patch, g('ownr') || '');
        toast(`${inc.ref} saved.`);
        setTimeout(() => incidentDetail(inc.id), 0);
      } else {
        const saved = await S.createIncident(data, fromCase ? [fromCase.id] : []);
        toast(`${saved.ref} declared.`);
        setTimeout(() => incidentDetail(saved.id), 0);
      }
    },
  });
}

export function incidentDetail(id) {
  const i = S.data().incidents.find((x) => x.id === id);
  if (!i) { toast('That incident no longer exists.', true); return; }
  const cases = i.caseIds.map((cid) => S.data().cases.find((c) => c.id === cid)).filter(Boolean);
  const stages = S.INCIDENT_STATUSES;
  const idx = stages.indexOf(i.status);
  openModal({
    title: esc(i.ref),
    width: '820px',
    body: `
      <h2 style="margin-bottom:12px">${esc(i.title)}</h2>
      <ol class="stages" aria-label="Incident lifecycle">${stages.map((s, n) => `<li class="${n < idx ? 'done' : n === idx ? 'now' : ''}">${s}</li>`).join('')}</ol>
      ${stageControl(i, 'istg')}
      <dl class="kv">
        <dt>Severity</dt><dd><span class="sev sev-${i.severity}">${i.severity}</span></dd>
        <dt>Category</dt><dd>${esc(i.category)}</dd>
        <dt>Owner</dt><dd>${esc(S.userName(i.ownerId))}</dd>
        <dt>Declared</dt><dd>${fmt(i.declaredAt)} by ${esc(S.userName(i.declaredBy))}</dd>
        <dt>Started</dt><dd>${fmt(i.startedAt)}</dd>
        ${i.containedAt ? `<dt>Contained</dt><dd>${fmt(i.containedAt)} <span class="small muted">(${dur(i.containedAt - i.startedAt)} after start)</span></dd>` : ''}
        ${i.recoveredAt ? `<dt>Recovered</dt><dd>${fmt(i.recoveredAt)}</dd>` : ''}
        ${i.closedAt ? `<dt>Closed</dt><dd>${fmt(i.closedAt)} by ${esc(S.userName(i.closedBy))}</dd>` : ''}
      </dl>
      ${[['Summary and impact', i.summary], ['Affected assets', i.affectedAssets], ['Root cause', i.rootCause], ['Lessons learned', i.lessonsLearned]].filter(([, t]) => t).map(([h, t]) => `<h3 style="margin-bottom:6px">${h}</h3><div class="body" style="white-space:pre-wrap;margin-bottom:14px;overflow-wrap:anywhere">${esc(t)}</div>`).join('')}
      <h3 style="margin-bottom:8px">Linked cases</h3>
      ${cases.length ? `<div style="margin-bottom:14px">${cases.map((c) => `<div class="open-case-row"><span class="sev sev-${c.severity}">${c.severity}</span><div><button type="button" class="case-name" data-case="${c.id}">${esc(c.name)}</button><div class="ref">${esc(c.ref)} · ${c.status}</div></div><span></span></div>`).join('')}</div>` : '<p class="small muted">No cases linked. Open a case and select Escalate to incident to add one.</p>'}
      <h3 style="margin-bottom:8px">Incident log</h3>
      <div class="timeline">${[...i.log].sort((a, b) => a.at - b.at).map((e) => `<div class="${e.kind === 'note' ? 'c' : ''}"><span class="faint small">${fmt(e.at)} · ${esc(S.userName(e.by))}</span><div style="white-space:pre-wrap">${esc(e.text)}</div></div>`).join('')}</div>
      <div class="field" style="margin-top:8px"><label for="ilog">Log an action or update</label><textarea id="ilog" placeholder="e.g. Blocked sender domain on the mail gateway"></textarea></div>
      <button type="button" class="sm" id="add-log">Add to log</button>`,
    foot: `${S.can.deleteIncidents() ? '<button type="button" class="danger left" id="idel">Delete</button>' : ''}
      <button type="button" id="iedit">Edit</button>
`,
    onMount: (f) => {
      f.querySelectorAll('[data-case]').forEach((b) => (b.onclick = () => caseDetail(b.dataset.case)));
      f.querySelector('#add-log').onclick = async () => { if (await guard(() => S.addIncidentLog(id, f.querySelector('#ilog').value), 'Added to the log.')) incidentDetail(id); };
      f.querySelector('#iedit').onclick = () => incidentForm(i);
      bindStageControl(f, i, 'istg');
      f.querySelector('#idel')?.addEventListener('click', async () => {
        if (!confirm(`Delete ${i.ref}? Linked cases stay, but lose the link. The deletion is kept in the audit log.`)) return;
        if (await guard(() => S.deleteIncident(id), 'Incident deleted.')) closeModal();
      });
    },
  });
}

function statusForm(i, status, after = () => incidentDetail(i.id)) {
  const closing = status === 'Closed';
  const back = S.INCIDENT_STATUSES.indexOf(status) < S.INCIDENT_STATUSES.indexOf(i.status);
  openModal({
    title: `${esc(i.ref)}: ${esc(i.status)} to ${esc(status)}`,
    body: `
      ${back ? `<p class="small" style="color:var(--sev-medium)">This moves the incident back a stage. The times recorded for later stages are cleared, and the log keeps the full history.</p>` : ''}
      <div class="field"><label for="snote">Reason for the change<span class="req">*</span></label>
        <textarea id="snote" placeholder="${status === 'Contained' ? 'e.g. Host isolated in EDR and the account disabled at 14:20' : status === 'Eradicated' ? 'e.g. Malware removed, persistence keys deleted, IOC sweep clean' : status === 'Recovered' ? 'e.g. Host reimaged and back in production, monitoring for 48 hours' : status === 'Closed' ? 'e.g. No further activity after 48 hours of monitoring' : 'e.g. New activity seen from the same source'}"></textarea>
        <div class="hint">Saved to the incident log with your name and the time.</div></div>
      ${closing ? `<p class="small muted">Closing also needs a summary and the root cause. Lessons learned are optional.</p>
        <div class="field"><label for="ssum">Summary and impact<span class="req">*</span></label><textarea id="ssum">${esc(i.summary)}</textarea></div>
        <div class="field"><label for="src">Root cause<span class="req">*</span></label><textarea id="src">${esc(i.rootCause)}</textarea></div>
        <div class="field"><label for="sll">Lessons learned</label><textarea id="sll">${esc(i.lessonsLearned)}</textarea></div>` : ''}
      <p class="error"></p>`,
    foot: `<button type="button" data-close>Cancel</button><button class="primary" type="submit">Move to ${esc(status.toLowerCase())}</button>`,
    onSubmit: async (f) => {
      const note = f.querySelector('#snote').value.trim();
      if (!note) throw new Error('Write a note explaining why the stage is changing.');
      const patch = closing ? { summary: f.querySelector('#ssum').value.trim(), rootCause: f.querySelector('#src').value.trim(), lessonsLearned: f.querySelector('#sll').value.trim() } : {};
      await S.setIncidentStatus(i.id, status, note, patch);
      toast(`${i.ref} moved to ${status.toLowerCase()}.`);
      setTimeout(after, 0);
    },
  });
}
