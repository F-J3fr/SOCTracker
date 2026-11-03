// Case tracker: list, form (with case templates), detail, closing, escalation to incident.
import * as S from './store.js';
import { esc, fmt, toInput, fromInput, dur, SEV_RANK, toast, guard, openModal, closeModal, refresh, fieldInput, readFields, fieldDisplay, requiredMark } from './ui.js';
import { incidentForm, incidentDetail, incStatus, stageControl, bindStageControl, lastStageChange } from './incidents.js';

const ESCALATION_SUGGESTIONS = ['IT Infrastructure', 'Network Team', 'Fraud Team', 'Application Support', 'IAM Team', 'Service Desk', 'Third-party vendor'];
const SOURCE_SUGGESTIONS = ['SIEM', 'EDR', 'Email gateway', 'Firewall / IPS', 'User report', 'Threat intel', 'Fraud monitoring', 'Vulnerability scan'];

export const caseFilters = { q: '', status: 'open', severity: '', sla: '', type: '', sort: 'priority' };

export function bindCaseLinks(root) {
  root.querySelectorAll('[data-case]').forEach((b) => b.addEventListener('click', () => caseDetail(b.dataset.case)));
  root.querySelectorAll('[data-incident]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); incidentDetail(b.dataset.incident); }));
}

export function incidentBadge(c) {
  if (!c.incidentId) return '';
  const inc = S.data().incidents.find((i) => i.id === c.incidentId);
  if (!inc) return '';
  return `<button type="button" class="inc-badge" data-incident="${inc.id}" title="Escalated to incident ${esc(inc.ref)}">${esc(inc.ref)}</button>`;
}

export function viewCases(el) {
  const tpls = [...S.data().templates].sort((a, b) => a.name.localeCompare(b.name));
  el.innerHTML = `
    <div class="toolbar" data-live>
      <div class="field grow"><label for="q">Search</label><input id="q" type="search" placeholder="Case name, reference, team, notes" value=""></div>
      <div class="field"><label for="fs">Status</label><select id="fs"><option value="open">Open (WIP)</option><option value="Closed">Closed</option><option value="">All</option></select></div>
      <div class="field"><label for="fv">Severity</label><select id="fv"><option value="">All</option>${S.SEVERITIES.map((s) => `<option>${s}</option>`).join('')}</select></div>
      <div class="field"><label for="ft">Case type</label><select id="ft"><option value="">All</option><option value="none">No template</option>${tpls.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="fl">SLA</label><select id="fl"><option value="">All</option><option value="Y">Breached</option><option value="N">Within SLA</option></select></div>
      <div class="field"><label for="so">Sort</label><select id="so"><option value="priority">Severity, then oldest</option><option value="newest">Newest detected</option><option value="updated">Recently updated</option></select></div>
      <button class="primary" id="new-case">New case</button>
    </div>
    <div id="case-table"></div>`;
  const set = (id, key) => { const i = el.querySelector(id); i.value = caseFilters[key]; i.addEventListener('input', () => { caseFilters[key] = i.value; drawCaseTable(); }); };
  set('#q', 'q'); set('#fs', 'status'); set('#fv', 'severity'); set('#ft', 'type'); set('#fl', 'sla'); set('#so', 'sort');
  el.querySelector('#new-case').onclick = () => caseForm();
  drawCaseTable();
}

function drawCaseTable() {
  const host = document.getElementById('case-table'); if (!host) return;
  const f = caseFilters; const q = f.q.trim().toLowerCase();
  const rows = S.data().cases.filter((c) =>
    (f.status === '' || (f.status === 'open' ? c.status !== 'Closed' : c.status === f.status)) &&
    (!f.severity || c.severity === f.severity) &&
    (!f.type || (f.type === 'none' ? !c.templateId : c.templateId === f.type)) &&
    (!f.sla || S.effectiveSla(c) === f.sla) &&
    (!q || [c.name, c.ref, c.escalatedTo, c.notes, c.source, c.template?.name, ...Object.values(c.fieldValues || {})].some((x) => String(x ?? '').toLowerCase().includes(q))));
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
      <td><button type="button" class="case-name" data-case="${c.id}">${esc(c.name)}</button>
        <div class="ref">${esc(c.ref)}${c.template ? ` · ${esc(c.template.name)}` : ''} ${incidentBadge(c)}</div></td>
      <td>${esc(c.escalatedTo) || '<span class="faint">—</span>'}</td>
      <td><span class="sev sev-${c.severity}">${c.severity}</span></td>
      <td class="t">${fmt(c.detectedAt)}</td><td class="t">${fmt(c.reportedAt)}</td><td class="t">${fmt(c.ackAt)}</td>
      <td class="sla-${S.effectiveSla(c)}">${S.effectiveSla(c)}</td>
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
  host.querySelectorAll('[data-reopen]').forEach((b) => (b.onclick = () => guard(() => S.setCaseStatus(b.dataset.reopen, 'WIP'), 'Case reopened.')));
}

// ---------------------------------------------------------------- close

export function confirmClose(id) {
  const c = S.data().cases.find((x) => x.id === id);
  if (!c) return;
  const t = c.template;
  const needCore = Object.entries(t?.core || {}).filter(([k, m]) => m !== 'no' && !String(c[k] ?? '').trim()).map(([k]) => k);
  const needFields = (t?.fields || []).filter((f) => f.required !== 'no' && !String(c.fieldValues?.[f.id] ?? '').trim());
  const coreInput = (k) => {
    if (k === 'reportedAt' || k === 'ackAt') return `<div class="field"><label for="cc-${k}">${S.CORE_FIELDS[k]}<span class="req">*</span></label><div class="with-now"><input type="datetime-local" id="cc-${k}"><button type="button" class="sm" data-now="cc-${k}">Now</button></div></div>`;
    if (k === 'notes') return `<div class="field"><label for="cc-${k}">${S.CORE_FIELDS[k]}<span class="req">*</span></label><textarea id="cc-${k}"></textarea></div>`;
    return `<div class="field"><label for="cc-${k}">${S.CORE_FIELDS[k]}<span class="req">*</span></label><input id="cc-${k}"></div>`;
  };
  openModal({
    title: `Close ${esc(c.ref)}`,
    body: `<p><b>${esc(c.name)}</b>${t ? ` <span class="tag">${esc(t.name)}</span>` : ''}</p>
      ${needCore.length || needFields.length ? `<p class="small muted">This case type needs these before it can close.</p>
        ${needCore.map(coreInput).join('')}
        <div class="tf-grid">${needFields.map((f) => fieldInput({ ...f, required: 'always' }, c.fieldValues?.[f.id], 'cc')).join('')}</div>` : ''}
      ${!c.ackAt && !needCore.includes('ackAt') ? '<div class="field"><label class="check"><input type="checkbox" id="setack" checked> Set acknowledgement time to now (none recorded yet)</label></div>' : ''}
      <div class="field"><label for="cm">Closing note (optional)</label><textarea id="cm" placeholder="Resolution, root cause, ticket number"></textarea></div>
      <p class="error"></p>`,
    foot: '<button type="button" data-close>Cancel</button><button class="primary" type="submit">Close case</button>',
    onMount: (f) => f.querySelectorAll('[data-now]').forEach((b) => (b.onclick = () => { f.querySelector('#' + b.dataset.now).value = toInput(Date.now()); })),
    onSubmit: async (f) => {
      const patch = {};
      for (const k of needCore) {
        const el = f.querySelector('#cc-' + k);
        patch[k] = (k === 'reportedAt' || k === 'ackAt') ? fromInput(el.value) : el.value.trim();
      }
      if (f.querySelector('#setack')?.checked) patch.ackAt = Date.now();
      const fieldValues = readFields(f, needFields);
      await S.setCaseStatus(id, 'Closed', { patch, fieldValues });
      const note = f.querySelector('#cm').value.trim();
      if (note) await S.addCaseComment(id, `Closing note: ${note}`);
      toast(`${c.ref} closed.`);
    },
  });
}

// ---------------------------------------------------------------- form

function dtField(id, label, ts, req = '', locked = false) {
  if (locked) return `<div class="field"><label for="${id}">${label} <span class="lock">locked</span></label><input type="datetime-local" id="${id}" value="${toInput(ts)}" disabled></div>`;
  return `<div class="field"><label for="${id}">${label}${req}</label><div class="with-now"><input type="datetime-local" id="${id}" value="${toInput(ts)}"><button type="button" class="sm" data-now="${id}">Now</button></div></div>`;
}

export function caseForm(c = null) {
  const d = S.data();
  const prevEsc = [...new Set([...d.cases.map((x) => x.escalatedTo).filter(Boolean), ...d.users.filter((u) => !u.disabled).map((u) => u.displayName), ...ESCALATION_SUGGESTIONS])];
  const activeTpls = d.templates.filter((t) => t.active !== false).sort((a, b) => a.name.localeCompare(b.name));
  const v = c || { severity: 'Medium', status: 'WIP', detectedAt: Date.now(), slaManual: false, slaBreach: 'N', fieldValues: {} };
  let tpl = c ? c.template : null;
  const lead = S.canEditLocked();

  const coreReq = (k) => requiredMark(tpl?.core?.[k]);
  const body = () => `
      ${c ? (tpl ? `<p class="small muted">Case type: <b>${esc(tpl.name)}</b></p>` : '')
        : `<div class="field"><label for="ctype">Case type</label><select id="ctype"><option value="">No template</option>${activeTpls.map((t) => `<option value="${t.id}" ${tpl?.id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
          ${activeTpls.length ? '<div class="hint">Picking a type adds its fields and marks what must be filled in.</div>' : (S.can.manageTemplates() ? '<div class="hint">No case types yet. Create them under Case templates.</div>' : '')}</div>`}
      ${c && !lead ? `<div class="field"><label for="cn">Case name <span class="lock">locked</span></label><input id="cn" value="${esc(v.name)}" disabled></div>`
        : c ? `<div class="field"><label for="cn">Case name<span class="req">*</span></label><input id="cn" maxlength="160" value="${esc(v.name)}"><div class="hint">Locked for analysts. As a ${esc(S.ROLES[S.currentUser().role].toLowerCase())} you can correct the name, detection time and reported time. Changes are recorded in the case history.</div></div>`
        : `<div class="field"><label for="cn">Case name<span class="req">*</span></label><input id="cn" maxlength="160" value="${esc(v.name)}" placeholder="e.g. Multiple failed logins on core banking admin portal"><div class="hint">The name, detection time and reported time can't be changed once the case is logged.</div></div>`}
      <div class="field-row">
        <div class="field"><label for="ce">Escalated team or user${coreReq('escalatedTo')}</label><input id="ce" list="esc-list" maxlength="120" value="${esc(v.escalatedTo)}"><datalist id="esc-list">${prevEsc.map((x) => `<option value="${esc(x)}">`).join('')}</datalist></div>
        <div class="field"><label for="cv">Severity<span class="req">*</span></label><select id="cv">${S.SEVERITIES.map((s) => `<option ${s === v.severity ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="field"><label for="csrc">Source${coreReq('source')}</label><input id="csrc" list="src-list" maxlength="60" value="${esc(v.source)}"><datalist id="src-list">${SOURCE_SUGGESTIONS.map((x) => `<option value="${esc(x)}">`).join('')}</datalist></div>
      </div>
      <div class="field-row">
        ${dtField('cd', 'Detection date and time', v.detectedAt, '<span class="req">*</span>', !!c && !lead)}
        ${dtField('cr', 'Reported date and time', v.reportedAt, coreReq('reportedAt'), !!(c && c.reportedAt) && !lead)}
        ${dtField('ca', 'Acknowledgement date and time', v.ackAt, coreReq('ackAt'))}
      </div>
      ${tpl?.fields?.length ? `<fieldset class="tf"><legend>${esc(tpl.name)} details</legend><div class="tf-grid">${tpl.fields.map((fd) => fieldInput(fd, v.fieldValues?.[fd.id])).join('')}</div></fieldset>` : ''}
      <div class="field-row">
        <div class="field"><label>SLA breach</label>
          <div id="sla-auto" class="small" style="padding:8px 0"></div>
          <label class="check"><input type="checkbox" id="slo" ${v.slaManual ? 'checked' : ''}> Override</label>
          <select id="slv" style="margin-top:6px" ${v.slaManual ? '' : 'disabled'}><option value="N" ${v.slaBreach === 'N' ? 'selected' : ''}>N</option><option value="Y" ${v.slaBreach === 'Y' ? 'selected' : ''}>Y</option></select>
        </div>
        <div class="field"><label for="cs">Status</label><select id="cs"><option ${v.status === 'WIP' ? 'selected' : ''}>WIP</option><option ${v.status === 'Closed' ? 'selected' : ''}>Closed</option></select>
          <div class="hint">Stays WIP until someone confirms it's closed. Any analyst can close a case.</div></div>
      </div>
      <div class="field"><label for="cnotes">Notes${coreReq('notes')}</label><textarea id="cnotes" maxlength="5000" placeholder="What happened, what you checked, next steps">${esc(v.notes)}</textarea></div>
      <p class="small faint"><span class="req">*</span> required${tpl ? '. Fields marked "required to close" can wait until the case is closed.' : ''}</p>
      <p class="error"></p>`;

  const snapshot = (f) => ({
    name: f.querySelector('#cn').value, escalatedTo: f.querySelector('#ce').value, severity: f.querySelector('#cv').value,
    source: f.querySelector('#csrc').value, detectedAt: fromInput(f.querySelector('#cd').value),
    reportedAt: fromInput(f.querySelector('#cr').value), ackAt: fromInput(f.querySelector('#ca').value),
    slaManual: f.querySelector('#slo').checked, slaBreach: f.querySelector('#slv').value,
    status: f.querySelector('#cs').value, notes: f.querySelector('#cnotes').value,
    fieldValues: tpl ? readFields(f, tpl.fields) : {},
  });

  const mount = (f) => {
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
    const typeSel = f.querySelector('#ctype');
    if (typeSel) typeSel.addEventListener('change', () => {
      const keep = snapshot(f);
      const t = d.templates.find((x) => x.id === typeSel.value);
      tpl = t ? { id: t.id, name: t.name, core: t.core || {}, fields: t.fields || [] } : null;
      Object.assign(v, keep, { fieldValues: { ...v.fieldValues, ...keep.fieldValues } });
      if (t && !c) v.severity = t.defaultSeverity || v.severity;
      f.querySelector('.modal-body').innerHTML = body();
      mount(f);
    });
  };

  openModal({
    title: c ? `Edit ${esc(c.ref)}` : 'New case',
    width: '780px',
    body: body(),
    foot: `<button type="button" data-close>Cancel</button><button class="primary" type="submit">${c ? 'Save changes' : 'Log case'}</button>`,
    onMount: mount,
    onSubmit: async (f) => {
      const s = snapshot(f);
      const input = {
        id: c?.id, templateId: c ? undefined : (tpl?.id || null),
        name: c && !lead ? c.name : s.name.trim(), escalatedTo: s.escalatedTo.trim(), severity: s.severity, source: s.source.trim(),
        detectedAt: c && !lead ? c.detectedAt : s.detectedAt, reportedAt: c?.reportedAt && !lead ? c.reportedAt : s.reportedAt, ackAt: s.ackAt,
        slaManual: s.slaManual, slaBreach: s.slaManual ? s.slaBreach : S.computeSla(s),
        status: s.status, notes: s.notes.trim(), fieldValues: s.fieldValues,
      };
      const saved = await S.saveCase(input);
      toast(c ? `${saved.ref} saved.` : `${saved.ref} logged.`);
    },
  });
}

// ---------------------------------------------------------------- detail

function fmtVal(v) {
  if (v === '' || v == null) return 'empty';
  if (typeof v === 'number' && v > 1e11) return fmt(v);
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return String(v).length > 90 ? String(v).slice(0, 90) + '…' : String(v);
}

export function caseDetail(id) {
  const c = S.data().cases.find((x) => x.id === id);
  if (!c) { toast('That case no longer exists.', true); return; }
  const inc = c.incidentId ? S.data().incidents.find((i) => i.id === c.incidentId) : null;
  const timeToAck = c.ackAt && c.detectedAt ? dur(c.ackAt - c.detectedAt) : '—';
  const events = [
    ...c.history.map((h) => ({ at: h.at, html: `<b>${esc(S.userName(h.by))}</b> ${h.action === 'opened' ? 'opened the case' : 'changed ' + h.changes.map((ch) => `${esc(ch.field)}${['Notes'].includes(ch.field) ? '' : ` (${esc(fmtVal(ch.from))} → ${esc(fmtVal(ch.to))})`}`).join(', ')}` })),
    ...(c.comments || []).map((cm) => ({ at: cm.at, c: true, html: `<b>${esc(S.userName(cm.by))}</b><div style="white-space:pre-wrap">${esc(cm.body)}</div>` })),
  ].sort((a, b) => a.at - b.at);
  const tf = (c.template?.fields || []).map((fd) => ({ fd, v: fieldDisplay(fd, c.fieldValues?.[fd.id]) }));
  openModal({
    title: `${esc(c.ref)}`,
    width: '780px',
    body: `
      <h2 style="margin-bottom:10px">${esc(c.name)}</h2>
      ${inc ? (() => {
        const last = lastStageChange(inc);
        return `<div class="inc-banner">
          <div class="inc-banner-head">Escalated to incident <button type="button" class="linkish" data-incident="${inc.id}">${esc(inc.ref)} ${esc(inc.title)}</button> ${incStatus(inc.status)}</div>
          ${stageControl(inc, 'cstg')}
          ${last ? `<div class="small muted">Last stage change: ${esc(last.from || '')}${last.from ? ' to ' : ''}${esc(last.to)} by ${esc(S.userName(last.by))}, ${fmt(last.at)}${last.note ? `. Reason: ${esc(last.note)}` : ''}</div>` : ''}
        </div>`;
      })() : ''}
      <dl class="kv">
        ${c.template ? `<dt>Case type</dt><dd>${esc(c.template.name)}</dd>` : ''}
        <dt>Status</dt><dd><span class="status status-${c.status}">${c.status}</span>${c.closedBy ? ` <span class="small muted">by ${esc(S.userName(c.closedBy))} at ${fmt(c.closedAt)}</span>` : ''}</dd>
        <dt>Severity</dt><dd><span class="sev sev-${c.severity}">${c.severity}</span></dd>
        <dt>Escalated to</dt><dd>${esc(c.escalatedTo) || '—'}</dd>
        ${c.source ? `<dt>Source</dt><dd>${esc(c.source)}</dd>` : ''}
        <dt>Detected</dt><dd>${fmt(c.detectedAt)}</dd>
        <dt>Reported</dt><dd>${fmt(c.reportedAt)}</dd>
        <dt>Acknowledged</dt><dd>${fmt(c.ackAt)} <span class="small muted">${c.ackAt ? `(${timeToAck} after detection)` : ''}</span></dd>
        <dt>SLA breach</dt><dd class="sla-${S.effectiveSla(c)}">${S.effectiveSla(c)}${c.slaManual ? ' <span class="small faint">(set manually)</span>' : ` <span class="small faint">(auto, target ${S.slaTargetMin(c.severity)} min)</span>`}</dd>
        <dt>Opened by</dt><dd>${esc(S.userName(c.createdBy))} at ${fmt(c.createdAt)}</dd>
        ${tf.map(({ fd, v }) => `<dt>${esc(fd.label)}</dt><dd style="white-space:pre-wrap">${v ? esc(v) : `<span class="faint">${fd.required === 'no' ? '—' : 'Not filled in yet'}</span>`}</dd>`).join('')}
      </dl>
      ${c.notes ? `<h3 style="margin-bottom:6px">Notes</h3><div class="body" style="white-space:pre-wrap;margin-bottom:16px;overflow-wrap:anywhere">${esc(c.notes)}</div>` : ''}
      <h3 style="margin-bottom:8px">Activity</h3>
      <div class="timeline">${events.map((e) => `<div class="${e.c ? 'c' : ''}"><span class="faint small">${fmt(e.at)}</span><div>${e.html}</div></div>`).join('')}</div>
      <div class="field" style="margin-top:8px"><label for="cmt">Add a comment</label><textarea id="cmt" placeholder="Update for the next analyst"></textarea></div>
      <button type="button" class="sm" id="add-cmt">Add comment</button>`,
    foot: `${S.can.deleteCases() ? '<button type="button" class="danger left" id="del">Delete</button>' : ''}
      ${!inc ? '<button type="button" id="esc">Escalate to incident</button>' : ''}
      <button type="button" id="edit">Edit</button>
      ${c.status === 'Closed' ? '<button type="button" id="reopen">Reopen</button>' : '<button type="button" class="primary" id="close">Close case</button>'}`,
    onMount: (f) => {
      f.querySelectorAll('[data-incident]').forEach((b) => (b.onclick = () => incidentDetail(b.dataset.incident)));
      if (inc) bindStageControl(f, inc, 'cstg', () => caseDetail(id));
      f.querySelector('#add-cmt').onclick = async () => {
        if (await guard(() => S.addCaseComment(id, f.querySelector('#cmt').value), 'Comment added.')) caseDetail(id);
      };
      f.querySelector('#edit').onclick = () => caseForm(S.data().cases.find((x) => x.id === id));
      f.querySelector('#esc')?.addEventListener('click', () => escalateForm(id));
      f.querySelector('#close')?.addEventListener('click', () => confirmClose(id));
      f.querySelector('#reopen')?.addEventListener('click', async () => { if (await guard(() => S.setCaseStatus(id, 'WIP'), 'Case reopened.')) caseDetail(id); });
      f.querySelector('#del')?.addEventListener('click', async () => {
        if (!confirm(`Delete ${c.ref}? This removes it from reports and search. The deletion is kept in the audit log.`)) return;
        if (await guard(() => S.deleteCase(id), 'Case deleted.')) closeModal();
      });
    },
  });
}

// ---------------------------------------------------------------- escalate to incident

export function escalateForm(caseId) {
  const c = S.data().cases.find((x) => x.id === caseId);
  const open = S.data().incidents.filter((i) => i.status !== 'Closed').sort((a, b) => b.declaredAt - a.declaredAt);
  if (!open.length) return incidentForm(null, c);
  openModal({
    title: `Escalate ${esc(c.ref)}`,
    body: `<p>Declare a new incident from <b>${esc(c.name)}</b>, or add it to an incident that's already open.</p>
      <div class="field"><label class="check"><input type="radio" name="mode" value="new" checked> Declare a new incident</label></div>
      <div class="field"><label class="check"><input type="radio" name="mode" value="link"> Link to an open incident</label>
        <select id="li" style="margin-top:6px" disabled>${open.map((i) => `<option value="${i.id}">${esc(i.ref)} ${esc(i.title)} (${esc(i.status)})</option>`).join('')}</select></div>
      <p class="error"></p>`,
    foot: '<button type="button" data-close>Cancel</button><button class="primary" type="submit">Continue</button>',
    onMount: (f) => f.querySelectorAll('[name=mode]').forEach((r) => r.addEventListener('change', () => { f.querySelector('#li').disabled = f.querySelector('[name=mode]:checked').value !== 'link'; })),
    onSubmit: async (f) => {
      if (f.querySelector('[name=mode]:checked').value === 'new') { setTimeout(() => incidentForm(null, c), 0); return; }
      const inc = await S.linkCaseToIncident(caseId, f.querySelector('#li').value);
      toast(`${c.ref} linked to ${inc.ref}.`);
    },
  });
}
