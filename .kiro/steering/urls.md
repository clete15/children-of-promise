# Site URLs

Server IP: `160.153.187.39` (Port 80)
Domain: `childrenofpromisedaycare.com`

| Site | URL |
|------|-----|
| External / Public Site | https://childrenofpromisedaycare.com/ |
| Admin Portal | https://childrenofpromisedaycare.com/portal |
| Internal Staff Portal | https://childrenofpromisedaycare.com/staff/ |
| ISBE PFA/PI Management | https://childrenofpromisedaycare.com/staff/isbe.html |

## Architecture

- **Server:** Node.js on Windows Server (`C:\app\Internal\server.js`), port 80 + 443 (SSL via Let's Encrypt)
- **Database:** SQL Server Express (`localhost\SQLEXPRESS`, DB: `CofPMillstadt`)
- **Tables:** `rptMasterEnrollment` (students, has Id PK), `dimClassrooms`, `PreEnrollment` (waiting list), `ISBETracking` (linked by StudentId), `SummerProgram`
- **GitHub:** https://github.com/clete15/children-of-promise.git (branch: master)
- **Deploy:** Push to GitHub → Deploy button on portal or `git pull` on server → restart with `.\startup.bat`

## Current Tabs (ems.html)

Waiting List | EMS | Room Roster | Benefits | Reports | Alerts

## ISBE Page (isbe.html)

- PFA Roster / PI Roster sidebar
- Checklist columns: Permission Slip, Parent Interview, Proof of Income, Beg ASQ, Beg ASE, Mid Year Report, End ASQ, End ASE, End Year Report
- Linked to `ISBETracking` table by `StudentId` (FK to `rptMasterEnrollment.Id`)

## Next Task

Build a **Parent Interview Form** modal on the ISBE page:
- Opens when clicking "Parent Interview" column header for a student
- Pre-fills from enrollment data (child name, DOB, room, household income, HH size, benefits, IEP, foster, military, etc.)
- Manual fields: parent goals, concerns, strengths, signatures, date
- Save button (stores to DB) and Print button
- When saved, auto-checks the ParentInterview checkbox for that student

## F/R/P Rules

- Free: public benefits (WIC/Medicaid/SNAP/TANF), Foster, Military, PFA program, or income ≤ 130% FPL
- Reduced: income ≤ 185% FPL
- Paid: everything else
- Thresholds auto-select by date (2025-2026 active now, 2026-2027 activates July 1, 2026)
- CCAP eligibility: 225% FPL (separate from food program)

## Backlog

- **SSL Certificate** — ✅ Done (Let's Encrypt, auto-renews)
- **Install SSMS locally** — ✅ Done
- **Parent Interview Form** — Next up
- **Cloudflare / transfer domain from Wix** — Wix won't change nameservers; SSL done directly instead
