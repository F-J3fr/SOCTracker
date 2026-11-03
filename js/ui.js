// Shared UI helpers: formatting, toasts, modal, template field widgets.
import * as S from './store.js';

const $modal = document.getElementById('modal');
const $toasts = document.getElementById('toasts');

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const pad = (n) => String(n).padStart(2, '0');
export function fmt(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const toInput = (ts) => (ts ? fmt(ts).replace(' ', 'T') : '');
export const fromInput = (v) => (v ? new Date(v).getTime() : null);
export function dur(ms) {
  if (ms == null) return '—';
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
export const minutesOf = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
export const SEV_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };
export function csvCell(v) { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

export function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $toasts.appendChild(el);
  setTimeout(() => el.remove(), err ? 6500 : 3500);
}
export async function guard(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r ?? true; }
  catch (e) { if (e.code) console.warn(e); toast(e.message || String(e), true); return false; }
}
export function download(name, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
export function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept;
    inp.onchange = () => resolve(inp.files[0] || null);
    inp.click();
  });
}
export function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Working…'; btn.disabled = true; }
  else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
}

// ---------------------------------------------------------------- re-render coordination
// Background sync must never wipe what someone is typing. Views mark filter inputs with
// data-live; any other input marks the page dirty, and updates wait until it's saved.
let renderFn = () => {};
let pending = false;
let dirty = false;
export function setRender(fn) { renderFn = fn; }
export function markClean() { dirty = false; pending = false; updatesBar(false); }
export function markDirty() { dirty = true; }
export function refresh() {
  if ($modal.open) { pending = true; return; }
  if (dirty) { pending = true; updatesBar(true); return; }
  renderFn();
}
export function forceRender() { markClean(); renderFn(); }
function updatesBar(show) {
  const el = document.getElementById('updates');
  if (el) el.classList.toggle('hidden', !show);
}

// ---------------------------------------------------------------- modal
export function modalOpen() { return $modal.open; }
export function openModal({ title, body, foot = '', onMount, onSubmit, width }) {
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
    catch (err) { if (err.code) console.warn(err); if (errEl) errEl.textContent = err.message; else toast(err.message, true); }
    finally { busy(btn, false); }
  });
  if (!$modal.open) $modal.showModal();
  onMount?.(form);
  const first = form.querySelector('input:not([type=hidden]):not([readonly]), select, textarea');
  first?.focus();
}
export function closeModal() {
  if ($modal.open) $modal.close();
  $modal.innerHTML = '';
  if (pending && !dirty) { pending = false; renderFn(); }
}
// The close event fires asynchronously, so a follow-up modal may already be open by then.
$modal.addEventListener('close', () => { if ($modal.open) return; $modal.innerHTML = ''; if (pending && !dirty) { pending = false; renderFn(); } });

// ---------------------------------------------------------------- report window
export function settings() { return S.data().settings; }
export function windowEnding(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = settings().reportCutoff.split(':').map(Number);
  const end = new Date(y, m - 1, d, hh, mm).getTime();
  return { start: end - 86400000, end };
}
export function currentWindow() {
  const now = new Date();
  let w = windowEnding(ymd(now));
  if (Date.now() >= w.end) { const t = new Date(now); t.setDate(t.getDate() + 1); w = windowEnding(ymd(t)); }
  return w;
}
export function currentShift(now = new Date()) {
  const n = now.getHours() * 60 + now.getMinutes();
  for (const code of ['M', 'A']) {
    const t = settings().shiftTimes[code];
    const s = minutesOf(t.start), e = minutesOf(t.end);
    if (s < e ? n >= s && n < e : n >= s || n < e) return code;
  }
  return null;
}

// ---------------------------------------------------------------- template field widgets
export function requiredMark(mode) {
  if (mode === 'always') return ' <span class="req" title="Required">*</span>';
  if (mode === 'close') return ' <span class="req-close">required to close</span>';
  return '';
}
export function fieldInput(fd, value, idPrefix = 'tf') {
  const id = `${idPrefix}-${fd.id}`;
  const v = value ?? '';
  const label = `<label for="${id}">${esc(fd.label)}${requiredMark(fd.required)}</label>`;
  const help = fd.help ? `<div class="hint">${esc(fd.help)}</div>` : '';
  let input;
  switch (fd.type) {
    case 'textarea': input = `<textarea id="${id}" data-fid="${fd.id}" maxlength="5000">${esc(v)}</textarea>`; break;
    case 'number': input = `<input type="number" step="any" id="${id}" data-fid="${fd.id}" value="${esc(v)}">`; break;
    case 'datetime': input = `<input type="datetime-local" id="${id}" data-fid="${fd.id}" value="${toInput(v)}">`; break;
    case 'select': input = `<select id="${id}" data-fid="${fd.id}"><option value=""></option>${(fd.options || []).map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`; break;
    case 'yesno': input = `<select id="${id}" data-fid="${fd.id}"><option value=""></option><option ${v === 'Yes' ? 'selected' : ''}>Yes</option><option ${v === 'No' ? 'selected' : ''}>No</option></select>`; break;
    case 'user': input = `<select id="${id}" data-fid="${fd.id}"><option value=""></option>${S.data().users.filter((u) => !u.disabled || u.id === v).map((u) => `<option value="${u.id}" ${u.id === v ? 'selected' : ''}>${esc(u.displayName)}</option>`).join('')}</select>`; break;
    default: input = `<input id="${id}" data-fid="${fd.id}" maxlength="300" value="${esc(v)}">`;
  }
  const wide = fd.type === 'textarea' ? ' wide' : '';
  return `<div class="field${wide}">${label}${input}${help}</div>`;
}
export function readFields(root, fields) {
  const out = {};
  for (const fd of fields) {
    const el = root.querySelector(`[data-fid="${fd.id}"]`);
    if (!el) continue;
    out[fd.id] = fd.type === 'datetime' ? fromInput(el.value) : el.value.trim();
    if (out[fd.id] === null) out[fd.id] = '';
  }
  return out;
}
export function fieldDisplay(fd, v) {
  if (v === undefined || v === null || v === '') return '';
  if (fd.type === 'datetime') return fmt(v);
  if (fd.type === 'user') return S.userName(v);
  return String(v);
}
