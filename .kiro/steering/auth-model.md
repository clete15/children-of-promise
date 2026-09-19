# Auth & sign-in model (READ THIS before touching any login/password code)

This has been misunderstood repeatedly. The model below is the intended design.
Do not "improve" it or add gates that are not described here.

## The pages, by exact URL — names collide, so go by URL not label

- **`childrenofpromisedaycare.com/portal`** — NOT part of the staff system. A public
  splash ("Where would you like to go?") with cards: Public Website, Staff Portal.
  **No login, no password, no admin panel as a public card.** The only extra thing
  here is a Deploy/Database panel (`#itPanel`) that stays hidden and reveals ONLY for a
  signed-in IT admin (Clete). Never add a "Site Administration" / sign-in card here.

- **`childrenofpromisedaycare.com/staff/`** — THE STAFF SYSTEM ENTRY. This is "the
  staff page": a dashboard of cards (Enrollment, Room Roster, ISBE PFA/PI, etc.).
  Served by `Internal/index.html`.
  - **This is the page the password gate sits in front of.** Reaching `/staff/`
    requires being signed in; if not, it redirects to `/me`.
  - The card labeled **"Staff Portal"** on this page is misleadingly named — it links
    to the person's own record page (`/staff/staff-portal.html`, "My Page"), NOT to a
    login. Do not make that card go to `/me`.

- **`childrenofpromisedaycare.com/me`** — the ONE login. Served by
  `Internal/my-portal.html`. Name + password. It sits **in front of `/staff/`**.
  - Sign in once here → routed onward: a centre admin lands on `/staff/` (all cards);
    everyone else lands on their own record page.
  - If you arrive at `/me` already holding a valid session this browser session, it
    forwards you straight through (no re-typing, no flash of the form).

- **`/staff/staff-portal.html`** — "My Page": one person's own record (credentials,
  files, forms). Reached from the "Staff Portal" card. Not a login.

## The flow (the whole thing, in one line)

**`/me` (log in once) → `/staff/` (cards shaped by who you are).**

- Admin (Clete / Megan / Sara) sees ALL cards on `/staff/`.
- Everyone else (a teacher) sees only the **Staff Portal** and **ISBE PFA/PI** cards.
- Card visibility is driven by `data-role` attributes on `/staff/` + `who.admin`.

## How identity works (why a login is required for the card split)

- Identity is a **personal session token** (sessionStorage `copStaffToken`), minted at
  `/me` by `/api/staff-login`. 12-hour TTL. `whoAmI()` reads the TOKEN ONLY.
- **The shared centre password is NOT an identity.** It authorises DATA endpoints as a
  rescue fallback so the centre can never be locked out, but it can never *be* a person
  and must never render the staff view. `whoAmI` deliberately ignores it.
- Because a per-person card split needs to know the person, a sign-in IS required —
  this is not optional gold-plating; it is what makes admin-vs-teacher cards possible.

## Recurring confusions to NOT repeat

1. **"It let me straight in / flashed then admin."** That is almost always a still-valid
   session token from a sign-in earlier the same 12h session — correct behavior, NOT a
   bug. To see the first-time gate, use a fresh incognito window or run
   `sessionStorage.clear()` then reload. Verify the gate server-side, not by trusting a
   browser that already has a session.
2. **The classroom kiosk `/classrooms` is separate** — it has its OWN shared classroom
   password for the signing tablet (no personal login). Never fold it into the token
   model or break it.
3. **Deploy is stuck / "Not authorised" on the portal** — the running server predates a
   fix; deploy remotely on the VPS: `& "C:\Program Files\Git\cmd\git.exe" -C "C:\app"
   pull` then restart node. The Deploy button can't fix the code that breaks the Deploy
   button.
4. **`COFP_SESSION_SECRET`** — **SET on the VPS as of 19 Sep 2026** (machine-wide via
   `setx ... /M`), so staff sessions now survive restarts/deploys. If the server ever
   starts logging `[STAFF AUTH] COFP_SESSION_SECRET is not set...` again, it was lost —
   re-set it. Setting/rotating it signs everyone out ONCE (old tokens were signed with
   the previous key); do it at a quiet time.

## Server guards (Internal/server.js) — which credential each accepts

- `checkClassroomAuth` — admin password OR classroom password OR **any** signed-in staff
  token. Child/roster/ISBE data. (A signed-in teacher reaches the roster and forms.)
- `checkAuth` — shared password OR a **centre-admin** token. Centre-wide data.
- `checkITAdmin` — shared password OR an **IT-admin** token (Clete). Deploy/Restart/SQL.
- `requireActor` — any valid token or shared password; per-record ownership checked inside.

Admin lists live in one place: `STAFF_ADMIN_LOGINS = ['CleteH','MeganN','SaraH']`,
`IT_ADMIN_LOGINS = ['CleteH']`.

## Operational reality — where things run (learned the hard way, 19 Sep 2026)

- **This dev machine (`acp-client`) is NOT the web server.** The live server is a
  separate VPS at **`160.153.187.39`** (public: `childrenofpromisedaycare.com`). Do not
  assume `localhost` here is production.
- **The real database is on the VPS**, reached from SSMS as `160.153.187.39,1433`
  (login `cofpadmin`), DB `CofPMillstadt`, with all the real tables (Staff,
  ISBETracking, ParentInterviews, etc.). The `localhost\SQLEXPRESS\CofPMillstadt` on the
  dev machine is a near-empty stale copy — queries against it are misleading. Verify DB
  facts against the VPS, not localhost.
- **Deploy flow:** commit + push to GitHub from the dev repo
  (`c:\Users\child\source\repos\Children Of Promise`) → then the change is live only
  after the VPS pulls and restarts. The user does that on the VPS.
- **The server's `C:\app` is its own clone.** Deploy = on the VPS:
  `& "C:\Program Files\Git\cmd\git.exe" -C "C:\app" pull` then relaunch node. The portal
  Deploy button can work once the running server is current, but it CANNOT ship the fix
  that repairs the Deploy button — that first recovery is always a manual VPS pull.
- **Server launcher:** `C:\app\Launch.bat` — `cd Internal` then `node server.js`
  (foreground, blocks on `pause`). To restart cleanly on the VPS:
  1. `Get-Process node | Select Id,StartTime,Path` → find the server's node Id.
  2. `Stop-Process -Id <id> -Force`.
  3. `Start-Process cmd -ArgumentList '/c','C:\app\Launch.bat'` (own window, inherits a
     freshly-set env var — an in-app restart does NOT pick up a new setx value).
  4. Verify: `GET https://childrenofpromisedaycare.com/api/health` → `200 {"ok":true}`.
- **Verify live behaviour from the public URL, not the user's browser.** "It let me
  straight in" is almost always a live sessionStorage token. Fetch the page/endpoint
  directly (e.g. grep the served HTML for a gate marker, or hit `/api/staff-whoami`
  unauthenticated and expect 401) to know the truth.

## Terminal quirks on this dev machine (so output is readable)

- **git is NOT on PATH** — always call it by full path:
  `& "C:\Program Files\Git\cmd\git.exe" ...` (see git-workflow steering).
- **The PowerShell terminal echoes/garbles inline output.** For anything whose result
  matters (git push/status, node --check, web checks), redirect to a temp file and read
  it back, then delete it:
  `... > _out.txt 2>&1` then read `_out.txt` (may be UTF-16, still readable).
- **Verifying an HTML page's inline JS parses:** extract the largest `<script>` block to
  a temp `.js` and `node --check` it:
  `$h=Get-Content -Raw file.html; $b=[regex]::Matches($h,'(?s)<script>(.*?)</script>');`
  `$big=($b|Sort {$_.Groups[1].Value.Length} -Desc)[0].Groups[1].Value;`
  `[IO.File]::WriteAllText("$PWD\_c.js",$big); node --check _c.js; Remove-Item _c.js`
  Exit code 0 = parses. Always do this after editing an inline `<script>`; async/await
  or a stray brace fails fast here instead of on the live site.
- Clean up every temp `_*.txt` / `_c.js` after use.

## Adding cards to the staff dashboard (`/staff/`, Internal/index.html)

- Each card / section carries `data-role`: `"all"` = everyone sees it, `"admin"` = only
  centre admins. The gate in `checkAuth()`/`showPortal()` hides `data-role="admin"`
  nodes for non-admins. Adding a new staff-visible card = add the `<a class="dash-item"
  data-role="all" href="...">` in the right section. No JS change needed.
