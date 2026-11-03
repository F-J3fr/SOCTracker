// Excel import/export via SheetJS (vendored in /vendor, no CDN).
/* global XLSX */
const pad = (n) => String(n).padStart(2, '0');
const fmt = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function normalizeCode(v) {
  const s = String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!s) return '';
  if (['M', 'MORNING', 'AM', 'D', 'DAY'].includes(s)) return 'M';
  if (['A', 'AFTERNOON', 'PM', 'E', 'EVENING'].includes(s)) return 'A';
  if (['O', 'OFF', 'OFF DAY', 'RD', 'REST', 'X', 'W/O', 'WO'].includes(s)) return 'O';
  if (['AL', 'A/L', 'A.L', 'ANNUAL LEAVE', 'LEAVE', 'L', 'VAC', 'VACATION'].includes(s)) return 'AL';
  return null; // unknown
}

/** Returns {day, year?, month?} for a header cell that represents a day of the month, else null. */
function headerDay(v) {
  if (v instanceof Date && !isNaN(v)) return { day: v.getDate(), year: v.getFullYear(), month: v.getMonth() };
  if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= 1 && v <= 31) return { day: v };
    if (v > 30000 && v < 80000) { // Excel serial date
      const p = XLSX.SSF.parse_date_code(v);
      if (p) return { day: p.d, year: p.y, month: p.m - 1 };
    }
    return null;
  }
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return { day: +m[3], year: +m[1], month: +m[2] - 1 };
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/); // d/m/y (day-first)
  if (m) return { day: +m[1], month: +m[2] - 1, year: m[3].length === 2 ? 2000 + +m[3] : +m[3] };
  m = s.match(/^(?:[A-Za-z]{2,9}\.?\s*)?(\d{1,2})(?:st|nd|rd|th)?(?:[\s-]+[A-Za-z]{3,9})?$/); // "1", "Sun 1", "1-Nov", "Mon 3rd"
  if (m && +m[1] >= 1 && +m[1] <= 31) return { day: +m[1] };
  return null;
}

/**
 * Parse an uploaded schedule. Expected shape (flexible):
 *   row with day headers (1..31, dates, or "Sun 1"), first text column = analyst name,
 *   cells contain M / A / O / AL (also accepts OFF, A/L, Morning, Afternoon…).
 */
export function importScheduleWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('The file has no sheets.');
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  let hdr = -1, dayCols = [];
  for (let r = 0; r < Math.min(grid.length, 15); r++) {
    const cols = [];
    grid[r].forEach((v, c) => { const h = headerDay(v); if (h) cols.push({ c, ...h }); });
    // need a run of increasing day numbers to count as the header
    const uniq = new Set(cols.map((x) => x.day));
    if (uniq.size >= 7) { hdr = r; dayCols = cols; break; }
  }
  if (hdr < 0) throw new Error('Could not find the row with day numbers (1, 2, 3…). Use Download template for the expected layout.');
  const firstDayCol = Math.min(...dayCols.map((x) => x.c));
  // name column: right-most non-day column before the first day column that has text in data rows
  let nameCol = 0;
  for (let c = firstDayCol - 1; c >= 0; c--) {
    const hasText = grid.slice(hdr + 1).some((row) => typeof row[c] === 'string' && row[c].trim() && normalizeCode(row[c]) === null);
    if (hasText) { nameCol = c; break; }
  }
  const dated = dayCols.find((x) => x.year != null && x.month != null);
  const rows = []; let skipped = 0;
  for (let r = hdr + 1; r < grid.length; r++) {
    const name = String(grid[r][nameCol] ?? '').trim();
    if (!name || /^(total|legend|key|notes?)\b/i.test(name)) continue;
    const cells = {}; let any = false;
    for (const dc of dayCols) {
      const code = normalizeCode(grid[r][dc.c]);
      if (code === null) { skipped++; continue; }
      if (code) { cells[String(dc.day)] = code; any = true; }
    }
    if (any || dayCols.some((dc) => String(grid[r][dc.c]).trim() === '')) rows.push({ name, cells });
  }
  const cleaned = rows.filter((r) => Object.keys(r.cells).length);
  if (!cleaned.length) throw new Error('Found the day columns but no M, A, O or AL entries under them.');
  return { rows: cleaned, dayCount: new Set(dayCols.map((x) => x.day)).size, skipped, year: dated?.year, month: dated?.month };
}

function monthGrid(y, m) {
  const days = new Date(y, m + 1, 0).getDate();
  return Array.from({ length: days }, (_, i) => ({ d: i + 1, dow: DOW[new Date(y, m, i + 1).getDay()] }));
}

export function downloadScheduleTemplate(y, m, names) {
  const days = monthGrid(y, m);
  const aoa = [
    [`Shift schedule ${MONTHS[m]} ${y}`],
    ['Use M = Morning, A = Afternoon, O = Off, AL = Annual leave'],
    ['', ...days.map((x) => x.dow)],
    ['Analyst', ...days.map((x) => x.d)],
    ...(names.length ? names : ['Analyst name']).map((n) => [n, ...days.map(() => '')]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 24 }, ...days.map(() => ({ wch: 4.5 }))];
  ws['!freeze'] = { xSplit: 1, ySplit: 4 };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Schedule');
  XLSX.writeFile(wb, `shift-schedule-template-${y}-${pad(m + 1)}.xlsx`);
}

export function exportScheduleXlsx(month, y, m, team) {
  const days = monthGrid(y, m);
  const aoa = [
    [`${team} shift schedule ${MONTHS[m]} ${y}`],
    ['', ...days.map((x) => x.dow)],
    ['Analyst', ...days.map((x) => x.d)],
    ...month.rows.map((r) => [r.name, ...days.map((x) => r.cells[String(x.d)] || '')]),
    [],
    ['M = Morning, A = Afternoon, O = Off, AL = Annual leave'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 24 }, ...days.map(() => ({ wch: 4.5 }))];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Schedule');
  XLSX.writeFile(wb, `shift-schedule-${y}-${pad(m + 1)}.xlsx`);
}

const REPORT_HEADERS = ['#', 'Case Reference', 'Case Name', 'Escalated Team / User', 'Severity', 'Detection Date & Time', 'Reported Date & Time', 'Acknowledgement Date & Time', 'SLA Breach (Y/N)', 'Status', 'Opened By', 'Closed By', 'Case Type', 'Incident'];
const reportRow = (x, i) => [i + 1, x.ref, x.name, x.escalatedTo, x.severity, fmt(x.detectedAt), fmt(x.reportedAt), fmt(x.ackAt), x.sla, x.status, x.openedBy, x.closedBy, x.caseType, x.incident];
const fileStamp = (r) => fmt(r.w.end).slice(0, 10);

export function downloadReportXlsx(r, meta) {
  const wb = XLSX.utils.book_new();
  const head = [
    [`${meta.team} daily report`],
    [`Window: ${fmt(r.w.start)} to ${fmt(r.w.end)}`],
    [`Generated by ${meta.by} at ${fmt(meta.at)}`],
    [],
    REPORT_HEADERS,
  ];
  const ws = XLSX.utils.aoa_to_sheet([...head, ...r.rows.map(reportRow)]);
  ws['!cols'] = [4, 18, 44, 26, 10, 19, 19, 19, 10, 9, 18, 18, 18, 16].map((wch) => ({ wch }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 4, c: 0 }, e: { r: 4 + Math.max(r.rows.length, 1), c: REPORT_HEADERS.length - 1 } }) };
  XLSX.utils.book_append_sheet(wb, ws, 'Daily report');

  const sev = ['Critical', 'High', 'Medium', 'Low'];
  const count = (f) => r.rows.filter(f).length;
  const summary = [
    ['Summary', ''],
    ['Window start', fmt(r.w.start)], ['Window end', fmt(r.w.end)], [],
    ['Total cases', r.rows.length],
    ['WIP at cutoff', count((x) => x.status === 'WIP')],
    ['Closed at cutoff', count((x) => x.status === 'Closed')],
    ['SLA breaches', count((x) => x.sla === 'Y')],
    ['Carried over from earlier', count((x) => x.carried)],
    ['Incidents', r.incidents.length], [],
    ['Severity', 'Cases', 'SLA breaches'],
    ...sev.map((s) => [s, count((x) => x.severity === s), count((x) => x.severity === s && x.sla === 'Y')]),
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(summary);
  ws2['!cols'] = [{ wch: 28 }, { wch: 18 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'Summary');

  if (r.incidents.length) {
    const ws4 = XLSX.utils.aoa_to_sheet([['Incident Reference', 'Title', 'Severity', 'Category', 'Status at Cutoff', 'Owner', 'Declared', 'Contained', 'Closed', 'Linked Cases', 'Log Updates in Window'],
      ...r.incidents.map((x) => [x.ref, x.title, x.severity, x.category, x.status, x.owner, fmt(x.declaredAt), fmt(x.containedAt), fmt(x.closedAt), x.cases, x.updates])]);
    ws4['!cols'] = [18, 44, 10, 22, 16, 20, 17, 17, 17, 30, 12].map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, ws4, 'Incidents');
  }
  if (r.handovers.length) {
    const ws3 = XLSX.utils.aoa_to_sheet([['Date', 'Shift', 'Author', 'Posted', 'Notes'],
      ...r.handovers.map((h) => [h.date, h.shift === 'M' ? 'Morning' : 'Afternoon', h.authorName || '', fmt(h.createdAt), h.body])]);
    ws3['!cols'] = [{ wch: 12 }, { wch: 11 }, { wch: 20 }, { wch: 17 }, { wch: 90 }];
    XLSX.utils.book_append_sheet(wb, ws3, 'Handovers');
  }
  XLSX.writeFile(wb, `soc-daily-report-${fileStamp(r)}.xlsx`);
}

export function downloadReportCsv(r, meta, download) {
  const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [[`${meta.team} daily report ${fmt(r.w.start)} to ${fmt(r.w.end)}`], REPORT_HEADERS, ...r.rows.map(reportRow)];
  download(`soc-daily-report-${fileStamp(r)}.csv`, '﻿' + lines.map((l) => l.map(cell).join(',')).join('\r\n'), 'text/csv');
}
