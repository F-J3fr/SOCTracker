// Case templates: case types with their own fields and mandated (required) fields.
import * as S from './store.js';
import { esc, toast, guard, openModal, fieldInput } from './ui.js';
import { uuid } from './crypto.js';

export function viewTemplates(el) {
  const tpls = [...S.data().templates].sort((a, b) => (a.active === false) - (b.active === false) || a.name.localeCompare(b.name));
  const used = (id) => S.data().cases.filter((c) => c.templateId === id).length;
  el.innerHTML = `
    <div class="toolbar"><div class="grow muted small">Case types decide which extra fields an analyst fills in, and which fields are required to save or to close the case. Changes apply to new cases. Existing cases keep the fields they were created with.</div>
      <button class="primary" id="new-t">New case type</button></div>
    ${tpls.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Case type</th><th>Default severity</th><th>Fields</th><th>Required</th><th>Cases</th><th>Status</th><th></th></tr></thead>
      <tbody>${tpls.map((t) => {
        const req = (t.fields || []).filter((f) => f.required !== 'no').length + Object.values(t.core || {}).filter((m) => m !== 'no').length;
        return `<tr>
          <td><b>${esc(t.name)}</b>${t.description ? `<div class="small muted">${esc(t.description)}</div>` : ''}</td>
          <td><span class="sev sev-${t.defaultSeverity}">${esc(t.defaultSeverity)}</span></td>
          <td class="t">${(t.fields || []).length}</td><td class="t">${req}</td><td class="t">${used(t.id)}</td>
          <td>${t.active === false ? '<span class="tag off">Archived</span>' : '<span class="small muted">Active</span>'}</td>
          <td class="actions"><button class="sm" data-tedit="${t.id}">Edit</button><button class="sm ghost" data-tcopy="${t.id}">Duplicate</button>
            <button class="sm ghost" data-tprev="${t.id}">Preview</button></td></tr>`;
      }).join('')}</tbody></table></div>`
    : `<div class="panel empty"><b>No case types yet.</b> Create one for each kind of case your team handles, such as Phishing, Malware alert or Account lockout, with the details analysts must record for it.
        <div style="margin-top:12px"><button id="starter">Add three example case types</button></div></div>`}`;
  el.querySelector('#new-t').onclick = () => templateEditor();
  el.querySelectorAll('[data-tedit]').forEach((b) => (b.onclick = () => templateEditor(S.data().templates.find((t) => t.id === b.dataset.tedit))));
  el.querySelectorAll('[data-tcopy]').forEach((b) => (b.onclick = () => {
    const t = structuredClone(S.data().templates.find((x) => x.id === b.dataset.tcopy));
    delete t.id; t.name = `${t.name} (copy)`; t.fields = t.fields.map((f) => ({ ...f, id: uuid().slice(0, 8) }));
    templateEditor(t);
  }));
  el.querySelectorAll('[data-tprev]').forEach((b) => (b.onclick = () => preview(S.data().templates.find((t) => t.id === b.dataset.tprev))));
  el.querySelector('#starter')?.addEventListener('click', () => guard(addStarters, 'Example case types added. Edit them to match how your team works.'));
}

const fid = () => uuid().slice(0, 8);
async function addStarters() {
  const starters = [
    { name: 'Phishing', description: 'Reported or detected phishing email', defaultSeverity: 'Medium',
      core: { escalatedTo: 'no', reportedAt: 'always', ackAt: 'close', source: 'always', notes: 'no' },
      fields: [
        { id: fid(), label: 'Sender address', type: 'text', required: 'always', options: [] },
        { id: fid(), label: 'Subject line', type: 'text', required: 'always', options: [] },
        { id: fid(), label: 'Recipients affected', type: 'number', required: 'always', options: [] },
        { id: fid(), label: 'Link or attachment clicked', type: 'yesno', required: 'always', options: [] },
        { id: fid(), label: 'Sender blocked on mail gateway', type: 'yesno', required: 'close', options: [] },
        { id: fid(), label: 'Verdict', type: 'select', required: 'close', options: ['Malicious', 'Spam', 'Simulation', 'False positive'] },
      ] },
    { name: 'Malware alert', description: 'EDR or antivirus detection on an endpoint or server', defaultSeverity: 'High',
      core: { escalatedTo: 'always', reportedAt: 'no', ackAt: 'close', source: 'always', notes: 'no' },
      fields: [
        { id: fid(), label: 'Hostname', type: 'text', required: 'always', options: [] },
        { id: fid(), label: 'User on host', type: 'text', required: 'no', options: [] },
        { id: fid(), label: 'File hash (SHA-256)', type: 'text', required: 'always', options: [] },
        { id: fid(), label: 'Host isolated', type: 'yesno', required: 'always', options: [] },
        { id: fid(), label: 'Action taken', type: 'select', required: 'close', options: ['Quarantined', 'Deleted', 'Reimaged', 'Allowed (false positive)'] },
      ] },
    { name: 'Account lockout', description: 'Repeated failed logins or lockout on a user or service account', defaultSeverity: 'Medium',
      core: { escalatedTo: 'no', reportedAt: 'no', ackAt: 'close', source: 'no', notes: 'no' },
      fields: [
        { id: fid(), label: 'Account name', type: 'text', required: 'always', options: [] },
        { id: fid(), label: 'Source IP', type: 'text', required: 'always', options: [] },
        { id: fid(), label: 'Failed attempts', type: 'number', required: 'no', options: [] },
        { id: fid(), label: 'User confirmed it was them', type: 'yesno', required: 'close', options: [] },
      ] },
  ];
  for (const t of starters) await S.saveTemplate(t);
}

function preview(t) {
  openModal({
    title: `Preview: ${esc(t.name)}`,
    body: `<p class="small muted">This is how the extra fields look in the case form.</p>
      <ul class="small" style="margin:0 0 14px;padding-left:18px">${Object.entries(t.core || {}).filter(([, m]) => m !== 'no').map(([k, m]) => `<li>${esc(S.CORE_FIELDS[k])}: ${esc(S.REQUIRED_MODES[m].toLowerCase())}</li>`).join('') || '<li>No standard fields are mandated beyond the usual ones.</li>'}</ul>
      <fieldset class="tf"><legend>${esc(t.name)} details</legend><div class="tf-grid">${(t.fields || []).map((f) => fieldInput(f, '', 'pv')).join('') || '<p class="muted small">No extra fields.</p>'}</div></fieldset>`,
    foot: '<button type="button" class="primary" data-close>Done</button>',
  });
}

export function templateEditor(t = null) {
  const draft = structuredClone(t || { name: '', description: '', defaultSeverity: 'Medium', active: true, core: {}, fields: [] });
  draft.core = { escalatedTo: 'no', reportedAt: 'no', ackAt: 'no', source: 'no', notes: 'no', ...(draft.core || {}) };
  const modeSelect = (id, val) => `<select id="${id}" class="mode">${Object.entries(S.REQUIRED_MODES).map(([k, l]) => `<option value="${k}" ${k === val ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const fieldRow = (f, n) => `
    <div class="trow" data-row="${n}">
      <div class="field"><label for="fl-${n}">Field label</label><input id="fl-${n}" data-k="label" maxlength="80" value="${esc(f.label)}" placeholder="e.g. Hostname"></div>
      <div class="field"><label for="ftp-${n}">Type</label><select id="ftp-${n}" data-k="type">${Object.entries(S.FIELD_TYPES).map(([k, l]) => `<option value="${k}" ${k === f.type ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label for="frq-${n}">Required</label>${modeSelect(`frq-${n}`, f.required || 'no').replace('class="mode"', 'class="mode" data-k="required"')}</div>
      <div class="field opts ${f.type === 'select' ? '' : 'hidden'}"><label for="fo-${n}">Options, one per line</label><textarea id="fo-${n}" data-k="options" style="min-height:64px">${esc((f.options || []).join('\n'))}</textarea></div>
      <div class="field"><label for="fh-${n}">Hint for analysts (optional)</label><input id="fh-${n}" data-k="help" maxlength="140" value="${esc(f.help)}"></div>
      <div class="trow-actions">
        <button type="button" class="sm ghost" data-up="${n}" ${n === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button type="button" class="sm ghost" data-down="${n}" ${n === draft.fields.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
        <button type="button" class="sm ghost" data-rm="${n}">Remove</button>
      </div>
    </div>`;
  const body = () => `
    <div class="field-row">
      <div class="field"><label for="tn">Case type name<span class="req">*</span></label><input id="tn" maxlength="60" value="${esc(draft.name)}" placeholder="e.g. Phishing"></div>
      <div class="field"><label for="tsev">Default severity</label><select id="tsev">${S.SEVERITIES.map((s) => `<option ${s === draft.defaultSeverity ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label for="td">Description</label><input id="td" maxlength="200" value="${esc(draft.description)}" placeholder="When analysts should pick this type"></div>
    <h3 style="margin:18px 0 6px">Standard fields</h3>
    <p class="small muted" style="margin-bottom:8px">Case name, severity and detection time are always required. Choose which of the others this type needs.</p>
    <div class="core-grid">${Object.entries(S.CORE_FIELDS).map(([k, l]) => `<label for="core-${k}">${l}</label>${modeSelect('core-' + k, draft.core[k])}`).join('')}</div>
    <h3 style="margin:18px 0 6px">Extra fields for this type</h3>
    <div id="rows">${draft.fields.map(fieldRow).join('') || '<p class="small muted">No extra fields yet.</p>'}</div>
    <button type="button" class="sm" id="addf">Add field</button>
    ${t?.id ? `<div class="field" style="margin-top:18px"><label class="check"><input type="checkbox" id="tact" ${draft.active !== false ? 'checked' : ''}> Active (offered when logging new cases)</label></div>` : ''}
    <p class="error"></p>`;

  const collect = (f) => {
    draft.name = f.querySelector('#tn').value;
    draft.description = f.querySelector('#td').value;
    draft.defaultSeverity = f.querySelector('#tsev').value;
    for (const k of Object.keys(S.CORE_FIELDS)) draft.core[k] = f.querySelector('#core-' + k).value;
    if (f.querySelector('#tact')) draft.active = f.querySelector('#tact').checked;
    f.querySelectorAll('.trow').forEach((row) => {
      const fd = draft.fields[+row.dataset.row];
      row.querySelectorAll('[data-k]').forEach((inp) => {
        const k = inp.dataset.k;
        fd[k] = k === 'options' ? inp.value.split('\n').map((x) => x.trim()).filter(Boolean) : inp.value;
      });
    });
  };
  const mount = (f) => {
    const redraw = () => { collect(f); f.querySelector('.modal-body').innerHTML = body(); mount(f); };
    f.querySelector('#addf').onclick = () => { collect(f); draft.fields.push({ id: fid(), label: '', type: 'text', required: 'no', options: [] }); f.querySelector('.modal-body').innerHTML = body(); mount(f); f.querySelector(`#fl-${draft.fields.length - 1}`)?.focus(); };
    f.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { collect(f); draft.fields.splice(+b.dataset.rm, 1); f.querySelector('.modal-body').innerHTML = body(); mount(f); }));
    f.querySelectorAll('[data-up]').forEach((b) => (b.onclick = () => { collect(f); const n = +b.dataset.up; [draft.fields[n - 1], draft.fields[n]] = [draft.fields[n], draft.fields[n - 1]]; f.querySelector('.modal-body').innerHTML = body(); mount(f); }));
    f.querySelectorAll('[data-down]').forEach((b) => (b.onclick = () => { collect(f); const n = +b.dataset.down; [draft.fields[n + 1], draft.fields[n]] = [draft.fields[n], draft.fields[n + 1]]; f.querySelector('.modal-body').innerHTML = body(); mount(f); }));
    f.querySelectorAll('[data-k="type"]').forEach((sel) => sel.addEventListener('change', () => redraw()));
  };
  openModal({
    title: t?.id ? `Edit ${esc(t.name)}` : 'New case type',
    width: '860px',
    body: body(),
    foot: `${t?.id ? '<button type="button" class="danger left" id="tdel">Delete</button>' : ''}<button type="button" data-close>Cancel</button><button class="primary" type="submit">${t?.id ? 'Save case type' : 'Create case type'}</button>`,
    onMount: (f) => {
      mount(f);
      f.querySelector('#tdel')?.addEventListener('click', async () => {
        const n = S.data().cases.filter((c) => c.templateId === t.id).length;
        if (!confirm(n ? `Delete ${t.name}? ${n} existing case${n > 1 ? 's keep their' : ' keeps its'} fields. To stop offering it but keep it in search filters, archive it instead.` : `Delete ${t.name}?`)) return;
        if (await guard(() => S.deleteTemplate(t.id), 'Case type deleted.')) document.getElementById('modal').close();
      });
    },
    onSubmit: async (f) => {
      collect(f);
      await S.saveTemplate(draft);
      toast(t?.id ? 'Case type saved.' : 'Case type created.');
    },
  });
}

