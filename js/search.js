// Search history: cases and incidents by keyword, person, case type and template field values.
import * as S from './store.js';
import { esc, fmt, ymd, csvCell, download, fieldDisplay } from './ui.js';
import { caseDetail } from './cases.js';
import { incidentDetail, incStatus } from './incidents.js';

export const sf = { q: '', kind: 'all', userId: '', role: 'any', templateId: '', fieldId: '', fieldValue: '', severity: '', status: '', from: '', to: '' };

const CASE_ROLES = { any: 'Any involvement', opened: 'Opened it', closed: 'Closed it', commented: 'Commented or edited', escalated: 'Escalated to them', owner: 'Incident owner', declared: 'Declared the incident' };

/** All case types that appear anywhere: current templates plus snapshots on old cases. */
function allTypes() {
  const map = new Map();
  for (const c of S.data().cases) if (c.template) map.set(c.template.id, { id: c.template.id, name: c.template.name, fields: c.template.fields });
  for (const t of S.data().templates) map.set(t.id, { id: t.id, name: t.name, fields: t.fields }); // current definition wins
  // merge fields from snapshots so fields removed from a template are still searchable
  for (const c of S.data().cases) {
    if (!c.template) continue;
    const t = map.get(c.template.id);
    for (const f of c.template.fields) if (!t.fields.some((x) => x.id === f.id)) t.fields = [...t.fields, f];
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function viewSearch(el) {
  const types = allTypes();
  const users = [...S.data().users].sort((a, b) => a.displayName.localeCompare(b.displayName));
  const type = types.find((t) => t.id === sf.templateId);
  const field = type?.fields.find((f) => f.id === sf.fieldId);
  const valueInput = () => {
    if (!field) return '<input id="sval" disabled placeholder="Pick a field first">';
    if (field.type === 'select') return `<select id="sval"><option value="">Any value</option>${field.options.map((o) => `<option ${o === sf.fieldValue ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    if (field.type === 'yesno') return `<select id="sval"><option value="">Any value</option><option ${sf.fieldValue === 'Yes' ? 'selected' : ''}>Yes</option><option ${sf.fieldValue === 'No' ? 'selected' : ''}>No</option></select>`;
    if (field.type === 'user') return `<select id="sval"><option value="">Any value</option>${users.map((u) => `<option value="${u.id}" ${u.id === sf.fieldValue ? 'selected' : ''}>${esc(u.displayName)}</option>`).join('')}</select>`;
    return `<input id="sval" value="${esc(sf.fieldValue)}" placeholder="Contains…">`;
  };
  el.innerHTML = `
    <section class="panel search-panel" data-live>
      <div class="field"><label for="sq">Keyword</label><input id="sq" type="search" value="${esc(sf.q)}" placeholder="Searches names, notes, comments, incident logs and case type fields"></div>
      <div class="search-grid">
        <div class="field"><label for="sk">Look in</label><select id="sk"><option value="all">Cases and incidents</option><option value="case" ${sf.kind === 'case' ? 'selected' : ''}>Cases only</option><option value="incident" ${sf.kind === 'incident' ? 'selected' : ''}>Incidents only</option></select></div>
        <div class="field"><label for="su">Person</label><select id="su"><option value="">Anyone</option>${users.map((u) => `<option value="${u.id}" ${u.id === sf.userId ? 'selected' : ''}>${esc(u.displayName)}</option>`).join('')}</select></div>
        <div class="field"><label for="sr">Who</label><select id="sr" ${sf.userId ? '' : 'disabled'}>${Object.entries(CASE_ROLES).map(([k, l]) => `<option value="${k}" ${k === sf.role ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label for="sv">Severity</label><select id="sv"><option value="">Any</option>${S.SEVERITIES.map((s) => `<option ${s === sf.severity ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="field"><label for="ss">Status</label><select id="ss"><option value="">Any</option><option value="open" ${sf.status === 'open' ? 'selected' : ''}>Open or active</option><option value="closed" ${sf.status === 'closed' ? 'selected' : ''}>Closed</option></select></div>
        <div class="field"><label for="sfrom">From</label><input type="date" id="sfrom" value="${sf.from}"></div>
        <div class="field"><label for="sto">To</label><input type="date" id="sto" value="${sf.to}"></div>
      </div>
      <div class="search-grid">
        <div class="field"><label for="st">Case type</label><select id="st"><option value="">Any</option><option value="none" ${sf.templateId === 'none' ? 'selected' : ''}>No case type</option>${types.map((t) => `<option value="${t.id}" ${t.id === sf.templateId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="sfield">Field</label><select id="sfield" ${type ? '' : 'disabled'}><option value="">${type ? 'Any field' : 'Pick a case type first'}</option>${(type?.fields || []).map((f) => `<option value="${f.id}" ${f.id === sf.fieldId ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="sval">Value</label>${valueInput()}</div>
        <div class="field" style="align-self:end"><button type="button" class="ghost" id="sclear">Clear filters</button></div>
      </div>
    </section>
    <div id="sresults" style="margin-top:16px"></div>`;
  const bind = (id, key, redraw = false) => {
    const i = el.querySelector(id); if (!i) return;
    i.addEventListener('input', () => {
      sf[key] = i.value;
      if (key === 'templateId') { sf.fieldId = ''; sf.fieldValue = ''; }
      if (key === 'fieldId') sf.fieldValue = '';
      if (key === 'userId' && !i.value) sf.role = 'any';
      if (redraw) { viewSearch(el); el.querySelector(id)?.focus(); } else drawResults();
    });
  };
  bind('#sq', 'q'); bind('#sk', 'kind'); bind('#su', 'userId', true); bind('#sr', 'role'); bind('#sv', 'severity'); bind('#ss', 'status');
  bind('#sfrom', 'from'); bind('#sto', 'to'); bind('#st', 'templateId', true); bind('#sfield', 'fieldId', true); bind('#sval', 'fieldValue');
  el.querySelector('#sclear').onclick = () => { Object.assign(sf, { q: '', kind: 'all', userId: '', role: 'any', templateId: '', fieldId: '', fieldValue: '', severity: '', status: '', from: '', to: '' }); viewSearch(el); };
  drawResults();
}

function involvement(item, kind, uid) {
  const r = new Set();
  if (kind === 'case') {
    if (item.createdBy === uid) r.add('opened');
    if (item.closedBy === uid) r.add('closed');
    if ((item.comments || []).some((c) => c.by === uid) || item.history.some((h) => h.by === uid && h.action !== 'opened')) r.add('commented');
    const u = S.data().users.find((x) => x.id === uid);
    if (u && item.escalatedTo && item.escalatedTo.toLowerCase().includes(u.displayName.toLowerCase())) r.add('escalated');
    for (const f of item.template?.fields || []) if (f.type === 'user' && item.fieldValues?.[f.id] === uid) r.add('commented');
  } else {
    if (item.declaredBy === uid) r.add('declared');
    if (item.ownerId === uid) r.add('owner');
    if (item.closedBy === uid) r.add('closed');
    if (item.log.some((e) => e.by === uid && e.kind !== 'created')) r.add('commented');
  }
  return r;
}

function caseText(c) {
  return [c.ref, c.name, c.escalatedTo, c.notes, c.source, c.template?.name,
    ...(c.template?.fields || []).map((f) => fieldDisplay(f, c.fieldValues?.[f.id])),
    ...(c.comments || []).map((x) => x.body)].join('\n').toLowerCase();
}
function incText(i) {
  return [i.ref, i.title, i.category, i.summary, i.affectedAssets, i.rootCause, i.lessonsLearned, ...i.log.map((e) => e.text)].join('\n').toLowerCase();
}
function snippet(text, q) {
  if (!q) return '';
  const i = text.indexOf(q);
  if (i < 0) return '';
  const s = Math.max(0, i - 40);
  return (s ? '…' : '') + text.slice(s, i + q.length + 60).replace(/\s+/g, ' ') + '…';
}

export function runSearch() {
  const q = sf.q.trim().toLowerCase();
  const from = sf.from ? new Date(sf.from + 'T00:00').getTime() : null;
  const to = sf.to ? new Date(sf.to + 'T23:59:59').getTime() : null;
  const out = [];
  if (sf.kind !== 'incident') {
    for (const c of S.data().cases) {
      if (sf.severity && c.severity !== sf.severity) continue;
      if (sf.status === 'open' && c.status === 'Closed') continue;
      if (sf.status === 'closed' && c.status !== 'Closed') continue;
      if (from && c.detectedAt < from) continue;
      if (to && c.detectedAt > to) continue;
      if (sf.templateId === 'none' && c.templateId) continue;
      if (sf.templateId && sf.templateId !== 'none' && c.templateId !== sf.templateId) continue;
      if (sf.fieldId) {
        const fd = c.template?.fields.find((f) => f.id === sf.fieldId);
        const raw = c.fieldValues?.[sf.fieldId];
        if (!fd || raw === undefined || raw === '') continue;
        if (sf.fieldValue) {
          if (['select', 'yesno', 'user'].includes(fd.type)) { if (raw !== sf.fieldValue) continue; }
          else if (!fieldDisplay(fd, raw).toLowerCase().includes(sf.fieldValue.toLowerCase())) continue;
        }
      }
      if (sf.userId) {
        const inv = involvement(c, 'case', sf.userId);
        if (sf.role === 'any' ? !inv.size : !inv.has(sf.role)) continue;
      }
      const text = caseText(c);
      if (q && !text.includes(q)) continue;
      out.push({ kind: 'case', id: c.id, ref: c.ref, title: c.name, severity: c.severity, status: c.status, type: c.template?.name || '', by: S.userName(c.createdBy), at: c.detectedAt, snippet: snippet(text, q), item: c });
    }
  }
  if (sf.kind !== 'case' && !sf.templateId) {
    for (const i of S.data().incidents) {
      if (sf.severity && i.severity !== sf.severity) continue;
      if (sf.status === 'open' && i.status === 'Closed') continue;
      if (sf.status === 'closed' && i.status !== 'Closed') continue;
      if (from && i.declaredAt < from) continue;
      if (to && i.declaredAt > to) continue;
      if (sf.userId) {
        const inv = involvement(i, 'incident', sf.userId);
        if (sf.role === 'any' ? !inv.size : !inv.has(sf.role)) continue;
      }
      const text = incText(i);
      if (q && !text.includes(q)) continue;
      out.push({ kind: 'incident', id: i.id, ref: i.ref, title: i.title, severity: i.severity, status: i.status, type: i.category, by: S.userName(i.declaredBy), at: i.declaredAt, snippet: snippet(text, q), item: i });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

function drawResults() {
  const host = document.getElementById('sresults'); if (!host) return;
  const rows = runSearch();
  const nothing = !sf.q && !sf.userId && !sf.templateId && !sf.severity && !sf.status && !sf.from && !sf.to && sf.kind === 'all';
  host.innerHTML = `
    <div class="toolbar"><div class="grow small muted">${rows.length} result${rows.length === 1 ? '' : 's'}${nothing ? ', showing everything. Add filters to narrow it down.' : ''}${sf.templateId && sf.kind !== 'case' ? ' Case type filters only apply to cases.' : ''}</div>
      ${rows.length ? '<button id="sexp">Export results (CSV)</button>' : ''}</div>
    ${rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Type</th><th>Reference and title</th><th>Severity</th><th>Status</th><th>Case type or category</th><th>Opened or declared by</th><th>Date</th></tr></thead>
      <tbody>${rows.slice(0, 300).map((r) => `<tr>
        <td><span class="tag ${r.kind === 'incident' ? 'kind-inc' : ''}">${r.kind === 'case' ? 'Case' : 'Incident'}</span></td>
        <td><button type="button" class="case-name" data-open="${r.kind}:${r.id}">${esc(r.title)}</button><div class="ref">${esc(r.ref)}</div>${r.snippet ? `<div class="snippet">${esc(r.snippet)}</div>` : ''}</td>
        <td><span class="sev sev-${r.severity}">${r.severity}</span></td>
        <td>${r.kind === 'case' ? `<span class="status status-${r.status}">${r.status}</span>` : incStatus(r.status)}</td>
        <td>${esc(r.type) || '<span class="faint">—</span>'}</td>
        <td>${esc(r.by)}</td><td class="t">${fmt(r.at)}</td></tr>`).join('')}</tbody></table></div>
      ${rows.length > 300 ? '<p class="small faint" style="margin-top:8px">Showing the newest 300. Export includes all of them.</p>' : ''}`
    : '<div class="panel empty">Nothing matches. Try a shorter keyword or remove a filter.</div>'}`;
  host.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => { const [k, id] = b.dataset.open.split(':'); (k === 'case' ? caseDetail : incidentDetail)(id); }));
  host.querySelector('#sexp')?.addEventListener('click', () => {
    const type = allTypes().find((t) => t.id === sf.templateId);
    const extra = type ? type.fields : [];
    const lines = [['Type', 'Reference', 'Title', 'Severity', 'Status', 'Case type or category', 'Opened or declared by', 'Date', ...extra.map((f) => f.label)],
      ...rows.map((r) => [r.kind, r.ref, r.title, r.severity, r.status, r.type, r.by, fmt(r.at), ...extra.map((f) => (r.kind === 'case' ? fieldDisplay(f, r.item.fieldValues?.[f.id]) : ''))])];
    download(`soc-search-${ymd(new Date())}.csv`, '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n'), 'text/csv');
    S.addAudit('search.export', `Exported ${rows.length} search results`);
  });
}
