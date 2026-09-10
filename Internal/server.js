const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
// Used for the document editor's JWT signing and its one-time file keys.
const crypto = require('crypto');

/* Writes a signed compliance form as a PDF. Hand-rolled rather than a dependency,
   because this project takes none; see pdf-form.js for what that costs and why the
   trade is worth it here. */
const { buildFormPdf } = require('./pdf-form.js');

/* Prevent crashes from unhandled errors.

   With one exception: a port conflict is not a crash to recover from, it means
   another copy of the server is already running and this one should not exist.
   Swallowing it left the wrapper restarting every 5 seconds forever while the
   original process carried on serving — which looked like a broken server and
   made a "restart" appear to succeed while changing nothing.

   Exiting with a non-zero code lets startup.bat stop instead of looping. */
process.on('uncaughtException', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        console.error('');
        console.error('  ALREADY RUNNING: port ' + (err.port || '80/443') + ' is taken by another copy.');
        console.error('  Not restarting — the copy already running is still serving.');
        console.error('  To take over:  Stop-Process -Name node -Force   then  .\\startup.bat');
        console.error('');
        process.exit(1);
    }
    console.error('[CRASH PREVENTED]', err.message);
});
process.on('unhandledRejection', (err) => {
    console.error('[UNHANDLED REJECTION]', err);
});

const PORT = process.env.PORT || 80;
const HTTPS_PORT = 443;
const DB_SERVER = 'localhost\\SQLEXPRESS';
const DB_NAME = 'CofPMillstadt';
const EXTERNAL_DIR = path.join(__dirname, '..', 'External');

// SSL Certificate paths (from win-acme / Let's Encrypt)
const CERT_DIR = 'C:\\certs';
let sslOptions = null;
try {
    const certFiles = fs.readdirSync(CERT_DIR);
    const keyFile = certFiles.find(f => f.endsWith('-key.pem'));
    const chainFile = certFiles.find(f => f.endsWith('-chain.pem'));
    if (keyFile && chainFile) {
        sslOptions = {
            key: fs.readFileSync(path.join(CERT_DIR, keyFile)),
            cert: fs.readFileSync(path.join(CERT_DIR, chainFile)),
        };
        console.log('[SSL] Certificates loaded from', CERT_DIR);
    }
} catch (e) {
    console.log('[SSL] No certificates found, HTTPS disabled');
}

const MIME = {
    '.html': 'text/html', '.css': 'text/css',
    '.js': 'application/javascript', '.json': 'application/json',
    '.png': 'image/png', '.ico': 'image/x-icon',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.pdf': 'application/pdf',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword'
};

const COLS = ['Last_Name','First_Name','Birth_date','Start_Date','City_Town','Days_Old',
              'RoomNumber','Monday','Tuesday','Wednesday','Thursday','Friday',
              'Active','Category','PFA_PI_na','F_R_P_Food','IEP','Military'];

const ROOM_COLS = ['RoomNumber','Building','Room','TeacherDescription','Type','RequiredSlots','AgeRange','DCFSCapacity'];

/* The staff password must NEVER be written into this file.

   It was a plain constant here until Sep 2026, in a public GitHub repository —
   so it was readable by anyone who found the repo, and it guards children's
   records. Committing a secret to source control also means it stays in the
   history after removal, which is why the old value had to be retired rather
   than edited.

   Set it on the server once, in an Administrator PowerShell:

       setx COFP_STAFF_PASSWORD "the-new-password" /M

   then start a NEW console (setx only affects processes started afterwards).

   Refusing to start is deliberate. A default here would quietly become the
   real password on any machine that forgot to set the variable, which is the
   situation this replaced. */
const INTERNAL_PASSWORD = process.env.COFP_STAFF_PASSWORD;
if (!INTERNAL_PASSWORD) {
    console.error('');
    console.error('  REFUSING TO START: COFP_STAFF_PASSWORD is not set.');
    console.error('');
    console.error('  The staff password is no longer stored in the source code,');
    console.error('  because this repository was public and the old one was readable.');
    console.error('');
    console.error('  Set it once, in an Administrator PowerShell:');
    console.error('      setx COFP_STAFF_PASSWORD "your-new-password" /M');
    console.error('  then open a NEW console and start the server again.');
    console.error('');
    process.exit(1);
}

/* The password out of a Basic header, or ''.

   Pulled out so the shared-password check below and the per-staff actor
   resolution further down read the header the same way. Both used to be able to
   disagree about what counts as a credential, which is the sort of difference
   that only shows up as one endpoint letting someone in and another not. */
function basicPassword(req) {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Basic ')) return '';
    try {
        // The username half is ignored; only the password is checked.
        return Buffer.from(auth.slice(6), 'base64').toString().split(':')[1] || '';
    } catch (e) { return ''; }
}

function checkAuth(req, res) {
    // A missing header and a wrong password are the same answer to the caller, so
    // they share one branch rather than two identical ones.
    if (basicPassword(req) !== INTERNAL_PASSWORD) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Children Of Promise Staff"' });
        res.end('Unauthorized');
        return false;
    }
    return true;
}

/* ── Per-staff sign-in ──────────────────────────────────────────────────────

   The shared password says someone is allowed in. It cannot say who they are, so
   nothing built on it could ever serve one person their own file and not their
   colleague's. This adds identity alongside it rather than replacing it: the
   shared password continues to mean "the director", and a signed-in staff member
   is a second kind of caller with a much narrower reach.

   Passwords are never stored, only scrypt hashes with a per-row random salt, so
   two people picking the same password do not produce the same hash and a copy of
   the database does not hand over anyone's password. */

const PW_KEYLEN = 64;

function newSalt() {
    return crypto.randomBytes(16).toString('hex');
}

function hashPassword(password, salt) {
    return crypto.scryptSync(String(password), String(salt), PW_KEYLEN).toString('hex');
}

/* Constant-time comparison. A plain === leaks how much of a value matched through
   how long it took to answer, which over enough attempts narrows down a secret. */
function secretsMatch(a, b) {
    const ba = Buffer.from(String(a == null ? '' : a), 'utf8');
    const bb = Buffer.from(String(b == null ? '' : b), 'utf8');
    // timingSafeEqual throws on a length mismatch, and the length of a hash is
    // fixed anyway, so an unequal length is simply not a match.
    if (ba.length !== bb.length || ba.length === 0) return false;
    return crypto.timingSafeEqual(ba, bb);
}

/* The day-one credential: first name plus the initial of the last name.
   "Keyona Hentz" -> "KeyonaH". A single-word name has no initial to add, so it
   stands alone rather than producing a trailing letter that is not there. */
function enrolmentCode(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '';
    if (parts.length === 1) return parts[0];
    return parts[0] + parts[parts.length - 1][0].toUpperCase();
}

/* Sessions are signed rather than stored, so signing in costs no table and no
   cleanup job. The token carries the staff id and an expiry, and the signature is
   what makes it unforgeable — without it a staff member could simply edit the id
   in their own token and become someone else.

   COFP_SESSION_SECRET keeps sessions valid across a restart. Without it a key is
   generated at boot, which is safe but means every deploy signs staff out. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;   // a working day, then sign in again
const SESSION_SECRET = process.env.COFP_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.COFP_SESSION_SECRET) {
    console.log('[STAFF AUTH] COFP_SESSION_SECRET is not set, so staff sessions are signed with');
    console.log('             a key made at startup and every restart signs staff out. To keep');
    console.log('             them signed in across deploys, set it once:');
    console.log('               setx COFP_SESSION_SECRET "<a long random string>" /M');
}

function signSession(staffId) {
    const body = String(staffId) + '.' + (Date.now() + SESSION_TTL_MS);
    return body + '.' + crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('hex');
}

// The staff id a token vouches for, or null if it is forged, malformed or expired.
function readSession(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const body = parts[0] + '.' + parts[1];
    const expect = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('hex');
    if (!secretsMatch(parts[2], expect)) return null;
    if (!/^\d+$/.test(parts[1]) || Date.now() > parseInt(parts[1], 10)) return null;
    const id = parseInt(parts[0], 10);
    return id > 0 ? id : null;
}

/* Who is asking? Either the director by shared password, or one specific staff
   member by signed token, or nobody.

   Deliberately never reads a staff id from the query string or the body. That is
   the whole point: an id the caller supplies is a request, not an identity, and
   treating it as one is how "my page" becomes "anyone's page". */
function resolveActor(req) {
    if (basicPassword(req) === INTERNAL_PASSWORD) {
        return { director: true, staffId: null };
    }
    const id = readSession(req.headers['x-staff-token']);
    if (id) return { director: false, staffId: id };
    return null;
}

/* Guard for the endpoints that either kind of caller may reach. Answers 401 and
   returns null when nobody is signed in, so callers can `if (!actor) return;`. */
function requireActor(req, res) {
    const actor = resolveActor(req);
    if (!actor) {
        sendJSON(res, 401, { error: 'Sign in first' });
        return null;
    }
    return actor;
}

/* May this caller see or change this staff member's record?
   The director may reach anyone; a staff member only themselves. */
function actorMayTouch(actor, staffId) {
    if (!actor) return false;
    if (actor.director) return true;
    return String(actor.staffId) === String(staffId);
}

/* ── Whose is it? ──────────────────────────────────────────────────────────

   The per-person PAS forms and the development plans were built for a single
   caller who could see everything, so ownership was never something the server
   had to answer. It does now, and these three are the answer.

   No new columns were needed. The per-person worksheets already record who they
   belong to in their scope key, and a plan already carries a StaffId — the
   information was there, it simply had nobody asking. */

/* The staff member a PAS worksheet scope belongs to, or null when it belongs to
   the programme rather than a person.

   pas-store.js builds these from the "__" separator, so
   "pas_annual_appraisal__staff7_2026-2027" is stored as worksheet
   "pas_annual_appraisal" with scope "staff7_2026-2027". A classroom scope
   ("Infant") or an empty one names no person and stays with the director. */
function pasScopeStaffId(scopeKey) {
    const m = /^staff(\d+)(?:_|$)/.exec(String(scopeKey || '').trim());
    return m ? parseInt(m[1], 10) : null;
}

// The staff member a development plan is for, or null if there is no such plan.
function devPlanStaffId(planId) {
    const id = parseInt(planId, 10);
    if (!id) return { ok: true, staffId: null };
    const r = runSQLRows(`SELECT StaffId FROM StaffDevelopmentPlan WHERE Id=${id}`,
        staffDevPlanEnsureSQL() + 'GO\n');
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, staffId: r.rows[0] ? parseInt(r.rows[0].StaffId, 10) : null };
}

/* The staff member a goal belongs to, reached through its plan. A goal names only
   its plan, so ownership has to be followed one step rather than read directly. */
function devGoalStaffId(goalId) {
    const id = parseInt(goalId, 10);
    if (!id) return { ok: true, staffId: null };
    const r = runSQLRows(
        `SELECT p.StaffId AS StaffId FROM StaffDevelopmentGoal g
         JOIN StaffDevelopmentPlan p ON p.Id = g.PlanId WHERE g.Id=${id}`,
        staffDevPlanEnsureSQL() + 'GO\n');
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, staffId: r.rows[0] ? parseInt(r.rows[0].StaffId, 10) : null };
}

/* Gives every staff member an account if they do not have one yet.

   Run on demand rather than at boot, the way the rest of the schema work here is,
   so a fresh database or a newly hired member of staff heals itself on the next
   sign-in instead of needing a migration to be remembered.

   The first password is the login name, so there is one thing to tell someone
   rather than two: "you are MollyE and your password is MollyE, change it when you
   get in". MustChangePassword is set with it, so that arrangement cannot outlive
   the first sign-in.

   The placeholder row is skipped. "New Teacher" is a slot on the staff list, not a
   person, and handing it an account would leave a working login named after a
   vacancy. */
function ensureStaffCredentials() {
    const r = runSQLRows(
        `SELECT Id, Name, ISNULL(LoginName,'') AS LoginName,
                CASE WHEN ISNULL(PasswordHash,'') = '' THEN 0 ELSE 1 END AS HasPassword
         FROM Staff`,
        staffEnsureSQL() + 'GO\n');
    if (!r.ok) return { ok: false, error: r.error };

    const taken = new Set(r.rows
        .map(x => String(x.LoginName || '').trim().toLowerCase())
        .filter(Boolean));
    const updates = [];

    r.rows.forEach(row => {
        if (row.HasPassword && String(row.LoginName || '').trim()) return;
        const name = String(row.Name || '').trim();
        if (!name || /^new teacher$/i.test(name)) return;

        let login = String(row.LoginName || '').trim() || enrolmentCode(name);
        if (!login) return;
        /* Two people can derive the same code — any second Sara with an H surname
           would — and a duplicate login is one person unable to sign in at all. A
           number is appended rather than more of the surname, because the second
           letter collides just as easily and the result stops being predictable
           either way. The director can rename it afterwards. */
        if (taken.has(login.toLowerCase()) && !String(row.LoginName || '').trim()) {
            let n = 2;
            while (taken.has((login + n).toLowerCase())) n++;
            login = login + n;
        }
        taken.add(login.toLowerCase());

        const salt = newSalt();
        updates.push({ id: row.Id, login: login, salt: salt, hash: hashPassword(login, salt) });
    });

    if (!updates.length) return { ok: true, seeded: 0 };
    const sql = updates.map(u =>
        `UPDATE Staff SET LoginName=${esc(u.login)}, PasswordHash=${esc(u.hash)},`
        + ` PasswordSalt=${esc(u.salt)}, MustChangePassword=1 WHERE Id=${parseInt(u.id, 10)};`
    ).join('\n');
    const w = runSQL(sql);
    if (!w.ok) return { ok: false, error: w.error };
    console.log('[STAFF AUTH] enrolled ' + updates.length + ' staff account(s): '
        + updates.map(u => u.login).join(', '));
    return { ok: true, seeded: updates.length };
}

/* Reads one staff member's credential row by login name.
   Returns { ok, row } where row is null for an unknown name. */
function staffCredentialRow(loginName) {
    const r = runSQLRows(
        `SELECT Id, Name, ISNULL(LoginName,'') AS LoginName,
                ISNULL(PasswordHash,'') AS PasswordHash,
                ISNULL(PasswordSalt,'') AS PasswordSalt,
                ISNULL(CAST(MustChangePassword AS INT), 1) AS MustChangePassword
         FROM Staff WHERE LOWER(LoginName) = ${esc(String(loginName || '').trim().toLowerCase())}`);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, row: r.rows[0] || null };
}

function esc(v) {
    if (v === null || v === undefined || v === '') return 'NULL';
    return `'${String(v).replace(/'/g, "''")}'`;
}

function bit(v) {
    if (v === true || v === 'Yes' || v === '1' || v === 1) return 1;
    if (v === false || v === 'No' || v === '0' || v === 0) return 0;
    return 'NULL';
}

// ── sqlcmd transport encoding ──
// runSQL() shells out to sqlcmd with `-s "|" -W -h -1`, so results come back as
// one line per row with columns separated by '|'. That means any stored value
// containing a literal '|' shifts every later column, and any value containing a
// line break splits one row into several unparseable lines.
//
// Free-text form fields (textareas) hit both cases routinely. Rather than
// mangling what we store, we keep the real text in the database and encode only
// the transport: wrap text columns in txCol() on the way out and run the value
// through txDecode() after splitting. Sentinels are plain ASCII so they survive
// whatever code page sqlcmd writes -- a non-ASCII sentinel such as CHAR(166)
// would come back as a replacement char once execSync decoded the output utf8.
const TX_PIPE = '{PIPE}';
const TX_NL = '{NL}';

function txCol(col, alias) {
    return `REPLACE(REPLACE(REPLACE(ISNULL(${col},''),'|','${TX_PIPE}'),CHAR(13),''),CHAR(10),'${TX_NL}') AS ${alias || col}`;
}

function txDecode(v) {
    return String(v == null ? '' : v).split(TX_NL).join('\n').split(TX_PIPE).join('|');
}

// ── School year ──
// Every per-child record is scoped to a school year. Without this, a returning
// child carried last year's ticked checkboxes into the new year and saving a new
// permission slip or screening overwrote the previous year's record, which the
// PICC needs kept (permission is valid July 1 to June 30, and the Individual
// Family Goal Plan must show annual updates).
//
// The year rolls over on July 1, matching getSchoolYear() in the browser and the
// USDA threshold boundary already used for F/R/P.
function currentSchoolYear() {
    const now = new Date();
    const start = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
    return start + '-' + (start + 1);
}

// Rows created before the SchoolYear columns existed are stamped with this on
// migration. All of that data was entered during the 2025-2026 year.
const LEGACY_SCHOOL_YEAR = '2025-2026';

// Accepts a year from the client but never trusts it into SQL unescaped, and
// falls back to the current year so an older client that omits it still works.
function resolveSchoolYear(v) {
    const s = String(v || '').trim();
    return /^\d{4}-\d{4}$/.test(s) ? s : currentSchoolYear();
}

// Adds SchoolYear to a table that predates it, backfills existing rows, and
// returns the DDL. Safe to re-run.
//
// Ends with GO, and every caller depends on that. SQL Server compiles an entire
// batch before executing any of it, and deferred name resolution covers a missing
// TABLE but not a missing COLUMN on a table that already exists. So "ALTER TABLE
// ADD SchoolYear" followed in the SAME batch by "SELECT ... WHERE SchoolYear=..."
// fails to compile - and because compilation fails, the ALTER never runs either.
// That is a permanent deadlock, not a transient error: the migration can never
// apply, and every request logs "Invalid column name 'SchoolYear'" forever. It is
// exactly what happened to ISBETracking's 11 newer columns. This function is the
// last DDL in every caller, so terminating the batch here fixes all of them.
function schoolYearColumnSQL(table) {
    // Guarded on the table existing as well as the column, because callers run
    // this before a SELECT that may be the first thing to touch the table.
    return `IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='${table}')
   AND NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='${table}' AND COLUMN_NAME='SchoolYear')
BEGIN
    EXEC('ALTER TABLE ${table} ADD SchoolYear NVARCHAR(20)');
    EXEC('UPDATE ${table} SET SchoolYear=''${LEGACY_SCHOOL_YEAR}'' WHERE SchoolYear IS NULL');
END;
GO
`;
}

// ── ISBETracking schema ──
// Single source of truth for the checklist columns. Every read and write runs the
// ensure block first, so a fresh database (or one predating a column we added
// later) heals itself instead of failing. EnterSIS and RemoveFromSIS were
// accepted by the PUT whitelist but never existed as columns, so those two
// checkboxes silently failed to save until this list took over.
const ISBE_TRACKING_COLUMNS = [
    'PermissionSlip', 'ParentInterview', 'ProofOfIncome', 'EnterSIS',
    'BegASQ', 'BegASE', 'MidYearReport', 'EndASQ', 'EndASE', 'EndYearReport',
    // PICC per-child document forms (Prevention Initiative only).
    'WeightedEligibility', 'ScreeningResultsShared',
    'FamilyCenteredAssessment', 'FamilyGoalPlan', 'TransitionPlan', 'Referral',
    'RemoveFromSIS', 'GrantPerfReport'
];

function isbeTrackingEnsureSQL() {
    let sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ISBETracking')
    CREATE TABLE ISBETracking (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        StudentId INT NOT NULL,
        SchoolYear NVARCHAR(20)
    );
`;
    for (const c of ISBE_TRACKING_COLUMNS) {
        sql += `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='ISBETracking' AND COLUMN_NAME='${c}') ALTER TABLE ISBETracking ADD ${c} BIT DEFAULT 0;\n`;
    }
    // schoolYearColumnSQL ends the batch, which is what lets the ALTERs above be
    // visible to the caller's SELECT. Without that the healing code deadlocked.
    sql += schoolYearColumnSQL('ISBETracking');
    return sql;
}

// Ticks one checklist column for a student in a given year. Used by every form
// save so the roster reflects a completed form immediately. Kept in one place
// because there are six form handlers that all need identical upsert semantics.
function trackingTickSQL(studentId, year, field) {
    return `IF EXISTS (SELECT 1 FROM ISBETracking WHERE StudentId=${studentId} AND SchoolYear=${esc(year)})
    UPDATE ISBETracking SET ${field}=1 WHERE StudentId=${studentId} AND SchoolYear=${esc(year)}
ELSE
    INSERT INTO ISBETracking (StudentId,SchoolYear,${field}) VALUES (${studentId},${esc(year)},1);
`;
}

// ── PICC per-child document forms ──
// PI6.A Family Centered Assessment, PI6.B Individual Family Goal Plan,
// PI7.A Transition Plan and PI7.B Referral all need the same treatment: one row
// per student, a printable form, and an auto-checked box on the roster. Rather
// than four near-identical endpoint pairs, each form is declared here as
// [columnName, sqlType, jsonKey] and served by one generic GET/POST.
// Column order drives both the INSERT and the SELECT, so it must stay stable;
// append new fields at the end and the migration below adds them in place.
const PI_DOC_FORMS = {
    'family-assessment': {
        table: 'PIFamilyAssessments',
        trackingColumn: 'FamilyCenteredAssessment',
        columns: [
            ['AssessmentDate', 'NVARCHAR(20)', 'assessmentDate'],
            ['EnrollmentDate', 'NVARCHAR(20)', 'enrollmentDate'],
            ['AssessmentTool', 'NVARCHAR(200)', 'assessmentTool'],
            ['ToolOther', 'NVARCHAR(300)', 'toolOther'],
            ['CompletedBy', 'NVARCHAR(200)', 'completedBy'],
            ['FamilyStrengths', 'NVARCHAR(MAX)', 'familyStrengths'],
            ['FamilyNeeds', 'NVARCHAR(MAX)', 'familyNeeds'],
            ['AreasOfConcern', 'NVARCHAR(MAX)', 'areasOfConcern'],
            ['NextSteps', 'NVARCHAR(MAX)', 'nextSteps'],
            ['ParentSignature', 'NVARCHAR(200)', 'parentSignature'],
            ['StaffSignature', 'NVARCHAR(200)', 'staffSignature'],
            ['SignedDate', 'NVARCHAR(20)', 'signedDate']
        ]
    },
    'family-goal-plan': {
        table: 'PIFamilyGoalPlans',
        trackingColumn: 'FamilyGoalPlan',
        columns: [
            ['PlanDate', 'NVARCHAR(20)', 'planDate'],
            ['EnrollmentDate', 'NVARCHAR(20)', 'enrollmentDate'],
            ['PlanType', 'NVARCHAR(60)', 'planType'],
            ['FamilyStrengths', 'NVARCHAR(MAX)', 'familyStrengths'],
            ['Goal1', 'NVARCHAR(MAX)', 'goal1'],
            ['Goal1Steps', 'NVARCHAR(MAX)', 'goal1Steps'],
            ['Goal1Resources', 'NVARCHAR(MAX)', 'goal1Resources'],
            ['Goal1Responsible', 'NVARCHAR(200)', 'goal1Responsible'],
            ['Goal1Target', 'NVARCHAR(20)', 'goal1Target'],
            ['Goal1Status', 'NVARCHAR(40)', 'goal1Status'],
            ['Goal2', 'NVARCHAR(MAX)', 'goal2'],
            ['Goal2Steps', 'NVARCHAR(MAX)', 'goal2Steps'],
            ['Goal2Resources', 'NVARCHAR(MAX)', 'goal2Resources'],
            ['Goal2Responsible', 'NVARCHAR(200)', 'goal2Responsible'],
            ['Goal2Target', 'NVARCHAR(20)', 'goal2Target'],
            ['Goal2Status', 'NVARCHAR(40)', 'goal2Status'],
            ['Goal3', 'NVARCHAR(MAX)', 'goal3'],
            ['Goal3Steps', 'NVARCHAR(MAX)', 'goal3Steps'],
            ['Goal3Resources', 'NVARCHAR(MAX)', 'goal3Resources'],
            ['Goal3Responsible', 'NVARCHAR(200)', 'goal3Responsible'],
            ['Goal3Target', 'NVARCHAR(20)', 'goal3Target'],
            ['Goal3Status', 'NVARCHAR(40)', 'goal3Status'],
            ['NextReviewDate', 'NVARCHAR(20)', 'nextReviewDate'],
            ['ParentSignature', 'NVARCHAR(200)', 'parentSignature'],
            ['StaffSignature', 'NVARCHAR(200)', 'staffSignature'],
            ['SignedDate', 'NVARCHAR(20)', 'signedDate']
        ]
    },
    'transition-plan': {
        table: 'PITransitionPlans',
        trackingColumn: 'TransitionPlan',
        columns: [
            ['PlanDate', 'NVARCHAR(20)', 'planDate'],
            ['TransitionType', 'NVARCHAR(120)', 'transitionType'],
            ['TransitionDate', 'NVARCHAR(20)', 'transitionDate'],
            ['ReceivingProgram', 'NVARCHAR(300)', 'receivingProgram'],
            ['ReceivingContact', 'NVARCHAR(200)', 'receivingContact'],
            ['ReceivingPhone', 'NVARCHAR(60)', 'receivingPhone'],
            ['CurrentServices', 'NVARCHAR(MAX)', 'currentServices'],
            ['TransitionSteps', 'NVARCHAR(MAX)', 'transitionSteps'],
            ['RecordsTransferred', 'NVARCHAR(MAX)', 'recordsTransferred'],
            ['ParentNotifiedDate', 'NVARCHAR(20)', 'parentNotifiedDate'],
            ['RecordsConsent', 'NVARCHAR(20)', 'recordsConsent'],
            ['FamilyConcerns', 'NVARCHAR(MAX)', 'familyConcerns'],
            ['StaffResponsible', 'NVARCHAR(200)', 'staffResponsible'],
            ['SuddenExit', 'NVARCHAR(20)', 'suddenExit'],
            ['ContactAttempts', 'NVARCHAR(MAX)', 'contactAttempts'],
            ['ParentSignature', 'NVARCHAR(200)', 'parentSignature'],
            ['StaffSignature', 'NVARCHAR(200)', 'staffSignature'],
            ['SignedDate', 'NVARCHAR(20)', 'signedDate']
        ]
    },
    // PI5.A weighted eligibility form, with PI5.B-G priority populations,
    // PI5.H determination and PI5.J income verification on the same document.
    // One column per criterion so eligibility can be reported on later.
    'weighted-eligibility': {
        table: 'PIWeightedEligibility',
        trackingColumn: 'WeightedEligibility',
        columns: [
            ['CompletedDate', 'NVARCHAR(20)', 'completedDate'],
            ['EnrollmentDate', 'NVARCHAR(20)', 'enrollmentDate'],
            ['CompletedBy', 'NVARCHAR(200)', 'completedBy'],
            ['Homeless', 'NVARCHAR(10)', 'homeless'],
            ['YouthInCare', 'NVARCHAR(10)', 'youthInCare'],
            ['EarlyIntervention', 'NVARCHAR(10)', 'earlyIntervention'],
            ['HasIep', 'NVARCHAR(10)', 'hasIep'],
            ['ScreeningDelayNoEi', 'NVARCHAR(10)', 'screeningDelayNoEi'],
            ['IncomeBelow50Fpl', 'NVARCHAR(10)', 'incomeBelow50Fpl'],
            ['ParentEll', 'NVARCHAR(10)', 'parentEll'],
            ['NonEnglishHome', 'NVARCHAR(10)', 'nonEnglishHome'],
            ['PublicBenefits', 'NVARCHAR(10)', 'publicBenefits'],
            ['AbuseHistory', 'NVARCHAR(10)', 'abuseHistory'],
            ['MentalIllness', 'NVARCHAR(10)', 'mentalIllness'],
            ['DcfsInvolvement', 'NVARCHAR(10)', 'dcfsInvolvement'],
            ['SubstanceAbuse', 'NVARCHAR(10)', 'substanceAbuse'],
            ['CaregiverOther', 'NVARCHAR(10)', 'caregiverOther'],
            ['FamilyDeath', 'NVARCHAR(10)', 'familyDeath'],
            ['LowBirthWeight', 'NVARCHAR(10)', 'lowBirthWeight'],
            ['ParentIncarcerated', 'NVARCHAR(10)', 'parentIncarcerated'],
            ['TeenParent', 'NVARCHAR(10)', 'teenParent'],
            ['NoHsDiploma', 'NVARCHAR(10)', 'noHsDiploma'],
            ['BornOutsideUs', 'NVARCHAR(10)', 'bornOutsideUs'],
            ['ActiveMilitary', 'NVARCHAR(10)', 'activeMilitary'],
            ['SingleParent', 'NVARCHAR(10)', 'singleParent'],
            ['TotalPoints', 'NVARCHAR(10)', 'totalPoints'],
            ['HouseholdIncome', 'NVARCHAR(40)', 'householdIncome'],
            ['HouseholdSize', 'NVARCHAR(10)', 'householdSize'],
            ['IncomeVerificationType', 'NVARCHAR(120)', 'incomeVerificationType'],
            ['IncomeVerificationDate', 'NVARCHAR(20)', 'incomeVerificationDate'],
            ['BenefitCardInParentName', 'NVARCHAR(20)', 'benefitCardInParentName'],
            ['EligibilityResult', 'NVARCHAR(120)', 'eligibilityResult'],
            ['Notes', 'NVARCHAR(MAX)', 'notes'],
            ['ParentSignature', 'NVARCHAR(200)', 'parentSignature'],
            ['StaffSignature', 'NVARCHAR(200)', 'staffSignature'],
            ['SignedDate', 'NVARCHAR(20)', 'signedDate']
        ]
    },
    'screening-results-shared': {
        table: 'PIScreeningResultsShared',
        trackingColumn: 'ScreeningResultsShared',
        columns: [
            ['ToolUsed', 'NVARCHAR(120)', 'toolUsed'],
            ['ToolOther', 'NVARCHAR(200)', 'toolOther'],
            ['ScreeningDate', 'NVARCHAR(20)', 'screeningDate'],
            ['ScreenerName', 'NVARCHAR(200)', 'screenerName'],
            ['ResultsSummary', 'NVARCHAR(MAX)', 'resultsSummary'],
            ['SharedDate', 'NVARCHAR(20)', 'sharedDate'],
            ['SharedWith', 'NVARCHAR(200)', 'sharedWith'],
            ['SharedMethod', 'NVARCHAR(120)', 'sharedMethod'],
            ['EvidenceOfSharing', 'NVARCHAR(MAX)', 'evidenceOfSharing'],
            ['ParentResponse', 'NVARCHAR(MAX)', 'parentResponse'],
            ['ConcernIdentified', 'NVARCHAR(10)', 'concernIdentified'],
            ['ReferralMade', 'NVARCHAR(20)', 'referralMade'],
            ['FollowUpNotes', 'NVARCHAR(MAX)', 'followUpNotes'],
            ['ParentSignature', 'NVARCHAR(200)', 'parentSignature'],
            ['StaffSignature', 'NVARCHAR(200)', 'staffSignature'],
            ['SignedDate', 'NVARCHAR(20)', 'signedDate']
        ]
    },
    'referral': {
        table: 'PIReferrals',
        trackingColumn: 'Referral',
        columns: [
            ['NotApplicable', 'NVARCHAR(20)', 'notApplicable'],
            ['NotApplicableReason', 'NVARCHAR(MAX)', 'notApplicableReason'],
            ['ReferralDate', 'NVARCHAR(20)', 'referralDate'],
            ['ReferralReason', 'NVARCHAR(200)', 'referralReason'],
            ['ConcernSource', 'NVARCHAR(200)', 'concernSource'],
            ['ConcernDetail', 'NVARCHAR(MAX)', 'concernDetail'],
            ['ReferredTo', 'NVARCHAR(300)', 'referredTo'],
            ['AgencyContact', 'NVARCHAR(200)', 'agencyContact'],
            ['AgencyPhone', 'NVARCHAR(60)', 'agencyPhone'],
            ['ReferredBy', 'NVARCHAR(200)', 'referredBy'],
            ['ParentNotifiedDate', 'NVARCHAR(20)', 'parentNotifiedDate'],
            ['ParentConsent', 'NVARCHAR(20)', 'parentConsent'],
            ['Outcome', 'NVARCHAR(120)', 'outcome'],
            ['OutcomeDate', 'NVARCHAR(20)', 'outcomeDate'],
            ['FollowUpNotes', 'NVARCHAR(MAX)', 'followUpNotes'],
            ['StaffSignature', 'NVARCHAR(200)', 'staffSignature'],
            ['SignedDate', 'NVARCHAR(20)', 'signedDate']
        ]
    }
};

// ── ParentInterviews schema ──
// PICC PI5.L requires the preferred language to be identified on the Parent
// Interview Form, and PI5.M requires a section recording translator
// arrangements. The checklist states neither section may be left blank. The
// table predates these columns in production, hence the migrations.
const PARENT_INTERVIEW_ADDED_COLUMNS = [
    ['PreferredLanguage', 'NVARCHAR(120)'],
    ['TranslatorNeeded', 'NVARCHAR(20)'],
    ['TranslatorArrangements', 'NVARCHAR(MAX)']
];

function parentInterviewEnsureSQL() {
    let sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ParentInterviews')
    CREATE TABLE ParentInterviews (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        StudentId INT NOT NULL,
        InterviewDate NVARCHAR(20),
        ParentGoals NVARCHAR(MAX),
        ParentConcerns NVARCHAR(MAX),
        ChildStrengths NVARCHAR(MAX),
        ParentSignature NVARCHAR(200),
        StaffSignature NVARCHAR(200),
        Notes NVARCHAR(MAX),
        CreatedAt DATETIME DEFAULT GETDATE(),
        UpdatedAt DATETIME DEFAULT GETDATE()
    );
`;
    for (const [name, type] of PARENT_INTERVIEW_ADDED_COLUMNS) {
        sql += `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='ParentInterviews' AND COLUMN_NAME='${name}') ALTER TABLE ParentInterviews ADD ${name} ${type};\n`;
    }
    sql += schoolYearColumnSQL('ParentInterviews');
    return sql;
}

// ── ProgramCompliance schema ──
// Key/value store, one row per (school year, field). The PICC panel writes a
// status, a date and a free-text note per checklist item, and a 200-char note
// would truncate, so FieldValue widens to MAX. FieldName stays NVARCHAR(50)
// because it sits inside UQ_Compliance and widening it would mean dropping and
// rebuilding that constraint; item keys are validated against 50 instead.
const COMPLIANCE_FIELD_NAME_MAX = 50;

// ── Staff schema ──
// Staff records were previously held in browser localStorage on staff-cards.html,
// which meant credential data existed only in one browser and a version bump in
// that page silently reset it to hardcoded defaults. They live here now because
// four other things depend on them: the PAS qualification worksheets, PICC CB6
// (classroom staff qualifications) and PI9 (professional development plans), the
// ExceleRate training thresholds, and CB4 staff-to-classroom ratios.
//
// ReviewedBy/ReviewedDate exist because the seed data was machine-extracted from
// Gateways PDFs and needs a human to confirm it before it backs a compliance
// claim. Unreviewed is the honest default.
function staffEnsureSQL() {
    return `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='Staff')
    CREATE TABLE Staff (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Name NVARCHAR(200) NOT NULL,
        Role NVARCHAR(200),
        Program NVARCHAR(40),
        Classroom NVARCHAR(100),
        Fte NVARCHAR(10),
        Education NVARCHAR(100),
        EceCredentials NVARCHAR(300),
        Gateways NVARCHAR(200),
        ExperienceYears NVARCHAR(20),
        RegistryId NVARCHAR(40),
        Notes NVARCHAR(MAX),
        Active BIT DEFAULT 1,
        ReviewedBy NVARCHAR(200),
        ReviewedDate NVARCHAR(20),
        StaffGroup NVARCHAR(40),
        SecondaryClassroom NVARCHAR(100),
        SemesterHoursTotal NVARCHAR(20),
        SemesterHoursEce NVARCHAR(20),
        TranscriptOnFile NVARCHAR(20),
        PdHoursYtd NVARCHAR(20),
        CreatedAt DATETIME DEFAULT GETDATE(),
        UpdatedAt DATETIME DEFAULT GETDATE()
    );
GO
/* Added after the table shipped, so existing databases need the column too.
   Separates the ownership group from classroom staff. It matters beyond display:
   the ExceleRate credential thresholds are proportions of TEACHING staff, and
   counting owners and administrators in that denominator would understate them. */
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Staff' AND COLUMN_NAME='StaffGroup')
    ALTER TABLE Staff ADD StaffGroup NVARCHAR(40);
GO
/* A second room the person is SCHEDULED to teach in part time, distinct from the
   irregular fill-in cover that is deliberately not tracked. It has to be a real
   place on the schedule, because that is what lets a credential be counted: the
   ExceleRate infant/toddler requirement is about staff working with infants and
   toddlers, and unscheduled cover would not support the claim.

   Staff appear on the PAS teaching worksheet for both rooms. */
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Staff' AND COLUMN_NAME='SecondaryClassroom')
    ALTER TABLE Staff ADD SecondaryClassroom NVARCHAR(100);
GO
/* Semester hours off the official transcript, and whether the Registry has it.

   The PAS Teaching Staff Qualifications worksheet asks for general and ECE
   semester hours per person, and until now nothing held them, so every worksheet
   printed with those columns blank. They also explain a gap that cost real
   credential levels here: Sue Engel has 53 earned hours including an infant and
   toddler course, none of which reached Gateways, so her registry record shows a
   high school diploma only. Tracking whether the transcript is on file makes that
   kind of omission visible instead of invisible. */
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Staff' AND COLUMN_NAME='SemesterHoursTotal')
    ALTER TABLE Staff ADD SemesterHoursTotal NVARCHAR(20);
GO
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Staff' AND COLUMN_NAME='SemesterHoursEce')
    ALTER TABLE Staff ADD SemesterHoursEce NVARCHAR(20);
GO
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Staff' AND COLUMN_NAME='TranscriptOnFile')
    ALTER TABLE Staff ADD TranscriptOnFile NVARCHAR(20);
GO
/* Professional development clock hours in the current school year.

   ExceleRate asks for 20 hours a year per classroom teaching staff member. The
   StaffTraining table records WHICH trainings were completed but carries no hour
   count, so the total cannot be derived from it. Held as a running total the
   director maintains, rather than computed, because PD comes from many sources
   (Gateways, in-house, conferences) that will never all be itemised here. */
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Staff' AND COLUMN_NAME='PdHoursYtd')
    ALTER TABLE Staff ADD PdHoursYtd NVARCHAR(20);
GO
/* Which CALENDAR year the PD hours above belong to.

   The 20-hour expectation runs on the actual year, not the school year — the
   centre is open year round and serves children who are PI, PFA or neither, so
   PAS and ExceleRate are centre-wide and calendar-based while the PI and PFA
   school-year clocks are a separate thing entirely.

   Without this column a stored total has no year attached, so on 1 January last
   year's hours would keep reading as though they were current. Hours only count
   toward the requirement when this matches the present calendar year. */
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Staff' AND COLUMN_NAME='PdHoursYear')
    ALTER TABLE Staff ADD PdHoursYear NVARCHAR(10);
GO
/* ── Per-staff sign-in ──

   Until now the site had one shared password and therefore no idea WHO was using
   it. That was tolerable while every page showed the same centre-wide compliance
   data, and stopped being tolerable once a staff member can open their own file:
   W4s and background check authorisations carry social security numbers, dates of
   birth and home addresses, so "which person is asking" has to be answerable
   before those can be served.

   Only a hash is stored, never the password. Scrypt with a per-row random salt,
   so two people who choose the same password do not collide, and a copy of the
   database does not hand over anyone's password.

   MustChangePassword starts at 1 because the first credential is derived from the
   person's own name (FirstnameL). That is deliberately guessable — it exists so
   the system can be handed out on day one without a password conversation for
   each of fourteen people — which is exactly why it must not survive first use.
   Every colleague can work out that value on sight, so while it stands it is an
   enrolment code and not a secret.

   These columns are deliberately NOT in STAFF_COLUMNS. That list drives the
   staff SELECT, INSERT and UPDATE together, so adding them there would publish
   the hash through GET /api/staff and let anyone overwrite it through the PUT. */
/* The name typed at sign-in, seeded from the same FirstnameL rule as the first
   password but stored rather than derived. It has to be stable: a derived login
   name would change the day someone's surname does, and one already has — the
   record reads Paige Holliday while her transcript is filed as Paige Turner. A
   stored value also lets a collision be resolved by hand, which a rule cannot. */
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Staff' AND COLUMN_NAME='LoginName')
    ALTER TABLE Staff ADD LoginName NVARCHAR(80);
GO
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Staff' AND COLUMN_NAME='PasswordHash')
    ALTER TABLE Staff ADD PasswordHash NVARCHAR(300);
GO
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Staff' AND COLUMN_NAME='PasswordSalt')
    ALTER TABLE Staff ADD PasswordSalt NVARCHAR(120);
GO
/* Defaults to 1 so every row that predates this column — which is all of them —
   is treated as still holding its enrolment code and is made to change it. */
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Staff' AND COLUMN_NAME='MustChangePassword')
    ALTER TABLE Staff ADD MustChangePassword BIT DEFAULT 1;
GO
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Staff' AND COLUMN_NAME='PasswordSetDate')
    ALTER TABLE Staff ADD PasswordSetDate NVARCHAR(30);
GO
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Staff' AND COLUMN_NAME='LastLoginDate')
    ALTER TABLE Staff ADD LastLoginDate NVARCHAR(30);
`;
}

// Columns the staff endpoints read and write, in one place so the SELECT, the
// INSERT and the UPDATE cannot drift apart.
const STAFF_COLUMNS = [
    ['Name', 'name'], ['Role', 'role'], ['Program', 'program'], ['Classroom', 'classroom'],
    ['Fte', 'fte'], ['Education', 'education'], ['EceCredentials', 'eceCredentials'],
    ['Gateways', 'gateways'], ['ExperienceYears', 'experienceYears'], ['RegistryId', 'registryId'],
    ['Notes', 'notes'], ['ReviewedBy', 'reviewedBy'], ['ReviewedDate', 'reviewedDate'],
    ['StaffGroup', 'staffGroup'], ['SecondaryClassroom', 'secondaryClassroom'],
    ['SemesterHoursTotal', 'semesterHoursTotal'], ['SemesterHoursEce', 'semesterHoursEce'],
    ['TranscriptOnFile', 'transcriptOnFile'], ['PdHoursYtd', 'pdHoursYtd'],
    ['PdHoursYear', 'pdHoursYear']
];

/* What a staff member may change on their OWN record. Everything else on the card
   stays with the director.

   The split is by who the fact belongs to. A person knows their own transcript,
   registry number and credential levels, and chasing them for those beats the
   director transcribing fourteen sets of them — that gap is real, seven of ten
   teaching records have no semester hours at all.

   Role, classroom, FTE, programme and staff group are assignments rather than
   facts about the person, so they are not self-service: someone moving themselves
   into a classroom would change the ratio and credential calculations that the
   ExceleRate and PAS figures are built from.

   Notes is excluded on purpose too. It carries the verification trail — who
   checked a credential and when — so it is evidence about the record rather than
   part of it. */
const STAFF_SELF_EDITABLE = new Set([
    'education', 'eceCredentials', 'gateways', 'registryId', 'experienceYears',
    'semesterHoursTotal', 'semesterHoursEce', 'transcriptOnFile',
    'pdHoursYtd', 'pdHoursYear'
]);

/* ── A staff member's own files ─────────────────────────────────────────────

   The personnel folders live in the document library on the server, under Staff:
   transcripts, Gateways education reports, applications, W4s, background check
   authorisations, goal plans and work history forms.

   Which file belongs to whom is recorded explicitly, in a table, and never
   decided by reading the filename at the moment someone asks. That is the whole
   design, and the reason is that the filenames cannot carry the answer:

     - "Transcript - Paige Turner.pdf" belongs to the person the record now calls
       Paige Holliday. Only a human knows that.
     - "Transcript - Janelle Poenetske.pdf" is Janell Poenitske, misspelt in both
       halves of the name.
     - Eight files are spelled "Transcipt".
     - There are transcripts for Hannah Engel, Khrystynna Holyk and Raquel Smith,
       none of whom are on the current roster.

   A fuzzy match good enough to catch those is also loose enough to hand one
   person another person's W4, and a W4 carries a social security number. So the
   filename is used only to PROPOSE a link for the director to confirm, and an
   unconfirmed file is shown to nobody but the director. */
function staffFileLinksEnsureSQL() {
    return `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='StaffFileLinks')
    CREATE TABLE StaffFileLinks (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        StaffId INT NOT NULL,
        RelPath NVARCHAR(500) NOT NULL,
        LinkedBy NVARCHAR(200),
        LinkedDate NVARCHAR(30),
        CreatedAt DATETIME DEFAULT GETDATE(),
        CONSTRAINT UQ_StaffFileLink UNIQUE(RelPath)
    );
`;
}

/* The Staff folder inside the library, and the categories within it.

   Listed explicitly rather than by walking whatever is there, so a folder added
   later for something that is not a personnel file cannot start appearing on
   people's pages on its own. Anything outside this list is reported to the
   director as unrecognised instead. */
const STAFF_DOC_ROOT_FOLDER = 'Staff';
const STAFF_DOC_CATEGORIES = [
    ['Staff Transcripts', 'Transcript'],
    ['Staff Gateways Education Reports', 'Gateways education report'],
    ['Staff Applications', 'Application'],
    ['Staff Work History Forms', 'Work history form'],
    ['Staff Goal Plans', 'Goal plan'],
    ['Staff W4s', 'W4'],
    ['Staff Authorization for Background Check', 'Background check authorisation']
];

/* Every file under Staff, with the category it came from.
   Returns { ok, files } so a missing library is distinguishable from an empty one. */
function listStaffFolderFiles() {
    const DOC_ROOT = findDocRoot();
    if (!DOC_ROOT) return { ok: false, error: 'The document library is not reachable from the server.' };
    const base = path.join(DOC_ROOT, STAFF_DOC_ROOT_FOLDER);
    if (!fs.existsSync(base)) {
        return { ok: false, error: 'No "' + STAFF_DOC_ROOT_FOLDER + '" folder in the document library.' };
    }
    const files = [];
    STAFF_DOC_CATEGORIES.forEach(([folder, label]) => {
        const dir = path.join(base, folder);
        if (!fs.existsSync(dir)) return;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        entries.forEach(e => {
            if (!e.isFile()) return;
            files.push({
                name: e.name,
                category: label,
                folder: folder,
                rel: (STAFF_DOC_ROOT_FOLDER + '/' + folder + '/' + e.name)
            });
        });
    });
    return { ok: true, files: files };
}

/* Levenshtein distance, capped: anything past the cap is simply "too different"
   and the exact number does not matter. Hand-rolled because this project takes no
   dependencies, and it is only ever run over short name tokens. */
function editDistance(a, b, cap) {
    a = String(a || ''); b = String(b || '');
    if (Math.abs(a.length - b.length) > cap) return cap + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let best = i;
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
            if (cur[j] < best) best = cur[j];
        }
        if (best > cap) return cap + 1;
        prev = cur;
    }
    return prev[b.length];
}

function nameWords(s) {
    return String(s || '').toLowerCase().replace(/[^a-z]+/g, ' ')
        .split(' ').filter(w => w.length > 1);
}

/* How well a filename appears to name this staff member, as something a person
   can read and agree or disagree with. Never used to grant access on its own.

   'firm'  — both names present, allowing a letter or two of misspelling
   'weak'  — only the first name matches
   null    — no reason to connect them */
function proposeStaffMatch(fileName, staffName) {
    const fileWords = nameWords(fileName);
    const parts = nameWords(staffName);
    if (!fileWords.length || !parts.length) return null;
    const first = parts[0];
    const last = parts.length > 1 ? parts[parts.length - 1] : '';

    const near = (target) => fileWords.some(w =>
        w === target
        || (target.length >= 5 && (w.startsWith(target) || target.startsWith(w)))
        || editDistance(w, target, target.length >= 6 ? 2 : 1) <= (target.length >= 6 ? 2 : 1));

    const firstHit = near(first);
    if (!firstHit) return null;
    if (last && near(last)) return { confidence: 'firm', why: 'first and last name both match' };
    return { confidence: 'weak', why: 'first name matches, surname does not' };
}

// Files already assigned, as { rel: staffId }.
function staffFileLinkMap() {
    const r = runSQLRows(
        `SELECT StaffId, RelPath FROM StaffFileLinks`,
        staffFileLinksEnsureSQL() + 'GO\n');
    if (!r.ok) return { ok: false, error: r.error };
    const byPath = {};
    r.rows.forEach(row => { byPath[String(row.RelPath)] = String(row.StaffId); });
    return { ok: true, byPath: byPath };
}

/* One-time migration payload: the staff list that used to be hardcoded in
   staff-cards.html as DEFAULT_STAFF. Inserted only when the table is empty, so
   it runs once and never overwrites the director's later edits. Registry IDs
   have been lifted out of the free-text notes into their own column; the notes
   are kept verbatim because they carry the verification trail.

   Safe to delete this constant once the table is populated in production. */
const STAFF_SEED = [
    { name: 'Keyona Hentz', role: 'Teacher', program: 'PFA', classroom: 'Pre-School', fte: '1.0', education: "Bachelor's", eceCredentials: 'ECE Level 5, IT Level 4, Director Level I', gateways: 'ECE Credential - Level 5', experienceYears: '9.5', registryId: 'N285894', notes: "Holds a Director Level I credential and serves as PFA Director for the grant, but her role here is Teacher. Bachelor's ECE (Univ of Arizona Global, 2020). Associate's ECE (SWIC, 2016). Prior: Toddle Town Inc IT (5/2015-5/2018, 6,240 hrs) + Preschool (3/2020-5/2022, 4,160 hrs), Belleville PS Dist 118 IT (08/22-08/24, 2,340 hrs). Current: CofP since 2/2024 - PFA Teacher + Director (teaching 520 hrs + admin 2,050 hrs thru 03/2025, continuing). Total ~9.5 yrs as of 08/2026." },
    { name: 'Madeline Muir', role: 'Assistant Teacher', program: 'PFA', classroom: 'Pre-School', fte: '1.0', education: 'High School/GED', eceCredentials: 'ECE Level 1', gateways: 'ECE Credential - Level 1', experienceYears: '3.5', registryId: 'N559187', notes: 'HS Diploma (Waterloo HS, 2012). ECE Level 1 (2/20/2025). Prior: Together We Grow - Asst Teacher Infant room (01/2023-05/2023, 4,160 hrs). Current: CofP since 01/2024.' },
    { name: 'Lindsey Runyon', role: 'Teacher', program: 'INCCRA', classroom: 'Toddlers', fte: '1.0', education: "Associate's", eceCredentials: 'ECE Level 1', gateways: 'ECE Credential - Level 1', experienceYears: '14', registryId: 'N171961', notes: "Associate's ECC (SWIC, 2011). At CofP since 4/2/2012. Moved from Pre-School 2 to the Toddler room for 2026-2027. 40hrs/wk. Pending: ECE & IT (Missing Documents)." },
    { name: 'Tara Goldsmith', role: 'Teacher', program: 'PI', classroom: 'Infant', fte: '1.0', education: 'High School/GED', eceCredentials: 'ECE Level 1, CDA', gateways: 'ECE Credential - Level 1', experienceYears: '14', registryId: 'N230823', notes: 'HS Diploma (Belleville West, 2004). At CofP since 10/15/2012. 40hrs/wk x 12+ yrs = 24,900+ hrs. Now the Infant Room Teacher (no longer floating). Holds a CDA. Pending: Director, ECE, IT.' },
    { name: 'Paige Turner', role: 'Teacher', program: 'PI', classroom: 'Infant/Toddler', fte: '.75', education: 'High School/GED', eceCredentials: '', gateways: '', experienceYears: '10', registryId: 'N452129', notes: 'HS Diploma (Litchfield Senior HS, 2013). At CofP since 1/2016 as Infant/Toddler Teacher. 32hrs/wk x 8+ yrs = 13,312+ hrs. Verified by Megan Nooney 12/16/2024. No Gateways credential yet.' },
    { name: 'Janell Poenitske', role: 'Teacher', program: 'PI', classroom: 'Pre-School 2', fte: '1.0', education: 'Some College', eceCredentials: 'ECE Level 1', gateways: 'ECE Credential - Level 1', experienceYears: '12', registryId: 'N147146', notes: "Pursuing a Director credential, but her role here is Teacher. HS Diploma (Providence HS, 1994). Coursework: Bachelor's Music (SIUE). Prior: Together We Grow (9/2023, 1,040 hrs), Magic Building Blocks (9/09-12/2010, 4,640 hrs), First Baptist/Early Years (10/2015-2/2023, 15,184 hrs). Current: CofP since 6/3/2024. Pending: Director, IT, ECE." },
    { name: 'Sue Engel', role: 'Teacher', program: 'PI', classroom: 'Infant/Toddler', fte: '.75', education: 'High School/GED', eceCredentials: 'ECE Level 1', gateways: 'ECE Credential - Level 1', experienceYears: '37', registryId: 'N278509', notes: 'HS Diploma (Belleville West, 1982). At CofP since 5/1988. 30hrs/wk x 36+ yrs = 56,160+ total hrs. Preschool/Toddler - care, feed, daily activities. Pending: ECE & IT.' },
    { name: 'Renee Nier', role: 'Assistant Teacher', program: 'PI', classroom: '2 Year Olds / Toddlers', fte: '1.0', education: '', eceCredentials: '', gateways: '', experienceYears: '', registryId: '', notes: 'Sole staff member in the 2 Year Olds / Toddlers room as of 2026-2027. Not in Gateways report as of 2/24/2025 — qualifications still need gathering.' },
    /* Classroom is deliberately blank: Megan is Director only as of 2026-2027,
       with no assigned room. That keeps her off the teaching staff worksheets —
       her qualifications belong on the Administrator Qualifications worksheet. */
    { name: 'Megan Nooney', role: 'Director', program: 'PI', classroom: '', fte: '1.0', education: "Associate's", eceCredentials: 'ECE Level 1, Gold IT2, Autism 101', gateways: 'ECE Credential - Level 1', experienceYears: '17.5', registryId: 'N179660', notes: "Director only as of 2026-2027, no assigned classroom. Associate's ECE (SWIC, 2012). At CofP since 01/2009. Prior teaching: 40hrs/wk x 15+ yrs = 31,200+ hrs - lead teacher preschool, curriculum, schedules. Admin: Director since 01/2009 - staff, files, admin, filling classrooms. Pending: IT, ECE, Director (Awaiting Work Exp). Gold IT2 (1/2024)." },
    { name: 'Molly Ellis', role: 'Teacher', program: 'PI', classroom: '2 Year Olds', fte: '', education: '', eceCredentials: '', gateways: '', experienceYears: '', registryId: '', notes: 'New teacher for 2026-2027, took over the 2 Year Olds room from Janell Poenitske. Qualifications not yet gathered — needs education, Gateways ECE level, credentials and prior experience before the PAS worksheets can be completed.' },
    /* Ownership group. Taken from the Gateways Staff Education and Credentials
       report of 9/6/2026, which is the source of truth for names, degrees and
       credential levels. Grouped separately from classroom staff because the
       ExceleRate credential thresholds are proportions of teaching staff. */
    { name: 'Pamela Holliday', role: 'Director', program: 'n/a', classroom: 'Before and Afterschool', fte: '', education: "Master's", eceCredentials: 'ECE Level 5', gateways: 'ECE Credential - Level 5', experienceYears: '21', registryId: 'N52689', staffGroup: 'Ownership', notes: 'Ownership group. Gateways 9/6/2026: Director/Early Childhood Teacher, position code 16 Director/Administrator (multi site), serves School-Age, at CofP since 1/3/2005. HS (Collinsville 1967), Bachelor\u2019s Special Education (SIU Carbondale 1971), Master\u2019s Special Education (SIUE 1976). ECE Level 1 (9/13/2017), ECE Level 5 (3/25/2025). Pending: Illinois Director Credential (Awaiting Work Experience).' },
    { name: 'Clete Holliday', role: 'Director', program: 'n/a', classroom: '', fte: '', education: "Bachelor's", eceCredentials: '', gateways: '', experienceYears: '', registryId: 'N297190', staffGroup: 'Ownership', notes: 'Ownership group, no classroom assignment. Gateways 9/6/2026: Manager LLC, position code 1 Director/Administrator (one site), age served Not Applicable, since 1/1/2025. Associate\u2019s and Bachelor\u2019s Electrical Engineering. No Gateways credentials. REGISTRY MEMBERSHIP EXPIRED \u2014 needs renewal.' },
    { name: 'Jeremy Holliday', role: 'Assistant Teacher', program: 'n/a', classroom: 'Before and Afterschool', fte: '', education: 'High School/GED', eceCredentials: 'ECE Level 1', gateways: 'ECE Credential - Level 1', experienceYears: '11', registryId: 'N279427', staffGroup: 'Ownership', notes: 'Ownership group. Gateways 9/6/2026: Assistant Child Care Worker, position code 5 Assistant Teacher, serves Preschool, at CofP since 1/5/2015. HS (Belleville West 2001). ECE Level 1 (10/13/2017).' },
    { name: 'Sara Holliday', role: 'Teacher', program: 'n/a', classroom: 'Before and Afterschool', fte: '', education: 'Some College', eceCredentials: 'ECE Level 1', gateways: 'ECE Credential - Level 1', experienceYears: '26', registryId: 'N236163', staffGroup: 'Ownership', notes: 'Ownership group. Gateways 9/6/2026: Early Childhood Teacher, position code 4 Teacher, serves Infants and Preschool, at CofP since 5/1/2000 (position since 5/1/2008). HS (Belleville West 2000), coursework toward Associate\u2019s and Bachelor\u2019s (no degree awarded). ECE Level 1 (12/4/2017). Pending: ECE Credential and Infant Toddler Credential (both Awaiting Additional Coursework).' },
    { name: 'New Teacher', role: 'TBD', program: 'n/a', classroom: 'TBD', fte: '', education: '', eceCredentials: '', gateways: '', experienceYears: '', registryId: '', notes: 'Placeholder for new hire' }
];

function staffSeedSQL() {
    const cols = STAFF_COLUMNS.map(([c]) => c).join(',');
    const rows = STAFF_SEED.map(s =>
        '(' + STAFF_COLUMNS.map(([, key]) => esc(s[key])).join(',') + ')').join(',\n        ');
    // Guarded on the table being empty, so this is a migration and not a reset.
    return `IF NOT EXISTS (SELECT 1 FROM Staff)
    INSERT INTO Staff (${cols}) VALUES
        ${rows};
`;
}

// ── StaffTraining schema ──
// One row per staff member per training. Backs two different requirements from
// the same data: the ExceleRate Silver thresholds (How ERS Works needs the
// director plus 50% of teaching staff, ideally one per classroom) and PICC PI9,
// which wants a professional development record for every staff member.
//
// Keyed on (StaffId, TrainingKey). A completion is cleared by deleting the row
// rather than blanking the date, so "no row" unambiguously means not done.
function staffTrainingEnsureSQL() {
    return `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='StaffTraining')
    CREATE TABLE StaffTraining (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        StaffId INT NOT NULL,
        TrainingKey NVARCHAR(60) NOT NULL,
        CompletedDate NVARCHAR(20),
        EvidenceLink NVARCHAR(500),
        Notes NVARCHAR(MAX),
        CreatedAt DATETIME DEFAULT GETDATE(),
        UpdatedAt DATETIME DEFAULT GETDATE()
    );
`;
}

/* ── StaffDevelopmentPlan / StaffDevelopmentGoal schemas ──
   PICC PI9 requires a written, dated Professional Development Plan for every PI
   staff member, carrying the person's name, the plan date and timelines, an
   assessment of their needs, and a description of the learning the program will
   provide. Those four things are the columns below.

   Superseded plans are kept rather than overwritten. PI9 asks for timelines, and
   a single mutable row cannot evidence progression or show a monitor that the
   mid-year review happened. The current plan is the newest row for that person
   with Status='Active'; issuing a new one marks the previous 'Superseded'.

   Note the frequency: PI9 itself states no review cadence. The annual and
   mid-year rhythm comes from the employee handbook 10.3 and the staff timeline,
   which are the centre's own policy and stricter than the regulation. */
function staffDevPlanEnsureSQL() {
    return `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='StaffDevelopmentPlan')
    CREATE TABLE StaffDevelopmentPlan (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        StaffId INT NOT NULL,
        PlanDate NVARCHAR(20),
        ReviewDate NVARCHAR(20),
        PlanType NVARCHAR(30),
        SchoolYear NVARCHAR(20),
        Location NVARCHAR(120),
        SupervisorName NVARCHAR(200),
        /* Self-assessment, in the four parts the centre's own goal plan uses.
           Written by the employee, so these are never auto-filled. */
        Strengths NVARCHAR(MAX),
        GrowthAreas NVARCHAR(MAX),
        FavoriteAspect NVARCHAR(MAX),
        Frustrations NVARCHAR(MAX),
        /* One SMART goal per plan, matching the existing form rather than a
           in StaffDevelopmentGoal, each with its own mid-year review. */
        /* Three sign-off points, as the 2024-25 form has them: the plan is agreed
           at the start of the year, reviewed mid-year, and evaluated at year end.
           Each carries its own notes and two signature dates, so one sheet
           evidences the whole year rather than three separate documents. */
        InitialDate NVARCHAR(20),
        InitialNotes NVARCHAR(MAX),
        InitialStaffSigned NVARCHAR(20),
        InitialSupervisorSigned NVARCHAR(20),
        MidYearDate NVARCHAR(20),
        MidYearNotes NVARCHAR(MAX),
        MidYearStaffSigned NVARCHAR(20),
        MidYearSupervisorSigned NVARCHAR(20),
        YearEndDate NVARCHAR(20),
        YearEndNotes NVARCHAR(MAX),
        YearEndStaffSigned NVARCHAR(20),
        YearEndSupervisorSigned NVARCHAR(20),
        NeedsAssessment NVARCHAR(MAX),
        ProgramWillProvide NVARCHAR(MAX),
        LongTermGoals NVARCHAR(MAX),
        StaffSignedDate NVARCHAR(20),
        SupervisorSignedDate NVARCHAR(20),
        Status NVARCHAR(20) DEFAULT 'Active',
        CreatedAt DATETIME DEFAULT GETDATE(),
        UpdatedAt DATETIME DEFAULT GETDATE()
    );
GO
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='StaffDevelopmentGoal')
    CREATE TABLE StaffDevelopmentGoal (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        PlanId INT NOT NULL,
        Goal NVARCHAR(MAX),
        /* Named as the form names them: the professional development that will
           support the goal, and the measurement that will evidence completion. */
        PdSupport NVARCHAR(MAX),
        Measurement NVARCHAR(MAX),
        /* Per-goal review, which is the part that makes progression visible. The
           2024-25 form carried a review date and mid-year comment against each
           goal individually, not one comment for the whole plan. */
        MidYearReviewDate NVARCHAR(20),
        MidYearComments NVARCHAR(MAX),
        YearEndComments NVARCHAR(MAX),
        ActionSteps NVARCHAR(MAX),
        Timeline NVARCHAR(200),
        Resources NVARCHAR(500),
        Evidence NVARCHAR(500),
        Status NVARCHAR(30),
        CompletedDate NVARCHAR(20),
        SortOrder INT DEFAULT 0,
        CreatedAt DATETIME DEFAULT GETDATE(),
        UpdatedAt DATETIME DEFAULT GETDATE()
    );
`;
}

const DEVPLAN_COLUMNS = [
    ['StaffId', 'staffId'], ['PlanDate', 'planDate'], ['ReviewDate', 'reviewDate'],
    ['PlanType', 'planType'], ['SchoolYear', 'schoolYear'],
    ['Location', 'location'], ['SupervisorName', 'supervisorName'],
    ['Strengths', 'strengths'], ['GrowthAreas', 'growthAreas'],
    ['FavoriteAspect', 'favoriteAspect'], ['Frustrations', 'frustrations'],
    ['InitialDate', 'initialDate'], ['InitialNotes', 'initialNotes'],
    ['InitialStaffSigned', 'initialStaffSigned'], ['InitialSupervisorSigned', 'initialSupervisorSigned'],
    ['MidYearDate', 'midYearDate'], ['MidYearNotes', 'midYearNotes'],
    ['MidYearStaffSigned', 'midYearStaffSigned'], ['MidYearSupervisorSigned', 'midYearSupervisorSigned'],
    ['YearEndDate', 'yearEndDate'], ['YearEndNotes', 'yearEndNotes'],
    ['YearEndStaffSigned', 'yearEndStaffSigned'], ['YearEndSupervisorSigned', 'yearEndSupervisorSigned'],
    ['NeedsAssessment', 'needsAssessment'],
    ['ProgramWillProvide', 'programWillProvide'], ['LongTermGoals', 'longTermGoals'],
    ['StaffSignedDate', 'staffSignedDate'], ['SupervisorSignedDate', 'supervisorSignedDate'],
    ['Status', 'status']
];
const DEVGOAL_COLUMNS = [
    ['PlanId', 'planId'], ['Goal', 'goal'],
    ['PdSupport', 'pdSupport'], ['Measurement', 'measurement'],
    ['MidYearReviewDate', 'midYearReviewDate'], ['MidYearComments', 'midYearComments'],
    ['YearEndComments', 'yearEndComments'],
    ['ActionSteps', 'actionSteps'],
    ['Timeline', 'timeline'], ['Resources', 'resources'], ['Evidence', 'evidence'],
    ['Status', 'status'], ['CompletedDate', 'completedDate'], ['SortOrder', 'sortOrder']
];

/* ── Document library ───────────────────────────────────────────────────────────
   The monitoring evidence already lives in a OneDrive-synced folder on this
   machine. It is INDEXED here, not copied: two years of files stay exactly where
   they are, so nothing can diverge between a store and the folder Megan and Clete
   already use. What this adds is a way to reach it without a Microsoft login, and
   a record of what is checked out.

   Folder names are deliberately NOT trusted. Across 2025 and 2026 the same item
   appears as "CB2" and "CB2.D - DCFS License and Evidence of Excelrate", and one
   folder is misspelled "afer" in SharePoint. Matching on the item number parsed
   out of the name makes every one of those equivalent, and keeps working when
   somebody renames a folder next year.

   The trailing "- M" / "- C" is the owner: Megan or Clete.                     */

/* Where the evidence lives.

   OneDrive syncs the library under the signed-in user's profile, and the server
   runs as a different account from any workstation, so a hardcoded path works on
   one machine and silently fails on the other. This searches the profiles for the
   synced library instead, and caches the answer.

   COFP_DOC_ROOT overrides it outright if the folder ever moves somewhere unusual. */
const DOC_ROOT_CANDIDATES = [];
let DOC_ROOT_CACHE = null;

function findDocRoot() {
    if (process.env.COFP_DOC_ROOT) return process.env.COFP_DOC_ROOT;
    if (DOC_ROOT_CACHE && fs.existsSync(DOC_ROOT_CACHE)) return DOC_ROOT_CACHE;
    DOC_ROOT_CANDIDATES.length = 0;
    const tails = [
        ['Children Of Promise', 'Children Of Promise - Documents', 'Operations'],
        ['OneDrive - Children Of Promise', 'Children Of Promise - Documents', 'Operations'],
        ['Children Of Promise - Documents', 'Operations'],
        ['OneDrive', 'Children Of Promise - Documents', 'Operations']
    ];
    /* Checked first: the library's own home on this server.

       OneDrive syncs per signed-in profile, which is why nothing was found here —
       the server runs as a service account with no OneDrive at all. Rather than
       run a sync client as a service, the library lives on the server and the
       server owns it. That is also the point of retiring SharePoint: one copy, in
       the place the application can actually read and write. */
    const SERVER_HOMES = [
        'C:\\app\\documents\\Operations',
        'C:\\CofP-Docs\\Operations',
        'D:\\CofP-Docs\\Operations'
    ];
    for (const p of SERVER_HOMES) {
        DOC_ROOT_CANDIDATES.push(p);
        if (fs.existsSync(p)) { DOC_ROOT_CACHE = p; return p; }
    }
    // Then a workstation's synced copy, which is where it lives before migration.
    const bases = [];
    try {
        fs.readdirSync('C:\\Users', { withFileTypes: true })
            .filter(d => d.isDirectory() && !/^(All Users|Default|Public|Default User)$/i.test(d.name))
            .forEach(d => bases.push(path.join('C:\\Users', d.name)));
    } catch (e) { /* fall through to the fixed candidates below */ }
    bases.push('C:\\', 'C:\\app');
    for (const b of bases) {
        for (const t of tails) {
            const p = path.join(b, ...t);
            DOC_ROOT_CANDIDATES.push(p);
            if (fs.existsSync(p)) { DOC_ROOT_CACHE = p; return p; }
        }
    }
    return null;
}

/* Pulls the PICC/PIQUET item number out of a folder name.
     "CB2.D - DCFS License and Evidence of Excelrate"  -> CB2.D
     "PI5.A-G Weighted Eligiblity Screen Form"         -> PI5.A-G
     "PI8.B Written CQIP - Completed afer Monitoring"  -> PI8.B
     "Child or Family Files - M"                       -> null (not an item) */
function docItemNumber(folderName) {
    /* The range part is tight on purpose: "A-B" and "A-G" never carry spaces.
       Allowing them made "CB2.D - DCFS License..." parse as CB2.D-D, swallowing
       the D of DCFS as a range end. A following letter must also not be part of a
       word, so "PI8.A written" stops at .A rather than reading into the text. */
    const m = String(folderName || '').match(/^\s*(CB|PI)\s*(\d+)(\.[A-Z](?:-[A-Z])?(?![A-Za-z]))?/);
    if (!m) return null;
    return m[1].toUpperCase() + m[2] + (m[3] || '').toUpperCase();
}

// Owner from the trailing marker. Absent on folders added since the convention.
function docOwner(folderName) {
    const m = String(folderName || '').match(/-\s*([MC])\s*$/);
    return m ? (m[1].toUpperCase() === 'M' ? 'Megan' : 'Clete') : '';
}

// Child and family files are per-child rather than per-item.
function isChildFileFolder(name) {
    return /child\s*or\s*family|family\s*files/i.test(String(name || ''));
}

/* The folder a child's own evidence belongs in, for a program and year.

   Returns { path } on success or { error } with something a person can act on.
   Finds the folder by the same rule the indexer uses rather than by an exact name,
   because the real folders are named inconsistently ("Child or Family Files",
   "Family Files 2026"). If the year folder is there but has no child folder, one is
   created: that is the difference between signing working on a fresh year and
   failing with a message nobody can interpret. The year folder itself is never
   created, because getting that name wrong would scatter evidence into a directory
   no other part of the system reads. */
function childFilesFolder(program, year) {
    const DOC_ROOT = findDocRoot();
    if (!DOC_ROOT) return { error: 'The document library is not reachable from the server.' };
    const programFolder = program === 'PFA' ? 'Preschool for All' : 'Birth to Three';
    const y = String(year || '').replace(/[^0-9]/g, '').slice(0, 4) || String(new Date().getFullYear());
    const yearFolder = program === 'PFA' ? 'PFA Monitoring Visit ' + y : y + ' PI Monitoring Visit';
    const base = path.join(DOC_ROOT, programFolder, yearFolder);
    if (!fs.existsSync(base)) {
        return { error: 'No folder "' + programFolder + '/' + yearFolder + '" in the library yet.' };
    }
    let found = null;
    try {
        found = fs.readdirSync(base, { withFileTypes: true })
            .filter(d => d.isDirectory() && isChildFileFolder(d.name))
            .map(d => path.join(base, d.name))[0] || null;
    } catch (e) { /* fall through to creating one */ }
    if (found) return { path: found };
    const made = path.join(base, 'Child or Family Files');
    try {
        fs.mkdirSync(made);
        console.log('[DOC] created ' + path.relative(DOC_ROOT, made));
        return { path: made };
    } catch (e) {
        return { error: 'Could not create a child files folder: ' + e.message };
    }
}

// ── Captured signatures ──
// The signed document is a PDF in the child's folder, exactly where a scan of a
// signed sheet would go; this table only points at it. One row per child, year, form
// and role, and the roles of one form point at the same PDF. Re-signing re-points
// the rows and leaves every previously signed PDF on disk.
function childSignatureEnsureSQL() {
    return `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ChildSignatures')
    CREATE TABLE ChildSignatures (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        StudentId INT NOT NULL,
        SchoolYear NVARCHAR(20),
        FormField NVARCHAR(60),
        Role NVARCHAR(20),
        SignedName NVARCHAR(200),
        RelPath NVARCHAR(500),
        SignedAt DATETIME,
        CapturedOn NVARCHAR(60)
    );
GO
`;
}

/* Where superseded evidence goes. Archiving MOVES a file here rather than deleting
   it: this is compliance evidence, and a monitor may still ask for the version that
   was current last year. The leading underscore keeps it sorted away from the item
   folders and gives the indexer one simple rule to skip. */
const DOC_ARCHIVE_DIR = '_Archive';

function isArchiveFolder(name) {
    return String(name || '').trim().toLowerCase() === DOC_ARCHIVE_DIR.toLowerCase();
}

/* Where a given evidence file should be archived to, as a library-relative folder.

   Layout is "<program>/<visit folder>/<item folder…>/<file>", so the archive goes at
   "<program>/<visit folder>/_Archive/<item folder…>". Keeping the originating folder
   name inside the archive answers the only question anyone browsing it will have:
   which checklist item was this evidence for.

   Pure so it can be tested without touching the filesystem. Returns { archiveRel }
   or { error } — never a guess, because the caller is about to move a file. */
function archiveTargetFor(rel) {
    const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean) return { error: 'relPath required' };
    const parts = clean.split('/').filter(Boolean);
    if (parts.some(isArchiveFolder)) return { error: 'That file is already archived' };
    // program / visit folder / …at least one more segment for the file itself
    if (parts.length < 3) {
        return { error: 'That file is not inside a monitoring visit folder' };
    }
    const visitRel = parts.slice(0, 2).join('/');
    const originRel = parts.slice(2, -1).join('/');   // '' for a file loose in the visit folder
    return { archiveRel: [visitRel, DOC_ARCHIVE_DIR, originRel].filter(Boolean).join('/') };
}

/* Checked-out state, and any note attached to a file. Only rows that need one
   exist: an unremarkable file has no row, so "no row" means available. Keyed on
   the path relative to DOC_ROOT so a file keeps its history if the tree moves. */
function docMetaEnsureSQL() {
    return `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='DocumentMeta')
    CREATE TABLE DocumentMeta (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        RelPath NVARCHAR(500) NOT NULL,
        ItemNumber NVARCHAR(40),
        SchoolYear NVARCHAR(20),
        Owner NVARCHAR(60),
        CheckedOutBy NVARCHAR(120),
        CheckedOutDate NVARCHAR(20),
        DueBackDate NVARCHAR(20),
        Notes NVARCHAR(MAX),
        CreatedAt DATETIME DEFAULT GETDATE(),
        UpdatedAt DATETIME DEFAULT GETDATE()
    );
`;
}

/* Resolves a caller-supplied relative path inside DOC_ROOT.

   This is the security boundary for the whole feature. A request controls the
   path, so it is resolved and then checked to be genuinely inside the root —
   without that, "..\..\..\Windows\System32" would be served. Returns null on
   anything that escapes, which callers treat as 404 rather than explaining why. */
/* ── Document roots ──
   There are two places editable documents live: the compliance library (the
   default) and the PAS folder of handbooks and policies. Rather than a second
   resolver, a path may carry an explicit "<rootId>:" prefix, and resolveDocPath
   below stays the one and only boundary.

   The library is deliberately left UNPREFIXED. Every DocumentMeta row, every
   check-out record and every link already rendered by the checklist uses a bare
   library-relative path, so prefixing it would orphan all of them.

   A colon is a safe delimiter because Windows forbids it in a file name, so no
   real relative path inside either root can contain one. */
const DOC_ROOTS = {
    pas: () => path.join(__dirname, '..', 'PAS')
};

function splitDocRef(ref) {
    const s = String(ref == null ? '' : ref);
    const m = /^([a-z][a-z0-9]*):(.*)$/.exec(s);
    if (m && Object.prototype.hasOwnProperty.call(DOC_ROOTS, m[1])) {
        return { rootId: m[1], rel: m[2] };
    }
    return { rootId: '', rel: s };
}

function docRootFor(rootId) {
    if (!rootId) return findDocRoot();
    const fn = DOC_ROOTS[rootId];
    return fn ? fn() : null;
}

/* Resolves a caller-supplied path inside whichever root it names.

   This is the security boundary for the whole feature, for both roots. A request
   controls the path, so it is resolved and then checked to be genuinely inside the
   chosen root — without that, "..\..\..\Windows\System32" would be served. An
   unrecognised prefix is NOT treated as a root, it falls through to the library
   and then fails containment, so a guessed prefix cannot reach anything.

   Returns null on anything that escapes, which callers treat as 404 rather than
   explaining why. */
function resolveDocPath(ref) {
    if (!ref) return null;
    const { rootId, rel } = splitDocRef(ref);
    const docRoot = docRootFor(rootId);
    if (!docRoot) return null;
    const decoded = String(rel).replace(/\\/g, '/');
    if (!decoded || decoded.includes('\0')) return null;
    const root = path.resolve(docRoot);
    const full = path.resolve(root, decoded);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (full !== root && !full.startsWith(rootWithSep)) return null;
    return full;
}

/* ── Office editing (OnlyOffice Docs) ───────────────────────────────────────
   Editing a Word or Excel file in the browser needs a document server; nothing
   in Node can render .docx faithfully. OnlyOffice Docs Community Edition does
   the rendering, and this server supplies the file and receives it back.

   The whole feature is OFF unless COFP_ONLYOFFICE_URL is set, so this code is
   inert on a machine without it and cannot break the library.

   Flow:
     1. Browser asks us for an editor config for a document.
     2. We return a config naming a download URL and a callback URL, signed with
        a secret shared with OnlyOffice so neither end accepts forged requests.
     3. OnlyOffice fetches the file from the download URL.
     4. When the user finishes editing, OnlyOffice POSTs the callback with a URL
        to the edited file, and we write it back into the library.

   Set on the server:
       setx COFP_ONLYOFFICE_URL "http://localhost:8080" /M
       setx COFP_ONLYOFFICE_SECRET "a-long-random-string" /M
   The secret must match OnlyOffice's own JWT secret exactly. */
const ONLYOFFICE_URL = (process.env.COFP_ONLYOFFICE_URL || '').replace(/\/+$/, '');

/* The address OnlyOffice should use to fetch and return documents.

   By default the config hands it our public HTTPS hostname, which means the
   document server loops out to the internet and back to reach a file sitting on
   its own disk. That hairpin frequently fails on a VPS, and the symptom is an
   editor that loads and then reports the document as missing.

   Setting this to http://localhost keeps the fetch on the box:
       setx COFP_SELF_URL "http://localhost" /M

   Safe over plain HTTP because the traffic never leaves the machine, and the
   download is authenticated by a one-time key scoped to a single file. */
const SELF_URL = (process.env.COFP_SELF_URL || '').replace(/\/+$/, '');

/* Endpoints the document server calls, which must NOT be redirected to HTTPS.
   OnlyOffice does not follow the redirect, so a redirect reads to it as a failed
   download — the same "not found" symptom. */
const OFFICE_NO_REDIRECT = ['/api/office-file', '/api/office-callback'];
const ONLYOFFICE_SECRET = process.env.COFP_ONLYOFFICE_SECRET || '';
const ONLYOFFICE_ON = !!(ONLYOFFICE_URL && ONLYOFFICE_SECRET);

// Which extensions OnlyOffice can actually edit, as opposed to only display.
const OFFICE_EDITABLE = { '.docx': 'word', '.xlsx': 'cell', '.pptx': 'slide' };
const OFFICE_VIEWABLE = { '.doc': 'word', '.xls': 'cell', '.ppt': 'slide', '.pdf': 'word' };

/* Paths the OnlyOffice editor requests, proxied through this site so the
   document server needs no public port. Order does not matter; these are matched
   as prefixes. Kept in one place because a version upgrade can add to the list,
   and a missing prefix shows up as an editor that half-loads. */
/* OnlyOffice also serves its assets under a version-and-hash prefix, e.g.
       /9.4.0-f19a704d416ba1e465d291ae249d3c81/web-apps/...
   That prefix changes with every release, so it cannot be listed. Matching the
   shape instead. Missing this produced a plain "Not Found" from our own static
   handler: the editor script loaded, then every asset it asked for 404'd. */
// The version must be followed by a separator, not run straight into more
// characters — otherwise /9.4.0abc/ would be treated as a version prefix.
const OFFICE_VERSION_PREFIX = /^\/\d+\.\d+\.\d+(?:[-.][\w.-]*)?\//;

function isOfficePath(url) {
    if (OFFICE_VERSION_PREFIX.test(url)) return true;
    return OFFICE_PROXY_PREFIXES.some(p => url === p || url.startsWith(p + '/')
        || url.startsWith(p + '?') || (p.endsWith('.ashx') && url.startsWith(p)));
}

const OFFICE_PROXY_PREFIXES = [
    '/web-apps',            // the editor application itself
    '/sdkjs',               // editing engine
    '/sdkjs-plugins',
    '/fonts',
    '/cache',               // rendered document pieces
    '/doc',                 // document sessions, including the co-authoring socket
    '/coauthoring',
    '/downloadas',
    '/ConvertService.ashx',
    '/FileUploader.ashx',
    '/healthcheck',
    '/dictionaries',
    '/themes'
];

/* HS256 JSON Web Token, hand-rolled to avoid adding a dependency. OnlyOffice
   accepts a standard JWT; the signature is what stops anyone who can reach the
   document server from asking it to open arbitrary files. */
function b64url(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function officeJwt(payload) {
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify(payload));
    const sig = b64url(crypto.createHmac('sha256', ONLYOFFICE_SECRET)
        .update(header + '.' + body).digest());
    return header + '.' + body + '.' + sig;
}
function officeJwtVerify(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const expect = b64url(crypto.createHmac('sha256', ONLYOFFICE_SECRET)
        .update(parts[0] + '.' + parts[1]).digest());
    // Constant-time compare, so a wrong signature leaks nothing by timing.
    const a = Buffer.from(parts[2]), b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try { return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); }
    catch (e) { return null; }
}

/* One-time keys let OnlyOffice fetch a document without holding staff
   credentials. The document server is trusted to render, not to log in as a
   member of staff — so it gets a short-lived key scoped to a single file. */
const officeKeys = new Map();
function officeIssueKey(relPath) {
    const key = crypto.randomBytes(24).toString('hex');
    officeKeys.set(key, { relPath, expires: Date.now() + 12 * 60 * 60 * 1000 });
    // Housekeeping: drop anything expired rather than growing without bound.
    for (const [k, v] of officeKeys) if (v.expires < Date.now()) officeKeys.delete(k);
    return key;
}
function officeResolveKey(key) {
    const e = officeKeys.get(key);
    if (!e || e.expires < Date.now()) return null;
    return e.relPath;
}

/* PFA numbers its items on the FILENAME, not the folder — the whole visit folder
   is flat. So a second parser is needed:

     "Item 1 - PFA Classroom Information Form - FY 24-25.docx" -> Item1
     "Item 13 a) - Transition Letter to Kindergarten.docx"     -> Item13.A
     "Item 13 B) 2024-25 C of P - Behavior Plan.docx"          -> Item13.B
     "2025 PFA-Compliance-Checklist.pdf"                       -> null

   The sub-letter must be followed by a closing paren. Without that rule
   "Item 1 PFA - Waiting List.pdf" parses as Item1.P, because "PFA" begins with
   a letter in exactly the position a sub-item would occupy. */
function docItemNumberFromFile(fileName) {
    const m = String(fileName || '').match(/^\s*Item\s*(\d+)\s*(?:([A-Za-z])\s*\))?/i);
    if (!m) return null;
    return 'Item' + m[1] + (m[2] ? '.' + m[2].toUpperCase() : '');
}

// Walks a year's evidence folder and groups the files by item number.
function indexYearFolder(programFolder, yearFolder) {
    const DOC_ROOT = findDocRoot();
    if (!DOC_ROOT) return { items: {}, childFiles: [], missing: true, noRoot: true };
    const base = path.join(DOC_ROOT, programFolder, yearFolder);
    const out = { items: {}, childFiles: [], missing: !fs.existsSync(base) };
    if (out.missing) {
        // List what IS there, so a naming difference is obvious rather than guessed at.
        const parent = path.join(DOC_ROOT, programFolder);
        try {
            if (fs.existsSync(parent)) {
                out.siblings = fs.readdirSync(parent, { withFileTypes: true })
                    .filter(d => d.isDirectory()).map(d => d.name);
            }
        } catch (e) { /* nothing more to report */ }
        return out;
    }
    /* PICC and PIQUET sit under the visit folder; tolerate either being absent.
       The '' pass picks up item folders left loose at the top level, but must
       skip the named sections themselves — otherwise PICC is treated as one
       giant item, every file is counted twice, and staleCount doubles. */
    const NAMED = ['PICC', 'PIQUET'];
    NAMED.concat(['']).forEach(section => {
        const dir = section ? path.join(base, section) : base;
        if (!fs.existsSync(dir)) return;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        entries.filter(e => e.isDirectory()).forEach(d => {
            if (!section && NAMED.indexOf(d.name) !== -1) return;
            // Archived evidence is skipped everywhere, at every depth. Without this
            // an archived file would keep appearing in the list it was archived out
            // of, so archiving would look like it had done nothing.
            if (isArchiveFolder(d.name)) return;
            const files = [];
            const walk = p => {
                let kids = [];
                try { kids = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return; }
                kids.forEach(k => {
                    const full = path.join(p, k.name);
                    if (k.isDirectory()) return isArchiveFolder(k.name) ? undefined : walk(full);
                    files.push({
                        name: k.name,
                        rel: path.relative(DOC_ROOT, full).replace(/\\/g, '/'),
                        // Filenames that still name an earlier year are the usual
                        // symptom of a folder copied forward and not refreshed.
                        stale: /20\d\d/.test(k.name)
                            ? !new RegExp(yearFolder.match(/(20\d\d)/)?.[1] || '').test(k.name)
                            : false
                    });
                });
            };
            walk(path.join(dir, d.name));
            if (isChildFileFolder(d.name)) {
                out.childFiles = files;
                out.childFolder = { name: d.name, owner: docOwner(d.name), count: files.length };
                return;
            }
            const num = docItemNumber(d.name);
            const key = num || d.name;
            if (!out.items[key]) out.items[key] = { item: num, folders: [], folderPaths: [], files: [], owner: '' };
            out.items[key].folders.push(d.name);
            // Relative path so the page can upload a signed copy back into this
            // exact folder without guessing at names.
            out.items[key].folderPaths.push(
                path.relative(DOC_ROOT, path.join(dir, d.name)).replace(/\\/g, '/'));
            out.items[key].owner = out.items[key].owner || docOwner(d.name);
            out.items[key].files = out.items[key].files.concat(files);
        });

        /* Loose files sitting directly in the visit folder. PFA keeps all its
           evidence this way, so without this pass the entire Preschool for All
           side indexes as nothing. Attributed by filename; anything that does
           not name an item (the checklist PDF, tables of contents, monitoring
           guides) is left out rather than filed under a guess. */
        entries.filter(e => e.isFile()).forEach(f => {
            const num = docItemNumberFromFile(f.name);
            if (!num) return;
            const full = path.join(dir, f.name);
            if (!out.items[num]) {
                out.items[num] = { item: num, folders: [], folderPaths: [], files: [], owner: '' };
                // PFA keeps these loose in the visit folder, so that is where a
                // signed copy belongs too.
                out.items[num].folderPaths.push(path.relative(DOC_ROOT, dir).replace(/\\/g, '/'));
            }
            out.items[num].files.push({
                name: f.name,
                rel: path.relative(DOC_ROOT, full).replace(/\\/g, '/'),
                stale: /20\d\d/.test(f.name)
                    ? !new RegExp(yearFolder.match(/(20\d\d)/)?.[1] || '').test(f.name)
                    : false
            });
        });
    });
    return out;
}

// ── SilverSelfAssessments schema ──
// ExceleRate Silver wants one environment-rating self-assessment per classroom,
// with the instrument set by the ages served: ITERS-3 for infants, toddlers and
// twos, ECERS-3 for 3-5s, SACERS-U for school age. Tracked per room rather than
// per program because that is how the scoresheets are completed and submitted.
//
// Keyed on (RoomNumber, Instrument) so a 2-3 room that switches from ITERS-3 to
// ECERS-3 under the 75% rule keeps both records rather than overwriting one.
function silverAssessmentEnsureSQL() {
    return `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='SilverSelfAssessments')
    CREATE TABLE SilverSelfAssessments (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        RoomNumber NVARCHAR(20) NOT NULL,
        Instrument NVARCHAR(40) NOT NULL,
        CompletedDate NVARCHAR(20),
        UploadedDate NVARCHAR(20),
        EvidenceLink NVARCHAR(500),
        Notes NVARCHAR(MAX),
        CreatedAt DATETIME DEFAULT GETDATE(),
        UpdatedAt DATETIME DEFAULT GETDATE()
    );
`;
}

// ── PasWorksheets schema ──
// The PAS self-assessment and its supporting worksheets are filled in across
// seven pages that each kept their answers in browser localStorage, under keys
// like pas_teaching_staff_quals_<classroom>. That meant the artifact being
// prepared for submission existed only in whichever browser typed it, could not
// be reviewed by anyone else, and vanished with a cleared cache.
//
// One row per (worksheet, scope). Scope is the classroom key for the per-room
// worksheets and empty for program-level ones. The answers are stored as the
// same JSON object the pages already build from their [data-field] inputs, so
// each page keeps its own shape and no schema change is needed to add a field.
function pasWorksheetEnsureSQL() {
    return `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='PasWorksheets')
    CREATE TABLE PasWorksheets (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        WorksheetKey NVARCHAR(60) NOT NULL,
        ScopeKey NVARCHAR(60) NOT NULL,
        Payload NVARCHAR(MAX),
        UpdatedBy NVARCHAR(200),
        CreatedAt DATETIME DEFAULT GETDATE(),
        UpdatedAt DATETIME DEFAULT GETDATE()
    );
`;
}

/* ── WeeklyMenus schema ──
   One row per week. The menu is shared across the centre — whoever opens the page
   next must see what the kitchen actually planned — so the database is the record
   and the browser copy is only a safety net.

   Previously this DDL existed inline in the POST handler only, so a read against a
   database without the table failed and the page fell back to whatever was in that
   one browser. Shared here so both paths agree. */
function weeklyMenusEnsureSQL() {
    return `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='WeeklyMenus')
    CREATE TABLE WeeklyMenus (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        WeekKey NVARCHAR(20) NOT NULL UNIQUE,
        PfaData NVARCHAR(MAX),
        OtherData NVARCHAR(MAX),
        UpdatedAt DATETIME DEFAULT GETDATE()
    );
GO
`;
}

// ── SiteSettings schema ──
// Key/value store for facts that are true of the site regardless of school year:
// the DCFS license, ExceleRate level, and similar. Deliberately has no
// SchoolYear column, which is what distinguishes it from ProgramCompliance.
function siteSettingsEnsureSQL() {
    return `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='SiteSettings')
    CREATE TABLE SiteSettings (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        SettingKey NVARCHAR(60) NOT NULL UNIQUE,
        SettingValue NVARCHAR(MAX),
        UpdatedAt DATETIME DEFAULT GETDATE()
    );
`;
}

function complianceEnsureSQL() {
    return `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ProgramCompliance')
    CREATE TABLE ProgramCompliance (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        SchoolYear NVARCHAR(20) NOT NULL,
        FieldName NVARCHAR(${COMPLIANCE_FIELD_NAME_MAX}) NOT NULL,
        FieldValue NVARCHAR(MAX),
        UpdatedAt DATETIME DEFAULT GETDATE(),
        CONSTRAINT UQ_Compliance UNIQUE(SchoolYear, FieldName)
    );
IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='ProgramCompliance' AND COLUMN_NAME='FieldValue' AND CHARACTER_MAXIMUM_LENGTH <> -1)
    ALTER TABLE ProgramCompliance ALTER COLUMN FieldValue NVARCHAR(MAX);
`;
}

function docFormEnsureSQL(cfg) {
    const cols = cfg.columns.map(([name, type]) => `        ${name} ${type}`).join(',\n');
    let sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='${cfg.table}')
    CREATE TABLE ${cfg.table} (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        StudentId INT NOT NULL,
${cols},
        CreatedAt DATETIME DEFAULT GETDATE(),
        UpdatedAt DATETIME DEFAULT GETDATE()
    );
`;
    // Forward migration so fields added to the config later appear without manual DDL.
    for (const [name, type] of cfg.columns) {
        sql += `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='${cfg.table}' AND COLUMN_NAME='${name}') ALTER TABLE ${cfg.table} ADD ${name} ${type};\n`;
    }
    // Ends the batch, so the forward migration above is visible to the caller's
    // SELECT. The self-migrating column list is useless otherwise.
    sql += schoolYearColumnSQL(cfg.table);
    return sql;
}

/* -f 65001 sets sqlcmd's input AND output code page to UTF-8, and it matters in
   both directions. The script file below is written as UTF-8, so without this flag
   sqlcmd reads it in the console code page and any accented character in a name or
   a note is corrupted ON THE WAY IN; results come back mangled on the way out for
   the same reason. It also makes the JSON transport below possible at all, because
   a mis-decoded byte can produce a stray quote that breaks the JSON.
   ASCII is unaffected, UTF-8 being a superset of it. */
const SQLCMD_ENCODING = '-f 65001';

function runSQL(sql) {
    const tmp = path.join(__dirname, '_q.sql');
    fs.writeFileSync(tmp, sql, 'utf8');
    try {
        const out = execSync(`"C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\170\\Tools\\Binn\\sqlcmd.exe" -S ${DB_SERVER} -d ${DB_NAME} -E -s "|" -W -h -1 ${SQLCMD_ENCODING} -i "${tmp}"`,
            { encoding: 'utf8', shell: 'cmd.exe', maxBuffer: 64 * 1024 * 1024 });
        console.log('[SQL]', out.trim());
        return { ok: true, data: out };
    } catch (e) {
        console.error('[SQL ERR]', e.stderr || e.message);
        return { ok: false, error: e.stderr || e.message };
    } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
    }
}

/* ── Reading long or free text out of SQL ──────────────────────────────────
   sqlcmd's text output truncates any variable-length value at 256 characters by
   default. -y raises the limit but caps at 8000 and is mutually exclusive with
   BOTH -W and -h, which this invocation needs. So every value longer than 256
   characters came back cut off: a week's menu JSON, a PAS worksheet payload, a
   staff note. JSON.parse then threw and the endpoint answered {} — which the
   pages correctly read as "nothing has been saved". The data was in the database
   the whole time; only the read was broken, which is why saving appeared to work
   and then the entry appeared to vanish for everyone else.

   Rather than fight the display width, this carries the whole result set as JSON,
   sliced so that no single field can reach the limit:

     1. SQL builds the rows with FOR JSON PATH into one NVARCHAR(MAX).
     2. That string is emitted in fixed-size chunks, one row each, with a sentinel
        appended to every chunk — because -W strips trailing spaces and a slice
        boundary can fall inside a JSON string that genuinely ends with one.
     3. Node reassembles the chunks in order and parses once.

   Verified against SQL Server 2022 with embedded pipes, CRLFs, double quotes,
   backslashes, a 3000-character blob, accented characters and NULL. Values arrive
   correctly typed, so txCol()/txDecode() are unnecessary on this path — their
   whole purpose was surviving the pipe-delimited format. */
const LONG_TEXT_CHUNK = 200;
const LONG_TEXT_SENTINEL = '~';

function jsonChunkSQL(innerSelect) {
    /* CAST to INT because TOP rejects a non-integer, and CEILING returns numeric.
       DATALENGTH/2 rather than LEN, because LEN ignores trailing spaces and would
       drop them from the final chunk. sys.all_objects is only a row source, large
       enough to number the chunks of any payload realistically stored here. */
    /* ISNULL is essential: FOR JSON yields NULL for an empty result set, and a NULL
       here would print as the literal text "NULL", which then fails to parse and
       reports a server error for the ordinary case of "nothing saved yet". Coalesced
       to an empty string so no rows reads as no rows. */
    return `DECLARE @j NVARCHAR(MAX) = ISNULL((${innerSelect} FOR JSON PATH, INCLUDE_NULL_VALUES), N'');
SELECT c.Seq, SUBSTRING(@j, 1 + (c.Seq - 1) * ${LONG_TEXT_CHUNK}, ${LONG_TEXT_CHUNK}) + N'${LONG_TEXT_SENTINEL}'
FROM (
    SELECT TOP (CAST(CASE WHEN ISNULL(DATALENGTH(@j), 0) = 0 THEN 1
                          ELSE CEILING(DATALENGTH(@j) / 2.0 / ${LONG_TEXT_CHUNK}) END AS INT))
           ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS Seq
    FROM sys.all_objects
) c
ORDER BY c.Seq`;
}

/* Runs one SELECT and returns its rows as objects.

   `ensure` is any schema DDL that must run first. It is emitted as its own batch
   for the reason schoolYearColumnSQL() explains at length: a column added in the
   same batch as the statement that reads it is invisible to that statement, and
   the failure blocks the ALTER too.

   Returns { ok: true, rows: [...] } or { ok: false, error }. A caller MUST
   distinguish those two — answering with an empty result on failure is exactly
   the bug this replaces, because "no rows" and "could not read" then look
   identical to the page. */
function runSQLRows(innerSelect, ensure) {
    const sql = (ensure || '') + 'SET NOCOUNT ON;\n' + jsonChunkSQL(innerSelect);
    const r = runSQL(sql);
    if (!r.ok) return { ok: false, error: r.error };

    const parts = [];
    r.data.split('\n').forEach(line => {
        const i = line.indexOf('|');
        if (i === -1) return;
        const seq = parseInt(line.slice(0, i).trim(), 10);
        if (!isFinite(seq) || seq < 1) return;
        // Strip the line ending and then the sentinel, and nothing else, so spaces
        // that belong to the data survive.
        let part = line.slice(i + 1).replace(/[\r\n]+$/, '');
        if (part.endsWith(LONG_TEXT_SENTINEL)) part = part.slice(0, -1);
        parts[seq - 1] = part;
    });

    // A hole means a chunk row went missing; parsing on would silently corrupt.
    const missing = [];
    for (let i = 0; i < parts.length; i++) if (parts[i] === undefined) missing.push(i + 1);
    if (missing.length) {
        return { ok: false, error: 'Incomplete result: chunk(s) ' + missing.join(',') + ' missing' };
    }

    const raw = parts.join('');
    // FOR JSON returns nothing at all for an empty result set.
    if (!raw.trim()) return { ok: true, rows: [] };
    try {
        const parsed = JSON.parse(raw);
        return { ok: true, rows: Array.isArray(parsed) ? parsed : [parsed] };
    } catch (e) {
        return { ok: false, error: 'Could not parse the result: ' + e.message };
    }
}

function parseRows(raw) {
    return raw.trim().split('\n')
        .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
        .map(l => {
            const vals = l.split('|').map(v => v.trim());
            const obj = {};
            COLS.forEach((c, i) => obj[c] = vals[i] ?? '');
            return obj;
        });
}

function sendJSON(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
}

function readBody(req, cb) {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { cb(null, JSON.parse(b)); } catch (e) { cb(e); } });
}

const server = http.createServer((req, res) => {
    /* If HTTPS is available, redirect HTTP to HTTPS — except for ACME challenges,
       and except for the two endpoints the local document server calls. It does
       not follow redirects, so redirecting those reads to it as a failed
       download. That traffic stays on the machine, so plain HTTP is fine. */
    if (sslOptions && !req.url.startsWith('/.well-known/acme-challenge')
        && !OFFICE_NO_REDIRECT.some(p => req.url.startsWith(p))) {
        const host = (req.headers.host || '').split(':')[0];
        res.writeHead(301, { 'Location': `https://${host}${req.url}` });
        return res.end();
    }
    handleRequest(req, res);
});

/* HTTPS server.

   The HSTS header is what stops the staff sign-in fault recurring. An http://
   bookmark still reaches the 301 above, but a browser drops the Authorization
   header when following a redirect that changes scheme, so the credential check
   arrived with nothing attached and the server answered 401 — the right password
   reported as wrong. Once a browser has seen this header it rewrites http:// to
   https:// on its own, before the request leaves the machine, so the credential
   never has a redirect to be stripped by. The guard in auth.js covers the first
   visit, before this header has been cached; this covers every visit after.

   No includeSubDomains and no preload. Everything we serve is on the apex, so
   subdomains would be a promise about hosts that do not exist, and preloading is
   difficult to reverse. max-age is six months, which browsers honour and refresh
   on each visit. The tradeoff to know about: for that window browsers will refuse
   to fall back to plain HTTP for this host, so a lapsed certificate becomes a
   hard outage rather than an insecure page. Let's Encrypt renews automatically,
   so the exposure is a renewal failure going unnoticed. */
let httpsServer = null;
if (sslOptions) {
    httpsServer = https.createServer(sslOptions, (req, res) => {
        res.setHeader('Strict-Transport-Security', 'max-age=15552000');
        handleRequest(req, res);
    });
}

/* WebSocket pass-through for the document editor.

   OnlyOffice opens a socket under /doc/<key>/c/... for live editing and saving.
   An upgrade request never reaches handleRequest, so it needs handling here or
   the editor loads and then silently fails to save — which would look like data
   loss rather than a configuration gap.

   Raw socket splicing, because this is a tunnel: once upgraded, neither side
   speaks HTTP any more. */
function proxyUpgrade(req, socket, head) {
    /* Logged on every path, success included.

       This handler previously only logged failures, so an empty console proved
       nothing: it could mean the upgrade never arrived, or that it arrived and
       worked. That ambiguity cost an evening of guessing. Now the console states
       plainly what happened to every socket. */
    console.log('[OFFICE WS] upgrade requested: ' + req.url.slice(0, 140));
    if (!ONLYOFFICE_ON) {
        console.log('[OFFICE WS] refused — OnlyOffice is not configured');
        return socket.destroy();
    }

    /* An upgrade request never reaches handleRequest, so the null-byte and
       traversal guard at the top of it does not apply here. Repeat it rather
       than assume the prefix check below is enough — this path forwards to
       another service, and a hostile path should not be relayed anywhere. */
    if (req.url.includes('\0') || req.url.includes('%00')) return socket.destroy();
    let decoded;
    try { decoded = decodeURIComponent(req.url.split('?')[0]); }
    catch (e) { return socket.destroy(); }
    if (decoded.includes('\0') || /(^|[\\/])\.\.([\\/]|$)/.test(decoded)) return socket.destroy();

    const url = req.url.split('?')[0];
    if (!isOfficePath(url)) {
        console.log('[OFFICE WS] refused — "' + url + '" is not a document-server path');
        return socket.destroy();
    }
    const target = new URL(ONLYOFFICE_URL);
    const lib = target.protocol === 'https:' ? https : http;
    const headers = Object.assign({}, req.headers);
    // Same reasoning as the HTTP proxy: keep the public Host so the document
    // server builds URLs the browser can actually reach.
    headers['x-forwarded-host'] = req.headers.host || '';
    headers['x-forwarded-proto'] = 'https';

    const upstream = lib.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        method: req.method,
        // Untouched, same as the HTTP proxy: nginx owns the version prefix.
        path: req.url,
        headers: headers,
        rejectUnauthorized: false
    });
    upstream.on('upgrade', (upRes, upSocket, upHead) => {
        console.log('[OFFICE WS] connected (' + upRes.statusCode + ') ' + url);
        // Replay the handshake to the browser, then join the two sockets.
        const lines = ['HTTP/1.1 101 Switching Protocols'];
        for (const [k, v] of Object.entries(upRes.headers)) lines.push(k + ': ' + v);
        socket.write(lines.join('\r\n') + '\r\n\r\n');
        if (upHead && upHead.length) socket.write(upHead);
        if (head && head.length) upSocket.write(head);
        upSocket.pipe(socket);
        socket.pipe(upSocket);
        const shut = () => { try { upSocket.destroy(); } catch (e) {} try { socket.destroy(); } catch (e) {} };
        upSocket.on('error', shut); socket.on('error', shut);
        upSocket.on('close', shut); socket.on('close', shut);
    });
    upstream.on('response', up => {
        // Upstream declined to upgrade; nothing useful to relay.
        console.log('[OFFICE WS] upstream refused to upgrade: HTTP ' + up.statusCode + ' for ' + url);
        socket.destroy();
    });
    upstream.on('error', e => {
        console.error('[OFFICE WS] ' + req.url + ' -> ' + e.message);
        socket.destroy();
    });
    upstream.end();
}
server.on('upgrade', proxyUpgrade);
if (httpsServer) httpsServer.on('upgrade', proxyUpgrade);

function handleRequest(req, res) {
    const url = req.url.split('?')[0];

    /* Reject hostile paths once, here, rather than in each static handler.

       Automated scanners probe every public IP for config files, and this server
       was seeing requests like:
           C:\app\External\<NUL>payment\<NUL>.env
       A null byte historically truncated a path in C-based filesystem calls, so
       "safe.html\0../../.env" could read something else entirely. Node rejects
       them, but only after the request has reached a file handler — and the error
       surfaced as noise in the console rather than a clean refusal.

       Traversal is blocked here too. resolveDocPath() already confines the
       document library, but the static handlers build paths by concatenation, so
       the guard belongs at the door. */
    if (req.url.includes('\0') || req.url.includes('%00')) {
        console.warn('[BLOCKED] null byte in path from ' + (req.socket.remoteAddress || '?'));
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('Bad request');
    }
    let decodedUrl = url;
    try {
        decodedUrl = decodeURIComponent(url);
    } catch (e) {
        // Malformed percent-encoding is never legitimate here.
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('Bad request');
    }
    if (decodedUrl.includes('\0') || /(^|[\\/])\.\.([\\/]|$)/.test(decodedUrl)) {
        console.warn('[BLOCKED] traversal in path: ' + decodedUrl.slice(0, 120));
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('Bad request');
    }

    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT', 'Access-Control-Allow-Headers': 'Content-Type' });
        return res.end();
    }

    // GET health check (public)
    if (req.method === 'GET' && url === '/api/health') {
        return sendJSON(res, 200, { ok: true });
    }

    // POST upload proof of income (internal - protected)
    if (req.method === 'POST' && url.startsWith('/api/upload/income/')) {
        if (!checkAuth(req, res)) return;
        const studentId = decodeURIComponent(url.split('/')[4] || '');
        const uploadDir = path.join(__dirname, '..', 'uploads', 'income');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

        let body = [];
        req.on('data', chunk => body.push(chunk));
        req.on('end', () => {
            const buf = Buffer.concat(body);
            const contentType = req.headers['content-type'] || '';
            const boundary = contentType.split('boundary=')[1];
            if (!boundary) return sendJSON(res, 400, { error: 'No boundary' });

            // Parse multipart
            const parts = buf.toString('binary').split('--' + boundary);
            for (const part of parts) {
                if (!part.includes('filename=')) continue;
                const nameMatch = part.match(/filename="([^"]+)"/);
                if (!nameMatch) continue;
                const origName = nameMatch[1];
                const ext = path.extname(origName);
                const safeName = `${studentId.replace(/[^a-zA-Z0-9]/g,'_')}_${Date.now()}${ext}`;
                const filePath = path.join(uploadDir, safeName);
                const headerEnd = part.indexOf('\r\n\r\n');
                if (headerEnd < 0) continue;
                const fileData = Buffer.from(part.slice(headerEnd + 4, part.lastIndexOf('\r\n')), 'binary');
                fs.writeFileSync(filePath, fileData);

                // Update DB
                const r = runSQL(`UPDATE rptMasterEnrollment SET ProofOfIncomeFile=${esc(safeName)},ProofOfIncomeUploaded=1 WHERE First_Name=${esc(studentId.split('|')[0])} AND Last_Name=${esc(studentId.split('|')[1])}`);
                if (!r.ok) return sendJSON(res, 500, { error: r.error });
                return sendJSON(res, 200, { success: true, file: safeName });
            }
            sendJSON(res, 400, { error: 'No file found in upload' });
        });
        return;
    }

    // GET download proof of income (internal - protected)
    if (req.method === 'GET' && url.startsWith('/api/download/income/')) {
        if (!checkAuth(req, res)) return;
        const fileName = decodeURIComponent(url.split('/')[4] || '');
        const filePath = path.join(__dirname, '..', 'uploads', 'income', fileName);
        if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('Not found'); }
        const ext = path.extname(fileName).toLowerCase();
        const mime = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Content-Disposition': `inline; filename="${fileName}"` });
        fs.createReadStream(filePath).pipe(res);
        return;
    }
    // GET students (internal - protected)
    if (req.method === 'GET' && url === '/api/students') {
        if (!checkAuth(req, res)) return;
        // Ensure CCAPStartDate column exists (separate batch so metadata refreshes)
        runSQL(`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='rptMasterEnrollment' AND COLUMN_NAME='CCAPStartDate') ALTER TABLE rptMasterEnrollment ADD CCAPStartDate NVARCHAR(20)`);
        const r = runSQL(`SELECT e.Id,e.Last_Name,e.First_Name,e.Birth_date,e.Start_Date,e.City_Town,e.Days_Old,e.RoomNumber,r.Room,r.TeacherDescription,r.Type,r.DCFSCapacity,e.Monday,e.Tuesday,e.Wednesday,e.Thursday,e.Friday,e.Active,e.Category,e.PFA_PI_na,e.F_R_P_Food,e.IEP,e.Military,ISNULL(e.HouseholdIncome,'') AS HouseholdIncome,ISNULL(e.ProofOfIncomeFile,'') AS ProofOfIncomeFile,ISNULL(CAST(e.ProofOfIncomeUploaded AS NVARCHAR),'0') AS ProofOfIncomeUploaded,ISNULL(e.PublicBenefits,'') AS PublicBenefits,ISNULL(CAST(e.HouseholdSize AS NVARCHAR),'') AS HouseholdSize,ISNULL(e.CCAPStartDate,'') AS CCAPStartDate FROM rptMasterEnrollment e LEFT JOIN dimClassrooms r ON e.RoomNumber=r.RoomNumber ORDER BY e.RoomNumber,e.Last_Name`);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()) && !l.includes('Changed database') && !l.includes('Commands completed') && l.includes('|'))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return {
                    Id: v[0], Last_Name: v[1], First_Name: v[2], Birth_date: v[3], Start_Date: v[4],
                    City_Town: v[5], Days_Old: v[6], RoomNumber: v[7], Room: v[8],
                    TeacherDescription: v[9], Type: v[10], Room_Capacity: v[11],
                    Monday: v[12], Tuesday: v[13], Wednesday: v[14], Thursday: v[15], Friday: v[16],
                    Active: v[17], Category: v[18], PFA_PI_na: v[19], F_R_P_Food: v[20],
                    IEP: v[21], Military: v[22], HouseholdIncome: v[23],
                    ProofOfIncomeFile: v[24], ProofOfIncomeUploaded: v[25], PublicBenefits: v[26], HouseholdSize: v[27], CCAPStartDate: v[28]
                };
            });
        return sendJSON(res, 200, rows);
    }

    // GET classrooms (internal - protected)
    if (req.method === 'GET' && url === '/api/classrooms') {
        if (!checkAuth(req, res)) return;
        const r = runSQL(`SELECT ${ROOM_COLS.join(',')} FROM dimClassrooms ORDER BY RoomNumber`);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return { RoomNumber: v[0], Building: v[1], Room: v[2], TeacherDescription: v[3], Type: v[4], RequiredSlots: v[5], AgeRange: v[6], DCFSCapacity: v[7] };
            });
        return sendJSON(res, 200, rows);
    }

    // POST new classroom (internal - protected)
    if (req.method === 'POST' && url === '/api/classrooms') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const sql = `INSERT INTO dimClassrooms (RoomNumber,Room,TeacherDescription,DCFSCapacity,AgeRange) VALUES (${parseInt(d.roomNumber)},${esc(d.room)},${esc(d.teacher)},${parseInt(d.capacity)||10},${esc(d.ageRange)})`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // PUT update classroom (internal - protected)
    if (req.method === 'PUT' && url.startsWith('/api/classrooms/')) {
        if (!checkAuth(req, res)) return;
        const roomNumber = decodeURIComponent(url.split('/')[3] || '');
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const fields = [];
            if (d.room !== undefined)     fields.push(`Room=${esc(d.room)}`);
            if (d.teacher !== undefined)  fields.push(`TeacherDescription=${esc(d.teacher)}`);
            if (d.capacity !== undefined) fields.push(`DCFSCapacity=${parseInt(d.capacity) || 0}`);
            if (d.ageRange !== undefined) fields.push(`AgeRange=${esc(d.ageRange)}`);
            if (!fields.length) return sendJSON(res, 400, { error: 'Nothing to update' });
            const rn = parseInt(roomNumber);
            const whereClause = isNaN(rn) ? `RoomNumber=${esc(roomNumber)}` : `RoomNumber=${rn}`;
            const sql = `UPDATE dimClassrooms SET ${fields.join(',')} WHERE ${whereClause}`;
            console.log('[PUT CLASSROOM]', sql);
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // POST new student (internal - protected)
    if (req.method === 'POST' && url === '/api/students') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            console.log('[POST] Saving:', d.firstName, d.lastName);
            // Auto-calculate F/R/P based on USDA income guidelines (2026-2027)
            const freeThresholds  = [20748,28132,35516,42900,50284,57668,65052,72436];
            const reducedThresholds = [29526,40034,50542,61050,71558,82066,92574,103082];
            const hhSize = Math.max(1, Math.min(parseInt(d.householdSize)||1, 8)) - 1;
            const income = parseInt(d.householdIncome) || 100000;
            const benefits = d.publicBenefits || '';
            const isFoster = d.category === 'Foster';
            const isMilitary = d.military === true || d.military === 'Yes';
            const isPFA = d.pfaPiNa === 'PFA';
            let frpFood = 'Paid';
            if (benefits || isFoster || isMilitary || isPFA || income <= freeThresholds[hhSize]) frpFood = 'Free';
            else if (income <= reducedThresholds[hhSize]) frpFood = 'Reduced';
            // Keep the link back to the pre-enrollment intake record so the rich
            // family/risk-factor data stays reachable after the child is enrolled.
            const preId = parseInt(d.preEnrollmentId);
            const preIdVal = isNaN(preId) ? 'NULL' : preId;
            const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='rptMasterEnrollment' AND COLUMN_NAME='PreEnrollmentId') ALTER TABLE rptMasterEnrollment ADD PreEnrollmentId INT NULL;
                INSERT INTO rptMasterEnrollment (Last_Name,First_Name,Birth_date,Start_Date,City_Town,Days_Old,RoomNumber,Monday,Tuesday,Wednesday,Thursday,Friday,Active,Category,PFA_PI_na,F_R_P_Food,IEP,Military,HouseholdIncome,HouseholdSize,PublicBenefits,ProofOfIncomeUploaded,PreEnrollmentId) VALUES (${esc(d.lastName)},${esc(d.firstName)},${esc(d.birthDate)},${esc(d.startDate)},${esc(d.cityTown)},${esc(d.daysOld)},${esc(d.roomNumber)},${d.monday?1:0},${d.tuesday?1:0},${d.wednesday?1:0},${d.thursday?1:0},${d.friday?1:0},${esc(d.active)},${esc(d.category)},${esc(d.pfaPiNa)},${esc(frpFood)},${esc(d.iep)},${esc(d.military)},${esc(d.householdIncome)},${parseInt(d.householdSize)||0},${esc(d.publicBenefits)},0,${preIdVal})`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            if (!r.data.includes('rows affected')) return sendJSON(res, 500, { error: 'No rows written: ' + r.data });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // GET screening summary for every student (internal - protected).
    // One row per student/type/period so the roster can show dates, concerns and
    // referral status without a request per child.
    if (req.method === 'GET' && url === '/api/screening-summary') {
        if (!checkAuth(req, res)) return;
        const summaryYear = resolveSchoolYear(new URLSearchParams(req.url.split('?')[1] || '').get('year'));
        const summaryEnsure = schoolYearColumnSQL('ScreeningScores');
        // Concern logic differs by instrument:
        //  ASQ-3      higher score is better, so 'Below' cutoff is the concern.
        //  ASQ:SE-2   higher score means more concern, so 'Above' cutoff is the concern.
        const sql = summaryEnsure + `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ScreeningScores') SELECT 0 AS StudentId WHERE 1=0
            ELSE
            SELECT StudentId,
                ISNULL(ScreeningType,'') AS ScreeningType,
                ISNULL(Period,'') AS Period,
                ISNULL(ScreeningDate,'') AS ScreeningDate,
                ISNULL(ReferralMade,'') AS ReferralMade,
                CASE WHEN ScreeningType='ASQ-3' AND (CommStatus='Below' OR GrossStatus='Below' OR FineStatus='Below' OR ProblemStatus='Below' OR PersonalStatus='Below') THEN 'concern'
                     WHEN ScreeningType='ASQ-3' AND (CommStatus='Monitor' OR GrossStatus='Monitor' OR FineStatus='Monitor' OR ProblemStatus='Monitor' OR PersonalStatus='Monitor') THEN 'monitor'
                     WHEN ScreeningType<>'ASQ-3' AND SEResult='Above' THEN 'concern'
                     WHEN ScreeningType<>'ASQ-3' AND SEResult='Monitor' THEN 'monitor'
                     ELSE 'ok' END AS Flag
            FROM ScreeningScores WHERE SchoolYear=${esc(summaryYear)}`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => /^\s*\d+\s*\|/.test(l))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return { StudentId: v[0], ScreeningType: v[1], Period: v[2], ScreeningDate: v[3], ReferralMade: v[4], Flag: v[5] };
            });
        return sendJSON(res, 200, rows);
    }

    // GET the pre-enrollment intake record linked to a student (internal - protected).
    // Prefers the stored PreEnrollmentId; falls back to an exact child name + DOB match
    // for students enrolled before the link existed.
    if (req.method === 'GET' && url.startsWith('/api/student-intake/')) {
        if (!checkAuth(req, res)) return;
        const studentId = parseInt(url.split('/')[3]);
        if (!studentId) return sendJSON(res, 400, { error: 'Student ID required' });
        // Free-text columns are flattened: rows are returned as pipe-delimited lines
        // split on newlines, so an embedded newline would corrupt the record.
        const flat = col => `REPLACE(REPLACE(ISNULL(${col},''),CHAR(13),' '),CHAR(10),' ')`;
        const cols = `p.Id,ISNULL(p.SubmittedAt,'') AS SubmittedAt,ISNULL(p.FirstName,'') AS ParentFirst,ISNULL(p.LastName,'') AS ParentLast,`
            + `ISNULL(p.Phone,'') AS Phone,ISNULL(p.Email,'') AS Email,ISNULL(p.Address,'') AS Address,ISNULL(p.City,'') AS City,ISNULL(p.Zip,'') AS Zip,`
            + `ISNULL(p.ChildName,'') AS ChildName,ISNULL(p.ChildBirthDate,'') AS ChildBirthDate,ISNULL(p.AgeGroup,'') AS AgeGroup,ISNULL(p.DaysRequested,'') AS DaysRequested,`
            + `ISNULL(CAST(p.Score AS NVARCHAR),'') AS Score,ISNULL(p.WaitlistStatus,'') AS WaitlistStatus,`
            + `ISNULL(p.Homeless,'') AS Homeless,ISNULL(p.FosterAdopted,'') AS FosterAdopted,ISNULL(p.IEP,'') AS IEP,ISNULL(p.EarlyIntervention,'') AS EarlyIntervention,`
            + `ISNULL(p.AbuseHistory,'') AS AbuseHistory,ISNULL(p.MentalIllness,'') AS MentalIllness,ISNULL(p.DcfsInvolvement,'') AS DcfsInvolvement,`
            + `ISNULL(p.SubstanceAbuse,'') AS SubstanceAbuse,ISNULL(p.CaregiverOther,'') AS CaregiverOther,ISNULL(p.FamilyDeath,'') AS FamilyDeath,`
            + `ISNULL(p.LowBirthWeight,'') AS LowBirthWeight,ISNULL(p.ParentIncarcerated,'') AS ParentIncarcerated,ISNULL(p.TeenParent,'') AS TeenParent,`
            + `ISNULL(p.NoHSDiploma,'') AS NoHSDiploma,ISNULL(p.BornOutsideUS,'') AS BornOutsideUS,ISNULL(p.NonEnglishHome,'') AS NonEnglishHome,`
            + `ISNULL(p.ActiveMilitary,'') AS ActiveMilitary,ISNULL(p.PriorEarlyLearning,'') AS PriorEarlyLearning,ISNULL(p.BrightpointSubsidy,'') AS BrightpointSubsidy,`
            + `${flat('p.LivingSituation')} AS LivingSituation,ISNULL(p.HouseholdIncome,'') AS HouseholdIncome,ISNULL(CAST(p.HouseholdSize AS NVARCHAR),'') AS HouseholdSize,`
            + `ISNULL(p.PublicBenefits,'') AS PublicBenefits,`
            // PICC PI5.C / PI5.G / PI5.F priority populations. Added to the intake
            // form later than the rest, so older records return blank here.
            + `ISNULL(p.ScreeningDelayNoEi,'') AS ScreeningDelayNoEi,ISNULL(p.ParentEll,'') AS ParentEll,ISNULL(p.IncomeBelow50Fpl,'') AS IncomeBelow50Fpl,`
            + `${flat('p.Notes')} AS Notes`;
        const sql = `SELECT TOP 1 ${cols},'linked' AS MatchType FROM rptMasterEnrollment e INNER JOIN PreEnrollment p ON p.Id = e.PreEnrollmentId WHERE e.Id=${studentId}
            UNION ALL
            SELECT TOP 1 ${cols},'name+dob' AS MatchType FROM rptMasterEnrollment e INNER JOIN PreEnrollment p ON LTRIM(RTRIM(p.ChildName))=LTRIM(RTRIM(e.First_Name+' '+e.Last_Name)) AND CONVERT(date,p.ChildBirthDate)=CONVERT(date,e.Birth_date) WHERE e.Id=${studentId} AND e.PreEnrollmentId IS NULL`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const keys = ['Id','SubmittedAt','ParentFirst','ParentLast','Phone','Email','Address','City','Zip','ChildName','ChildBirthDate','AgeGroup','DaysRequested','Score','WaitlistStatus','Homeless','FosterAdopted','IEP','EarlyIntervention','AbuseHistory','MentalIllness','DcfsInvolvement','SubstanceAbuse','CaregiverOther','FamilyDeath','LowBirthWeight','ParentIncarcerated','TeenParent','NoHSDiploma','BornOutsideUS','NonEnglishHome','ActiveMilitary','PriorEarlyLearning','BrightpointSubsidy','LivingSituation','HouseholdIncome','HouseholdSize','PublicBenefits','ScreeningDelayNoEi','ParentEll','IncomeBelow50Fpl','Notes','MatchType'];
        const line = r.data.trim().split('\n').find(l => /^\s*\d+\s*\|/.test(l));
        if (!line) return sendJSON(res, 200, { found: false });
        const v = line.split('|').map(x => x.trim());
        const rec = { found: true };
        keys.forEach((k, i) => rec[k] = v[i] || '');
        return sendJSON(res, 200, rec);
    }

    // PUT update student (internal - protected)
    if (req.method === 'PUT' && url.startsWith('/api/students/')) {
        if (!checkAuth(req, res)) return;
        const parts = url.split('/');
        const origFirst = decodeURIComponent(parts[3] || '');
        const origLast  = decodeURIComponent(parts[4] || '');
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });

            // Auto-calculate F_R_P_Food from income/size/benefits (USDA 2026-2027)
            const freeThresholds  = [20748,28132,35516,42900,50284,57668,65052,72436];
            const reducedThresholds = [29526,40034,50542,61050,71558,82066,92574,103082];
            const hasIncome = d.householdIncome !== undefined && d.householdIncome !== '';
            const hasSize   = d.householdSize !== undefined && d.householdSize !== '';
            if (hasIncome && hasSize) {
                const hhSize = Math.max(1, Math.min(parseInt(d.householdSize)||1, 8)) - 1;
                const income = parseInt(d.householdIncome) || 100000;
                const benefits = d.publicBenefits || '';
                const isFoster = d.category === 'Foster';
                const isMilitary = d.military === true || d.military === 'Yes';
                const isPFA = d.pfaPiNa === 'PFA';
                let frpFood = 'Paid';
                if (benefits || isFoster || isMilitary || isPFA || income <= freeThresholds[hhSize]) frpFood = 'Free';
                else if (income <= reducedThresholds[hhSize]) frpFood = 'Reduced';
                d.frpFood = frpFood;
            }

            const fields = [];
            if (d.lastName !== undefined)        fields.push(`Last_Name=${esc(d.lastName)}`);
            if (d.firstName !== undefined)       fields.push(`First_Name=${esc(d.firstName)}`);
            if (d.birthDate !== undefined)       fields.push(`Birth_date=${esc(d.birthDate)}`);
            if (d.startDate !== undefined)       fields.push(`Start_Date=${esc(d.startDate)}`);
            if (d.cityTown !== undefined)        fields.push(`City_Town=${esc(d.cityTown)}`);
            if (d.daysOld !== undefined)         fields.push(`Days_Old=${esc(d.daysOld)}`);
            if (d.roomNumber !== undefined)      fields.push(`RoomNumber=${esc(d.roomNumber)}`);
            if (d.monday !== undefined)          fields.push(`Monday=${d.monday?1:0}`);
            if (d.tuesday !== undefined)         fields.push(`Tuesday=${d.tuesday?1:0}`);
            if (d.wednesday !== undefined)       fields.push(`Wednesday=${d.wednesday?1:0}`);
            if (d.thursday !== undefined)        fields.push(`Thursday=${d.thursday?1:0}`);
            if (d.friday !== undefined)          fields.push(`Friday=${d.friday?1:0}`);
            if (d.active !== undefined)          fields.push(`Active=${esc(d.active)}`);
            if (d.category !== undefined)        fields.push(`Category=${esc(d.category)}`);
            if (d.pfaPiNa !== undefined)         fields.push(`PFA_PI_na=${esc(d.pfaPiNa)}`);
            if (d.frpFood !== undefined)         fields.push(`F_R_P_Food=${esc(d.frpFood)}`);
            if (d.iep !== undefined)             fields.push(`IEP=${esc(d.iep)}`);
            if (d.military !== undefined)        fields.push(`Military=${esc(d.military)}`);
            if (d.householdIncome !== undefined)  fields.push(`HouseholdIncome=${esc(d.householdIncome)}`);
            if (d.householdSize !== undefined)    fields.push(`HouseholdSize=${d.householdSize?parseInt(d.householdSize):'NULL'}`);
            if (d.publicBenefits !== undefined)   fields.push(`PublicBenefits=${esc(d.publicBenefits)}`);
            if (d.proofOfIncome !== undefined)    fields.push(`ProofOfIncomeUploaded=${d.proofOfIncome?1:0}`);
            if (d.ccapStartDate !== undefined)    fields.push(`CCAPStartDate=${esc(d.ccapStartDate)}`);
            if (!fields.length) return sendJSON(res, 400, { error: 'Nothing to update' });
            const sql = `UPDATE rptMasterEnrollment SET ${fields.join(',')} WHERE First_Name=${esc(origFirst)} AND Last_Name=${esc(origLast)}`;
            console.log('[PUT SQL]', sql);
            const r = runSQL(sql);
            console.log('[PUT RESULT]', JSON.stringify(r));
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            if (!r.data.includes('rows affected')) return sendJSON(res, 500, { error: 'No rows updated: ' + r.data });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // POST run SQL (internal - protected)
    if (req.method === 'POST' && url === '/api/sql') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            if (!d.query) return sendJSON(res, 400, { error: 'No query provided' });
            const r = runSQL(d.query);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true, output: r.data });
        });
        return;
    }

    // POST deploy (internal - protected) — pulls code only, no restart
    if (req.method === 'POST' && url === '/api/deploy') {
        if (!checkAuth(req, res)) return;
        try {
            const out = execSync('"C:\\Program Files\\Git\\mingw64\\bin\\git.exe" fetch origin && "C:\\Program Files\\Git\\mingw64\\bin\\git.exe" reset --hard origin/master', { encoding: 'utf8', shell: 'cmd.exe', cwd: 'C:\\app' });
            console.log('[DEPLOY]', out);
            return sendJSON(res, 200, { success: true, output: out, message: 'Code updated. Static files active immediately. Restart server if server.js changed.' });
        } catch (e) {
            return sendJSON(res, 500, { error: e.message });
        }
    }

    // POST restart server (internal - protected)
    if (req.method === 'POST' && url === '/api/restart') {
        if (!checkAuth(req, res)) return;
        sendJSON(res, 200, { success: true, message: 'Server restarting...' });
        setTimeout(() => {
            try {
                // Spawn a detached process that waits 2 seconds then starts the server
                const child = require('child_process').spawn('cmd.exe', ['/c', 'timeout /t 2 /nobreak >nul & cd /d C:\\app & Launch.bat'], {
                    detached: true,
                    stdio: 'ignore',
                    shell: false
                });
                child.unref();
            } catch(e) { console.error('[RESTART ERR]', e.message); }
            process.exit(0);
        }, 1000);
        return;
    }

    // POST summer program sign-up (public)
    if (req.method === 'POST' && url === '/api/summer') {
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const sql = `
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'SummerProgram')
                CREATE TABLE SummerProgram (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    SubmittedAt DATETIME DEFAULT GETDATE(),
                    ParentFirstName NVARCHAR(100),
                    ParentLastName NVARCHAR(100),
                    ParentPhone NVARCHAR(30),
                    ChildFirstName NVARCHAR(100),
                    ChildLastName NVARCHAR(100),
                    ChildAge INT,
                    Days NVARCHAR(200)
                );
                INSERT INTO SummerProgram (ParentFirstName,ParentLastName,ParentPhone,ChildFirstName,ChildLastName,ChildAge,Days)
                VALUES (${esc(d.parentFirstName)},${esc(d.parentLastName)},${esc(d.parentPhone)},${esc(d.childFirstName)},${esc(d.childLastName)},${parseInt(d.childAge)||0},${esc(d.days)});`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // POST pre-enrollment form (public)
    if (req.method === 'POST' && url === '/api/preenrollment') {
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const sql = `
                IF NOT EXISTS (
                    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
                    WHERE TABLE_NAME = 'PreEnrollment'
                )
                CREATE TABLE PreEnrollment (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    SubmittedAt DATETIME DEFAULT GETDATE(),
                    FirstName NVARCHAR(100),
                    LastName NVARCHAR(100),
                    Email NVARCHAR(200),
                    Address NVARCHAR(500),
                    City NVARCHAR(100),
                    Zip NVARCHAR(20),
                    Country NVARCHAR(100),
                    Phone NVARCHAR(30),
                    ChildrenInfo NVARCHAR(1000),
                    HouseholdIncome NVARCHAR(200),
                    PublicBenefits NVARCHAR(500),
                    Homeless NVARCHAR(10),
                    IEP NVARCHAR(10),
                    NoHSDiploma NVARCHAR(10),
                    TeenParent NVARCHAR(10),
                    BornOutsideUS NVARCHAR(10),
                    FosterAdopted NVARCHAR(10),
                    NonEnglishHome NVARCHAR(10),
                    ActiveMilitary NVARCHAR(10),
                    PriorEarlyLearning NVARCHAR(10),
                    BrightpointSubsidy NVARCHAR(10),
                    LivingSituation NVARCHAR(20),
                    EarlyIntervention NVARCHAR(10),
                    AbuseHistory NVARCHAR(10),
                    MentalIllness NVARCHAR(10)
                );
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='ChildName') ALTER TABLE PreEnrollment ADD ChildName NVARCHAR(200);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='ChildBirthDate') ALTER TABLE PreEnrollment ADD ChildBirthDate NVARCHAR(20);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='ChildStartDate') ALTER TABLE PreEnrollment ADD ChildStartDate NVARCHAR(20);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='HouseholdSize') ALTER TABLE PreEnrollment ADD HouseholdSize INT;
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='DcfsInvolvement') ALTER TABLE PreEnrollment ADD DcfsInvolvement NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='SubstanceAbuse') ALTER TABLE PreEnrollment ADD SubstanceAbuse NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='CaregiverOther') ALTER TABLE PreEnrollment ADD CaregiverOther NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='FamilyDeath') ALTER TABLE PreEnrollment ADD FamilyDeath NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='LowBirthWeight') ALTER TABLE PreEnrollment ADD LowBirthWeight NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='ParentIncarcerated') ALTER TABLE PreEnrollment ADD ParentIncarcerated NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='Score') ALTER TABLE PreEnrollment ADD Score INT DEFAULT 0;
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='WaitlistStatus') ALTER TABLE PreEnrollment ADD WaitlistStatus NVARCHAR(20) DEFAULT 'Pending';
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='AgeGroup') ALTER TABLE PreEnrollment ADD AgeGroup NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='DaysRequested') ALTER TABLE PreEnrollment ADD DaysRequested NVARCHAR(50);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='ScreeningDelayNoEi') ALTER TABLE PreEnrollment ADD ScreeningDelayNoEi NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='ParentEll') ALTER TABLE PreEnrollment ADD ParentEll NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='IncomeBelow50Fpl') ALTER TABLE PreEnrollment ADD IncomeBelow50Fpl NVARCHAR(10);
                INSERT INTO PreEnrollment (
                    FirstName,LastName,Email,Address,City,Zip,Country,Phone,
                    ChildrenInfo,ChildName,ChildBirthDate,ChildStartDate,AgeGroup,DaysRequested,HouseholdIncome,HouseholdSize,PublicBenefits,Homeless,IEP,
                    NoHSDiploma,TeenParent,BornOutsideUS,FosterAdopted,
                    NonEnglishHome,ActiveMilitary,PriorEarlyLearning,
                    BrightpointSubsidy,LivingSituation,EarlyIntervention,
                    AbuseHistory,MentalIllness,DcfsInvolvement,SubstanceAbuse,
                    CaregiverOther,FamilyDeath,LowBirthWeight,ParentIncarcerated,
                    ScreeningDelayNoEi,ParentEll,IncomeBelow50Fpl,Score
                ) VALUES (
                    ${esc(d.firstName)},${esc(d.lastName)},${esc(d.email)},
                    ${esc(d.address)},${esc(d.city)},${esc(d.zip)},${esc(d.country)},
                    ${esc(d.phone)},${esc(d.childrenInfo)},${esc(d.childName)},${esc(d.childBirthDate)},${esc(d.childStartDate)},${esc(d.ageGroup)},${esc(d.daysRequested||'')},
                    ${esc(d.householdIncome)},${parseInt(d.householdSize)||0},${esc(d.publicBenefits)},${esc(d.homeless)},${esc(d.iep)},
                    ${esc(d.noHSDiploma)},${esc(d.teenParent)},${esc(d.bornOutsideUS)},
                    ${esc(d.fosterAdopted)},${esc(d.nonEnglishHome)},${esc(d.activeMilitary)},
                    ${esc(d.priorEarlyLearning)},${esc(d.brightpointSubsidy)},
                    ${esc(d.livingSituation)},${esc(d.earlyIntervention)},
                    ${esc(d.abuseHistory)},${esc(d.mentalIllness)},
                    ${esc(d.dcfsInvolvement)},${esc(d.substanceAbuse)},
                    ${esc(d.caregiverOther)},${esc(d.familyDeath)},
                    ${esc(d.lowBirthWeight)},${esc(d.parentIncarcerated)},
                    ${esc(d.screeningDelayNoEi)},${esc(d.parentEll)},${esc(d.incomeBelow50Fpl)},
                    ${parseInt(d.score)||0}
                );`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // GET ISBE tracking data (internal - protected)
    if (req.method === 'GET' && url === '/api/isbe-tracking') {
        if (!checkAuth(req, res)) return;
        // Column list comes from ISBE_TRACKING_COLUMNS so the SELECT can never drift
        // out of step with the schema the way EnterSIS/RemoveFromSIS previously did.
        const select = ISBE_TRACKING_COLUMNS.map(c => `ISNULL(${c},0) AS ${c}`).join(',');
        const year = resolveSchoolYear(new URLSearchParams(req.url.split('?')[1] || '').get('year'));
        const sql = isbeTrackingEnsureSQL()
            + `SELECT StudentId,${select} FROM ISBETracking WHERE SchoolYear=${esc(year)}`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                const row = { StudentId: v[0] };
                ISBE_TRACKING_COLUMNS.forEach((c, i) => { row[c] = v[i + 1] === '1'; });
                return row;
            });
        return sendJSON(res, 200, rows);
    }

    /* ── Which per-child forms actually exist ──────────────────────────────
       GET /api/child-forms?year=YYYY-YYYY

       ISBETracking holds a tick per checklist column. A tick is set when a form is
       saved, but it is an independent boolean: nothing stops it being ticked by hand
       with no form behind it, and nothing unticks it if the record is later removed.
       So the roster could show a completed checklist for a file that has nothing in
       it — which is precisely the thing a monitoring visit looks for.

       This reports the other half: for each child, which forms have a record. The
       roster then shows "form on file" and "ticked by hand" as the different things
       they are, and the compliance panel can count real evidence rather than ticks.

       Keyed by ISBETracking column name so the client's registry maps straight onto
       a checkbox with nothing in between to get out of step.

       Every table is guarded on existing AND queried through EXEC. Deferred name
       resolution covers a missing table but not a missing column, so without the
       dynamic call a table that predates one of these columns would fail the whole
       batch rather than just its own line. */
    if (req.method === 'GET' && url === '/api/child-forms') {
        if (!checkAuth(req, res)) return;
        const year = resolveSchoolYear(new URLSearchParams(req.url.split('?')[1] || '').get('year'));

        // Field, table, date column, and any extra WHERE. Year is already validated
        // to \d{4}-\d{4} by resolveSchoolYear, so it is safe inside the quoted SQL.
        const sources = [
            ['ParentInterview', 'ParentInterviews', 'InterviewDate', ''],
            ['PermissionSlip', 'PermissionSlips', 'SignedDate', ''],
            ['BegASQ', 'ScreeningScores', 'ScreeningDate', " AND ScreeningType=''ASQ-3'' AND Period=''Beginning''"],
            ['EndASQ', 'ScreeningScores', 'ScreeningDate', " AND ScreeningType=''ASQ-3'' AND Period=''End''"],
            ['BegASE', 'ScreeningScores', 'ScreeningDate', " AND ScreeningType=''ASQ:SE-2'' AND Period=''Beginning''"],
            ['EndASE', 'ScreeningScores', 'ScreeningDate', " AND ScreeningType=''ASQ:SE-2'' AND Period=''End''"]
        ];

        /* The PICC document forms come from their own declaration rather than being
           listed again here, so adding a seventh form needs no change in this handler.
           Its date is the first column named like a date; a form without one still
           reports as present, just undated. */
        Object.keys(PI_DOC_FORMS).forEach(k => {
            const cfg = PI_DOC_FORMS[k];
            const dateCol = (cfg.columns.find(([name]) => /Date$/.test(name)) || [null])[0];
            sources.push([cfg.trackingColumn, cfg.table, dateCol, '']);
        });

        // Tables touched here get the SchoolYear migration first, for the same reason
        // every other reader does: without it an older table fails forever.
        const tables = [...new Set(sources.map(([, table]) => table))];
        let sql = tables.map(t => schoolYearColumnSQL(t)).join('')
            + `IF OBJECT_ID('tempdb..#cf') IS NOT NULL DROP TABLE #cf;
CREATE TABLE #cf (Field NVARCHAR(60), StudentId INT, Dt NVARCHAR(40));
`;
        sources.forEach(([field, table, dateCol, extra]) => {
            const dateExpr = dateCol ? `ISNULL(CAST(${dateCol} AS NVARCHAR(40)),'''')` : `''''`;
            // Quotes are doubled once, because these strings are read by SQL Server
            // one level deep inside EXEC. Doubling twice makes the year literal
            // '' + 2026-2027 + '' and the batch fails to parse.
            sql += `IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='${table}')
    EXEC('INSERT INTO #cf (Field,StudentId,Dt) SELECT ''${field}'', StudentId, ${dateExpr} FROM ${table} WHERE SchoolYear=''${year}''${extra}');
`;
        });
        // MAX picks a date over a blank one where a child somehow has two rows.
        sql += `SELECT Field, StudentId, MAX(Dt) AS Dt FROM #cf GROUP BY Field, StudentId;
DROP TABLE #cf;`;

        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });

        const forms = {};
        r.data.trim().split('\n').forEach(l => {
            // Data lines only: "<Field> | <StudentId> | <Dt>".
            const v = l.split('|').map(x => x.trim());
            if (v.length < 2 || !/^\d+$/.test(v[1])) return;
            if (!forms[v[1]]) forms[v[1]] = {};
            forms[v[1]][v[0]] = { on: true, date: v[2] || '' };
        });
        return sendJSON(res, 200, { year: year, forms: forms });
    }

    /* ── Filing a signed form ─────────────────────────────────────────────
       POST /api/child-signed-form

       An unsigned form is work in progress: its content lives in its own table and
       shows on the roster. Nothing goes into the child's folder, because a half
       finished document is not evidence.

       Once it is signed, THE WHOLE FORM is written into the child's folder as a PDF,
       with the signatures drawn on it. That is the artefact a monitor reviews, and
       it is the same thing that would have been produced by printing the form,
       signing it and scanning it back in — without the paper.

       A PDF rather than the signature image on its own: a signature in a folder with
       no form around it proves nothing. A PDF rather than a database column: a
       monitor reviewing the folder can open it, and the sqlcmd transport moves long
       values in 200-character chunks, so an embedded document would be hundreds of
       rows on every read.

       ChildSignatures stores one row per signing role, both pointing at the same
       PDF. Nothing is overwritten: re-signing writes a new PDF and re-points the
       rows, so every version that was ever signed stays on disk. */
    if (req.method === 'POST' && url === '/api/child-signed-form') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });

            const studentId = parseInt(d.studentId);
            if (!studentId) return sendJSON(res, 400, { error: 'Invalid student id' });
            // Whitelisted against the checklist columns, so a signed document can
            // only ever be filed against a real form.
            if (!ISBE_TRACKING_COLUMNS.includes(d.field)) {
                return sendJSON(res, 400, { error: 'Unknown form: ' + d.field });
            }
            const year = resolveSchoolYear(d.year);
            const program = d.program === 'PFA' ? 'PFA' : 'PI';

            const incoming = Array.isArray(d.signatures) ? d.signatures : [];
            const signatures = [];
            for (const s of incoming) {
                const role = s.role === 'staff' ? 'staff' : s.role === 'parent' ? 'parent' : null;
                if (!role) return sendJSON(res, 400, { error: 'Role must be parent or staff' });
                const m = String(s.dataUrl || '').match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
                if (!m) return sendJSON(res, 400, { error: 'Expected a JPEG signature' });
                const bytes = Buffer.from(m[1], 'base64');
                if (!bytes.length) return sendJSON(res, 400, { error: 'A signature was empty' });
                if (bytes.length > 2 * 1024 * 1024) {
                    return sendJSON(res, 413, { error: 'A signature image is unreasonably large' });
                }
                signatures.push({ role: role, label: String(s.label || ''), name: String(s.name || ''),
                                  date: String(s.date || ''), jpeg: bytes });
            }
            if (!signatures.length) {
                return sendJSON(res, 400, { error: 'Nothing was signed, so there is nothing to file' });
            }

            const folder = childFilesFolder(program, year);
            if (folder.error) return sendJSON(res, 400, { error: folder.error });

            let pdf;
            try {
                pdf = buildFormPdf({
                    title: String(d.formTitle || d.field),
                    subtitle: 'Children of Promise LLC \u2014 '
                        + (program === 'PFA' ? 'Preschool for All' : 'Prevention Initiative')
                        + ' \u2014 ' + year,
                    rows: Array.isArray(d.rows) ? d.rows : [],
                    blocks: Array.isArray(d.blocks) ? d.blocks : [],
                    signatures: signatures,
                    footer: 'Signed electronically in the Children of Promise staff portal on '
                        + new Date().toLocaleString('en-US')
                });
            } catch (e) {
                // A signature that cannot be embedded must not produce a document
                // that looks signed and is not.
                return sendJSON(res, 400, { error: 'Could not build the document: ' + e.message });
            }

            /* Named so the file says what it is without the database, and sanitised
               the same way an upload is: a child's name reaches the filesystem here,
               and a name containing a slash would escape the folder. */
            const safe = s => String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim();
            const stamp = new Date().toISOString().slice(0, 10);
            const base = [safe(d.childName) || ('Student ' + studentId),
                          safe(d.formTitle || d.field), year, 'signed ' + stamp].join(' - ');
            let target = path.join(folder.path, base + '.pdf');
            let n = 2;
            while (fs.existsSync(target) && n < 50) {
                target = path.join(folder.path, base + ' (' + n + ').pdf');
                n++;
            }
            try {
                fs.writeFileSync(target, pdf);
            } catch (e) {
                console.error('[SIGNED FORM]', e.message);
                return sendJSON(res, 500, { error: 'Could not write the signed document' });
            }
            const rel = path.relative(findDocRoot(), target).replace(/\\/g, '/');
            console.log('[SIGNED FORM] ' + pdf.length + ' bytes -> ' + rel);

            let sql = childSignatureEnsureSQL();
            signatures.forEach(s => {
                const where = `StudentId=${studentId} AND SchoolYear=${esc(year)} `
                    + `AND FormField=${esc(d.field)} AND Role=${esc(s.role)}`;
                sql += `IF EXISTS (SELECT 1 FROM ChildSignatures WHERE ${where})
    UPDATE ChildSignatures SET SignedName=${esc(s.name)},RelPath=${esc(rel)},
        SignedAt=GETDATE(),CapturedOn=${esc(d.capturedOn)} WHERE ${where}
ELSE
    INSERT INTO ChildSignatures (StudentId,SchoolYear,FormField,Role,SignedName,RelPath,SignedAt,CapturedOn)
    VALUES (${studentId},${esc(year)},${esc(d.field)},${esc(s.role)},${esc(s.name)},${esc(rel)},GETDATE(),${esc(d.capturedOn)});
`;
            });
            const r = runSQL(sql);
            /* The document is already on disk at this point. Reporting a plain
               failure would send someone hunting for a file that is there, so it
               names the file it wrote. */
            if (!r.ok) {
                return sendJSON(res, 500, {
                    error: 'The signed document was filed as "' + path.basename(target)
                         + '" but could not be recorded against the form: ' + r.error
                });
            }
            return sendJSON(res, 200, {
                success: true, relPath: rel, name: path.basename(target), bytes: pdf.length
            });
        });
        return;
    }

    /* Every captured signature for a year, without the images: the roster needs to
       know which forms are signed, not what the signatures look like. */
    if (req.method === 'GET' && url === '/api/child-signatures') {
        if (!checkAuth(req, res)) return;
        const year = resolveSchoolYear(new URLSearchParams(req.url.split('?')[1] || '').get('year'));
        const r = runSQLRows(
            `SELECT StudentId, FormField, Role, SignedName, RelPath,
                    CONVERT(NVARCHAR(20), SignedAt, 120) AS SignedAt
             FROM ChildSignatures WHERE SchoolYear=${esc(year)}`,
            childSignatureEnsureSQL());
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        return sendJSON(res, 200, { year: year, signatures: r.rows });
    }

    // GET parent interview for a student (internal - protected)
    if (req.method === 'GET' && url.startsWith('/api/parent-interview/')) {
        if (!checkAuth(req, res)) return;
        const studentId = parseInt(url.split('/')[3]);
        const year = resolveSchoolYear(new URLSearchParams(req.url.split('?')[1] || '').get('year'));
        const sql = parentInterviewEnsureSQL()
            + `SELECT Id,StudentId,InterviewDate,${txCol('ParentGoals')},${txCol('ParentConcerns')},${txCol('ChildStrengths')},${txCol('ParentSignature')},${txCol('StaffSignature')},${txCol('Notes')},${txCol('PreferredLanguage')},${txCol('TranslatorNeeded')},${txCol('TranslatorArrangements')} FROM ParentInterviews WHERE StudentId=${studentId} AND SchoolYear=${esc(year)}`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return { Id:v[0], StudentId:v[1], InterviewDate:v[2], ParentGoals:txDecode(v[3]), ParentConcerns:txDecode(v[4]), ChildStrengths:txDecode(v[5]), ParentSignature:txDecode(v[6]), StaffSignature:txDecode(v[7]), Notes:txDecode(v[8]), PreferredLanguage:txDecode(v[9]), TranslatorNeeded:txDecode(v[10]), TranslatorArrangements:txDecode(v[11]) };
            });
        return sendJSON(res, 200, rows.length ? rows[0] : null);
    }

    // POST save parent interview (internal - protected)
    if (req.method === 'POST' && url.startsWith('/api/parent-interview/')) {
        if (!checkAuth(req, res)) return;
        const studentId = parseInt(url.split('/')[3]);
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const year = resolveSchoolYear(d.year);
            const sql = parentInterviewEnsureSQL()
                + isbeTrackingEnsureSQL()
                + `IF EXISTS (SELECT 1 FROM ParentInterviews WHERE StudentId=${studentId} AND SchoolYear=${esc(year)})
                    UPDATE ParentInterviews SET InterviewDate=${esc(d.interviewDate)},ParentGoals=${esc(d.parentGoals)},ParentConcerns=${esc(d.parentConcerns)},ChildStrengths=${esc(d.childStrengths)},ParentSignature=${esc(d.parentSignature)},StaffSignature=${esc(d.staffSignature)},Notes=${esc(d.notes)},PreferredLanguage=${esc(d.preferredLanguage)},TranslatorNeeded=${esc(d.translatorNeeded)},TranslatorArrangements=${esc(d.translatorArrangements)},UpdatedAt=GETDATE() WHERE StudentId=${studentId} AND SchoolYear=${esc(year)}
                ELSE
                    INSERT INTO ParentInterviews (StudentId,SchoolYear,InterviewDate,ParentGoals,ParentConcerns,ChildStrengths,ParentSignature,StaffSignature,Notes,PreferredLanguage,TranslatorNeeded,TranslatorArrangements) VALUES (${studentId},${esc(year)},${esc(d.interviewDate)},${esc(d.parentGoals)},${esc(d.parentConcerns)},${esc(d.childStrengths)},${esc(d.parentSignature)},${esc(d.staffSignature)},${esc(d.notes)},${esc(d.preferredLanguage)},${esc(d.translatorNeeded)},${esc(d.translatorArrangements)});
`
                + trackingTickSQL(studentId, year, 'ParentInterview');
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // GET permission slip for a student (internal - protected)
    if (req.method === 'GET' && url.startsWith('/api/permission-slip/')) {
        if (!checkAuth(req, res)) return;
        const studentId = parseInt(url.split('/')[3]);
        const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='PermissionSlips')
            CREATE TABLE PermissionSlips (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                StudentId INT NOT NULL,
                ParentName NVARCHAR(200),
                SchoolYear NVARCHAR(20),
                SignedDate NVARCHAR(20),
                Teacher NVARCHAR(200),
                ParentSignature NVARCHAR(200),
                ParentSigDate NVARCHAR(20),
                TeacherSignature NVARCHAR(200),
                TeacherSigDate NVARCHAR(20),
                CreatedAt DATETIME DEFAULT GETDATE(),
                UpdatedAt DATETIME DEFAULT GETDATE()
            );
            ${schoolYearColumnSQL('PermissionSlips')}
            SELECT Id,StudentId,ISNULL(ParentName,'') AS ParentName,ISNULL(SchoolYear,'') AS SchoolYear,ISNULL(SignedDate,'') AS SignedDate,ISNULL(Teacher,'') AS Teacher,ISNULL(ParentSignature,'') AS ParentSignature,ISNULL(ParentSigDate,'') AS ParentSigDate,ISNULL(TeacherSignature,'') AS TeacherSignature,ISNULL(TeacherSigDate,'') AS TeacherSigDate,CreatedAt,UpdatedAt FROM PermissionSlips WHERE StudentId=${studentId} AND SchoolYear=${esc(resolveSchoolYear(new URLSearchParams(req.url.split('?')[1] || '').get('year')))}`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return { Id:v[0], StudentId:v[1], ParentName:v[2], SchoolYear:v[3], SignedDate:v[4], Teacher:v[5], ParentSignature:v[6], ParentSigDate:v[7], TeacherSignature:v[8], TeacherSigDate:v[9], CreatedAt:v[10], UpdatedAt:v[11] };
            });
        return sendJSON(res, 200, rows.length ? rows[0] : null);
    }

    // POST save permission slip (internal - protected)
    if (req.method === 'POST' && url.startsWith('/api/permission-slip/')) {
        if (!checkAuth(req, res)) return;
        const studentId = parseInt(url.split('/')[3]);
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            // The slip form already carries the school year it was filled in for;
            // that is the year the record belongs to.
            const slipYear = resolveSchoolYear(d.schoolYear || d.year);
            const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='PermissionSlips')
                CREATE TABLE PermissionSlips (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    StudentId INT NOT NULL,
                    ParentName NVARCHAR(200),
                    SchoolYear NVARCHAR(20),
                    SignedDate NVARCHAR(20),
                    Teacher NVARCHAR(200),
                    ParentSignature NVARCHAR(200),
                    ParentSigDate NVARCHAR(20),
                    TeacherSignature NVARCHAR(200),
                    TeacherSigDate NVARCHAR(20),
                    CreatedAt DATETIME DEFAULT GETDATE(),
                    UpdatedAt DATETIME DEFAULT GETDATE()
                );
                ${schoolYearColumnSQL('PermissionSlips')}
                IF EXISTS (SELECT 1 FROM PermissionSlips WHERE StudentId=${studentId} AND SchoolYear=${esc(slipYear)})
                    UPDATE PermissionSlips SET ParentName=${esc(d.parentName)},SignedDate=${esc(d.signedDate)},Teacher=${esc(d.teacher)},ParentSignature=${esc(d.parentSignature)},ParentSigDate=${esc(d.parentSigDate)},TeacherSignature=${esc(d.teacherSignature)},TeacherSigDate=${esc(d.teacherSigDate)},UpdatedAt=GETDATE() WHERE StudentId=${studentId} AND SchoolYear=${esc(slipYear)}
                ELSE
                    INSERT INTO PermissionSlips (StudentId,SchoolYear,ParentName,SignedDate,Teacher,ParentSignature,ParentSigDate,TeacherSignature,TeacherSigDate) VALUES (${studentId},${esc(slipYear)},${esc(d.parentName)},${esc(d.signedDate)},${esc(d.teacher)},${esc(d.parentSignature)},${esc(d.parentSigDate)},${esc(d.teacherSignature)},${esc(d.teacherSigDate)});
`
                + trackingTickSQL(studentId, slipYear, 'PermissionSlip');
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // GET a PICC document form for a student (internal - protected)
    // /api/pi-doc/<form-type>/<studentId>
    if (req.method === 'GET' && url.startsWith('/api/pi-doc/')) {
        if (!checkAuth(req, res)) return;
        const parts = url.split('/');
        const cfg = PI_DOC_FORMS[parts[3]];
        if (!cfg) return sendJSON(res, 404, { error: 'Unknown form type' });
        const studentId = parseInt(parts[4]);
        if (!studentId) return sendJSON(res, 400, { error: 'Invalid student id' });

        // `url` has the query string stripped, so read params off req.url.
        const year = resolveSchoolYear(new URLSearchParams(req.url.split('?')[1] || '').get('year'));
        const select = cfg.columns.map(([name]) => txCol(name)).join(',');
        const sql = docFormEnsureSQL(cfg)
            + `SELECT Id,StudentId,${select} FROM ${cfg.table} WHERE StudentId=${studentId} AND SchoolYear=${esc(year)}`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()));
        if (!rows.length) return sendJSON(res, 200, { found: false });
        const v = rows[0].split('|').map(x => x.trim());
        const out = { found: true, Id: v[0], StudentId: v[1] };
        cfg.columns.forEach(([name], i) => { out[name] = txDecode(v[i + 2]); });
        return sendJSON(res, 200, out);
    }

    // POST save a PICC document form (internal - protected)
    // Upserts the form row and auto-checks the matching roster column.
    if (req.method === 'POST' && url.startsWith('/api/pi-doc/')) {
        if (!checkAuth(req, res)) return;
        const parts = url.split('/');
        const cfg = PI_DOC_FORMS[parts[3]];
        if (!cfg) return sendJSON(res, 404, { error: 'Unknown form type' });
        const studentId = parseInt(parts[4]);
        if (!studentId) return sendJSON(res, 400, { error: 'Invalid student id' });

        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const year = resolveSchoolYear(d.year);
            const names = cfg.columns.map(([name]) => name).join(',');
            const vals = cfg.columns.map(([, , key]) => esc(d[key])).join(',');
            const sets = cfg.columns.map(([name, , key]) => `${name}=${esc(d[key])}`).join(',');
            const sql = docFormEnsureSQL(cfg)
                + isbeTrackingEnsureSQL()
                + `IF EXISTS (SELECT 1 FROM ${cfg.table} WHERE StudentId=${studentId} AND SchoolYear=${esc(year)})
    UPDATE ${cfg.table} SET ${sets},UpdatedAt=GETDATE() WHERE StudentId=${studentId} AND SchoolYear=${esc(year)}
ELSE
    INSERT INTO ${cfg.table} (StudentId,SchoolYear,${names}) VALUES (${studentId},${esc(year)},${vals});
`
                + trackingTickSQL(studentId, year, cfg.trackingColumn);
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // GET screening score for a student (internal - protected)
    if (req.method === 'GET' && url.startsWith('/api/screening/')) {
        if (!checkAuth(req, res)) return;
        const studentId = parseInt(url.split('/')[3]);
        const query = req.url.split('?')[1] || '';
        const params = new URLSearchParams(query);
        const type = params.get('type') || '';
        const period = params.get('period') || '';
        const scrYear = resolveSchoolYear(params.get('year'));
        const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ScreeningScores')
            CREATE TABLE ScreeningScores (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                StudentId INT NOT NULL,
                ScreeningType NVARCHAR(20),
                Period NVARCHAR(20),
                ScreeningDate NVARCHAR(20),
                CompletedBy NVARCHAR(20),
                Interval NVARCHAR(30),
                ReferralMade NVARCHAR(10),
                CommScore NVARCHAR(10),CommStatus NVARCHAR(20),
                GrossScore NVARCHAR(10),GrossStatus NVARCHAR(20),
                FineScore NVARCHAR(10),FineStatus NVARCHAR(20),
                ProblemScore NVARCHAR(10),ProblemStatus NVARCHAR(20),
                PersonalScore NVARCHAR(10),PersonalStatus NVARCHAR(20),
                SETotal NVARCHAR(10),SECutoff NVARCHAR(10),SEResult NVARCHAR(20),
                Notes NVARCHAR(MAX),
                CreatedAt DATETIME DEFAULT GETDATE(),
                UpdatedAt DATETIME DEFAULT GETDATE()
            );
            ${schoolYearColumnSQL('ScreeningScores')}
            SELECT Id,StudentId,ScreeningType,Period,ISNULL(ScreeningDate,'') AS ScreeningDate,ISNULL(CompletedBy,'') AS CompletedBy,ISNULL([Interval],'') AS [Interval],ISNULL(ReferralMade,'') AS ReferralMade,ISNULL(CommScore,'') AS CommScore,ISNULL(CommStatus,'') AS CommStatus,ISNULL(GrossScore,'') AS GrossScore,ISNULL(GrossStatus,'') AS GrossStatus,ISNULL(FineScore,'') AS FineScore,ISNULL(FineStatus,'') AS FineStatus,ISNULL(ProblemScore,'') AS ProblemScore,ISNULL(ProblemStatus,'') AS ProblemStatus,ISNULL(PersonalScore,'') AS PersonalScore,ISNULL(PersonalStatus,'') AS PersonalStatus,ISNULL(SETotal,'') AS SETotal,ISNULL(SECutoff,'') AS SECutoff,ISNULL(SEResult,'') AS SEResult,ISNULL(Notes,'') AS Notes FROM ScreeningScores WHERE StudentId=${studentId} AND ScreeningType=${esc(type)} AND Period=${esc(period)} AND SchoolYear=${esc(scrYear)}`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return { Id:v[0],StudentId:v[1],ScreeningType:v[2],Period:v[3],ScreeningDate:v[4],CompletedBy:v[5],Interval:v[6],ReferralMade:v[7],CommScore:v[8],CommStatus:v[9],GrossScore:v[10],GrossStatus:v[11],FineScore:v[12],FineStatus:v[13],ProblemScore:v[14],ProblemStatus:v[15],PersonalScore:v[16],PersonalStatus:v[17],SETotal:v[18],SECutoff:v[19],SEResult:v[20],Notes:v[21] };
            });
        return sendJSON(res, 200, rows.length ? rows[0] : null);
    }

    // POST save screening score (internal - protected)
    if (req.method === 'POST' && url.startsWith('/api/screening/')) {
        if (!checkAuth(req, res)) return;
        const studentId = parseInt(url.split('/')[3]);
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            // Map period to ISBE tracking field
            let isbeField = '';
            if (d.type === 'ASQ-3' && d.period === 'Beginning') isbeField = 'BegASQ';
            else if (d.type === 'ASQ-3' && d.period === 'End') isbeField = 'EndASQ';
            else if (d.type === 'ASQ:SE-2' && d.period === 'Beginning') isbeField = 'BegASE';
            else if (d.type === 'ASQ:SE-2' && d.period === 'End') isbeField = 'EndASE';
            const scrYear = resolveSchoolYear(d.year);

            const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ScreeningScores')
                CREATE TABLE ScreeningScores (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    StudentId INT NOT NULL,
                    ScreeningType NVARCHAR(20),
                    Period NVARCHAR(20),
                    ScreeningDate NVARCHAR(20),
                    CompletedBy NVARCHAR(20),
                    [Interval] NVARCHAR(30),
                    ReferralMade NVARCHAR(10),
                    CommScore NVARCHAR(10),CommStatus NVARCHAR(20),
                    GrossScore NVARCHAR(10),GrossStatus NVARCHAR(20),
                    FineScore NVARCHAR(10),FineStatus NVARCHAR(20),
                    ProblemScore NVARCHAR(10),ProblemStatus NVARCHAR(20),
                    PersonalScore NVARCHAR(10),PersonalStatus NVARCHAR(20),
                    SETotal NVARCHAR(10),SECutoff NVARCHAR(10),SEResult NVARCHAR(20),
                    Notes NVARCHAR(MAX),
                    CreatedAt DATETIME DEFAULT GETDATE(),
                    UpdatedAt DATETIME DEFAULT GETDATE()
                );
                ${schoolYearColumnSQL('ScreeningScores')}
                IF EXISTS (SELECT 1 FROM ScreeningScores WHERE StudentId=${studentId} AND ScreeningType=${esc(d.type)} AND Period=${esc(d.period)} AND SchoolYear=${esc(scrYear)})
                    UPDATE ScreeningScores SET ScreeningDate=${esc(d.screeningDate)},CompletedBy=${esc(d.completedBy)},[Interval]=${esc(d.interval)},ReferralMade=${esc(d.referralMade)},CommScore=${esc(d.commScore||'')},CommStatus=${esc(d.commStatus||'')},GrossScore=${esc(d.grossScore||'')},GrossStatus=${esc(d.grossStatus||'')},FineScore=${esc(d.fineScore||'')},FineStatus=${esc(d.fineStatus||'')},ProblemScore=${esc(d.problemScore||'')},ProblemStatus=${esc(d.problemStatus||'')},PersonalScore=${esc(d.personalScore||'')},PersonalStatus=${esc(d.personalStatus||'')},SETotal=${esc(d.seTotal||'')},SECutoff=${esc(d.seCutoff||'')},SEResult=${esc(d.seResult||'')},Notes=${esc(d.notes)},UpdatedAt=GETDATE() WHERE StudentId=${studentId} AND ScreeningType=${esc(d.type)} AND Period=${esc(d.period)} AND SchoolYear=${esc(scrYear)}
                ELSE
                    INSERT INTO ScreeningScores (StudentId,SchoolYear,ScreeningType,Period,ScreeningDate,CompletedBy,[Interval],ReferralMade,CommScore,CommStatus,GrossScore,GrossStatus,FineScore,FineStatus,ProblemScore,ProblemStatus,PersonalScore,PersonalStatus,SETotal,SECutoff,SEResult,Notes) VALUES (${studentId},${esc(scrYear)},${esc(d.type)},${esc(d.period)},${esc(d.screeningDate)},${esc(d.completedBy)},${esc(d.interval)},${esc(d.referralMade)},${esc(d.commScore||'')},${esc(d.commStatus||'')},${esc(d.grossScore||'')},${esc(d.grossStatus||'')},${esc(d.fineScore||'')},${esc(d.fineStatus||'')},${esc(d.problemScore||'')},${esc(d.problemStatus||'')},${esc(d.personalScore||'')},${esc(d.personalStatus||'')},${esc(d.seTotal||'')},${esc(d.seCutoff||'')},${esc(d.seResult||'')},${esc(d.notes)});
`
                + (isbeField ? trackingTickSQL(studentId, scrYear, isbeField) : '');
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // ══════════════════════════════════════════
    // PARENT PORTAL (public - code-authenticated)
    // ══════════════════════════════════════════

    // POST parent portal login (public)
    if (req.method === 'POST' && url === '/api/parent-portal/login') {
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const code = (d.code || '').trim().toUpperCase();
            if (!code) return sendJSON(res, 400, { error: 'Code required' });

            // Ensure table exists and look up code
            const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ParentCodes')
                CREATE TABLE ParentCodes (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    StudentId INT NOT NULL,
                    Code NVARCHAR(10) NOT NULL UNIQUE,
                    CreatedAt DATETIME DEFAULT GETDATE()
                );
                SELECT pc.StudentId,e.First_Name,e.Last_Name,e.Birth_date,e.RoomNumber,r.Room,r.TeacherDescription,
                    ISNULL(e.HouseholdIncome,'') AS HouseholdIncome,ISNULL(CAST(e.HouseholdSize AS NVARCHAR),'') AS HouseholdSize,
                    ISNULL(e.PublicBenefits,'') AS PublicBenefits,ISNULL(e.IEP,'') AS IEP,ISNULL(e.Military,'') AS Military,
                    ISNULL(e.Category,'') AS Category,ISNULL(e.City_Town,'') AS City_Town,ISNULL(e.PFA_PI_na,'') AS PFA_PI_na
                FROM ParentCodes pc
                JOIN rptMasterEnrollment e ON pc.StudentId=e.Id
                LEFT JOIN dimClassrooms r ON e.RoomNumber=r.RoomNumber
                WHERE pc.Code=${esc(code)}`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            const lines = r.data.trim().split('\n')
                .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()));
            if (!lines.length) return sendJSON(res, 200, { success: false, error: 'Invalid code' });
            const v = lines[0].split('|').map(x => x.trim());
            const student = { Id:v[0], First_Name:v[1], Last_Name:v[2], Birth_date:v[3], RoomNumber:v[4], Room:v[5], TeacherDescription:v[6], HouseholdIncome:v[7], HouseholdSize:v[8], PublicBenefits:v[9], IEP:v[10], Military:v[11], Category:v[12], City_Town:v[13], PFA_PI_na:v[14] };

            // Get tracking status for the year in progress. A parent following a
            // code should see whether THIS year's slip and interview are done, not
            // whether last year's were.
            const tSql = isbeTrackingEnsureSQL()
                + `SELECT PermissionSlip,ParentInterview FROM ISBETracking WHERE StudentId=${parseInt(student.Id)} AND SchoolYear=${esc(currentSchoolYear())}`;
            const tRes = runSQL(tSql);
            let tracking = {};
            if (tRes.ok) {
                const tLines = tRes.data.trim().split('\n')
                    .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()));
                if (tLines.length) {
                    const tv = tLines[0].split('|').map(x => x.trim());
                    tracking = { PermissionSlip: tv[0]==='1', ParentInterview: tv[1]==='1' };
                }
            }

            // Get pre-enrollment data if available
            let preEnroll = {};
            const peSql = `SELECT TOP 1 FirstName,LastName,Phone,Email,Address,City,Zip,
                ISNULL(Homeless,'') AS Homeless,ISNULL(FosterAdopted,'') AS FosterAdopted,
                ISNULL(NonEnglishHome,'') AS NonEnglishHome,ISNULL(ActiveMilitary,'') AS ActiveMilitary,
                ISNULL(TeenParent,'') AS TeenParent,ISNULL(LivingSituation,'') AS LivingSituation,
                ISNULL(IEP,'') AS IEP,ISNULL(EarlyIntervention,'') AS EarlyIntervention,
                ISNULL(ChildName,'') AS ChildName,ISNULL(ChildBirthDate,'') AS ChildBirthDate
                FROM PreEnrollment WHERE
                (ChildName LIKE '%'+${esc(student.First_Name)}+'%' OR FirstName=${esc(student.First_Name)})
                ORDER BY Id DESC`;
            const peRes = runSQL(peSql);
            if (peRes.ok) {
                const peLines = peRes.data.trim().split('\n')
                    .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()));
                if (peLines.length) {
                    const pv = peLines[0].split('|').map(x => x.trim());
                    preEnroll = { FirstName:pv[0],LastName:pv[1],Phone:pv[2],Email:pv[3],Address:pv[4],City:pv[5],Zip:pv[6],Homeless:pv[7],FosterAdopted:pv[8],NonEnglishHome:pv[9],ActiveMilitary:pv[10],TeenParent:pv[11],LivingSituation:pv[12],IEP:pv[13],EarlyIntervention:pv[14],ChildName:pv[15],ChildBirthDate:pv[16] };
                }
            }

            sendJSON(res, 200, { success: true, student, tracking, preEnroll });
        });
        return;
    }

    // POST parent portal sign form (public)
    if (req.method === 'POST' && url === '/api/parent-portal/sign') {
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const code = (d.code || '').trim().toUpperCase();
            const formType = d.formType;
            const data = d.data || {};
            // A parent signing today is signing for the year in progress. The
            // form may also carry the year it was rendered with.
            const formYear = resolveSchoolYear(data.schoolYear || d.year);

            // Verify code and get student ID
            const lookupSql = `SELECT StudentId FROM ParentCodes WHERE Code=${esc(code)}`;
            const lr = runSQL(lookupSql);
            if (!lr.ok) return sendJSON(res, 500, { error: lr.error });
            const lookupLines = lr.data.trim().split('\n')
                .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()));
            if (!lookupLines.length) return sendJSON(res, 403, { error: 'Invalid code' });
            const studentId = parseInt(lookupLines[0].trim());

            if (formType === 'PermissionSlip') {
                const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='PermissionSlips')
                    CREATE TABLE PermissionSlips (
                        Id INT IDENTITY(1,1) PRIMARY KEY,StudentId INT NOT NULL,
                        ParentName NVARCHAR(200),SchoolYear NVARCHAR(20),SignedDate NVARCHAR(20),
                        Teacher NVARCHAR(200),ParentSignature NVARCHAR(200),ParentSigDate NVARCHAR(20),
                        TeacherSignature NVARCHAR(200),TeacherSigDate NVARCHAR(20),
                        CreatedAt DATETIME DEFAULT GETDATE(),UpdatedAt DATETIME DEFAULT GETDATE()
                    );
                    ${schoolYearColumnSQL('PermissionSlips')}
                    IF EXISTS (SELECT 1 FROM PermissionSlips WHERE StudentId=${studentId} AND SchoolYear=${esc(formYear)})
                        UPDATE PermissionSlips SET ParentName=${esc(data.parentName)},SignedDate=${esc(data.signedDate)},Teacher=${esc(data.teacher)},ParentSignature=${esc(data.parentSignature)},ParentSigDate=${esc(data.parentSigDate)},UpdatedAt=GETDATE() WHERE StudentId=${studentId} AND SchoolYear=${esc(formYear)}
                    ELSE
                        INSERT INTO PermissionSlips (StudentId,SchoolYear,ParentName,SignedDate,Teacher,ParentSignature,ParentSigDate) VALUES (${studentId},${esc(formYear)},${esc(data.parentName)},${esc(data.signedDate)},${esc(data.teacher)},${esc(data.parentSignature)},${esc(data.parentSigDate)});
`
                    + trackingTickSQL(studentId, formYear, 'PermissionSlip');
                const r = runSQL(sql);
                if (!r.ok) return sendJSON(res, 500, { error: r.error });
                return sendJSON(res, 200, { success: true });
            }

            if (formType === 'ParentInterview') {
                // Full interview payload kept as JSON alongside the mapped columns.
                // esc() handles the quote escaping, so this must stay raw or the
                // stored JSON ends up double-escaped and unparseable.
                const jsonData = JSON.stringify(data);
                const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ParentInterviews')
                    CREATE TABLE ParentInterviews (
                        Id INT IDENTITY(1,1) PRIMARY KEY,StudentId INT NOT NULL,
                        InterviewDate NVARCHAR(20),ParentGoals NVARCHAR(MAX),ParentConcerns NVARCHAR(MAX),
                        ChildStrengths NVARCHAR(MAX),ParentSignature NVARCHAR(200),StaffSignature NVARCHAR(200),
                        Notes NVARCHAR(MAX),CreatedAt DATETIME DEFAULT GETDATE(),UpdatedAt DATETIME DEFAULT GETDATE()
                    );
                    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='ParentInterviews' AND COLUMN_NAME='FormData') ALTER TABLE ParentInterviews ADD FormData NVARCHAR(MAX);
                    ${schoolYearColumnSQL('ParentInterviews')}
                    IF EXISTS (SELECT 1 FROM ParentInterviews WHERE StudentId=${studentId} AND SchoolYear=${esc(formYear)})
                        UPDATE ParentInterviews SET InterviewDate=${esc(data.signDate||'')},ParentGoals=${esc(data.goals||'')},ParentConcerns=${esc(data.behaviors||'')},ChildStrengths=${esc(data.describeChild||'')},ParentSignature=${esc(data.parentSignature||'')},FormData=${esc(jsonData)},UpdatedAt=GETDATE() WHERE StudentId=${studentId} AND SchoolYear=${esc(formYear)}
                    ELSE
                        INSERT INTO ParentInterviews (StudentId,SchoolYear,InterviewDate,ParentGoals,ParentConcerns,ChildStrengths,ParentSignature,FormData) VALUES (${studentId},${esc(formYear)},${esc(data.signDate||'')},${esc(data.goals||'')},${esc(data.behaviors||'')},${esc(data.describeChild||'')},${esc(data.parentSignature||'')},${esc(jsonData)});
`
                    + trackingTickSQL(studentId, formYear, 'ParentInterview');
                const r = runSQL(sql);
                if (!r.ok) return sendJSON(res, 500, { error: r.error });
                return sendJSON(res, 200, { success: true });
            }

            sendJSON(res, 400, { error: 'Unknown form type' });
        });
        return;
    }

    // GET parent codes for staff (internal - protected)
    if (req.method === 'GET' && url === '/api/parent-codes') {
        if (!checkAuth(req, res)) return;
        const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ParentCodes')
            CREATE TABLE ParentCodes (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                StudentId INT NOT NULL,
                Code NVARCHAR(10) NOT NULL UNIQUE,
                CreatedAt DATETIME DEFAULT GETDATE()
            );
            SELECT pc.StudentId,pc.Code,e.First_Name,e.Last_Name FROM ParentCodes pc JOIN rptMasterEnrollment e ON pc.StudentId=e.Id ORDER BY e.Last_Name`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => { const v = l.split('|').map(x => x.trim()); return { StudentId:v[0], Code:v[1], First_Name:v[2], Last_Name:v[3] }; });
        return sendJSON(res, 200, rows);
    }

    // POST generate parent code (internal - protected)
    if (req.method === 'POST' && url === '/api/parent-codes') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const studentId = parseInt(d.studentId);
            if (!studentId) return sendJSON(res, 400, { error: 'Student ID required' });
            // Generate random 6-char code
            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            let code = '';
            for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];

            const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ParentCodes')
                CREATE TABLE ParentCodes (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    StudentId INT NOT NULL,
                    Code NVARCHAR(10) NOT NULL UNIQUE,
                    CreatedAt DATETIME DEFAULT GETDATE()
                );
                IF EXISTS (SELECT 1 FROM ParentCodes WHERE StudentId=${studentId})
                    UPDATE ParentCodes SET Code=${esc(code)} WHERE StudentId=${studentId}
                ELSE
                    INSERT INTO ParentCodes (StudentId,Code) VALUES (${studentId},${esc(code)})`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true, code: code });
        });
        return;
    }

    // POST start conference (internal - protected)
    if (req.method === 'POST' && url === '/api/conference') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const studentId = parseInt(d.studentId);
            const meetUrl = d.meetUrl || '';
            const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='Conferences')
                CREATE TABLE Conferences (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    StudentId INT NOT NULL,
                    MeetUrl NVARCHAR(500),
                    StartedAt DATETIME DEFAULT GETDATE(),
                    Active BIT DEFAULT 1
                );
                UPDATE Conferences SET Active=0 WHERE StudentId=${studentId};
                INSERT INTO Conferences (StudentId,MeetUrl,Active) VALUES (${studentId},${esc(meetUrl)},1)`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    /* GET weekly menus (internal - protected)

       Answers with a status the page can act on. The previous version returned
       200 {} for three different situations — no menu saved, a SQL failure, and a
       value too long to survive sqlcmd — so the page could not tell them apart and
       fell back to its own browser copy in all three. Since a real week's menu is
       well over the 256-character limit that used to apply, that fallback was the
       normal case: the person who typed the menu saw it, nobody else did.

       Now: 200 with saved:true when a row exists, 200 with saved:false when the
       week genuinely has no menu, and 500 when the read failed. */
    if (req.method === 'GET' && url.startsWith('/api/menus')) {
        if (!checkAuth(req, res)) return;
        const week = new URLSearchParams(req.url.split('?')[1] || '').get('week') || '';
        const r = runSQLRows(
            `SELECT PfaData, OtherData FROM WeeklyMenus WHERE WeekKey=${esc(week)}`,
            weeklyMenusEnsureSQL());
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        if (!r.rows.length) return sendJSON(res, 200, { pfa: {}, other: {}, saved: false });

        const parse = v => {
            if (v === null || v === undefined || v === '') return {};
            try { return JSON.parse(v); } catch (e) { return null; }
        };
        const pfa = parse(r.rows[0].PfaData);
        const other = parse(r.rows[0].OtherData);
        // Stored text that will not parse is a real fault, not an empty week.
        if (pfa === null || other === null) {
            return sendJSON(res, 500, { error: 'The saved menu for that week is not valid JSON' });
        }
        return sendJSON(res, 200, { pfa, other, saved: true });
    }

    // POST save weekly menus (internal - protected)
    if (req.method === 'POST' && url === '/api/menus') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const week = d.week || '';
            // Raw JSON; esc() does the quoting and escaping at the point of use.
            const pfaJson = JSON.stringify(d.pfa || {});
            const otherJson = JSON.stringify(d.other || {});
            const sql = weeklyMenusEnsureSQL()
                + `IF EXISTS (SELECT 1 FROM WeeklyMenus WHERE WeekKey=${esc(week)})
                    UPDATE WeeklyMenus SET PfaData=${esc(pfaJson)},OtherData=${esc(otherJson)},UpdatedAt=GETDATE() WHERE WeekKey=${esc(week)}
                ELSE
                    INSERT INTO WeeklyMenus (WeekKey,PfaData,OtherData) VALUES (${esc(week)},${esc(pfaJson)},${esc(otherJson)})`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // GET active conference for parent portal (public - code-authenticated via query)
    if (req.method === 'GET' && url === '/api/parent-portal/conference') {
        const query = req.url.split('?')[1] || '';
        const params = new URLSearchParams(query);
        const code = (params.get('code') || '').trim().toUpperCase();
        if (!code) return sendJSON(res, 400, { error: 'Code required' });
        const sql = `SELECT c.MeetUrl FROM Conferences c
            JOIN ParentCodes pc ON c.StudentId=pc.StudentId
            WHERE pc.Code=${esc(code)} AND c.Active=1
            ORDER BY c.StartedAt DESC`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const lines = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()));
        if (!lines.length) return sendJSON(res, 200, { active: false });
        return sendJSON(res, 200, { active: true, meetUrl: lines[0].trim() });
    }

    // GET program compliance data (internal - protected)
    if (req.method === 'GET' && url === '/api/compliance') {
        if (!checkAuth(req, res)) return;
        const query = req.url.split('?')[1] || '';
        const params = new URLSearchParams(query);
        const year = params.get('year') || '';
        /* JSON transport: FieldValue is NVARCHAR(MAX) and holds the free-text note
           staff write against a checklist item, which routinely runs past the 256
           characters the pipe-delimited read could carry. */
        const r = runSQLRows(
            `SELECT FieldName, FieldValue FROM ProgramCompliance WHERE SchoolYear=${esc(year)}`,
            complianceEnsureSQL() + 'GO\n');
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const data = {};
        r.rows.forEach(row => {
            const name = row.FieldName;
            if (!name) return;
            const raw = row.FieldValue == null ? '' : String(row.FieldValue);
            data[name] = raw === '1' ? true : raw === '0' ? false : raw;
        });
        return sendJSON(res, 200, data);
    }

    /* GET the files belonging to a staff member.

       A staff member gets exactly the files confirmed as theirs. The director gets
       the same for whoever is asked about, plus the unassigned ones and what the
       filenames suggest, which is the screen where confirming happens.

       A staff member never receives a proposal. An unconfirmed file might be
       someone else's, and "probably yours" is not a standard worth applying to a
       document with a social security number in it. */
    if (req.method === 'GET' && url === '/api/staff-files') {
        const actor = requireActor(req, res);
        if (!actor) return;

        const asked = parseInt(new URLSearchParams(req.url.split('?')[1] || '').get('staffId') || 0, 10);
        // The id is only honoured for the director. For a staff member it comes
        // from the token, so a hand-edited URL changes nothing.
        const staffId = actor.director ? asked : parseInt(actor.staffId, 10);
        if (actor.director && !staffId) {
            return sendJSON(res, 400, { error: 'Which staff member?' });
        }

        const links = staffFileLinkMap();
        if (!links.ok) return sendJSON(res, 500, { error: links.error });

        const listed = listStaffFolderFiles();
        if (!listed.ok) {
            /* The library being unreachable is not "no files". Saying so matters:
               a staff member told they have no transcript on file would go and
               request a new one from their college for no reason. */
            return sendJSON(res, 200, {
                staffId: String(staffId), libraryReachable: false,
                reason: listed.error, mine: [], unassigned: [], suggestions: []
            });
        }

        const mine = listed.files.filter(f => links.byPath[f.rel] === String(staffId));
        const body = {
            staffId: String(staffId),
            libraryReachable: true,
            mine: mine.map(f => ({ name: f.name, category: f.category, rel: f.rel }))
        };

        if (actor.director) {
            const r = runSQLRows(`SELECT Id, ISNULL(Name,'') AS Name FROM Staff WHERE ISNULL(Active,1)=1`,
                staffEnsureSQL() + 'GO\n');
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            const target = r.rows.find(x => String(x.Id) === String(staffId));

            /* Set aside as not being anyone's personnel file. Reported back rather
               than simply omitted, so a file put here by mistake can be found and
               undone instead of quietly disappearing from every list there is. */
            body.misc = listed.files
                .filter(f => links.byPath[f.rel] === '0')
                .map(f => ({ name: f.name, category: f.category, rel: f.rel }));

            const unassigned = listed.files.filter(f => !links.byPath[f.rel]);
            body.unassigned = unassigned.map(f => {
                // What this filename looks like across the whole roster, best first,
                // so a file can be filed against the right person in one pass.
                const guesses = r.rows
                    .map(s => {
                        const m = proposeStaffMatch(f.name, s.Name);
                        return m ? { staffId: String(s.Id), name: String(s.Name), confidence: m.confidence, why: m.why } : null;
                    })
                    .filter(Boolean)
                    .sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === 'firm' ? -1 : 1));
                return { name: f.name, category: f.category, rel: f.rel, guesses: guesses };
            });
            // Called out separately: a file matching nobody is usually a former
            // member of staff, and leaving it silent looks like an oversight.
            body.matchesNobody = body.unassigned
                .filter(f => !f.guesses.length)
                .map(f => ({ name: f.name, category: f.category }));
            body.suggestedForTarget = target
                ? body.unassigned
                    .filter(f => f.guesses.some(g => String(g.staffId) === String(staffId)))
                    .map(f => ({
                        name: f.name, category: f.category, rel: f.rel,
                        confidence: (f.guesses.find(g => String(g.staffId) === String(staffId)) || {}).confidence
                    }))
                : [];
        }

        return sendJSON(res, 200, body);
    }

    /* POST link a file to a staff member, or unlink it by sending no staffId.
       Director only: this is the confirmation step, so it cannot be self-served. */
    if (req.method === 'POST' && url === '/api/staff-file-link') {
        if (!checkAuth(req, res)) return;
        return readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const rel = String((d && d.rel) || '').replace(/\\/g, '/').trim();
            if (!rel) return sendJSON(res, 400, { error: 'Which file?' });

            /* Confined to the Staff folder and required to exist. Without the first
               check this endpoint would file any path in the library — including a
               child's record — against a staff member, and then serve it to them. */
            if (!rel.startsWith(STAFF_DOC_ROOT_FOLDER + '/')) {
                return sendJSON(res, 400, { error: 'That file is not in the Staff folder' });
            }
            const full = resolveDocPath(rel);
            if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
                return sendJSON(res, 404, { error: 'No such file in the library' });
            }

            /* Three outcomes, not two: filed against a person, set aside as not
               being anybody's personnel file, or put back to undecided.

               "Misc" is recorded as a link to staff 0 rather than as a deletion,
               because a deleted row means "nobody has looked at this yet" and that
               is the opposite of what happened. Staff ids start at 1, so 0 can
               never collide with a real person, and the row keeps the file out of
               the pending list while leaving it visible and reversible.

               Nothing is moved or deleted on disk. Three of these files belong to
               former staff and are still the centre's records; the only thing being
               decided here is whether they appear on somebody's own page. */
            const misc = !!(d && d.misc);
            const staffId = misc ? 0 : parseInt((d && d.staffId) || 0, 10);

            if (!misc && !staffId) {
                const w = runSQL(staffFileLinksEnsureSQL() + 'GO\n'
                    + `DELETE FROM StaffFileLinks WHERE RelPath=${esc(rel)}`);
                if (!w.ok) return sendJSON(res, 500, { error: w.error });
                return sendJSON(res, 200, { success: true, linked: false });
            }

            /* One owner per file, so re-filing replaces rather than adds. A file
               with two owners would show up on two people's pages, and the second
               person seeing it is the failure this whole table exists to prevent. */
            const w = runSQL(staffFileLinksEnsureSQL() + 'GO\n'
                + `DELETE FROM StaffFileLinks WHERE RelPath=${esc(rel)};\n`
                + `INSERT INTO StaffFileLinks (StaffId, RelPath, LinkedBy, LinkedDate) VALUES (`
                + `${staffId}, ${esc(rel)}, ${esc('director')}, ${esc(new Date().toISOString())})`);
            if (!w.ok) return sendJSON(res, 500, { error: w.error });
            return sendJSON(res, 200, { success: true, linked: true });
        });
    }

    /* GET one personnel file.

       Separate from /api/doc-file because that one answers to the shared password
       and hands over anything in the library. This one asks whose file it is first,
       so a staff member can only ever pull a document confirmed as theirs. */
    if (req.method === 'GET' && url.startsWith('/api/staff-file-download')) {
        const actor = requireActor(req, res);
        if (!actor) return;
        const rel = String(new URLSearchParams(req.url.split('?')[1] || '').get('path') || '')
            .replace(/\\/g, '/').trim();
        if (!rel.startsWith(STAFF_DOC_ROOT_FOLDER + '/')) {
            res.writeHead(404); return res.end('Not found');
        }

        if (!actor.director) {
            const links = staffFileLinkMap();
            if (!links.ok) return sendJSON(res, 500, { error: links.error });
            if (links.byPath[rel] !== String(actor.staffId)) {
                // Deliberately 404 and not 403: whether a file exists at all is
                // not something to confirm to someone it does not belong to.
                res.writeHead(404); return res.end('Not found');
            }
        }

        const full = resolveDocPath(rel);
        if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
            res.writeHead(404); return res.end('Not found');
        }
        const ext = path.extname(full).toLowerCase();
        // Read fully then send in one write. Streaming never completes against this
        // server's HTTPS response — see the note on /api/doc-file.
        let buf;
        try {
            buf = fs.readFileSync(full);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            return res.end('Could not read that document');
        }
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Content-Length': buf.length,
            'Content-Disposition': (['.pdf', '.png', '.jpg', '.jpeg', '.txt'].includes(ext)
                ? 'inline' : 'attachment')
                + '; filename="' + path.basename(full).replace(/"/g, '') + '"',
            'X-Content-Type-Options': 'nosniff'
        });
        return res.end(buf);
    }

    /* POST staff sign-in. The only endpoint here that is reachable without a
       credential, because it is the one that issues them.

       Answers the same "that did not match" for an unknown login name and a wrong
       password. Distinguishing them would let anyone confirm who works here by
       trying names, and the roster is not something a public page should hand out.

       The staff list is deliberately not returned by this endpoint either, for the
       same reason: someone signing in types their name, they do not pick it from a
       list of everybody. */
    if (req.method === 'POST' && url === '/api/staff-login') {
        return readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const login = String((d && d.login) || '').trim();
            const password = String((d && d.password) || '');
            if (!login || !password) {
                return sendJSON(res, 400, { error: 'Enter your name and password' });
            }

            // Enrols anyone who does not have an account yet, including a new hire.
            const seeded = ensureStaffCredentials();
            if (!seeded.ok) return sendJSON(res, 500, { error: seeded.error });

            const got = staffCredentialRow(login);
            if (!got.ok) return sendJSON(res, 500, { error: got.error });

            /* A missing row still costs a hash, so a wrong name and a wrong password
               take the same time to answer. Skipping the work for an unknown name
               would make the roster readable from the response time alone. */
            const row = got.row;
            const salt = row ? row.PasswordSalt : 'absent';
            const expect = row ? row.PasswordHash : hashPassword('no such account', 'absent');
            const ok = !!row && secretsMatch(hashPassword(password, salt), expect);
            if (!ok) return sendJSON(res, 401, { error: 'That name and password did not match' });

            runSQL(`UPDATE Staff SET LastLoginDate=${esc(new Date().toISOString())}`
                + ` WHERE Id=${parseInt(row.Id, 10)}`);

            return sendJSON(res, 200, {
                token: signSession(row.Id),
                staffId: String(row.Id),
                name: String(row.Name || ''),
                // The page uses this to insist on a new password before anything else.
                mustChangePassword: String(row.MustChangePassword) === '1'
            });
        });
    }

    /* POST a new password for the signed-in staff member.

       Requires the current password even though the token already proves who they
       are, so a borrowed screen cannot be used to lock the owner out of their own
       account. The director route is separate: a reset goes back to the enrolment
       code rather than to a password the director chooses and knows. */
    if (req.method === 'POST' && url === '/api/staff-password') {
        /* Resolved from the session token ALONE, deliberately ignoring any shared
           password on the same request.

           resolveActor() lets the shared password win when a browser carries both,
           which is right for reading — that is the director at their own desk and
           they expect to see everything. It is wrong here. This endpoint is about
           one person's own password, and a browser that has ever been signed in to
           the portal keeps cofpadmin in local storage, so a member of staff setting
           their first password on the office computer was told to "sign in as a
           staff member first" while being signed in as exactly that. */
        const tokenStaffId = readSession(req.headers['x-staff-token']);
        if (!tokenStaffId) {
            return sendJSON(res, 401, { error: 'Sign in as a staff member first' });
        }
        const actor = { director: false, staffId: tokenStaffId };
        return readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const current = String((d && d.current) || '');
            const next = String((d && d.next) || '');

            /* Length only. A rule demanding punctuation and digits pushes people to
               write the result on a sticky note, which is a worse outcome than a
               long simple phrase. Ten characters is the floor because the value it
               replaces is a first name plus a letter. */
            if (next.length < 10) {
                return sendJSON(res, 400, { error: 'Use at least 10 characters' });
            }

            const r = runSQLRows(
                `SELECT Id, ISNULL(Name,'') AS Name, ISNULL(LoginName,'') AS LoginName,
                        ISNULL(PasswordHash,'') AS PasswordHash,
                        ISNULL(PasswordSalt,'') AS PasswordSalt
                 FROM Staff WHERE Id=${parseInt(actor.staffId, 10)}`);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            const row = r.rows[0];
            if (!row) return sendJSON(res, 404, { error: 'Staff record not found' });

            if (!secretsMatch(hashPassword(current, row.PasswordSalt), row.PasswordHash)) {
                return sendJSON(res, 401, { error: 'That current password did not match' });
            }
            // Blocks setting it straight back to the value everyone can derive.
            if (next.trim().toLowerCase() === String(row.LoginName || '').trim().toLowerCase()) {
                return sendJSON(res, 400, {
                    error: 'That is your sign-in name, which your colleagues can guess. Pick something else.'
                });
            }

            const salt = newSalt();
            const w = runSQL(`UPDATE Staff SET PasswordHash=${esc(hashPassword(next, salt))},`
                + ` PasswordSalt=${esc(salt)}, MustChangePassword=0,`
                + ` PasswordSetDate=${esc(new Date().toISOString())}`
                + ` WHERE Id=${parseInt(actor.staffId, 10)}`);
            if (!w.ok) return sendJSON(res, 500, { error: w.error });
            return sendJSON(res, 200, { success: true });
        });
    }

    /* GET who the caller is, so a page can tell a staff member from the director
       without guessing. Deliberately thin: identity only, no record. */
    if (req.method === 'GET' && url === '/api/staff-whoami') {
        const actor = resolveActor(req);
        if (!actor) return sendJSON(res, 401, { error: 'Sign in first' });
        if (actor.director) return sendJSON(res, 200, { director: true });
        const r = runSQLRows(
            `SELECT Id, ISNULL(Name,'') AS Name, ISNULL(LoginName,'') AS LoginName,
                    ISNULL(CAST(MustChangePassword AS INT),1) AS MustChangePassword
             FROM Staff WHERE Id=${parseInt(actor.staffId, 10)}`);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const row = r.rows[0];
        if (!row) return sendJSON(res, 404, { error: 'Staff record not found' });
        return sendJSON(res, 200, {
            director: false,
            staffId: String(row.Id),
            name: String(row.Name || ''),
            loginName: String(row.LoginName || ''),
            mustChangePassword: String(row.MustChangePassword) === '1'
        });
    }

    /* POST reset a staff member back to their enrolment code. Director only.

       Resets to the derived code rather than to something the director invents, so
       nobody ends up knowing a colleague's standing password, and the reset lands
       the person back in the forced-change flow. */
    if (req.method === 'POST' && url === '/api/staff-password-reset') {
        if (!checkAuth(req, res)) return;
        return readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const staffId = parseInt((d && d.staffId) || 0, 10);
            if (!staffId) return sendJSON(res, 400, { error: 'Which staff member?' });
            const r = runSQLRows(
                `SELECT Id, ISNULL(Name,'') AS Name, ISNULL(LoginName,'') AS LoginName
                 FROM Staff WHERE Id=${staffId}`);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            const row = r.rows[0];
            if (!row) return sendJSON(res, 404, { error: 'Staff record not found' });
            const code = String(row.LoginName || '').trim() || enrolmentCode(row.Name);
            if (!code) return sendJSON(res, 400, { error: 'That record has no name to derive a code from' });
            const salt = newSalt();
            const w = runSQL(`UPDATE Staff SET LoginName=${esc(code)},`
                + ` PasswordHash=${esc(hashPassword(code, salt))}, PasswordSalt=${esc(salt)},`
                + ` MustChangePassword=1 WHERE Id=${staffId}`);
            if (!w.ok) return sendJSON(res, 500, { error: w.error });
            return sendJSON(res, 200, { success: true, loginName: code, password: code });
        });
    }

    // GET staff (internal - protected)
    // Ensure, seed-if-empty and select are separated by GO because the seed and
    // the select reference a table the first batch may have only just created;
    // SQL Server compiles a whole batch up front, so they cannot share one.
    if (req.method === 'GET' && url === '/api/staff') {
        /* Either caller may ask, and the answer is scoped to who they are: the
           director gets the roster, a staff member gets one row — their own.

           Scoping the existing endpoint rather than adding a personal one keeps a
           single definition of what a staff record is, and means the pages need no
           change: My Page reads an array either way, so for a staff member the
           chooser simply has nothing to choose. It also fails safe. A new endpoint
           would have left this one as it was, and this one is the one every page
           already calls. */
        const actor = requireActor(req, res);
        if (!actor) return;
        const select = ['Id'].concat(STAFF_COLUMNS.map(([c]) => c));
        /* JSON transport. Notes is the reason: the credential trail held there runs
           to several hundred characters per person, so the old read cut every one of
           them off at 256. That silently broke anything reading the tail of a note —
           including the PAS prefill, which scans Notes for "Pending: ECE, IT" to
           avoid ticking a credential that has not actually been awarded. */
        // Parsed to an integer and interpolated, so the scope cannot be widened by
        // anything a caller sends — the id comes from the signed token, not the URL.
        const scope = actor.director
            ? 'ISNULL(Active,1)=1'
            : `Id=${parseInt(actor.staffId, 10)}`;
        const r = runSQLRows(
            `SELECT ${select.join(',')},ISNULL(CAST(Active AS INT),1) AS Active
             FROM Staff WHERE ${scope} ORDER BY Name`,
            staffEnsureSQL() + 'GO\n' + staffSeedSQL() + 'GO\n');
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        // Strings throughout, as the pages expect; null becomes '' rather than "null".
        const rows = r.rows.map(row => {
            const o = {};
            select.concat(['Active']).forEach(k => {
                o[k] = row[k] === null || row[k] === undefined ? '' : String(row[k]);
            });
            return o;
        });
        return sendJSON(res, 200, rows);
    }

    // POST new staff member (internal - protected)
    if (req.method === 'POST' && url === '/api/staff') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            if (!String(d.name || '').trim()) return sendJSON(res, 400, { error: 'Name is required' });
            const cols = STAFF_COLUMNS.map(([c]) => c).join(',');
            const vals = STAFF_COLUMNS.map(([, key]) => esc(d[key])).join(',');
            const sql = staffEnsureSQL() + 'GO\n'
                + `INSERT INTO Staff (${cols}) VALUES (${vals});SELECT SCOPE_IDENTITY() AS Id`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // PUT update staff member. The director may edit anyone; a staff member may
    // edit their own record, and only the fields listed in STAFF_SELF_EDITABLE.
    if (req.method === 'PUT' && url.startsWith('/api/staff/')) {
        const actor = requireActor(req, res);
        if (!actor) return;
        const id = parseInt(url.split('/')[3]);
        if (!id) return sendJSON(res, 400, { error: 'Staff id required' });
        if (!actorMayTouch(actor, id)) {
            return sendJSON(res, 403, { error: 'You can only change your own record' });
        }
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            // Only update the fields actually supplied, so a partial save (for
            // example marking a record reviewed) cannot blank the rest.
            const supplied = STAFF_COLUMNS.filter(([, key]) => d[key] !== undefined);

            /* Refuse the whole request rather than quietly dropping the fields a
               staff member may not set. A partial save that silently ignores half
               of what was sent looks like it worked and is worse than an error. */
            if (!actor.director) {
                const refused = supplied
                    .filter(([, key]) => !STAFF_SELF_EDITABLE.has(key))
                    .map(([, key]) => key);
                if (refused.length) {
                    return sendJSON(res, 403, {
                        error: 'Only the director can change: ' + refused.join(', ')
                    });
                }
            }

            const sets = supplied.map(([c, key]) => `${c}=${esc(d[key])}`);
            if (!sets.length) return sendJSON(res, 400, { error: 'Nothing to update' });

            /* A staff member editing their own qualifications puts the record back
               to unreviewed. These figures feed the ExceleRate proportions and the
               PAS worksheets, and the record has carried ReviewedBy/ReviewedDate
               since the seed data was machine-extracted precisely so a human
               confirms before it backs a compliance claim. Self-reported data has
               the same standing, so it re-enters the same queue. */
            if (!actor.director) {
                sets.push('ReviewedBy=NULL', 'ReviewedDate=NULL');
            }

            const sql = staffEnsureSQL() + 'GO\n'
                + `UPDATE Staff SET ${sets.join(',')},UpdatedAt=GETDATE() WHERE Id=${id}`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true, reviewCleared: !actor.director });
        });
        return;
    }

    // DELETE staff member (internal - protected)
    // Soft delete: qualification history is compliance evidence, so the row stays
    // and is simply excluded from the active list.
    if (req.method === 'DELETE' && url.startsWith('/api/staff/')) {
        if (!checkAuth(req, res)) return;
        const id = parseInt(url.split('/')[3]);
        if (!id) return sendJSON(res, 400, { error: 'Staff id required' });
        const sql = staffEnsureSQL() + 'GO\n' + `UPDATE Staff SET Active=0,UpdatedAt=GETDATE() WHERE Id=${id}`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        return sendJSON(res, 200, { success: true });
    }

    /* ── Document library ──
       Indexes the monitoring evidence folder for a program and year, grouped by
       item number so folder renames do not matter. Nothing is copied or moved. */
        /* Reverse proxy for the document server.

       OnlyOffice listens on localhost, so the server can reach it but a browser
       on someone's laptop cannot. Rather than exposing another port to the
       internet, its own paths are mounted on this site: the editor script loads
       from childrenofpromisedaycare.com and the document server stays private.

       These prefixes are OnlyOffice's, taken from the paths its editor requests.
       They are mounted at the root because the editor asks for absolute paths —
       proxying under /office/ instead would mean rewriting every URL inside its
       JavaScript, which is brittle. None of these collide with our own routes;
       ours are all under /api/, /staff/, /pas/ or /public/. */
    if (ONLYOFFICE_ON && isOfficePath(url)) {
        const target = new URL(ONLYOFFICE_URL);
        const lib = target.protocol === 'https:' ? https : http;
        const headers = Object.assign({}, req.headers);

        /* Keep the ORIGINAL Host and pass the usual forwarding headers.

           Rewriting Host to localhost:8080 seemed tidier, but the document server
           builds absolute URLs from whatever Host it sees and hands them to the
           browser. That produced
               http://localhost:8080/cache/files/data/.../Editor.bin
           which a laptop cannot reach — the editor loaded and then failed with a
           connection error rather than an HTTP status.

           With the public host preserved, it builds URLs on this site, which come
           back through this proxy. */
        headers['x-forwarded-host'] = req.headers.host || '';
        headers['x-forwarded-proto'] = 'https';
        headers['x-forwarded-for'] = (req.socket && req.socket.remoteAddress) || '';
        delete headers['accept-encoding'];   // no need to re-encode on the way through

        /* Forward the path UNTOUCHED, version prefix included.

           An earlier version stripped the /9.4.0-<hash>/ prefix, because with
           nginx dead only docservice was answering and it serves /web-apps/...
           without the prefix. Once nginx was running that became actively wrong:
           the prefix is nginx's OWN cache-busting scheme, and it redirects
           unversioned paths back to versioned ones. Stripping therefore produced
           a redirect loop, which surfaced as the editor's service worker failing
           with net::ERR_FAILED on its asset JSON files.

           nginx understands the prefix. Leave it alone. */
        const upstreamPath = req.url;

        const upstream = lib.request({
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            method: req.method,
            path: upstreamPath,
            headers: headers,
            rejectUnauthorized: false        // a local instance may use a self-signed cert
        }, up => {
            res.writeHead(up.statusCode, up.headers);
            up.pipe(res);
        });
        upstream.on('error', e => {
            console.error('[OFFICE PROXY] ' + req.method + ' ' + url + ' -> ' + e.message);
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end('The document editor is not reachable');
            } else { res.destroy(); }
        });
        req.pipe(upstream);
        return;
    }

    /* Cheapest possible authenticated endpoint. The styled sign-in page uses it to
       ask "is this password correct?" instead of comparing against a copy held in
       the page — which is what let the password end up in the source in the first
       place. Returns 200 when accepted, 401 when not, and nothing sensitive. */
    if (req.method === 'GET' && url === '/api/whoami') {
        if (!checkAuth(req, res)) return;
        return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.startsWith('/api/doc-index')) {
        if (!checkAuth(req, res)) return;
        const qs = new URLSearchParams(req.url.split('?')[1] || '');
        const program = qs.get('program') === 'PFA' ? 'Preschool for All' : 'Birth to Three';
        const year = (qs.get('year') || '').replace(/[^0-9]/g, '') || '2026';
        const folder = qs.get('folder') || (program === 'Birth to Three'
            ? year + ' PI Monitoring Visit' : 'PFA Monitoring Visit ' + year);
        const idx = indexYearFolder(program, folder);

        // Checked-out state, so the list can show what has left the cabinet.
        const meta = {};
        const m = runSQL(docMetaEnsureSQL() + 'GO\n'
            + `SELECT ${txCol('RelPath')},${txCol('CheckedOutBy')},${txCol('CheckedOutDate')},${txCol('DueBackDate')},${txCol('Notes')} FROM DocumentMeta WHERE ISNULL(CheckedOutBy,'') <> '' OR ISNULL(Notes,'') <> ''`);
        if (m.ok) {
            m.data.trim().split('\n').filter(l => l.includes('|')).forEach(l => {
                const v = l.split('|').map(x => txDecode(x.trim()));
                if (v[0]) meta[v[0]] = { checkedOutBy: v[1], checkedOutDate: v[2], dueBack: v[3], notes: v[4] };
            });
        }
        return sendJSON(res, 200, {
            root: findDocRoot(), program, year, folder,
            // Reported so a wrong path is diagnosable from the page itself.
            rootCandidates: findDocRoot() ? undefined : DOC_ROOT_CANDIDATES.slice(0, 12),
            siblings: idx.siblings, noRoot: idx.noRoot,
            missing: idx.missing, items: idx.items,
            childFolder: idx.childFolder || null,
            childFileCount: (idx.childFiles || []).length,
            /* The files themselves, not just how many. documents.html has always told
               people to open per-child evidence "from the child's row on the roster",
               but the roster had no way to know what was in this folder. Sent in full
               so the roster can match a file to a child without a request per child;
               the folder holds tens of files, not thousands. */
            childFiles: idx.childFiles || [],
            staleCount: Object.values(idx.items).reduce((n, i) =>
                n + i.files.filter(f => f.stale).length, 0)
                + (idx.childFiles || []).filter(f => f.stale).length,
            meta
        });
    }

    /* Is Office editing available, and can this file be edited?
       The page asks before offering an Edit button, so a server without
       OnlyOffice simply never shows one. */
    if (req.method === 'GET' && url === '/api/office-status') {
        if (!checkAuth(req, res)) return;
        return sendJSON(res, 200, {
            enabled: ONLYOFFICE_ON,
            editable: Object.keys(OFFICE_EDITABLE),
            viewable: Object.keys(OFFICE_VIEWABLE),
            reason: ONLYOFFICE_ON ? null
                : 'COFP_ONLYOFFICE_URL and COFP_ONLYOFFICE_SECRET are not set on the server'
        });
    }

    /* Editor configuration for one document.

       Returns what the browser hands to OnlyOffice's script: where to fetch the
       file, where to send it back, and a signature over the whole config so the
       document server will not act on a config we did not produce. */
    if (req.method === 'GET' && url === '/api/office-config') {
        if (!checkAuth(req, res)) return;
        if (!ONLYOFFICE_ON) return sendJSON(res, 501, { error: 'Office editing is not configured on this server' });

        const rel = new URLSearchParams(req.url.split('?')[1] || '').get('path');
        const full = resolveDocPath(rel);
        if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
            return sendJSON(res, 404, { error: 'Not found' });
        }
        const ext = path.extname(full).toLowerCase();
        const docType = OFFICE_EDITABLE[ext] || OFFICE_VIEWABLE[ext];
        if (!docType) return sendJSON(res, 400, { error: 'That file type cannot be opened in the editor' });

        const key = officeIssueKey(rel);
        const stat = fs.statSync(full);
        /* OnlyOffice caches by document key, so it must change whenever the file
           changes — otherwise staff reopen a stale copy from its cache. Size and
           modified time give a key that moves with the content. */
        const docKey = crypto.createHash('sha1')
            .update(rel + '|' + stat.size + '|' + stat.mtimeMs).digest('hex').slice(0, 20);

        /* Where OnlyOffice should fetch from and post back to. Prefer an explicit
           COFP_SELF_URL — usually http://localhost — so the document server never
           has to leave the machine to read a file that is already on it. */
        const base = SELF_URL || ('https://' + (req.headers.host || 'childrenofpromisedaycare.com'));
        const config = {
            document: {
                fileType: ext.slice(1),
                key: docKey,
                title: path.basename(full),
                url: base + '/api/office-file?key=' + key,
                permissions: { edit: !!OFFICE_EDITABLE[ext], download: true, print: true }
            },
            documentType: docType,
            editorConfig: {
                // Saves land back in the library through this callback.
                callbackUrl: base + '/api/office-callback?key=' + key,
                lang: 'en-US',
                mode: OFFICE_EDITABLE[ext] ? 'edit' : 'view',
                user: { id: 'staff', name: 'Children of Promise staff' },
                customization: { forcesave: true, autosave: true, compactHeader: false }
            }
        };
        config.token = officeJwt(config);
        /* The browser loads the editor from THIS site, through the proxy above —
           an empty base means same-origin. The document server itself stays on
           localhost with no public port. COFP_ONLYOFFICE_PUBLIC overrides this if
           OnlyOffice is ever given its own hostname. */
        return sendJSON(res, 200, {
            url: process.env.COFP_ONLYOFFICE_PUBLIC || '',
            proxied: !process.env.COFP_ONLYOFFICE_PUBLIC,
            config: config
        });
    }

    /* The document server fetching a file. Authenticated by a one-time key
       rather than staff credentials, and scoped to the single file that key was
       issued for — so a leaked key cannot be used to browse the library. */
    if (req.method === 'GET' && url === '/api/office-file') {
        if (!ONLYOFFICE_ON) { res.writeHead(404); return res.end('Not found'); }
        const key = new URLSearchParams(req.url.split('?')[1] || '').get('key');
        const rel = officeResolveKey(key);
        if (!rel) { res.writeHead(403); return res.end('Forbidden'); }
        const full = resolveDocPath(rel);
        if (!full || !fs.existsSync(full)) { res.writeHead(404); return res.end('Not found'); }
        let buf;
        try { buf = fs.readFileSync(full); }
        catch (e) { res.writeHead(500); return res.end('Could not read'); }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
            'Content-Length': buf.length
        });
        return res.end(buf);
    }

    /* OnlyOffice reporting the outcome of an editing session.

       status 2 (ready to save) and 6 (force-save) carry a URL to the edited
       file, which we fetch and write back into the library. Anything else is
       informational.

       The previous version is kept alongside rather than replaced: this is
       compliance evidence, and an editing mistake must be recoverable. */
    if (req.method === 'POST' && url.startsWith('/api/office-callback')) {
        if (!ONLYOFFICE_ON) { res.writeHead(404); return res.end('Not found'); }
        const key = new URLSearchParams(req.url.split('?')[1] || '').get('key');
        const rel = officeResolveKey(key);
        if (!rel) return sendJSON(res, 403, { error: 1 });

        return readBody(req, (err, d) => {
            if (err) return sendJSON(res, 200, { error: 1 });

            // Reject anything not signed with the shared secret.
            if (d.token && !officeJwtVerify(d.token)) {
                console.warn('[OFFICE] callback with a bad signature, ignored');
                return sendJSON(res, 200, { error: 1 });
            }
            const status = Number(d.status);
            if (status !== 2 && status !== 6) return sendJSON(res, 200, { error: 0 });
            if (!d.url) return sendJSON(res, 200, { error: 0 });

            const full = resolveDocPath(rel);
            if (!full) return sendJSON(res, 200, { error: 1 });

            // Fetch the edited file from the document server and write it back.
            const lib = d.url.startsWith('https:') ? https : http;
            lib.get(d.url, r2 => {
                if (r2.statusCode !== 200) {
                    console.error('[OFFICE] could not fetch the edited file: HTTP ' + r2.statusCode);
                    r2.resume();
                    return sendJSON(res, 200, { error: 1 });
                }
                const chunks = [];
                r2.on('data', c => chunks.push(c));
                r2.on('end', () => {
                    const data = Buffer.concat(chunks);
                    if (!data.length) return sendJSON(res, 200, { error: 1 });
                    try {
                        // Keep the version being replaced, dated, next to it.
                        if (fs.existsSync(full)) {
                            const ext = path.extname(full);
                            const stem = full.slice(0, -ext.length);
                            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
                            fs.copyFileSync(full, stem + ' (before ' + stamp + ')' + ext);
                        }
                        fs.writeFileSync(full, data);
                        console.log('[OFFICE] saved ' + data.length + ' bytes -> ' + rel);
                        return sendJSON(res, 200, { error: 0 });
                    } catch (e) {
                        console.error('[OFFICE] save failed: ' + e.message);
                        return sendJSON(res, 200, { error: 1 });
                    }
                });
            }).on('error', e => {
                console.error('[OFFICE] fetch failed: ' + e.message);
                return sendJSON(res, 200, { error: 1 });
            });
        });
    }

    /* Checks a document IN — the other half of check-out.

       Takes a file from the browser and writes it into an item's evidence folder
       in the library, so a signed or scanned page gets back into the system
       without SharePoint. ?folder= is the item folder's path relative to
       DOC_ROOT, confined by resolveDocPath like everything else.

       Never overwrites. Compliance evidence must not be silently replaced — if a
       name is taken, the new file gets a dated suffix and both survive, so a
       mistaken upload can be undone by deleting rather than by recovering
       something that is already gone. */
    if (req.method === 'POST' && url.startsWith('/api/doc-upload')) {
        if (!checkAuth(req, res)) return;
        const qs = new URLSearchParams(req.url.split('?')[1] || '');
        const folderRel = qs.get('folder') || '';
        const folder = resolveDocPath(folderRel);
        if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
            return sendJSON(res, 400, { error: 'That folder is not in the library' });
        }

        const MAX = 40 * 1024 * 1024;   // a scanned multi-page PDF, generously
        let body = [], size = 0, aborted = false;
        req.on('data', chunk => {
            if (aborted) return;
            size += chunk.length;
            if (size > MAX) {
                aborted = true;
                sendJSON(res, 413, { error: 'File is larger than 40 MB' });
                req.destroy();
                return;
            }
            body.push(chunk);
        });
        req.on('end', () => {
            if (aborted) return;
            const ct = req.headers['content-type'] || '';
            const boundary = ct.split('boundary=')[1];
            if (!boundary) return sendJSON(res, 400, { error: 'Not a file upload' });

            const parts = Buffer.concat(body).toString('binary').split('--' + boundary);
            for (const part of parts) {
                if (!part.includes('filename=')) continue;
                const m = part.match(/filename="([^"]*)"/);
                if (!m || !m[1]) continue;

                /* Keep the name staff recognise, but strip anything that could
                   escape the folder: directory separators, traversal, null bytes
                   and leading dots. */
                let safe = path.basename(m[1].replace(/\0/g, ''))
                    .replace(/[\\/:*?"<>|]/g, '_')
                    .replace(/^\.+/, '')
                    .trim();
                if (!safe) safe = 'upload';

                const ext = path.extname(safe).toLowerCase();
                const ALLOWED = ['.pdf', '.png', '.jpg', '.jpeg', '.docx', '.xlsx', '.doc', '.xls', '.txt'];
                if (!ALLOWED.includes(ext)) {
                    return sendJSON(res, 400, { error: 'That file type is not accepted (' + (ext || 'no extension') + ')' });
                }

                const headerEnd = part.indexOf('\r\n\r\n');
                if (headerEnd < 0) continue;
                const data = Buffer.from(part.slice(headerEnd + 4, part.lastIndexOf('\r\n')), 'binary');
                if (!data.length) return sendJSON(res, 400, { error: 'That file was empty' });

                // Date suffix rather than overwrite, so nothing is ever replaced.
                let target = path.join(folder, safe);
                if (fs.existsSync(target)) {
                    const stem = path.basename(safe, ext);
                    const stamp = new Date().toISOString().slice(0, 10);
                    let n = 1;
                    do {
                        target = path.join(folder, stem + ' (' + stamp + (n > 1 ? ' ' + n : '') + ')' + ext);
                        n++;
                    } while (fs.existsSync(target) && n < 50);
                }

                try {
                    fs.writeFileSync(target, data);
                } catch (e) {
                    console.error('[DOC UPLOAD]', e.message);
                    return sendJSON(res, 500, { error: 'Could not save the file' });
                }
                const rel = path.relative(findDocRoot(), target).replace(/\\/g, '/');
                console.log('[DOC UPLOAD] ' + data.length + ' bytes -> ' + rel);
                return sendJSON(res, 200, {
                    success: true, name: path.basename(target), relPath: rel, bytes: data.length,
                    renamed: path.basename(target) !== safe
                });
            }
            sendJSON(res, 400, { error: 'No file found in the upload' });
        });
        return;
    }

    /* Serves one indexed file. The path is caller-supplied, so resolveDocPath
       confines it to DOC_ROOT; anything escaping is a flat 404 rather than an
       explanation. Requires the same login as the rest of the site — these are
       children's records and must never be reachable by URL alone. */
    if (req.method === 'GET' && url.startsWith('/api/doc-file')) {
        if (!checkAuth(req, res)) return;
        const rel = new URLSearchParams(req.url.split('?')[1] || '').get('path');
        const full = resolveDocPath(rel);
        if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
            res.writeHead(404); return res.end('Not found');
        }
        const ext = path.extname(full).toLowerCase();
        // The table is MIME, not MIME_TYPES. Referencing the wrong name threw a
        // ReferenceError here before any response was written, so every request
        // for a document that existed hung the browser indefinitely while the
        // 404 path — which never reached this line — worked perfectly.
        const mime = MIME[ext] || 'application/octet-stream';
        // Attachment for anything not safely previewable, so nothing renders inline
        // that could carry script.
        const inline = ['.pdf', '.png', '.jpg', '.jpeg', '.txt'].includes(ext);
        /* Read fully, then send in one write — deliberately NOT a stream.

           createReadStream().pipe(res) never completes against this server's
           HTTPS response: the request hangs with no response at all and no error
           raised, so an error handler cannot catch it. Verified against the live
           site — doc-index (10 KB) and the ISBE page itself (185 KB) both return
           promptly because they read and send in one go, while any streamed file
           times out regardless of type or size.

           Buffering is fine here: the largest document in the library is a few
           megabytes, and correctness beats memory efficiency for a handful of
           compliance PDFs. */
        let buf;
        try {
            buf = fs.readFileSync(full);
        } catch (err) {
            console.log('[DOC ERROR] ' + rel + ' -> ' + err.message);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            return res.end('Could not read that document');
        }
        res.writeHead(200, {
            'Content-Type': mime,
            // Lets the browser tell a finished response from a stalled one.
            'Content-Length': buf.length,
            'Content-Disposition': (inline ? 'inline' : 'attachment')
                + '; filename="' + path.basename(full).replace(/"/g, '') + '"',
            'X-Content-Type-Options': 'nosniff'
        });
        return res.end(buf);
    }

    /* Archives one evidence file.

       MOVES it into an _Archive folder beside the item folder it came from. It never
       deletes and never overwrites: if the name is taken in the archive, the incoming
       copy gets a dated suffix, so a mistake is undone by moving the file back rather
       than by recovering something that is already gone.

       The original folder name is preserved inside the archive, because "which item
       was this evidence for" is the question anyone looking in there will have. */
    if (req.method === 'POST' && url === '/api/doc-archive') {
        if (!checkAuth(req, res)) return;
        return readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const rel = String(d.relPath || '').trim();
            if (!rel) return sendJSON(res, 400, { error: 'relPath required' });

            const full = resolveDocPath(rel);
            if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
                return sendJSON(res, 404, { error: 'That file is not in the library' });
            }
            const root = findDocRoot();
            if (!root) return sendJSON(res, 500, { error: 'The document library is not reachable' });

            const plan = archiveTargetFor(rel);
            if (plan.error) return sendJSON(res, 400, { error: plan.error });
            const archiveDir = resolveDocPath(plan.archiveRel);
            if (!archiveDir) return sendJSON(res, 400, { error: 'Could not place that file in the archive' });

            try {
                fs.mkdirSync(archiveDir, { recursive: true });
                const base = path.basename(full);
                let target = path.join(archiveDir, base);
                if (fs.existsSync(target)) {
                    const ext = path.extname(base);
                    const stem = base.slice(0, base.length - ext.length);
                    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
                    target = path.join(archiveDir, stem + ' (archived ' + stamp + ')' + ext);
                }
                /* rename first: it is atomic on the same volume. Falls back to
                   copy-then-unlink only if the archive somehow lands elsewhere, and
                   the copy is verified before the original is removed. */
                try {
                    fs.renameSync(full, target);
                } catch (e) {
                    fs.copyFileSync(full, target);
                    if (!fs.existsSync(target) || fs.statSync(target).size !== fs.statSync(full).size) {
                        return sendJSON(res, 500, { error: 'Copy into the archive did not verify; nothing was removed' });
                    }
                    fs.unlinkSync(full);
                }
                const newRel = path.relative(path.resolve(root), target).replace(/\\/g, '/');
                console.log('[ARCHIVE] ' + rel + '  ->  ' + newRel);
                return sendJSON(res, 200, { success: true, archivedTo: newRel });
            } catch (e) {
                console.error('[ARCHIVE] failed for ' + rel + ': ' + e.message);
                return sendJSON(res, 500, { error: 'Could not archive that file: ' + e.message });
            }
        });
    }

    // Check a file out or back in. Sending a blank name checks it back in.
    if (req.method === 'POST' && url === '/api/doc-checkout') {
        if (!checkAuth(req, res)) return;
        return readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const rel = String(d.relPath || '').trim();
            if (!rel) return sendJSON(res, 400, { error: 'relPath required' });
            if (!resolveDocPath(rel)) return sendJSON(res, 400, { error: 'Path outside the library' });
            const by = String(d.checkedOutBy || '').trim();
            const sql = docMetaEnsureSQL() + 'GO\n'
                + `IF EXISTS (SELECT 1 FROM DocumentMeta WHERE RelPath=${esc(rel)})
    UPDATE DocumentMeta SET CheckedOutBy=${esc(by)},CheckedOutDate=${esc(d.checkedOutDate)},DueBackDate=${esc(d.dueBackDate)},Notes=${esc(d.notes)},UpdatedAt=GETDATE() WHERE RelPath=${esc(rel)}
ELSE
    INSERT INTO DocumentMeta (RelPath,ItemNumber,SchoolYear,Owner,CheckedOutBy,CheckedOutDate,DueBackDate,Notes)
    VALUES (${esc(rel)},${esc(d.itemNumber)},${esc(d.schoolYear)},${esc(d.owner)},${esc(by)},${esc(d.checkedOutDate)},${esc(d.dueBackDate)},${esc(d.notes)})`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            return sendJSON(res, 200, { success: true, checkedOut: !!by });
        });
    }

    /* ── Staff development plans (PICC PI9) ──
       Returns every plan and goal, current and superseded, so the page can show
       history. The caller picks the current one; the server does not hide the
       older versions, because they are the evidence of timelines PI9 asks for. */
    if (req.method === 'GET' && url === '/api/dev-plans') {
        const actor = requireActor(req, res);
        if (!actor) return;
        const pCols = ['Id'].concat(DEVPLAN_COLUMNS.map(([c]) => c));
        const gCols = ['Id'].concat(DEVGOAL_COLUMNS.map(([c]) => c));
        const r = runSQL(staffDevPlanEnsureSQL() + 'GO\n'
            + `SELECT ${pCols.map(c => /^(Id|StaffId)$/.test(c) ? c : txCol(c)).join(',')} FROM StaffDevelopmentPlan ORDER BY StaffId, PlanDate DESC, Id DESC`);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const plans = r.data.trim().split('\n').filter(l => /^\s*\d+\s*\|/.test(l)).map(l => {
            const v = l.split('|').map(x => x.trim());
            const o = {};
            pCols.forEach((c, i) => { o[c] = /^(Id|StaffId)$/.test(c) ? v[i] : txDecode(v[i]); });
            return o;
        });
        const g = runSQL(staffDevPlanEnsureSQL() + 'GO\n'
            + `SELECT ${gCols.map(c => /^(Id|PlanId|SortOrder)$/.test(c) ? c : txCol(c)).join(',')} FROM StaffDevelopmentGoal ORDER BY PlanId, SortOrder, Id`);
        const goals = (!g.ok ? [] : g.data.trim().split('\n').filter(l => /^\s*\d+\s*\|/.test(l)).map(l => {
            const v = l.split('|').map(x => x.trim());
            const o = {};
            gCols.forEach((c, i) => { o[c] = /^(Id|PlanId|SortOrder)$/.test(c) ? v[i] : txDecode(v[i]); });
            return o;
        }));

        /* A staff member sees their own plans and the goals hanging off them, and
           nothing else. Goals are filtered by the surviving plan ids rather than by
           staff id, because a goal records only which plan it belongs to — filtering
           them independently would either leak a colleague's goals or orphan the
           person's own. Superseded versions of their own plan are kept: the dated
           history is what PI9 asks for, and it is their history. */
        if (!actor.director) {
            const mine = parseInt(actor.staffId, 10);
            const myPlans = plans.filter(p => parseInt(p.StaffId, 10) === mine);
            const myPlanIds = new Set(myPlans.map(p => String(p.Id)));
            return sendJSON(res, 200, {
                plans: myPlans,
                goals: goals.filter(x => myPlanIds.has(String(x.PlanId)))
            });
        }
        return sendJSON(res, 200, { plans, goals });
    }

    // POST a new plan. Any existing active plan for that person is superseded
    // rather than deleted, so the dated history survives.
    if (req.method === 'POST' && url === '/api/dev-plans') {
        const actor = requireActor(req, res);
        if (!actor) return;
        return readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const staffId = parseInt(d.staffId);
            if (!staffId) return sendJSON(res, 400, { error: 'staffId required' });
            // Writing a plan for somebody else would also supersede their current
            // one, so this refuses rather than quietly filing it under the caller.
            if (!actorMayTouch(actor, staffId)) {
                return sendJSON(res, 403, { error: 'You can only write your own plan' });
            }
            const cols = DEVPLAN_COLUMNS.map(([c]) => c).join(',');
            const vals = DEVPLAN_COLUMNS.map(([c, key]) =>
                c === 'StaffId' ? staffId
                : c === 'Status' ? esc(d.status || 'Active')
                : esc(d[key])).join(',');
            /* One plan per person per program year. The mid-year and year-end
               reviews are sections ON that plan, not separate records, so
               superseding is scoped to the year alone. Re-issuing a plan for the
               same year replaces it and keeps the old copy as history. */
            const sameCycle = `StaffId=${staffId} AND ISNULL(Status,'Active')='Active'`
                + ` AND ISNULL(SchoolYear,'')=${esc(d.schoolYear || '')}`;
            const sql = staffDevPlanEnsureSQL() + 'GO\n'
                + `UPDATE StaffDevelopmentPlan SET Status='Superseded',UpdatedAt=GETDATE() WHERE ${sameCycle};\n`
                /* Tag the identity so it can be found unambiguously. A bare
                   SELECT SCOPE_IDENTITY() gets lost among sqlcmd's row-count
                   messages, and matching the first number in the output returned
                   0 — which silently detached every goal from its plan. */
                + `INSERT INTO StaffDevelopmentPlan (${cols}) VALUES (${vals});`
                + `SELECT 'NEWID=' + CAST(SCOPE_IDENTITY() AS VARCHAR(20))`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            const m = (r.data || '').match(/NEWID=(\d+)/);
            return sendJSON(res, 200, { success: true, id: m ? m[1] : null });
        });
    }

    // PUT edits a plan in place, for correcting the current one without
    // generating a spurious new version.
    if (req.method === 'PUT' && url.startsWith('/api/dev-plans/')) {
        const actor = requireActor(req, res);
        if (!actor) return;
        const id = parseInt(url.split('/')[3]);
        if (!id) return sendJSON(res, 400, { error: 'Plan id required' });
        if (!actor.director) {
            const owner = devPlanStaffId(id);
            if (!owner.ok) return sendJSON(res, 500, { error: owner.error });
            if (!actorMayTouch(actor, owner.staffId)) {
                return sendJSON(res, 403, { error: 'That plan is not yours' });
            }
        }
        return readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const sets = DEVPLAN_COLUMNS.filter(([, key]) => d[key] !== undefined)
                .map(([c, key]) => `${c}=${esc(d[key])}`);
            if (!sets.length) return sendJSON(res, 400, { error: 'Nothing to update' });
            const r = runSQL(staffDevPlanEnsureSQL() + 'GO\n'
                + `UPDATE StaffDevelopmentPlan SET ${sets.join(',')},UpdatedAt=GETDATE() WHERE Id=${id}`);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            return sendJSON(res, 200, { success: true });
        });
    }

    // Goals: upsert by id, or insert when no id is supplied.
    if (req.method === 'POST' && url === '/api/dev-goals') {
        const actor = requireActor(req, res);
        if (!actor) return;
        return readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const id = parseInt(d.id);

            /* Ownership is followed through the plan, because a goal names only its
               plan. Checked for both shapes of this request: editing an existing
               goal is reached through the goal, adding a new one through the plan it
               is being added to. Missing the second would leave a staff member able
               to append goals to a colleague's plan. */
            if (!actor.director) {
                const owner = id ? devGoalStaffId(id) : devPlanStaffId(d.planId);
                if (!owner.ok) return sendJSON(res, 500, { error: owner.error });
                if (!actorMayTouch(actor, owner.staffId)) {
                    return sendJSON(res, 403, { error: 'That plan is not yours' });
                }
            }

            let sql;
            if (id) {
                const sets = DEVGOAL_COLUMNS.filter(([, key]) => d[key] !== undefined)
                    .map(([c, key]) => c === 'SortOrder' || c === 'PlanId'
                        ? `${c}=${parseInt(d[key]) || 0}` : `${c}=${esc(d[key])}`);
                if (!sets.length) return sendJSON(res, 400, { error: 'Nothing to update' });
                sql = `UPDATE StaffDevelopmentGoal SET ${sets.join(',')},UpdatedAt=GETDATE() WHERE Id=${id}`;
            } else {
                const planId = parseInt(d.planId);
                if (!planId) return sendJSON(res, 400, { error: 'planId required' });
                const cols = DEVGOAL_COLUMNS.map(([c]) => c).join(',');
                const vals = DEVGOAL_COLUMNS.map(([c, key]) =>
                    c === 'PlanId' ? planId
                    : c === 'SortOrder' ? (parseInt(d.sortOrder) || 0)
                    : esc(d[key])).join(',');
                sql = `INSERT INTO StaffDevelopmentGoal (${cols}) VALUES (${vals});`
                    + `SELECT 'NEWID=' + CAST(SCOPE_IDENTITY() AS VARCHAR(20))`;
            }
            const r = runSQL(staffDevPlanEnsureSQL() + 'GO\n' + sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            const m = (r.data || '').match(/NEWID=(\d+)/);
            return sendJSON(res, 200, { success: true, id: id || (m ? m[1] : null) });
        });
    }

    if (req.method === 'DELETE' && url.startsWith('/api/dev-goals/')) {
        const actor = requireActor(req, res);
        if (!actor) return;
        const id = parseInt(url.split('/')[3]);
        if (!id) return sendJSON(res, 400, { error: 'Goal id required' });
        if (!actor.director) {
            const owner = devGoalStaffId(id);
            if (!owner.ok) return sendJSON(res, 500, { error: owner.error });
            if (!actorMayTouch(actor, owner.staffId)) {
                return sendJSON(res, 403, { error: 'That plan is not yours' });
            }
        }
        const r = runSQL(staffDevPlanEnsureSQL() + 'GO\n'
            + `DELETE FROM StaffDevelopmentGoal WHERE Id=${id}`);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        return sendJSON(res, 200, { success: true });
    }

    // GET all staff training records (internal - protected)
    if (req.method === 'GET' && url === '/api/staff-training') {
        if (!checkAuth(req, res)) return;
        const sql = staffTrainingEnsureSQL() + 'GO\n'
            + `SELECT Id,StaffId,${txCol('TrainingKey')},${txCol('CompletedDate')},${txCol('EvidenceLink')},${txCol('Notes')} FROM StaffTraining`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => /^\s*\d+\s*\|/.test(l))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return {
                    Id: v[0], StaffId: v[1], TrainingKey: txDecode(v[2]),
                    CompletedDate: txDecode(v[3]), EvidenceLink: txDecode(v[4]), Notes: txDecode(v[5])
                };
            });
        return sendJSON(res, 200, rows);
    }

    // POST record or clear a staff training (internal - protected)
    // Upserts on (StaffId, TrainingKey). Sending an empty completion with no
    // evidence or notes removes the row, which is how a checkbox un-tick arrives.
    if (req.method === 'POST' && url === '/api/staff-training') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const staffId = parseInt(d.staffId);
            const key = String(d.trainingKey || '').trim();
            if (!staffId || !key) return sendJSON(res, 400, { error: 'staffId and trainingKey are required' });

            const date = String(d.completedDate || '').trim();
            const link = String(d.evidenceLink || '').trim();
            const notes = String(d.notes || '').trim();
            const isEmpty = !date && !link && !notes;

            const where = `StaffId=${staffId} AND TrainingKey=${esc(key)}`;
            const sql = staffTrainingEnsureSQL() + 'GO\n' + (isEmpty
                ? `DELETE FROM StaffTraining WHERE ${where}`
                : `IF EXISTS (SELECT 1 FROM StaffTraining WHERE ${where})
    UPDATE StaffTraining SET CompletedDate=${esc(date)},EvidenceLink=${esc(link)},Notes=${esc(notes)},UpdatedAt=GETDATE() WHERE ${where}
ELSE
    INSERT INTO StaffTraining (StaffId,TrainingKey,CompletedDate,EvidenceLink,Notes) VALUES (${staffId},${esc(key)},${esc(date)},${esc(link)},${esc(notes)})`);
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true, cleared: isEmpty });
        });
        return;
    }

    // GET Silver self-assessment records (internal - protected)
    if (req.method === 'GET' && url === '/api/silver-assessments') {
        if (!checkAuth(req, res)) return;
        const sql = silverAssessmentEnsureSQL() + 'GO\n'
            + `SELECT Id,${txCol('RoomNumber')},${txCol('Instrument')},${txCol('CompletedDate')},${txCol('UploadedDate')},${txCol('EvidenceLink')},${txCol('Notes')} FROM SilverSelfAssessments`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => /^\s*\d+\s*\|/.test(l))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return {
                    Id: v[0], RoomNumber: txDecode(v[1]), Instrument: txDecode(v[2]),
                    CompletedDate: txDecode(v[3]), UploadedDate: txDecode(v[4]),
                    EvidenceLink: txDecode(v[5]), Notes: txDecode(v[6])
                };
            });
        return sendJSON(res, 200, rows);
    }

    // POST record or clear a Silver self-assessment (internal - protected)
    if (req.method === 'POST' && url === '/api/silver-assessments') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const room = String(d.roomNumber || '').trim();
            const instrument = String(d.instrument || '').trim();
            if (!room || !instrument) return sendJSON(res, 400, { error: 'roomNumber and instrument are required' });

            const completed = String(d.completedDate || '').trim();
            const uploaded = String(d.uploadedDate || '').trim();
            const link = String(d.evidenceLink || '').trim();
            const notes = String(d.notes || '').trim();
            const isEmpty = !completed && !uploaded && !link && !notes;

            const where = `RoomNumber=${esc(room)} AND Instrument=${esc(instrument)}`;
            const sql = silverAssessmentEnsureSQL() + 'GO\n' + (isEmpty
                ? `DELETE FROM SilverSelfAssessments WHERE ${where}`
                : `IF EXISTS (SELECT 1 FROM SilverSelfAssessments WHERE ${where})
    UPDATE SilverSelfAssessments SET CompletedDate=${esc(completed)},UploadedDate=${esc(uploaded)},EvidenceLink=${esc(link)},Notes=${esc(notes)},UpdatedAt=GETDATE() WHERE ${where}
ELSE
    INSERT INTO SilverSelfAssessments (RoomNumber,Instrument,CompletedDate,UploadedDate,EvidenceLink,Notes) VALUES (${esc(room)},${esc(instrument)},${esc(completed)},${esc(uploaded)},${esc(link)},${esc(notes)})`);
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true, cleared: isEmpty });
        });
        return;
    }

    // GET PAS worksheet answers (internal - protected)
    // Returns every saved worksheet. The pages need the full set anyway to show
    // which classrooms have been completed, and the row count is small.
    if (req.method === 'GET' && url === '/api/pas-worksheets') {
        const actor = requireActor(req, res);
        if (!actor) return;
        /* Read through the JSON transport. A worksheet payload is comfortably over
           256 characters — the teaching staff sheet alone carries about twenty
           fields per person for four people — so under the old pipe-delimited read
           every payload came back truncated, failed to parse, and was served as {}.
           Saving worked; loading returned an empty sheet, on every machine
           including the one that typed it. */
        const r = runSQLRows(
            `SELECT Id, WorksheetKey, ScopeKey, Payload, UpdatedBy,
                    CONVERT(NVARCHAR(20), UpdatedAt, 120) AS UpdatedAt
             FROM PasWorksheets`,
            pasWorksheetEnsureSQL() + 'GO\n');
        if (!r.ok) return sendJSON(res, 500, { error: r.error });

        /* A staff member receives only the worksheets that are about them: their
           self-appraisal, their 90-day review, their observation. The programme
           worksheets and the classroom sheets are the director's, and a colleague's
           appraisal is nobody else's business at all.

           Filtered here rather than in the WHERE clause because the scope is parsed
           rather than matched — "staff7" must not also mean "staff71" — and because
           the chunked JSON read above is the one thing on this endpoint that has
           already broken once. Nothing filtered out leaves the server. */
        const visible = actor.director
            ? r.rows
            : r.rows.filter(row => pasScopeStaffId(row.ScopeKey) === parseInt(actor.staffId, 10));

        const rows = visible.map(row => {
            let payload = {};
            // Keep a single unparseable row from emptying the whole worksheet set,
            // but say so rather than passing off {} as the saved answers.
            let bad = false;
            try { payload = row.Payload ? JSON.parse(row.Payload) : {}; }
            catch (e) { bad = true; }
            return {
                Id: String(row.Id), WorksheetKey: row.WorksheetKey || '',
                ScopeKey: row.ScopeKey || '', Payload: payload,
                UpdatedBy: row.UpdatedBy || '', UpdatedAt: row.UpdatedAt || '',
                unreadable: bad || undefined
            };
        });
        return sendJSON(res, 200, rows);
    }

    // POST save or clear one PAS worksheet (internal - protected)
    // An empty payload deletes the row, which is what the pages' "clear" action
    // means; that keeps "no row" as the single meaning of not started.
    if (req.method === 'POST' && url === '/api/pas-worksheets') {
        const actor = requireActor(req, res);
        if (!actor) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const worksheet = String(d.worksheet || '').trim();
            if (!worksheet || worksheet.length > 60) return sendJSON(res, 400, { error: 'worksheet key required, max 60 chars' });
            const scope = String(d.scope || '').trim().slice(0, 60);

            /* A staff member may only write a worksheet scoped to themselves. That
               rules out the programme worksheets and the classroom sheets, which
               have no person in their scope, as well as anything belonging to a
               colleague.

               Worth being explicit about the empty scope: a blank one is the PAS
               self-assessment for the whole centre, so without this check a staff
               member saving their own appraisal under a mistyped key could
               overwrite the submission the centre is assessed on. */
            if (!actor.director
                && pasScopeStaffId(scope) !== parseInt(actor.staffId, 10)) {
                return sendJSON(res, 403, {
                    error: 'You can only save your own forms. This one belongs to the centre '
                         + 'or to someone else, so Megan needs to fill it in.'
                });
            }

            const payloadObj = d.payload && typeof d.payload === 'object' ? d.payload : null;
            const hasAnswers = payloadObj && Object.keys(payloadObj).some(k => {
                const v = payloadObj[k];
                return v !== '' && v !== false && v !== null && v !== undefined;
            });
            const where = `WorksheetKey=${esc(worksheet)} AND ScopeKey=${esc(scope)}`;

            if (!hasAnswers) {
                const r0 = runSQL(pasWorksheetEnsureSQL() + 'GO\n' + `DELETE FROM PasWorksheets WHERE ${where}`);
                if (!r0.ok) return sendJSON(res, 500, { error: r0.error });
                return sendJSON(res, 200, { success: true, cleared: true });
            }

            const payload = JSON.stringify(payloadObj);
            const by = String(d.updatedBy || '').trim();
            const sql = pasWorksheetEnsureSQL() + 'GO\n'
                + `IF EXISTS (SELECT 1 FROM PasWorksheets WHERE ${where})
    UPDATE PasWorksheets SET Payload=${esc(payload)},UpdatedBy=${esc(by)},UpdatedAt=GETDATE() WHERE ${where}
ELSE
    INSERT INTO PasWorksheets (WorksheetKey,ScopeKey,Payload,UpdatedBy) VALUES (${esc(worksheet)},${esc(scope)},${esc(payload)},${esc(by)})`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // GET site-level settings (internal - protected)
    // Facts that span school years live here rather than in ProgramCompliance,
    // which is keyed per year. First use is the DCFS license.
    if (req.method === 'GET' && url === '/api/site-settings') {
        if (!checkAuth(req, res)) return;
        const sql = siteSettingsEnsureSQL()
            + `SELECT SettingKey,${txCol('SettingValue')} FROM SiteSettings`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const data = {};
        r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .forEach(l => {
                const i = l.indexOf('|');
                if (i === -1) return;
                const k = l.slice(0, i).trim();
                if (k) data[k] = txDecode(l.slice(i + 1).trim());
            });
        return sendJSON(res, 200, data);
    }

    // POST save one site-level setting (internal - protected)
    if (req.method === 'POST' && url === '/api/site-settings') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const key = String(d.key || '').trim();
            if (!key || key.length > 60) return sendJSON(res, 400, { error: 'Key required, max 60 chars' });
            const sql = siteSettingsEnsureSQL()
                + `IF EXISTS (SELECT 1 FROM SiteSettings WHERE SettingKey=${esc(key)})
    UPDATE SiteSettings SET SettingValue=${esc(String(d.value == null ? '' : d.value))},UpdatedAt=GETDATE() WHERE SettingKey=${esc(key)}
ELSE
    INSERT INTO SiteSettings (SettingKey,SettingValue) VALUES (${esc(key)},${esc(String(d.value == null ? '' : d.value))})`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // POST save program compliance field (internal - protected)
    if (req.method === 'POST' && url === '/api/compliance') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const { year, field, value } = d;
            if (!year || !field) return sendJSON(res, 400, { error: 'Year and field required' });
            // A key longer than the column would be silently truncated and could then
            // collide with another item's key under the unique constraint.
            if (String(field).length > COMPLIANCE_FIELD_NAME_MAX) {
                return sendJSON(res, 400, { error: 'Field name exceeds ' + COMPLIANCE_FIELD_NAME_MAX + ' characters' });
            }
            const sql = complianceEnsureSQL()
                + `IF EXISTS (SELECT 1 FROM ProgramCompliance WHERE SchoolYear=${esc(year)} AND FieldName=${esc(field)})
                    UPDATE ProgramCompliance SET FieldValue=${esc(String(value))},UpdatedAt=GETDATE() WHERE SchoolYear=${esc(year)} AND FieldName=${esc(field)}
                ELSE
                    INSERT INTO ProgramCompliance (SchoolYear,FieldName,FieldValue) VALUES (${esc(year)},${esc(field)},${esc(String(value))})`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // PUT ISBE tracking field (internal - protected)
    if (req.method === 'PUT' && url === '/api/isbe-tracking') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const { studentId, field, value } = d;
            // Whitelist is the schema list itself, so a new checklist column is
            // writable as soon as it is declared (and never writable if it isn't).
            if (!ISBE_TRACKING_COLUMNS.includes(field)) return sendJSON(res, 400, { error: 'Invalid field' });
            const year = resolveSchoolYear(d.year);
            const sql = isbeTrackingEnsureSQL()
                + `IF EXISTS (SELECT 1 FROM ISBETracking WHERE StudentId=${parseInt(studentId)} AND SchoolYear=${esc(year)})
                UPDATE ISBETracking SET ${field}=${value?1:0} WHERE StudentId=${parseInt(studentId)} AND SchoolYear=${esc(year)}
            ELSE
                INSERT INTO ISBETracking (StudentId,SchoolYear,${field}) VALUES (${parseInt(studentId)},${esc(year)},${value?1:0})`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // POST recalculate all F/R/P values (internal - protected)
    if (req.method === 'POST' && url === '/api/recalculate-frp') {
        if (!checkAuth(req, res)) return;
        // Auto-select thresholds based on current date (effective July 1 each year)
        const now = new Date();
        const usdaYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
        const guidelines = {
            2025: { free: [20163,27339,34515,41691,48867,56043,63219,70395], reduced: [28694,38907,49120,59333,69546,79759,89972,100185] },
            2026: { free: [20748,28132,35516,42900,50284,57668,65052,72436], reduced: [29526,40034,50542,61050,71558,82066,92574,103082] },
        };
        const g = guidelines[usdaYear] || guidelines[2026];
        const f = g.free;
        const r2 = g.reduced;
        console.log(`[FRP] Using ${usdaYear}-${usdaYear+1} thresholds`);
        const sql = `UPDATE rptMasterEnrollment SET F_R_P_Food = 
            CASE 
                WHEN ISNULL(PublicBenefits,'') <> '' THEN 'Free'
                WHEN Category = 'Foster' THEN 'Free'
                WHEN Military = 'Yes' OR Military = 'YES' THEN 'Free'
                WHEN PFA_PI_na = 'PFA' THEN 'Free'
                WHEN ISNULL(HouseholdIncome,100000) <= CASE ISNULL(HouseholdSize,1) WHEN 1 THEN ${f[0]} WHEN 2 THEN ${f[1]} WHEN 3 THEN ${f[2]} WHEN 4 THEN ${f[3]} WHEN 5 THEN ${f[4]} WHEN 6 THEN ${f[5]} WHEN 7 THEN ${f[6]} ELSE ${f[7]} END THEN 'Free'
                WHEN ISNULL(HouseholdIncome,100000) <= CASE ISNULL(HouseholdSize,1) WHEN 1 THEN ${r2[0]} WHEN 2 THEN ${r2[1]} WHEN 3 THEN ${r2[2]} WHEN 4 THEN ${r2[3]} WHEN 5 THEN ${r2[4]} WHEN 6 THEN ${r2[5]} WHEN 7 THEN ${r2[6]} ELSE ${r2[7]} END THEN 'Reduced'
                ELSE 'Paid'
            END
            WHERE Active = 'Yes' OR Active = 'YES'`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        sendJSON(res, 200, { success: true, message: `All F/R/P values recalculated using ${usdaYear}-${usdaYear+1} thresholds` });
        return;
    }

    // GET management reports (internal - protected)
    if (req.method === 'GET' && url === '/api/reports') {
        if (!checkAuth(req, res)) return;
        const queries = {
            byRoom:        `SELECT r.Room, COUNT(*) AS Total, SUM(CASE WHEN e.Active='Yes' OR e.Active='YES' THEN 1 ELSE 0 END) AS Active FROM rptMasterEnrollment e LEFT JOIN dimClassrooms r ON e.RoomNumber=r.RoomNumber GROUP BY r.Room ORDER BY r.Room`,
            byRoomDaily:   `SELECT r.Room, r.DCFSCapacity, SUM(CASE WHEN e.Monday=1 AND (e.Active='Yes' OR e.Active='YES') THEN 1 ELSE 0 END) AS Mon, SUM(CASE WHEN e.Tuesday=1 AND (e.Active='Yes' OR e.Active='YES') THEN 1 ELSE 0 END) AS Tue, SUM(CASE WHEN e.Wednesday=1 AND (e.Active='Yes' OR e.Active='YES') THEN 1 ELSE 0 END) AS Wed, SUM(CASE WHEN e.Thursday=1 AND (e.Active='Yes' OR e.Active='YES') THEN 1 ELSE 0 END) AS Thu, SUM(CASE WHEN e.Friday=1 AND (e.Active='Yes' OR e.Active='YES') THEN 1 ELSE 0 END) AS Fri FROM rptMasterEnrollment e LEFT JOIN dimClassrooms r ON e.RoomNumber=r.RoomNumber WHERE e.Active='Yes' OR e.Active='YES' GROUP BY r.Room, r.DCFSCapacity, r.RoomNumber ORDER BY r.RoomNumber`,
            byProgram:     `SELECT ISNULL(PFA_PI_na,'Unknown') AS ProgramType, COUNT(*) AS Total FROM rptMasterEnrollment WHERE Active='Yes' OR Active='YES' GROUP BY PFA_PI_na`,
            byFood:        `SELECT ISNULL(F_R_P_Food,'Unknown') AS FoodProgram, COUNT(*) AS Total FROM rptMasterEnrollment WHERE Active='Yes' OR Active='YES' GROUP BY F_R_P_Food`,
            byPayType:     `SELECT ISNULL(Category,'Unknown') AS PayType, COUNT(*) AS Total FROM rptMasterEnrollment WHERE Active='Yes' OR Active='YES' GROUP BY Category`,
            benefits:      `SELECT SUM(CASE WHEN PublicBenefits LIKE '%WIC%' THEN 1 ELSE 0 END) AS WIC, SUM(CASE WHEN PublicBenefits LIKE '%Medicaid%' THEN 1 ELSE 0 END) AS Medicaid, SUM(CASE WHEN PublicBenefits LIKE '%SNAP%' THEN 1 ELSE 0 END) AS SNAP, SUM(CASE WHEN PublicBenefits LIKE '%TANF%' THEN 1 ELSE 0 END) AS TANF, SUM(CASE WHEN PublicBenefits LIKE '%CCAP%' THEN 1 ELSE 0 END) AS CCAP FROM rptMasterEnrollment WHERE Active='Yes' OR Active='YES'`,
            incomeProof:   `SELECT SUM(CASE WHEN ISNULL(ProofOfIncomeUploaded,0)=1 THEN 1 ELSE 0 END) AS Uploaded, SUM(CASE WHEN ISNULL(ProofOfIncomeUploaded,0)=0 THEN 1 ELSE 0 END) AS Missing FROM rptMasterEnrollment WHERE (Active='Yes' OR Active='YES') AND (PFA_PI_na='PFA' OR PFA_PI_na='PI')`,
            flags:         `SELECT SUM(CASE WHEN IEP='Yes' OR IEP='YES' THEN 1 ELSE 0 END) AS IEP, SUM(CASE WHEN Military='Yes' OR Military='YES' THEN 1 ELSE 0 END) AS Military FROM rptMasterEnrollment WHERE Active='Yes' OR Active='YES'`,
            waitlistSummary: `SELECT AgeGroup, COUNT(*) AS Total, AVG(CAST(Score AS FLOAT)) AS AvgScore FROM PreEnrollment WHERE WaitlistStatus NOT IN ('Enrolled','Declined') GROUP BY AgeGroup`,
            ccapEligible:  `SELECT e.First_Name,e.Last_Name,r.Room,ISNULL(e.HouseholdIncome,'') AS HouseholdIncome,ISNULL(CAST(e.HouseholdSize AS NVARCHAR),'') AS HouseholdSize,ISNULL(p.FirstName+' '+p.LastName,'') AS ParentName,ISNULL(p.Phone,'') AS ParentPhone FROM rptMasterEnrollment e LEFT JOIN dimClassrooms r ON e.RoomNumber=r.RoomNumber LEFT JOIN (SELECT ChildName,FirstName,LastName,Phone,ROW_NUMBER() OVER (PARTITION BY ChildName ORDER BY Id DESC) AS rn FROM PreEnrollment) p ON p.ChildName LIKE '%'+e.First_Name+'%' AND p.rn=1 WHERE (e.Active='Yes' OR e.Active='YES') AND e.Category<>'CCAP' AND e.Category<>'Foster' AND ISNULL(e.HouseholdIncome,0)>0 AND ISNULL(e.HouseholdSize,0)>0 AND ((e.HouseholdSize=1 AND e.HouseholdIncome<=35213) OR (e.HouseholdSize=2 AND e.HouseholdIncome<=47588) OR (e.HouseholdSize=3 AND e.HouseholdIncome<=59963) OR (e.HouseholdSize=4 AND e.HouseholdIncome<=72338) OR (e.HouseholdSize=5 AND e.HouseholdIncome<=84713) OR (e.HouseholdSize=6 AND e.HouseholdIncome<=97088) OR (e.HouseholdSize=7 AND e.HouseholdIncome<=109463) OR (e.HouseholdSize>=8 AND e.HouseholdIncome<=121838)) ORDER BY e.Last_Name`,
            foodDetail:    `SELECT r.Room,e.Last_Name,e.First_Name,ISNULL(e.HouseholdIncome,'') AS HouseholdIncome,ISNULL(CAST(e.HouseholdSize AS NVARCHAR),'') AS HouseholdSize,ISNULL(e.F_R_P_Food,'') AS FRP,ISNULL(e.PublicBenefits,'') AS Benefits FROM rptMasterEnrollment e LEFT JOIN dimClassrooms r ON e.RoomNumber=r.RoomNumber WHERE e.Active='Yes' OR e.Active='YES' ORDER BY r.Room,e.Last_Name`,
            summerProgram: `IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='SummerProgram') SELECT s.ChildLastName,s.ChildFirstName,s.ChildAge,ISNULL(e.F_R_P_Food,'Unknown') AS FRP,s.Days,s.ParentLastName,s.ParentFirstName,s.ParentPhone FROM SummerProgram s LEFT JOIN rptMasterEnrollment e ON s.ChildFirstName=e.First_Name AND s.ChildLastName=e.Last_Name ORDER BY s.ChildLastName`,
        };
        const results = {};
        for (const [key, sql] of Object.entries(queries)) {
            const r = runSQL(sql);
            if (!r.ok) { results[key] = { error: r.error }; continue; }
            results[key] = r.data.trim().split('\n')
                .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
                .map(l => l.split('|').map(x => x.trim()));
        }
        return sendJSON(res, 200, results);
    }

    // GET waiting list count (lightweight - for badge)
    if (req.method === 'GET' && url === '/api/waitinglist/count') {
        if (!checkAuth(req, res)) return;
        const r = runSQL(`SELECT COUNT(*) AS Total FROM PreEnrollment WHERE ISNULL(WaitlistStatus,'Pending') NOT IN ('Enrolled','Declined')`);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const line = r.data.trim().split('\n').find(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()));
        const count = parseInt(line) || 0;
        return sendJSON(res, 200, { count });
    }

    // GET waiting list (internal - protected)
    if (req.method === 'GET' && url === '/api/waitinglist') {
        if (!checkAuth(req, res)) return;
        runSQL(`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='DaysRequested') ALTER TABLE PreEnrollment ADD DaysRequested NVARCHAR(50)`);
        // Rows come back as pipe-delimited text split on newlines, so any newline inside a
        // free-text column would break one record into bogus rows. Flatten those columns here.
        const flat = col => `REPLACE(REPLACE(ISNULL(${col},''),CHAR(13),' '),CHAR(10),' ')`;
        const r = runSQL(`SELECT Id,SubmittedAt,FirstName,LastName,Phone,Email,${flat('ChildrenInfo')} AS ChildrenInfo,ChildName,ChildBirthDate,ISNULL(ChildStartDate,'') AS ChildStartDate,AgeGroup,Homeless,FosterAdopted,IEP,EarlyIntervention,AbuseHistory,MentalIllness,DcfsInvolvement,SubstanceAbuse,CaregiverOther,FamilyDeath,LowBirthWeight,ParentIncarcerated,TeenParent,NoHSDiploma,BornOutsideUS,NonEnglishHome,ActiveMilitary,PublicBenefits,${flat('LivingSituation')} AS LivingSituation,City,HouseholdIncome,ISNULL(CAST(HouseholdSize AS NVARCHAR),'') AS HouseholdSize,Score,ISNULL(WaitlistStatus,'Pending') AS WaitlistStatus,${flat('Notes')} AS Notes,ISNULL(DaysRequested,'') AS DaysRequested FROM PreEnrollment ORDER BY Score DESC,SubmittedAt ASC`);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            // Every real row starts with a numeric Id; that also drops any stray continuation line.
            .filter(l => /^\s*\d+\s*\|/.test(l) && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return { Id:v[0],SubmittedAt:v[1],FirstName:v[2],LastName:v[3],Phone:v[4],Email:v[5],ChildrenInfo:v[6],ChildName:v[7],ChildBirthDate:v[8],ChildStartDate:v[9],AgeGroup:v[10],Homeless:v[11],FosterAdopted:v[12],IEP:v[13],EarlyIntervention:v[14],AbuseHistory:v[15],MentalIllness:v[16],DcfsInvolvement:v[17],SubstanceAbuse:v[18],CaregiverOther:v[19],FamilyDeath:v[20],LowBirthWeight:v[21],ParentIncarcerated:v[22],TeenParent:v[23],NoHSDiploma:v[24],BornOutsideUS:v[25],NonEnglishHome:v[26],ActiveMilitary:v[27],PublicBenefits:v[28],LivingSituation:v[29],City:v[30],HouseholdIncome:v[31],HouseholdSize:v[32],Score:v[33],WaitlistStatus:v[34],Notes:v[35],DaysRequested:v[36]||'' };
            });
        return sendJSON(res, 200, rows);
    }

    // PUT update waitlist status (internal - protected)
    if (req.method === 'PUT' && url.startsWith('/api/waitinglist/')) {
        if (!checkAuth(req, res)) return;
        const id = parseInt(url.split('/')[3]);
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const fields = [];
            if (d.status !== undefined) fields.push(`WaitlistStatus=${esc(d.status)}`);
            if (d.notes !== undefined) fields.push(`Notes=${esc(d.notes)}`);
            if (d.ageGroup !== undefined) fields.push(`AgeGroup=${esc(d.ageGroup)}`);
            if (!fields.length) return sendJSON(res, 400, { error: 'Nothing to update' });
            const r = runSQL(`UPDATE PreEnrollment SET ${fields.join(',')} WHERE Id=${id}`);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // External public site static files
    if (url.startsWith('/public')) {
        let subPath = decodeURIComponent(url.slice('/public'.length) || '/');
        if (subPath === '' || subPath === '/') subPath = '/index.html';
        const filePath = path.join(EXTERNAL_DIR, subPath);
        console.log('[PUBLIC]', url, '->', filePath);
        fs.readFile(filePath, (err, data) => {
            if (err) { console.error('[PUBLIC 404]', filePath); res.writeHead(404); return res.end('Not found'); }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
            res.end(data);
        });
        return;
    }

    // Portal page (admin splash)
    if (url === '/portal' || url === '/portal/') {
        const rootIndex = path.join(__dirname, '..', 'index.html');
        fs.readFile(rootIndex, (err, data) => {
            if (err) { res.writeHead(404); return res.end('Not found'); }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
        return;
    }

    // Parent Portal (public - no auth)
    if (url === '/parent' || url === '/parent/') {
        const parentPage = path.join(__dirname, 'parent.html');
        fs.readFile(parentPage, (err, data) => {
            if (err) { res.writeHead(404); return res.end('Not found'); }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
        return;
    }

    // Root landing page — serve public site
    if (url === '/' || url === '/index.html') {
        const pubIndex = path.join(EXTERNAL_DIR, 'index.html');
        fs.readFile(pubIndex, (err, data) => {
            if (err) { res.writeHead(404); return res.end('Not found'); }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
        return;
    }

    /* A short address for the staff sign-in page: /me.

       It exists to be said out loud and written on a noticeboard, which the real
       path is not. Served rather than redirected so the address bar keeps the short
       form. The page itself carries no data — it posts credentials and receives a
       token — so it needs no gate of its own. */
    if (url === '/me' || url === '/me/') {
        return fs.readFile(path.join(__dirname, 'my-portal.html'), (err, data) => {
            if (err) { res.writeHead(404); return res.end('Not found'); }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    }

    // PAS static files (protected - served under /pas/)
    if (url.startsWith('/pas/') || url === '/pas') {
        const subPath = url === '/pas' || url === '/pas/' ? '/pas-documentation.html' : url.replace('/pas', '');
        const filePath = path.join(__dirname, '..', 'PAS', subPath);
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); return res.end('Not found'); }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
            res.end(data);
        });
        return;
    }

    // Internal static files (protected) - served under /staff/
    // Allow images/css without auth (needed for login page logo)
    if (url.startsWith('/staff') && (url.endsWith('.png') || url.endsWith('.jpg') || url.endsWith('.css'))) {
        const subPath = url.replace('/staff', '');
        const filePath = path.join(__dirname, subPath);
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); return res.end('Not found'); }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
            res.end(data);
        });
        return;
    }
    if (url.startsWith('/staff')) {
        // Serve staff HTML files without Basic Auth popup - the portal has its own password gate
        const subPath = url === '/staff' || url === '/staff/' ? '/index.html' : url.replace('/staff', '');
        const filePath = path.join(__dirname, subPath);
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); return res.end('Not found'); }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
            res.end(data);
        });
        return;
    }

    // Fallback: try serving from External directory (public site assets at root level)
    const extPath = decodeURIComponent(url);
    const extFile = path.join(EXTERNAL_DIR, extPath);
    fs.readFile(extFile, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(extFile)] || 'text/plain' });
        res.end(data);
    });
}

server.listen(PORT, () => {
    console.log(`HTTP Server: http://localhost:${PORT}`);
    console.log(`DB: ${DB_SERVER} / ${DB_NAME}`);
});

if (httpsServer) {
    httpsServer.listen(HTTPS_PORT, () => {
        console.log(`HTTPS Server: https://localhost:${HTTPS_PORT}`);
    });
}
