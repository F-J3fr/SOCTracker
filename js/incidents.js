// Incident tracker: list, declare (optionally from a case), detail with log, lifecycle.
import * as S from './store.js';
import { esc, fmt, toInput, fromInput, dur, SEV_RANK, toast, guard, openModal, closeModal } from './ui.js';
import { caseDetail } from './cases.js';

export const incFilters = { q: '', status: 'active', severity: '', category: '' };
const STATUS_CLASS = { Open: 'inc-open', Contained: 'inc-contained', Eradicated: 'inc-contained', Recovered: 'inc-recovered', Closed: 'Closed' };
export const incStatus = (s) => `<span class="status status-${STATUS_CLASS[s] || 'inc-open'}">${esc(s)}</span>`;

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
  const v = inc || {
    title: fromCase?.name || '', severity: fromCase?.severity || 'High', category: 'Other', ownerId: S.currentUser().id,
    summary: fromCase?.notes || '', affectedAssets: '', startedAt: fromCase?.detectedAt || Date.now(), rootCause: '', lessonsLearned: '',
  };
  openModal({
    title: inc ? `Edit ${esc(inc.ref)}` : fromCase ? `Declare incident from ${esc(fromCase.ref)}` : 'Declare incident',
    width: '760px',
    body: `
      <div class="field"><label for="it">Incident title<span class="req">*</span></label><input id="it" maxlength="160" value="${esc(v.title)}"></div>
      <div class="field-row">
        <div class="field"><label for="isv">Severity<span class="req">*</span></label><select id="isv">${S.SEVERITIES.map((s) => `<option ${s === v.severity ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="field"><label for="ict">Category</label><select id="ict">${S.INCIDENT_CATEGORIES.map((s) => `<option ${s === v.category ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="field"><label for="io">Owner</label><select id="io">${ownerOptions(v.ownerId)}</select></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="ist">Incident start</label><div class="with-now"><input type="datetime-local" id="ist" value="${toInput(v.startedAt)}"><button type="button" class="sm" data-now="ist">Now</button></div>
          <div class="hint">When the activity began. Defaults to the case's detection time.</div></div>
      </div>
      <div class="field"><label for="isum">Summary and impact</label><textarea id="isum" maxlength="8000" placeholder="What happened, who and what is affected">${esc(v.summary)}</textarea></div>
      <div class="field"><label for="ias">Affected assets</label><textarea id="ias" maxlength="4000" style="min-height:64px" placeholder="Hosts, accounts, applications">${esc(v.affectedAssets)}</textarea></div>
      ${inc ? `<div class="field"><label for="irc">Root cause</label><textarea id="irc" maxlength="8000">${esc(v.rootCause)}</textarea></div>
        <div class="field"><label for="ill">Lessons learned</label><textarea id="ill" maxlength="8000">${esc(v.lessonsLearned)}</textarea></div>` : ''}
      ${fromCase ? `<p class="small muted">${esc(fromCase.ref)} will be linked to this incident.</p>` : ''}
      <p class="error"></p>`,
    foot: `<button type="button" data-close>Cancel</button><button class="primary" type="submit">${inc ? 'Save changes' : 'Declare incident'}</button>`,
    onMount: (f) => f.querySelectorAll('[data-now]').forEach((b) => (b.onclick = () => { f.querySelector('#' + b.dataset.now).value = toInput(Date.now()); })),
    onSubmit: async (f) => {
      const g = (id) => f.querySelector('#' + id)?.value;
      const data = { title: g('it'), severity: g('isv'), category: g('ict'), ownerId: g('io'), startedAt: fromInput(g('ist')) || Date.now(), summary: g('isum'), affectedAssets: g('ias') };
      if (inc) {
        await S.updateIncident(inc.id, { ...data, rootCause: g('irc'), lessonsLearned: g('ill') });
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
  const next = stages[idx + 1];
  openModal({
    title: esc(i.ref),
    width: '820px',
    body: `
      <h2 style="margin-bottom:12px">${esc(i.title)}</h2>
      <ol class="stages" aria-label="Incident lifecycle">${stages.map((s, n) => `<li class="${n < idx ? 'done' : n === idx ? 'now' : ''}">${s}</li>`).join('')}</ol>
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
      ${i.status === 'Closed' ? '<button type="button" id="ireopen">Reopen</button>' : ''}
      ${next ? `<button type="button" class="primary" id="inext">Mark ${next.toLowerCase()}</button>` : ''}`,
    onMount: (f) => {
      f.querySelectorAll('[data-case]').forEach((b) => (b.onclick = () => caseDetail(b.dataset.case)));
      f.querySelector('#add-log').onclick = async () => { if (await guard(() => S.addIncidentLog(id, f.querySelector('#ilog').value), 'Added to the log.')) incidentDetail(id); };
      f.querySelector('#iedit').onclick = () => incidentForm(i);
      f.querySelector('#inext')?.addEventListener('click', () => statusForm(i, next));
      f.querySelector('#ireopen')?.addEventListener('click', () => statusForm(i, 'Open'));
      f.querySelector('#idel')?.addEventListener('click', async () => {
        if (!confirm(`Delete ${i.ref}? Linked cases stay, but lose the link. The deletion is kept in the audit log.`)) return;
        if (await guard(() => S.deleteIncident(id), 'Incident deleted.')) closeModal();
      });
    },
  });
}

function statusForm(i, status) {
  const closing = status === 'Closed';
  openModal({
    title: `${esc(i.ref)}: ${closing ? 'close incident' : `mark ${status.toLowerCase()}`}`,
    body: `
      ${closing ? `<p class="small muted">Closing needs a summary and the root cause. Lessons learned are optional.</p>
        <div class="field"><label for="ssum">Summary and impact<span class="req">*</span></label><textarea id="ssum">${esc(i.summary)}</textarea></div>
        <div class="field"><label for="src">Root cause<span class="req">*</span></label><textarea id="src">${esc(i.rootCause)}</textarea></div>
        <div class="field"><label for="sll">Lessons learned</label><textarea id="sll">${esc(i.lessonsLearned)}</textarea></div>` : ''}
      <div class="field"><label for="snote">Note for the log${closing ? '' : ' (optional)'}</label><textarea id="snote" placeholder="${status === 'Contained' ? 'e.g. Host isolated, account disabled' : 'What changed'}"></textarea></div>
      <p class="error"></p>`,
    foot: `<button type="button" data-close>Cancel</button><button class="primary" type="submit">${closing ? 'Close incident' : `Mark ${status.toLowerCase()}`}</button>`,
    onSubmit: async (f) => {
      const patch = closing ? { summary: f.querySelector('#ssum').value.trim(), rootCause: f.querySelector('#src').value.trim(), lessonsLearned: f.querySelector('#sll').value.trim() } : {};
      await S.setIncidentStatus(i.id, status, f.querySelector('#snote').value, patch);
      toast(`${i.ref} is now ${status.toLowerCase()}.`);
      setTimeout(() => incidentDetail(i.id), 0);
    },
  });
}
