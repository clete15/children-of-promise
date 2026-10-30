# Site URLs

Server IP: `160.153.187.39` (Port 80)
Domain: `childrenofpromisedaycare.com`

| Site | URL |
|------|-----|
| External / Public Site | https://childrenofpromisedaycare.com/ |
| Admin Portal | https://childrenofpromisedaycare.com/portal |
| Internal Staff Portal | https://childrenofpromisedaycare.com/staff/ |
| ISBE PFA/PI Management | https://childrenofpromisedaycare.com/staff/isbe.html |

## Domain & DNS — READ BEFORE TOUCHING

Confirmed by WHOIS/registry lookup, Aug 2026:

- **Registrar: Wix.com Ltd.** (not GoDaddy). Nameservers `NS4.WIXDNS.NET`, `NS5.WIXDNS.NET`.
- **Renews 13 Oct 2026**, auto-renew ON (Wix shows "Renews on", which means active).
- Domain status is `clientTransferProhibited` **and** `clientUpdateProhibited` — a registrar
  lock. This, not Wix policy, is why the nameservers can't be changed self-service. Lifting it
  is a Wix support request, so Cloudflare remains possible but not DIY.
- Wix does **DNS only**. The root A record points to the VPS. No Wix site is served.
- **The server IP is in GoDaddy's range** (`160.153.0.0/16`, GO-DADDY-COM-LLC), but the VPS
  does **not** appear in the GoDaddy account that holds `escapeband.net`. It is a second
  GoDaddy login, most likely under a Children of Promise email. Find it via an old GoDaddy
  receipt naming the server — the address it was sent to is the login.

### ⚠ Two buttons that will take the whole site down

Both look like the helpful thing to press. Neither is.

1. **Wix Domains page → "Try Again"** on the red *"Your domain is set to point away from
   Wix"* banner. That banner is a **permanent false alarm**. Pointing away from Wix is the
   intended setup — the real site is on the VPS. Clicking it reconnects the domain to Wix and
   takes down the public site, the staff portal, the ISBE pages and the roster together. DNS
   propagation makes it slow to undo.
2. **Wix site dashboard → "Connect Domain"** under the site name. Same outcome, same reason.

Wix will keep showing that error for as long as the setup is correct. Leave it alone.

## Office editing (OnlyOffice Docs) — hard-won, read before touching

Word and Excel files in the document library open and save in the browser.
Working as of 7 Sep 2026. Four things had to be true at once; each one broke it
alone, and the symptoms all looked like the same vague error.

**1. nginx must listen on 8080, not 80.**
`C:\Program Files\ONLYOFFICE\DocumentServer\nginx\conf\ds.conf`, lines 3-4:
```
listen 0.0.0.0:8080;
listen [::]:8080 default_server;
```
The installer sets 80, which our node server already owns, so nginx silently
failed to start on a loop since installation. A `.bak` of the original is beside
it. **An OnlyOffice upgrade will almost certainly reset this to 80** — that is
the first thing to check if editing ever stops working. Symptom: assets 404, and
`nginx\Proxy_*.err.log` fills with `bind() to 0.0.0.0:80 failed (10013)`.

**2. Environment variables on the server** (all `setx ... /M`, then a NEW console
before restarting node — `setx` only reaches processes started afterwards):
```
COFP_ONLYOFFICE_URL      http://localhost:8080
COFP_ONLYOFFICE_SECRET   must equal services.CoAuthoring.secret.inbox.string
                         in C:\Program Files\ONLYOFFICE\DocumentServer\config\local.json
COFP_SELF_URL            https://childrenofpromisedaycare.com
```
Copy the secret with PowerShell rather than typing it; verify with
`$s -eq $env:COFP_ONLYOFFICE_SECRET`.

**3. The proxy must PRESERVE the incoming Host header.** Rewriting it to
`localhost:8080` makes the document server build absolute URLs from that, and
hand them to the browser — which cannot reach the server's localhost. Symptom:
`Editor.bin` fails with `net::ERR_CONNECTION_*`.

**4. The proxy must NOT strip the `/<version>-<hash>/` path prefix.** That prefix
is nginx's own cache-busting scheme and nginx redirects unversioned paths back to
versioned ones, so stripping creates a loop. Symptom: the editor's service worker
fails with `net::ERR_FAILED` on its asset JSON files. Stripping WAS correct while
nginx was dead and docservice answered alone — it became wrong the moment nginx
started, which is the trap.

Diagnosing: the server console logs `[OFFICE WS]` for every socket (success
included) and `[OFFICE PROXY]` for proxy failures. The browser Console tab is
more informative than the Network tab for editor faults. Service workers cache
hard — always hard-refresh, and use incognito to rule out a stale one.

Saves return through `/api/office-callback` and **keep the previous version**
alongside as `name (before YYYY-MM-DD-HH-MM-SS).ext`. Nothing overwrites
compliance evidence irrecoverably.

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

## Parent Interview Form — built, do not rebuild

Done. ~100 fields, defined once in `Internal/pi-interview-schema.js` and rendered by
BOTH the ISBE admin roster (`isbe.html`) and the parent portal (`parent.html`), so the
family and the office always see the identical form. Saves to `ParentInterviews`, with
everything beyond the summary columns held in a `FormData` JSON blob — so adding a field
needs no migration. Files a PDF on save and auto-ticks `ParentInterview`.

- An uploaded signed **scan** is authoritative: if one exists the roster opens it and
  the save endpoint returns 409 rather than creating a second interview.
- Pre-enrollment answers are carried forward by ONE declarative crosswalk,
  `PI_INTERVIEW_PREFILL` + `applyInterviewPrefill()` in `pi-interview-schema.js`. Add
  mappings there, never in a page — the two pages had their own copies and drifted.
- The old "From the Pre-Enrollment Application" section was **removed** from the Parent
  Interview — it duplicated priority-population data that already lives on the waiting
  list and the Weighted Eligibility form, which is the only place it is needed.
- It is **entirely separate** from the ASQ/ASE parent questionnaire. Different document,
  different table, no shared state. The names collide; the things do not.

## F/R/P Rules

- Free: public benefits (WIC/Medicaid/SNAP/TANF), Foster, Military, PFA program, or income ≤ 130% FPL
- Reduced: income ≤ 185% FPL
- Paid: everything else
- Thresholds auto-select by date (2025-2026 active now, 2026-2027 activates July 1, 2026)
- CCAP eligibility: 225% FPL (separate from food program)

## Backlog

- **SSL Certificate** — ✅ Done (Let's Encrypt, auto-renews)
- **Install SSMS locally** — ✅ Done
- **Parent Interview Form** — ✅ Done (see the section above)
- **`staff-portal.html` `loadClassroomData()` destructuring off-by-one** — `weRes` binds
  `CofpForms.loadSignatures` instead of `/api/weighted-eligibility-files`, so
  `CLS_WEIGHTED` is always `{}`. Harmless today (the weighted pill was moved off the
  classroom card) but it is a live landmine. Fix by naming the promise — see
  `sql-reads.md`. Same bug was fixed in `isbe.html`.
- **`ChildFiles` has 71 `WeightedEligibility/generated` rows for ~17 children** — the
  backfill re-indexed repeatedly. `indexWeightedEligibilityDoc` now DELETEs before
  INSERTing so it will not grow further, but the existing duplicates are still there and
  inflate every `/api/child-files` payload. Worth a one-off cleanup keeping the newest
  row per child.
- **Pre-enrollment → Parent Interview crosswalk** — ✅ Done. Deferred piece: nothing
  maps `ChildStartDate`; `Score`/`WaitlistStatus` are deliberately excluded.
- **Cloudflare / transfer domain from Wix** — blocked by a registrar lock
  (`clientUpdateProhibited`), not by Wix refusing. Ask Wix support to unlock if ever wanted.
  SSL was done directly on the server instead, so there is no pressing need. See Domain & DNS above.
- **Server documents folder has no backup** — OneDrive was doing this invisibly and no longer
  will. Check the (second) GoDaddy account for snapshot backups. A snapshot restores the whole
  machine, so it is a poor way to recover one file — file-level backup wanted too.
