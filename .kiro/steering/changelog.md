---
inclusion: auto
---

# Project Changelog & Session Context

This file tracks all significant changes to the Children of Promise daycare management system. Use this for session continuity.

## Architecture
- **Server:** Node.js on Windows Server (`C:\app\Internal\server.js`), port 80+443
- **Database:** SQL Server Express (`localhost\SQLEXPRESS`, DB: `CofPMillstadt`)
- **Deploy:** Push to GitHub → `git pull` + `Launch.bat` on server
- **Pages:** Staff portal (`index.html`), EMS (`ems.html`), ISBE (`isbe.html`), Food Program (`foodreport.html`), Menus (`menus.html`), Parent Portal (`parent.html`)

## ⚠️ CRITICAL: Laptop ≠ Server — Code vs Data (read before any DB change)
Kiro's tools (terminal, file edits, `sqlcmd`) run on the **laptop**, NOT the live
server. The laptop has its own local `localhost\SQLEXPRESS\CofPMillstadt` copy. The
**live site reads the database on the server at `160.153.187.39`** (SQL Server 2022,
login `cofpadmin`). These are two different databases.

- **Code changes** (server.js, HTML, JS) travel through git:
  commit → push → **Deploy** button (pulls on server) → **Restart** if server.js changed.
  This is the correct, working path — the Deploy/Restart buttons are built into the site.
- **Data changes** (any table row: `dimClassrooms` room names/capacities, enrollment
  records, etc.) do **NOT** travel through git or Deploy. They must be applied to the
  **server's** database directly:
  - Run in **SSMS connected to `160.153.187.39`** (DB `CofPMillstadt`), **or**
  - via `POST /api/sql` which runs on the server — BUT note `/api/sql` returns
    `{success:true}` even when a statement fails inside the batch (sqlcmd exits 0 and
    prints errors to stdout). Always include a trailing `SELECT` and verify the row
    actually changed; don't trust "executed successfully."
- **Do not verify a data change by querying from the laptop** — that hits the local
  copy and looks correct while the live site is unchanged. Verify on `160.153.187.39`.
- Lesson from the 2 & 3 Year Olds room rename (Sept 2026): every laptop-side
  `dimClassrooms` UPDATE looked correct locally but never touched the live site.
  It was only fixed by running the UPDATE in SSMS against `160.153.187.39`.

## 25 Oct 2026 — the eleven-day silent read failure (read `sql-reads.md`)

The worst bug this project has had, because it accused staff of not doing work they had
done. Full writeup and the rules that came out of it are in `.kiro/steering/sql-reads.md`.

**Symptom:** every PI child's Beg ASQ / Beg ASE chip turned from green to amber, and the
screening modal said "Required — no ASQ uploaded yet." Non-PI children were unaffected.

**Cause:** `/api/child-files` was rewritten on 14 Oct as
`` runSQLRows(`;WITH CandidateFiles AS (...)`) ``. `runSQLRows` embeds its argument in a
scalar subquery, where a CTE and a leading `;` are both illegal. It never compiled —
but `sqlcmd` exits 0, `runSQLRows` ignored `sqlError`, and zero parsed chunks fell
through to `return { ok: true, rows: [] }`. The endpoint answered **HTTP 200 with
`files: []`**, and the client's `.catch` turned that into "no child has any upload."

**Nothing was deleted.** The PDFs and their `ChildFiles` rows were intact throughout.

Fixed in `10d3acb` at three layers: derived table instead of the CTE; `runSQLRows` now
rejects a leading `WITH`/`;` and fails on "batch error + nothing parsed"; and
`ChildForms.loadFiles` now tracks `filesState` and throws instead of silently emptying.

**Debugging order that found it** (steps 1–2 both looked perfect, which is the trap):
query the table directly → run the endpoint's exact query → **check how the query is
wrapped** → then the browser. Three wrong theories were burned first; see `sql-reads.md`
for what they were so they are not re-tried.

### Also landed this session
- **Weighted Eligibility** unified to one generated PDF per child, superseded copies
  archived rather than deleted (`7bc1ccc`), and the roster pill fixed — it showed
  "Create form" for every child because of a `Promise.all` destructuring off-by-one
  (`9e5a5d8`).
- **Pre-enrollment → Parent Interview crosswalk** (`29422f3`): one declarative mapping
  in `pi-interview-schema.js`, replacing two drifted copies; 17 previously-dropped
  answers now carried forward.
- **ASQ/ASE screening rule documented honestly** (`9a137ba`): the questionnaire upload is
  **required for PI, optional for non-PI**. Six places in the app said "optional" flat
  out while the code enforced otherwise — including a column header sitting directly
  above an amber cell. Decision recorded in `compliance.md`.
- `ChildForms.screeningNeeds()` / `phraseList()` added so the roster and staff portal
  phrase "what's still missing" from one source. The roster's old copy said "the ASQ
  upload" on ASE cells.

## Recent Changes (June 2026 Session)

### Food Program Management System (`foodreport.html`)
- Standalone page at `/staff/foodreport.html` — no longer part of EMS
- Titled "Food Program Management System"
- Left sidebar: Food Program summary, Full Roster, Monthly Count Sheets, Weekly Menus
- Full Roster: editable Room/Income/HH with save → F/R/P recalculates live
- Removed PFA/PI column from roster (managed elsewhere)
- Monthly Food Count Sheets: ISBE 68-75 format, per classroom, attendance + Breakfast/Lunch/PM Snack
- Sorted Free/Reduced/Paid, weekend shading, bold names, month picker
- Portal card links directly to this page

### Weekly Menu Planner (`menus.html`)
- 4-week rotating templates (PFA + Birth to Three)
- Auto-fills next week's dates, rotates template by ISO week mod 4
- Seasonal/holiday themes: SVG corner art (110px), gradient banners, colored headers, themed borders
- Holidays: 4th of July, Halloween, Thanksgiving, Christmas, Valentine's, St. Patrick's, Easter
- Google Fonts: Dancing Script (dates), Fredoka (subtitles)
- Print: landscape, 2 sheets (Preschool + Birth to Three), decorative art row below table
- Templates populated from spreadsheet data

### ISBE PFA/PI Management (`isbe.html`)
- PFA Roster / PI Roster with compliance checklists
- Columns: Permission Slip, Parent Interview, Proof of Income, Enter into SIS, Beg ASQ, Beg ASE, Mid Year Report, End ASQ, End ASE, End Year Report, Remove from SIS
- PFA Compliance: Written Annual Self-Assessment, Compliance CQIP (SharePoint linked), ECERS-3 CQIP (SharePoint linked), PEL/ECE Level 5, Paraprofessional, PFA Calendar
- PI Compliance: Written Annual Self-Assessment (SharePoint linked), Compliance CQIP, ITERS-3 CQIP, PI Calendar
- SharePoint document links with 📄 Open buttons
- Permission Slip, Parent Interview, ASQ/ASE screening forms (modals)

### EMS (`ems.html`)
- Hidden from EMS form: IEP, Military, Benefits checkboxes, Income, HH Size, Proof of Income (still in DB, managed on Benefits tab)
- Reports sidebar: Attendance, Program Type, Pay Type, CCAP, Summer Program
- CCAP Report: collapsible eligible list, collapsible thresholds chart (effective date shown), Full CCAP Roster with eligibility dates, export button
- Waiting list: counts now separate pending vs contacted
- Alerts: CCAP eligible, CCAP renewals, waiting list pending, summer unmatched

### Thresholds
- USDA Free/Reduced: 2025 and 2026 thresholds in place
- CCAP (225% FPL): 2025 = [35213,47588,59963,72338,84713,97088,109463,121838], 2026 = [35910,48690,61470,74250,87030,99810,112590,125370]
- Auto-switches July 1 each year based on `_usdaYear`
- Server.js ccapEligible query uses 2025 thresholds (needs manual update July 1)

### Server Fixes
- CCAPStartDate ALTER TABLE separated from SELECT (was causing empty rosters)
- Restart endpoint uses detached `Launch.bat` spawn instead of broken schtasks
- Parse filter: excludes non-data lines from sqlcmd output (Commands completed, Changed database, requires `|`)

### Staff Portal (`index.html`)
- Cards: Enrollment Management, ISBE PFA/PI Management, Food Program
- Scan Document card removed

### Parent Portal
- Code-based login, permission slip signing, parent interview form
- Conference button for video calls

## Known Issues / TODOs
- Server.js CCAP thresholds hardcoded in SQL — needs update July 1, 2026
- Menu templates saved in-memory only (not persisted to DB on template update)
- fullContext.md needs updating for next session
