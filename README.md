# SOC Tracker

A shift tracker for SOC analyst teams: case tracking, shift handovers, team-lead notices, shift schedules and an auto-generated daily report, with individual logins for analysts, team leads and admins.

**This is a proof of concept.** It runs entirely in the browser as a static site on GitHub Pages. There is no server, so each browser keeps its own encrypted copy of the data. See [Limits of this version](#limits-of-this-version) before using it with real case data.

## Try it

Open the GitHub Pages URL and select **Try the demo** on the setup screen. That loads a fictional team with sample cases, a handover, a notice and two months of schedule, plus three accounts:

| Role | Username | Password |
|---|---|---|
| Admin | `admin.demo` | `Demo-Admin-2026!` |
| Team lead | `lead.demo` | `Demo-Lead-2026!` |
| Analyst | `analyst.demo` | `Demo-Analyst-2026!` |

Demo data stays in that visitor's browser only. **Erase demo and start fresh** on the sign-in screen removes it.

## Features

**Case tracker.** Case name, escalated team or user, severity, detection, reported and acknowledgement date and time, SLA breach (Y/N), status (WIP until closed). Any analyst can close a case another analyst opened, and the tracker records who opened it and who closed it. Each case has a comment thread and a full change history. SLA breach is calculated from per-severity targets (detection to acknowledgement), and analysts can override it.

**Daily report.** Download as Excel (Daily report, Summary and Handovers sheets), CSV, or print to PDF. It covers the 24 hours ending at the cutoff (default 18:00 the previous day to 18:00 on the chosen day). Status is shown as it was at the cutoff. Cases still open from earlier days are included by default and can be switched off.

**Shift handover.** Analysts post notes for the next shift and attach the open cases they're handing over. Each handover tracks who has read it, and unread handovers are badged in the menu.

**Notices.** Team leads post items to pay attention to, marked normal or important, with an optional expiry date. Every analyst sees them on the dashboard until they acknowledge them, and the team lead sees who has acknowledged.

**Shift schedule.** Team leads build the month in the app (click a cell to cycle M, A, O, AL), import an Excel file, or copy last month's pattern. **Download template** gives a pre-filled sheet with the team's names and the month's days. Import also accepts OFF, A/L, Morning, Afternoon and date headers. Analysts see the month, today's roster and their own next 7 days.

**Users.** Admins and team leads create accounts, reset passwords, rename, change roles and disable accounts. New and reset accounts get a temporary password and must change it at first sign-in. Team leads can manage analysts and team leads but not admin accounts. That's deliberate: if a team lead could create admins, there would be no difference between the two roles. To change it, edit `can.manageTarget` and `can.assignRole` in `js/store.js`.

**Also included.** Dashboard with a 24-hour report-window timeline, audit log (with CSV export), settings for SLA targets, shift times, report cutoff and idle timeout, automatic sign-out after inactivity, lockout after 5 failed sign-ins, and encrypted backup, merge and restore.

### Roles

| | Analyst | Team lead | Admin |
|---|:-:|:-:|:-:|
| Log, edit, close and reopen cases; comment | ✓ | ✓ | ✓ |
| Write handovers, acknowledge notices, download reports | ✓ | ✓ | ✓ |
| Delete cases | | ✓ | ✓ |
| Post notices, edit the schedule, change settings, view the audit log | | ✓ | ✓ |
| Create, reset and disable analyst and team lead accounts | | ✓ | ✓ |
| Create, reset and disable admin accounts; replace or erase the data | | | ✓ |

## How the encryption works

Everything uses the browser's built-in WebCrypto API. There are no third-party crypto libraries.

- One random 256-bit key encrypts all tracker data (cases, notes, users, schedule, audit log) with **AES-256-GCM**. The data is re-encrypted with a fresh IV on every save.
- Each user's password is run through **PBKDF2-SHA256 (310,000 iterations, random salt)** to derive a key that wraps the data key. A wrong password can't unwrap it, so no password or password hash is stored anywhere.
- **Usernames** are stored only inside the encrypted data. The sign-in lookup uses a PBKDF2 hash of the username with a random per-install salt.
- Disabling an account deletes its key slot, so its password stops working immediately.
- The page sets a strict Content Security Policy (scripts only from this site, no inline scripts) and escapes all user input to block XSS.

What localStorage and backup files contain: a random salt, one wrapped key per user, and an encrypted blob. Nothing readable.

## Limits of this version

These come from running on GitHub Pages with no backend. Know them before you show it to anyone or put real data in it:

1. **Data is per browser.** Analysts on different machines don't see each other's changes automatically. To share work, use **Backup and sync**: download an encrypted backup, then **Merge** it on the other machine (the newest version of each record wins).
2. **The site is public.** GitHub Pages sites on free and Pro plans can be reached by anyone with the URL. The data itself never leaves the browser, but don't put links to the site anywhere public.
3. **Security is only as strong as the weakest password.** Anyone who has a copy of the encrypted data and any one valid password can read everything. Enforce strong passwords.
4. **Revocation isn't retroactive.** A disabled user's password no longer works on this copy, but it still opens older backup files they already had.
5. **Lockout and roles are enforced by the browser.** A technical user with the data and a valid password could bypass them with developer tools. Real enforcement needs a server.
6. **Don't put real incident data in it** without approval from your information security and compliance teams.

### Going to production

Keep this frontend and add a backend that holds the data and checks permissions:

- **Internal (recommended for regulated environments):** a small Node or Python API with PostgreSQL in a container on an internal VM, behind the corporate SSO. The data never leaves the network.
- **Cloud:** Supabase (Postgres, Auth, row-level security) with the frontend still on GitHub Pages. Only do this if policy allows SOC data on a third-party cloud.

## Deploy to GitHub Pages

```bash
cd SOCTracker
git init
git add .
git commit -m "SOC Tracker proof of concept"
git branch -M main
git remote add origin https://github.com/<your-username>/SOCTracker.git
git push -u origin main
```

Then on GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main`, folder `/ (root)` → Save.** After a minute or two the site is live at `https://<your-username>.github.io/SOCTracker/`.

To update, commit and `git push`. Pages redeploys automatically.

## Run locally

It has to be served over HTTP, because ES modules don't load from `file://`:

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

## Project layout

```
index.html              App shell and Content Security Policy
css/app.css             Styles (black and orange theme, print styles for the report)
js/crypto.js            WebCrypto: PBKDF2, AES-GCM, key wrapping
js/store.js             Encrypted storage, roles and permissions, cases, users, schedule, merge
js/app.js               Views and routing
js/excel.js             Schedule import and export, report Excel and CSV
js/demo.js              Demo data
vendor/xlsx.full.min.js SheetJS 0.18.5 (Apache-2.0), bundled locally so there's no CDN dependency
```
