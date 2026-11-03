// Demo seeding for showing the tracker on GitHub Pages. All names and cases are fictional.
import * as S from './store.js';

export const DEMO_ACCOUNTS = [
  { username: 'admin.demo', password: 'Demo-Admin-2026!', role: 'admin', displayName: 'Demo Admin' },
  { username: 'lead.demo', password: 'Demo-Lead-2026!', role: 'teamlead', displayName: 'Noor Al Said' },
  { username: 'analyst.demo', password: 'Demo-Analyst-2026!', role: 'analyst', displayName: 'Hamed Al Riyami' },
];

const MIN = 60000, HOUR = 60 * MIN;

export async function seedDemo() {
  const [adm, lead, an] = DEMO_ACCOUNTS;
  await S.initialize({ username: adm.username, displayName: adm.displayName, password: adm.password, teamName: 'Demo SOC' });
  S.markDemo();
  const users = {};
  for (const a of [lead, an]) {
    const u = await S.createUser({ username: a.username, displayName: a.displayName, role: a.role, password: a.password });
    u.mustChange = false;
    users[a.role] = u;
  }
  const d = S.data();
  const now = Date.now();
  const specs = [
    { name: 'Expired TLS certificate on internal HR portal', sev: 'Low', esc: 'Application Support', src: 'Vulnerability scan', ago: 27 * HOUR, ack: 45, by: 'analyst' },
    { name: 'Malware blocked on USB at a branch workstation', sev: 'Medium', esc: 'IT Infrastructure', src: 'EDR', ago: 11 * HOUR, ack: 14, by: 'analyst', closeAfter: 2 * HOUR, closer: 'teamlead' },
    { name: 'Phishing email reported by treasury staff', sev: 'Medium', esc: 'Email Security', src: 'User report', ago: 7 * HOUR, ack: 20, by: 'teamlead', closeAfter: 90 * MIN, closer: 'analyst' },
    { name: 'Multiple failed logins on core banking admin portal', sev: 'Critical', esc: 'IAM Team', src: 'SIEM', ago: 5 * HOUR, ack: 22, by: 'analyst' },
    { name: 'Suspicious PowerShell on branch workstation WS-114', sev: 'High', esc: 'IT Infrastructure', src: 'EDR', ago: 3 * HOUR, ack: 12, by: 'teamlead' },
    { name: 'Impossible travel sign-in on an executive mailbox', sev: 'High', esc: 'IAM Team', src: 'SIEM', ago: 70 * MIN, ack: null, by: 'analyst' },
  ];
  for (const s of specs) {
    const det = now - s.ago;
    const c = await S.saveCase({
      name: s.name, severity: s.sev, escalatedTo: s.esc, source: s.src,
      detectedAt: det, reportedAt: det + 3 * MIN, ackAt: s.ack ? det + s.ack * MIN : null,
      status: 'WIP', slaManual: false, slaBreach: 'N', notes: 'Demo case. Triage notes go here.',
    });
    const who = users[s.by]?.id || S.currentUser().id;
    c.createdBy = who; c.createdAt = det + 4 * MIN; c.history[0].by = who; c.history[0].at = c.createdAt;
    c.slaBreach = S.computeSla(c);
    if (s.closeAfter) {
      c.status = 'Closed'; c.closedAt = det + s.closeAfter; c.closedBy = users[s.closer].id;
      c.history.push({ at: c.closedAt, by: c.closedBy, action: 'updated', changes: [{ field: 'Status', from: 'WIP', to: 'Closed' }] });
    }
  }
  const today = new Date();
  const iso = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const open = d.cases.filter((c) => c.status !== 'Closed');
  d.handovers.push({
    id: crypto.randomUUID(), shift: 'M', date: iso(today), author: users.analyst.id, createdAt: now - 2 * HOUR, updatedAt: now - 2 * HOUR,
    body: 'Core banking brute force: IAM locked the account, still waiting for confirmation it was the vendor pen test.\nWS-114 isolated by IT. Waiting for the EDR forensic package.\nWatch the VIP mailbox sign-ins overnight.',
    openCaseIds: open.map((c) => c.id), readBy: [users.analyst.id],
  });
  d.notices.push({
    id: crypto.randomUUID(), title: 'Change freeze on the payment gateway until Thursday', priority: 'important',
    body: 'Escalate any alert on the payment gateway servers straight to the team lead. No rule tuning on those sources this week.',
    author: users.teamlead.id, createdAt: now - 6 * HOUR, updatedAt: now - 6 * HOUR, expiresAt: null, acks: [],
  });
  // schedule for this month and next
  const names = [
    { name: lead.displayName, userId: users.teamlead.id }, { name: an.displayName, userId: users.analyst.id },
    { name: 'Laila Al Habsi' }, { name: 'Yousuf Al Maskari' }, { name: 'Aisha Al Busaidi' }, { name: 'Salim Al Hinai' },
  ];
  const pattern = ['M', 'M', 'M', 'A', 'A', 'O', 'O'];
  for (const off of [0, 1]) {
    const base = new Date(today.getFullYear(), today.getMonth() + off, 1);
    const days = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
    const rows = names.map((n, i) => {
      const cells = {};
      for (let dd = 1; dd <= days; dd++) {
        const dayIndex = Math.floor((new Date(base.getFullYear(), base.getMonth(), dd) - new Date(2026, 0, 1)) / 86400000);
        cells[String(dd)] = pattern[(dayIndex + i * 2) % 7];
      }
      if (i === 4 && off === 0) for (let dd = 20; dd <= Math.min(24, days); dd++) cells[String(dd)] = 'AL';
      return { ...n, cells };
    });
    d.schedule.months[S.monthKey(base.getFullYear(), base.getMonth())] = { rows, updatedAt: now };
  }
  S.addAudit('demo.seed', 'Loaded demo data');
  await S.commit();
  S.logout();
}
