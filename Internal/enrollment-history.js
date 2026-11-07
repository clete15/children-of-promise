/* Enrollment history: who was on the roster on any given day.

   rptMasterEnrollment holds only the CURRENT state. Active, RoomNumber, the attending days
   and the program are overwritten in place, so once a child is marked inactive or moved,
   the previous state was gone. This keeps it, in an append-only table, EnrollmentHistory.

   HOW IT WORKS (server-side, no database trigger)
   - Before a save, the endpoint takes a snapshot of the tracked fields; after a SUCCESSFUL
     save it takes another and writes one history row per field that actually changed.
     The save always happens first, so a history failure can never undo or block it: the
     worst case is a missing history row, logged loudly to the console.
   - The table creates itself the first time the server needs it, and the first time it is
     created every existing child gets a "baseline" row per field dated 1900-01-01 (their
     best known state, from the beginning). Transfers already carry a date and use it.
   - EffectiveDate is the first day the new value applies. When a child is marked inactive,
     staff give the LAST DAY ATTENDED and the change takes effect the day after, so a child
     who left on the 15th but is entered on the 20th is gone from the 16th. Everything else
     takes effect the day it is saved.
   - Children already inactive when the log began have no known leaving date. They are
     listed (missingEndDates) so staff can enter one, once.

   Edits made directly in SSMS or the portal SQL box bypass this and are not logged.

   AS-OF RULE: for a date D, each field's value is the NewValue of its latest row with
   EffectiveDate <= D. A child is on the roster when that Active is 'Yes' and their
   Start_Date is not after D. A child with no history rows at all falls back to their
   current state rather than vanishing. */

'use strict';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const FIELDS = ['Active', 'RoomNumber', 'PFA_PI_na'].concat(DAYS);
const BASELINE = '1900-01-01';

/* One normalisation, used everywhere a tracked value is read (baseline, snapshots, and the
   as-of fallback), so two reads of the same value always compare equal. */
function normSql(alias, field) {
    const col = `${alias}.${field}`;
    if (field === 'Active') {
        return `CASE WHEN UPPER(LTRIM(RTRIM(CAST(${col} AS NVARCHAR(20))))) = N'YES' THEN N'Yes' ELSE N'No' END`;
    }
    if (DAYS.includes(field)) {
        return `CASE WHEN LTRIM(RTRIM(CAST(${col} AS NVARCHAR(10)))) IN (N'1', N'True', N'Yes') THEN N'1' ELSE N'0' END`;
    }
    return `ISNULL(LTRIM(RTRIM(CAST(${col} AS NVARCHAR(100)))), N'')`;
}

// ── Dates (all plain YYYY-MM-DD strings) ──
const ISO = /^\d{4}-\d{2}-\d{2}$/;
function isIsoDate(s) {
    if (!ISO.test(String(s || ''))) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function addDays(iso, n) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}
// The server's local calendar date (the centre's day), not UTC.
function localToday() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// Start_Date is stored as text in more than one style ('2025-09-01', '9/1/2025').
function parseLooseDate(s) {
    const t = String(s || '').trim();
    if (isIsoDate(t.slice(0, 10))) return t.slice(0, 10);
    const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) {
        const iso = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
        if (isIsoDate(iso)) return iso;
    }
    return null;
}
// Who may be written into ChangedBy: plain characters only (it goes into SQL via esc too).
function cleanActor(s) {
    return String(s || '').replace(/[^A-Za-z0-9._ @()-]/g, '').slice(0, 80) || 'unknown';
}

module.exports = function makeEnrollmentHistory({ runSQL, runSQLRows, esc }) {
    let ensured = false;

    /* Creates the table (and the one-time baseline) if needed. Idempotent; remembers success
       for the life of the process and retries on the next call after a failure. */
    function ensure() {
        if (ensured) return { ok: true };
        const fieldRows = FIELDS.map(f => `(N'${f}', ${normSql('e', f)})`).join(',\n            ');
        const sql = `
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='rptMasterEnrollment' AND COLUMN_NAME='TransferredOut') ALTER TABLE rptMasterEnrollment ADD TransferredOut BIT NOT NULL DEFAULT 0;
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='rptMasterEnrollment' AND COLUMN_NAME='TransferDate') ALTER TABLE rptMasterEnrollment ADD TransferDate NVARCHAR(20);
IF OBJECT_ID(N'dbo.EnrollmentHistory', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.EnrollmentHistory (
        Id            INT IDENTITY(1,1) PRIMARY KEY,
        StudentId     INT           NOT NULL,
        Field         NVARCHAR(30)  NOT NULL,
        OldValue      NVARCHAR(100) NULL,
        NewValue      NVARCHAR(100) NOT NULL DEFAULT N'',
        EffectiveDate DATE          NOT NULL,
        ChangedAt     DATETIME2     NOT NULL DEFAULT SYSDATETIME(),
        ChangedBy     NVARCHAR(100) NULL,
        Source        NVARCHAR(20)  NOT NULL DEFAULT N'change'
    );
    CREATE INDEX IX_EnrollmentHistory_Lookup ON dbo.EnrollmentHistory (StudentId, Field, EffectiveDate, Id);
END
GO
SET XACT_ABORT ON;
BEGIN TRAN;
IF NOT EXISTS (SELECT 1 FROM dbo.EnrollmentHistory WITH (TABLOCKX, HOLDLOCK))
BEGIN
    INSERT INTO dbo.EnrollmentHistory (StudentId, Field, OldValue, NewValue, EffectiveDate, ChangedBy, Source)
    SELECT e.Id, c.Field, NULL, c.Val, '${BASELINE}', N'baseline', N'baseline'
    FROM dbo.rptMasterEnrollment e
    CROSS APPLY (VALUES
            ${fieldRows}
    ) c (Field, Val);

    -- A transfer already carries its own date (the last day), so those children are known.
    INSERT INTO dbo.EnrollmentHistory (StudentId, Field, OldValue, NewValue, EffectiveDate, ChangedBy, Source)
    SELECT e.Id, N'Active', N'No', N'Yes', '1900-01-02', N'baseline', N'baseline'
    FROM dbo.rptMasterEnrollment e
    WHERE e.TransferredOut = 1 AND TRY_CONVERT(DATE, e.TransferDate) IS NOT NULL;
    INSERT INTO dbo.EnrollmentHistory (StudentId, Field, OldValue, NewValue, EffectiveDate, ChangedBy, Source)
    SELECT e.Id, N'Active', N'Yes', N'No', DATEADD(DAY, 1, TRY_CONVERT(DATE, e.TransferDate)), N'baseline', N'baseline'
    FROM dbo.rptMasterEnrollment e
    WHERE e.TransferredOut = 1 AND TRY_CONVERT(DATE, e.TransferDate) IS NOT NULL;
END
COMMIT;
GO
SELECT 'HISTORY_READY=' + CAST(COUNT(*) AS VARCHAR(20)) FROM dbo.EnrollmentHistory;`;
        const r = runSQL(sql);
        if (!r.ok) return { ok: false, error: r.error };
        if (r.sqlError) return { ok: false, error: r.sqlError };
        if (!/HISTORY_READY=\d+/.test(r.data || '')) return { ok: false, error: 'History table check returned nothing' };
        ensured = true;
        console.log('[HISTORY] ready (' + (r.data.match(/HISTORY_READY=(\d+)/) || [])[1] + ' rows)');
        return { ok: true };
    }

    /* The tracked fields for the children matching `whereSql` (a WHERE clause body the
       caller already built safely), keyed by Id. Returns null when the read fails, which
       tells after() to skip logging rather than log a bogus diff. */
    function snapshot(whereSql) {
        const cols = FIELDS.map(f => `${normSql('e', f)} AS ${f}`).join(', ');
        const r = runSQLRows(`SELECT e.Id, ${cols} FROM dbo.rptMasterEnrollment e WHERE ${whereSql}`);
        if (!r.ok) { console.error('[HISTORY] snapshot failed: ' + r.error); return null; }
        const map = {};
        r.rows.forEach(row => { map[row.Id] = row; });
        return map;
    }

    function insertRows(rows) {
        if (!rows.length) return { ok: true, logged: 0 };
        // esc() turns '' into NULL; a blank value here is a real value (no program, say).
        const txt = v => (v == null) ? 'NULL' : (String(v) === '' ? "N''" : esc(String(v)));
        const bad = rows.find(x => !isIsoDate(x.eff));
        if (bad) {
            console.error('[HISTORY] refused a row with a bad effective date: ' + bad.eff);
            return { ok: false, error: 'Bad effective date' };
        }
        const values = rows.map(x =>
            `(${parseInt(x.id, 10)}, ${esc(x.field)}, ${txt(x.oldVal)}, `
            + `${x.newVal == null ? "N''" : txt(x.newVal)}, '${x.eff}', ${esc(cleanActor(x.by))}, ${esc(x.source)})`
        ).join(',\n');
        const r = runSQL(`INSERT INTO dbo.EnrollmentHistory (StudentId, Field, OldValue, NewValue, EffectiveDate, ChangedBy, Source) VALUES\n${values};`);
        if (!r.ok || r.sqlError) {
            console.error('[HISTORY] could not record ' + rows.length + ' change(s): ' + (r.error || r.sqlError));
            return { ok: false, error: r.error || r.sqlError };
        }
        return { ok: true, logged: rows.length };
    }

    /* Call BEFORE the save. Never throws; returns a token for after(). */
    function before(whereSql) {
        try {
            const e = ensure();
            if (!e.ok) { console.error('[HISTORY] not ready, this save will not be logged: ' + e.error); return null; }
            const snap = snapshot(whereSql);
            return snap ? { whereSql, snap } : null;
        } catch (err) {
            console.error('[HISTORY] before() failed: ' + err.message);
            return null;
        }
    }

    /* Call AFTER a successful save. opts: { by, lastDayAttended, source }.
       Never throws: the save has already happened, so all this can do is record it. */
    function after(token, opts) {
        if (!token) return { ok: false, logged: 0 };
        try {
            const now = snapshot(token.whereSql);
            if (!now) return { ok: false, logged: 0 };
            const today = localToday();
            const o = opts || {};
            const rows = [];
            Object.keys(now).forEach(id => {
                const was = token.snap[id];
                const is = now[id];
                if (!was || !is) return;   // a row that appeared mid-save is not this save's change
                FIELDS.forEach(f => {
                    if (String(was[f]) === String(is[f])) return;
                    let eff = today;
                    // Leaving: the change applies the day after the last day attended.
                    if (f === 'Active' && is[f] === 'No' && isIsoDate(o.lastDayAttended)) {
                        eff = addDays(o.lastDayAttended, 1);
                    }
                    rows.push({ id, field: f, oldVal: was[f], newVal: is[f], eff, by: o.by, source: o.source || 'change' });
                });
            });
            return insertRows(rows);
        } catch (err) {
            console.error('[HISTORY] after() failed: ' + err.message);
            return { ok: false, logged: 0 };
        }
    }

    /* A child just created: one row per field, effective from their start date (or today). */
    function created(studentId, startDate, by) {
        try {
            const id = parseInt(studentId, 10);
            if (!id) return { ok: false };
            const e = ensure();
            if (!e.ok) return { ok: false };
            const snap = snapshot(`e.Id = ${id}`);
            if (!snap || !snap[id]) return { ok: false };
            const eff = parseLooseDate(startDate) || localToday();
            return insertRows(FIELDS.map(f => ({ id, field: f, oldVal: null, newVal: snap[id][f], eff, by, source: 'created' })));
        } catch (err) {
            console.error('[HISTORY] created() failed: ' + err.message);
            return { ok: false };
        }
    }

    /* The roster on a given date. A derived table throughout, never a CTE, because
       runSQLRows embeds it in a scalar subquery (see sql-reads steering). */
    function rosterAsOfSelect(date) {
        if (!isIsoDate(date)) throw new Error('Bad date');
        const d = `CONVERT(DATE, '${date}', 23)`;
        const pick = FIELDS.map(f => `MAX(CASE WHEN q.Field = N'${f}' THEN q.NewValue END) AS ${f}`).join(', ');
        const cur = f => `COALESCE(h.${f}, ${normSql('e', f)})`;
        return `SELECT x.Id, x.First_Name, x.Last_Name, x.Birth_date, x.Start_Date, x.RoomNumber,
       ISNULL(c.Room, N'') AS Room, x.Program, x.Monday, x.Tuesday, x.Wednesday, x.Thursday, x.Friday
FROM (
    SELECT e.Id, e.First_Name, e.Last_Name, ISNULL(e.Birth_date, N'') AS Birth_date, ISNULL(e.Start_Date, N'') AS Start_Date,
           ${cur('Active')} AS Active, ${cur('RoomNumber')} AS RoomNumber, ${cur('PFA_PI_na')} AS Program,
           ${DAYS.map(f => `${cur(f)} AS ${f}`).join(', ')},
           TRY_CONVERT(DATE, e.Start_Date) AS StartD
    FROM dbo.rptMasterEnrollment e
    LEFT JOIN (
        SELECT q.StudentId, ${pick}
        FROM (
            SELECT StudentId, Field, NewValue,
                   ROW_NUMBER() OVER (PARTITION BY StudentId, Field ORDER BY EffectiveDate DESC, Id DESC) AS rn
            FROM dbo.EnrollmentHistory
            WHERE EffectiveDate <= ${d}
        ) q
        WHERE q.rn = 1
        GROUP BY q.StudentId
    ) h ON h.StudentId = e.Id
    WHERE h.StudentId IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM dbo.EnrollmentHistory z WHERE z.StudentId = e.Id)
) x
LEFT JOIN dbo.dimClassrooms c ON c.RoomNumber = TRY_CAST(x.RoomNumber AS INT)
WHERE x.Active = N'Yes' AND (x.StartD IS NULL OR x.StartD <= ${d})
ORDER BY x.Last_Name, x.First_Name`;
    }

    function rosterAsOf(date) {
        const e = ensure();
        if (!e.ok) return { ok: false, error: 'History is not available yet: ' + e.error };
        return runSQLRows(rosterAsOfSelect(date));
    }

    /* Inactive today, but no dated leaving row (they left before the log began). */
    function missingEndDates() {
        const e = ensure();
        if (!e.ok) return { ok: false, error: 'History is not available yet: ' + e.error };
        return runSQLRows(`SELECT e.Id, e.First_Name, e.Last_Name, ISNULL(e.Start_Date, N'') AS Start_Date,
       ISNULL(r.Room, N'') AS Room, ${normSql('e', 'PFA_PI_na')} AS Program
FROM dbo.rptMasterEnrollment e
LEFT JOIN dbo.dimClassrooms r ON r.RoomNumber = TRY_CAST(e.RoomNumber AS INT)
WHERE ${normSql('e', 'Active')} = N'No'
  AND NOT EXISTS (SELECT 1 FROM dbo.EnrollmentHistory h
                  WHERE h.StudentId = e.Id AND h.Field = N'Active' AND h.NewValue = N'No'
                    AND h.EffectiveDate > '${BASELINE}')
ORDER BY e.Last_Name, e.First_Name`);
    }

    /* Records the last day attended for a child who was already inactive when the log began.
       Writes Yes from their start date and No from the day after their last day. */
    function setEndDate(studentId, lastDay, by) {
        const id = parseInt(studentId, 10);
        if (!id) return { ok: false, status: 400, error: 'Bad student id' };
        if (!isIsoDate(lastDay)) return { ok: false, status: 400, error: 'Give the date as YYYY-MM-DD' };
        if (lastDay > localToday()) return { ok: false, status: 400, error: 'The last day attended cannot be in the future' };
        const e = ensure();
        if (!e.ok) return { ok: false, status: 500, error: 'History is not available yet: ' + e.error };
        const r = runSQLRows(`SELECT e.Id, ${normSql('e', 'Active')} AS Active, ISNULL(e.Start_Date, N'') AS Start_Date,
       (SELECT COUNT(*) FROM dbo.EnrollmentHistory h WHERE h.StudentId = e.Id AND h.Field = N'Active'
          AND h.NewValue = N'No' AND h.EffectiveDate > '${BASELINE}') AS Dated
FROM dbo.rptMasterEnrollment e WHERE e.Id = ${id}`);
        if (!r.ok) return { ok: false, status: 500, error: r.error };
        const c = r.rows[0];
        if (!c) return { ok: false, status: 404, error: 'No child with that id' };
        if (c.Active === 'Yes') return { ok: false, status: 409, error: 'That child is active, so there is no leaving date to enter' };
        if (c.Dated > 0) return { ok: false, status: 409, error: 'That child already has a leaving date' };
        const start = parseLooseDate(c.Start_Date);
        const yesFrom = (start && start <= lastDay) ? start : '1900-01-02';
        return insertRows([
            { id, field: 'Active', oldVal: 'No', newVal: 'Yes', eff: yesFrom, by, source: 'backfill' },
            { id, field: 'Active', oldVal: 'Yes', newVal: 'No', eff: addDays(lastDay, 1), by, source: 'backfill' },
        ]);
    }

    return { ensure, before, after, created, rosterAsOf, rosterAsOfSelect, missingEndDates, setEndDate };
};

module.exports.isIsoDate = isIsoDate;
module.exports.localToday = localToday;
module.exports.addDays = addDays;
module.exports.parseLooseDate = parseLooseDate;
