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
