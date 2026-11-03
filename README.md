# SOC Tracker

A shared shift tracker for SOC analyst teams. It covers case tracking with case templates, an incident tracker, search across history, shift handovers, team-lead notices, the shift schedule and an auto-generated daily report. Each analyst, team lead and admin has their own login.

The site is a static page on GitHub Pages. Data is stored in a Supabase (Postgres) database, but **it's encrypted in the browser before it's sent**. The database only ever holds ciphertext, plus the minimum it needs to enforce access: record types, versions, timestamps, user IDs and roles.

## First-time setup (once)

1. In Supabase, go to **SQL Editor → New query**, paste the whole of [`supabase/setup.sql`](supabase/setup.sql) and select **Run**.
2. The result at the bottom shows a **setup code**. Copy it.
3. Open the site. It shows **Set up the tracker**. Enter the setup code, your team name and the first admin account.
4. Sign in and create everyone else's accounts under **Users**.

Without the setup code nobody can claim the tracker, even though the site is public. The code is deleted once the first admin exists. The script is safe to run again later, for example after an update: it replaces the functions and keeps all data.

The project URL and publishable key are in `js/config.js`. The publishable key is designed to be public. **Never put the secret (`sb_secret_…`) or service-role key in this repo.** The app doesn't need it.

## Features

**Case tracker.** Case name, escalated team or user, severity, detection, reported and acknowledgement date and time, SLA breach (Y/N), and status, which stays WIP until closed. Any analyst can close another analyst's case. SLA breach is calculated from per-severity targets and can be overridden. Each case has comments and a full change history.

**Case templates (case types).** Anyone can build case types in the app. Analysts can edit the ones they created; team leads and admins can edit, archive or delete any of them. Each type has:
- **Its own fields:** short text, long text, number, date and time, pick from a list, yes or no, or team member.
- **A rule for each field:** optional, required to save, or required to close.
- **Mandated standard fields:** it can also require some of the standard fields (escalated to, reported time, acknowledgement time, source, notes).

Analysts pick the type when logging a case, and the form enforces it. Closing a case prompts for any "required to close" fields still empty. Existing cases keep the fields they were created with, even if the template changes later. There's a one-click starter set: Phishing, Malware alert and Account lockout.

**Incident tracker.** From any case, **Escalate to incident** declares a new incident or links the case to one that's already open. Incidents have:
- **Details:** severity, category, owner, start time, summary and impact, affected assets, root cause and lessons learned.
- **Lifecycle:** Open, Contained, Eradicated, Recovered, Closed, with each stage's time recorded.
- **A running incident log** of actions taken.

Closing an incident requires a summary and root cause. Linked cases show the incident badge everywhere.

**Incident stage from the case.** Every case escalated to an incident has an **Incident stage** dropdown, as does the incident itself. Analysts can move the incident to any stage, including back to an earlier one. **Every change requires a written reason.** It's saved to the incident log and the audit log with the person's name and time, and the case shows the latest change and its reason.

**Locked fields, with team lead and admin corrections.** For analysts, these can't be edited once saved:
- **Cases:** the case name and detection time; the reported time once it's been filled in.
- **Incidents:** the title, owner and start time.

Team leads and admins can edit all of them:
- **Reassigning the owner** needs a written reason, which goes to the incident log.
- **Other changes** to these fields are recorded in the case history or incident log with the old and new values.

For analysts the fields show as locked, and the data layer refuses changes to them.

**Search history.** Search all cases and incidents by:
- **Keyword:** names, notes, comments, incident logs and case-type fields.
- **Person and role:** opened, closed, commented or edited, escalated to them, incident owner, declared the incident.
- **Case type, then a specific field and value**, for example Phishing where Verdict = Malicious.
- **Severity, status and date range.**

Results export to CSV, including the chosen case type's fields as columns.

**Daily report.** Download as Excel (Daily report, Summary, Incidents and Handovers sheets), CSV or PDF. It covers the 24 hours ending at the cutoff (default 18:00 to 18:00), with statuses as they were at the cutoff.

**Shift handover, notices and shift schedule.** These work as before. Handovers have read tracking. Notices must be acknowledged, and team leads see who has acknowledged. The schedule is M, A, O or AL, built in the app or imported from Excel, with a template download.

**Live for the whole team.** Changes appear on everyone's screen within about 8 seconds. When two people save the same case at once, both changes are kept: comments, log entries and acknowledgements merge, and later field edits win. Background updates never wipe what you're typing. You get a **New updates** button instead.

### Roles

| | Analyst | Team lead | Admin |
|---|:-:|:-:|:-:|
| Log, edit, close and reopen cases; comment; escalate to incidents | ✓ | ✓ | ✓ |
| Declare and update incidents; write handovers; search; download reports | ✓ | ✓ | ✓ |
| Delete cases and incidents; post notices; edit the schedule and settings | | ✓ | ✓ |
| Correct locked fields (case name and times, incident title, owner and start) | | ✓ | ✓ |
| Create case templates and edit your own | ✓ | ✓ | ✓ |
| Edit, archive or delete anyone's case templates; view the audit log | | ✓ | ✓ |
| Create, reset and disable analyst and team lead accounts | | ✓ | ✓ |
| Create, reset and disable admin accounts | | | ✓ |

The database enforces these roles, not just the app. Calling the API directly with an analyst session can't post notices, read the audit log or create users.

## Security model

- **Data encryption:** each record is encrypted with AES-256-GCM using a team key, and bound to its row ID so ciphertext can't be swapped between records.
- **Passwords:** each password goes through PBKDF2-SHA256 (310,000 iterations), then HKDF splits the result into two keys:
  - a **sign-in key**, which the server stores only as a bcrypt hash;
  - a **key-encryption key**, which never leaves the browser and unwraps the team key.

  So the server can check a sign-in but can't decrypt anything.
- **Usernames:** the server stores a salted PBKDF2 hash of each username, never the name itself. Display names are encrypted.
- **Sign-in protection:** sessions last up to 12 hours and use random tokens stored hashed. Five failed sign-ins lock an account for 5 minutes. Disabling an account ends its sessions and deletes its key.
- **Audit:** sign-ins, failed sign-ins and account changes are written by the database itself. App events are also logged, encrypted.
- **Browser hardening:** strict Content Security Policy, all input escaped, and no third-party scripts or CDNs.

**Limits to know about**
- **No recovery.** If every admin forgets their password, nobody can decrypt the data.
- **Encryption isn't retroactive.** A disabled user can't sign in, but anything they already saw stays seen.
- **Free Supabase projects pause after a week with no activity.** Unpause them from the Supabase dashboard.
- **Approval first.** Don't put real incident data in a third-party cloud without your information security team's approval.

## Deploy

Push to `main`. GitHub Pages serves the repo root (**Settings → Pages → Deploy from a branch → `main` / root**).

## Project layout

```
index.html              App shell and Content Security Policy
css/app.css             Styles
js/config.js            Supabase URL and publishable key
js/api.js               Calls to the database functions
js/crypto.js            WebCrypto: PBKDF2, HKDF, AES-GCM, key wrapping
js/store.js             Encrypted sync, permissions, cases, incidents, templates, users
js/app.js               Routing, sign-in, dashboard, reports, handover, notices, schedule, users
js/cases.js             Case tracker, case form with templates, escalation
js/incidents.js         Incident tracker
js/templates.js         Case template builder
js/search.js            Search history
js/excel.js             Excel import and export
js/ui.js                Shared UI helpers
supabase/setup.sql      Database setup: run once in the Supabase SQL Editor
vendor/xlsx.full.min.js SheetJS 0.18.5 (Apache-2.0)
```
