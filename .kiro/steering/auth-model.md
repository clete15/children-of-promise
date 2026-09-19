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
4. **`COFP_SESSION_SECRET`** — if unset, every server restart signs everyone out (a new
   signing key each boot). Set once on the server to keep sessions across deploys.

## Server guards (Internal/server.js) — which credential each accepts

- `checkClassroomAuth` — admin password OR classroom password OR **any** signed-in staff
  token. Child/roster/ISBE data. (A signed-in teacher reaches the roster and forms.)
- `checkAuth` — shared password OR a **centre-admin** token. Centre-wide data.
- `checkITAdmin` — shared password OR an **IT-admin** token (Clete). Deploy/Restart/SQL.
- `requireActor` — any valid token or shared password; per-record ownership checked inside.

Admin lists live in one place: `STAFF_ADMIN_LOGINS = ['CleteH','MeganN','SaraH']`,
`IT_ADMIN_LOGINS = ['CleteH']`.
