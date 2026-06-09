# Children Of Promise – Full System Context

**Last Updated:** June 8, 2026  
**Purpose:** This file gives a new Kiro session full context on what's been built, how the system works, and what's pending.

---

## Architecture

- **Server:** Node.js (`Internal/server.js`) on Windows Server at `160.153.187.39`, ports 80+443 (SSL via Let's Encrypt)
- **Database:** SQL Server Express (`localhost\SQLEXPRESS`, DB: `CofPMillstadt`)
- **GitHub:** https://github.com/clete15/children-of-promise.git (branch: master)
- **Deploy:** Push to GitHub → Deploy button on portal (or `/api/deploy`) → Restart server (`startup.bat` or `/api/restart`)
- **Domain:** childrenofpromisedaycare.com

## Key URLs

| URL | What |
|-----|------|
| `/` | Public website (External folder) |
| `/parent` | Parent Portal (code-authenticated, no login) |
| `/portal` | Admin splash page |
| `/staff/` | Staff portal (password: `cofpadmin`, stored in localStorage with "Remember Me") |
| `/staff/ems.html` | Enrollment Management System |
| `/staff/isbe.html` | ISBE PFA/PI Management |

## Database Tables

| Table | Purpose |
|-------|---------|
| `rptMasterEnrollment` | All students (Id PK). Has: names, DOB, room, days, active, category, PFA_PI_na, F_R_P_Food, IEP, Military, HouseholdIncome, HouseholdSize, PublicBenefits, ProofOfIncomeUploaded, CCAPStartDate |
| `dimClassrooms` | Rooms: RoomNumber, Room, TeacherDescription, DCFSCapacity, AgeRange |
| `PreEnrollment` | Waiting list / pre-enrollment submissions (public form) |
| `ISBETracking` | Per-student checklist: PermissionSlip, ParentInterview, ProofOfIncome, BegASQ, BegASE, MidYearReport, EndASQ, EndASE, EndYearReport |
| `ParentInterviews` | Full PI interview form data (FormData column stores JSON) |
| `PermissionSlips` | Screening consent forms |
| `ScreeningScores` | ASQ-3 and ASQ:SE-2 scores per student per period |
| `ProgramCompliance` | Site-level compliance items (SchoolYear + FieldName + FieldValue) |
| `ParentCodes` | Access codes for parent portal (StudentId + 6-char Code) |
| `Conferences` | Active video conference links (StudentId + MeetUrl + Active flag) |
| `SummerProgram` | Summer program sign-ups |

## What's Built

### Staff Portal (`Internal/index.html`)
- Password gate with "Remember Me" (localStorage)
- Cards: EMS, ISBE, Scan Document (HP Smart web link)
- Server status indicator
- No more Basic Auth popup (removed)

### EMS (`Internal/ems.html`)
- **Tabs:** Waiting List | EMS | Room Roster | Benefits | Reports | Alerts
- **EMS tab:** View/edit/add students with room sidebar, nav arrows
- **Room Roster:** Daily capacity view, room settings (add/edit rooms)
- **Benefits Roster:** Editable income/HH size/pay type/benefits per student, CCAP Start Date column, hover tooltips on all column headers with thresholds and CCAP info
- **Waiting List:** Scored/prioritized by age group, status management
- **Reports:** Attendance, Food Program, Program Type, Pay Type, CCAP Eligible, Summer
- **Alerts:** CCAP eligible (inline editable table), CCAP renewals due, threshold updates (with Recalculate button), summer mismatches
- **Buttons per student:** 🔑 Parent Code (generate/view), 📹 Conference (Jitsi video call)
- **F/R/P auto-calculation** with USDA thresholds (auto-selects year based on July 1 cutover)

### ISBE Page (`Internal/isbe.html`)
- **Sidebar:** PFA Roster | PI Roster | PFA Compliance | PI Compliance
- **Roster columns:** Student, Room, Permission Slip, Parent Interview, Proof of Income, Beg ASQ, Beg ASE, Mid Year Report Card, End ASQ, End ASE, End Year Report Card
- **[form] links** on: Permission Slip, Parent Interview, Beg ASQ, End ASQ, Beg ASE, End ASE
- **Column header tooltips** describing what each item requires
- **Modals:**
  - Permission Slip (matches paper form, e-signature)
  - Parent Interview (pre-fills from enrollment data)
  - ASQ-3 Score Entry (5 domains + cutoff status)
  - ASQ:SE-2 Score Entry (total score + cutoff)
- **PFA Compliance:** CQIP, ECERS-3 CQIP, PEL/ECE Level 5, Paraprofessional, Parent Handbook, Curriculum Plan, Fire Drills, Health Screenings
- **PI Compliance:** CQIP, ITERS-3 CQIP, PEL/ECE Level 5, Paraprofessional, Parent Handbook, Curriculum Plan, Fire Drills, Developmental Screenings
- Compliance items tracked per school year with date completed

### Parent Portal (`Internal/parent.html`)
- Served at `/parent` (public, no staff auth)
- Parent enters 6-char access code → sees only their child
- **Forms available:** Permission Slip (e-sign), Parent Interview (full 7-page PI form digitized)
- **Conference:** "Join Video Call" banner appears when teacher starts a Jitsi call (polls every 15s)
- Pre-populates from enrollment + pre-enrollment data
- Saves code to localStorage for auto-login
- Electronic signature (typed name) — valid per ISBE/Illinois UETA

### Public Site (`External/`)
- Marketing pages (index, about, mission)
- Pre-enrollment form (submits to API, scored for waitlist priority)
- Summer program sign-up form

## Known Issues / Terminal Problem

- Kiro's PowerShell terminal cannot reliably execute git commands (they silently fail)
- All file edits work correctly but git add/commit/push must be done manually by the user
- Always run `& "C:\Program Files\Git\cmd\git.exe" status` before deploying to check for uncommitted changes
- Use the full path `& "C:\Program Files\Git\cmd\git.exe"` for all git commands (the bare `git` command produces no output)

## Backlog / Next Steps

1. **Verify all pending changes are pushed** — Run `git add -A && git commit && git push` from user's terminal
2. **Mid/End Year Report Card** — Just checkboxes (printed from Teaching Strategies), no form needed
3. **ISBE page alerts panel** — Move PFA/PI-specific alerts (like missing proof of income) here
4. **Staff credentials expansion** — Could add CPR/First Aid expiration, DCFS background check, Gateways level, annual training hours, mandated reporter training
5. **Attendance tracking** — Daily check-in per classroom for real meal counts
6. **Billing/payment tracking** — Monthly ledger per student based on pay type and days enrolled
7. **Parent communication** — Email/text notifications for closures, events, payment reminders
8. **ISBE export** — Generate CSV/reports in ISBE's required format for grant reporting

## Key Business Rules

- **Free meals:** Public benefits (WIC/Medicaid/SNAP/TANF), Foster, Military, PFA program, or income ≤ 130% FPL
- **Reduced meals:** Income ≤ 185% FPL
- **Paid meals:** Everything else
- **CCAP eligibility:** 225% FPL (separate from food program)
- **Thresholds auto-select:** July 1 = new year's thresholds activate
- **CCAP renewals:** 12-month cycles, parent gets redetermination form automatically from CCR&R
- **ASQ/ASE:** Parent-completed tools; teacher scores. ISBE accepts electronic signatures.

## USDA Thresholds in System

```javascript
// Household sizes 1-8
2025: { free: [20163,27339,34515,41691,48867,56043,63219,70395], reduced: [28694,38907,49120,59333,69546,79759,89972,100185] }
2026: { free: [20748,28132,35516,42900,50284,57668,65052,72436], reduced: [29526,40034,50542,61050,71558,82066,92574,103082] }
CCAP 2025: [35888,48668,61448,74228,87008,99788,112568,125348]
```
