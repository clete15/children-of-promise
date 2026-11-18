'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Personnel Activity, filled from the staff scheduler.

   Starting with FY 2026-27 (Oct 2026), a person's monthly figure on the Personnel
   Activity sheet is worked out from the shifts saved in the staff scheduler:

        days scheduled in the month  x  CACFP hours per day  x  hourly wage

   A day counts when the scheduler holds a shift for it (anything but blank or OFF).
   Days are credited to the calendar month they fall in, so a week that straddles two
   months is split between them. Hours per day and wage are kept per person on the sheet
   itself (doc.rates), not on the Staff record, so a raise is one edit on the sheet.

   Only people with a rate AND a matching active Staff record AND at least one worked
   day that month are written. Everyone else's cells are left exactly as they are:
   Sara's operational and admin lines, and Megan's admin line, vary month to month and
   stay typed in by hand.

   Weeks only count once they are saved in the scheduler. A month fills up as its weeks
   are saved, and every save recomputes the whole month from every saved week, so saving
   the same week twice cannot double count.
   ══════════════════════════════════════════════════════════════════════════ */

const FIRST_FY = 2026;   // FY 2026-27 is the first year the sheet is filled from the schedule

const DEFAULT_OPERATIONAL = ['Sue', 'Tara', 'Megan', 'Paige', 'Keyona', 'Janell', 'Lindsey', 'Renee', 'Jeremy',
    'Sara Holliday- Operational', 'Madeline', 'Molly'];
const DEFAULT_ADMIN = ['Sara Holliday-Admin', 'Megan-Admin'];

/* Starting rates, from the most recent signed forms (Sep 2026). hpd is CACFP hours per
   scheduled day: 2 for Paige, Tara and Sue, 1.5 for everyone else (director's rule). */
const DEFAULT_RATES = {
    Sue: { rate: 20, hpd: 2 },
    Tara: { rate: 19, hpd: 2 },
    Paige: { rate: 19, hpd: 2 },
    Megan: { rate: 18.10, hpd: 1.5 },
    Keyona: { rate: 20.07, hpd: 1.5 },
    Janell: { rate: 19, hpd: 1.5 },
    Lindsey: { rate: 19, hpd: 1.5 },
    Renee: { rate: 18, hpd: 1.5 },
    Jeremy: { rate: 19, hpd: 1.5 },
    Madeline: { rate: 18.5, hpd: 1.5 },
    Molly: { rate: 18.5, hpd: 1.5 },
};

/* A sheet row is a first name; the Staff record may carry another first name (the
   printed schedule calls Renee "Donna"). */
const ALIASES = { renee: ['renee', 'donna'] };

const round2 = n => Math.round(n * 100) / 100;
const pad = n => String(n).padStart(2, '0');
const calYear = (fy, m) => (m >= 10 ? fy : fy + 1);
const isoOf = d => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
const FY_MONTHS = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const DAY_COLS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const worked = s => { const t = String(s == null ? '' : s).trim(); return t !== '' && !/^off$/i.test(t); };

/* The fiscal year and month a date string (YYYY-MM-DD) belongs to. */
function fyMonthOf(iso) {
    const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
    return { fy: m >= 10 ? y : y - 1, month: m };
}

/* Which (fy, month) pairs the days Mon..Fri of a week fall in. */
function monthsOfWeek(weekStart) {
    const [y, m, d] = weekStart.split('-').map(Number);
    const seen = {}, out = [];
    for (let i = 0; i < 5; i++) {
        const iso = isoOf(new Date(Date.UTC(y, m - 1, d + i)));
        const fm = fyMonthOf(iso);
        const k = fm.fy + '|' + fm.month;
        if (!seen[k]) { seen[k] = 1; out.push(fm); }
    }
    return out;
}

function blankDoc() {
    return {
        operational: DEFAULT_OPERATIONAL.map(n => ({ name: n, cells: {} })),
        admin: DEFAULT_ADMIN.map(n => ({ name: n, cells: {} })),
        rates: {},
    };
}

module.exports = function PersonnelSync(deps) {
    const { runSQL, runSQLRows, esc } = deps;
    let lockProvider = null;      // (fy) => Set of 'staffId|month' whose signed report freezes that cell
    const setLockProvider = fn => { lockProvider = fn; };

    function readDoc(fy) {
        const r = runSQLRows(`SELECT DataJson, Version FROM dbo.MonthlyReporting WHERE Book=N'personnel' AND FiscalYear=N'${fy}'`);
        if (!r.ok) return { error: 'Could not read the sheet: ' + r.error };
        const row = r.rows[0];
        if (!row) return { doc: blankDoc(), version: 0 };
        try { return { doc: JSON.parse(row.DataJson), version: parseInt(row.Version, 10) || 0 }; }
        catch (e) { return { error: 'The saved sheet is not readable (corrupt data); nothing was changed.' }; }
    }

    function writeDoc(fy, doc, version, by) {
        const json = JSON.stringify(doc);
        const r = runSQL(`SET NOCOUNT ON;
DECLARE @v INT = (SELECT Version FROM dbo.MonthlyReporting WHERE Book=N'personnel' AND FiscalYear=N'${fy}');
IF @v IS NULL AND ${version} = 0
BEGIN
    INSERT INTO dbo.MonthlyReporting (Book, FiscalYear, DataJson, UpdatedBy) VALUES (N'personnel', N'${fy}', N${esc(json)}, N${esc(by)});
    SELECT 'MR_SAVED=1';
END
ELSE IF @v = ${version}
BEGIN
    UPDATE dbo.MonthlyReporting SET DataJson = N${esc(json)}, Version = @v + 1, UpdatedAt = SYSDATETIME(), UpdatedBy = N${esc(by)} WHERE Book=N'personnel' AND FiscalYear=N'${fy}';
    SELECT 'MR_SAVED=' + CAST(@v + 1 AS VARCHAR(12));
END
ELSE SELECT 'MR_CONFLICT=' + CAST(ISNULL(@v, 0) AS VARCHAR(12));`);
        if (!r.ok) return { error: r.error };
        if (r.sqlError) return { error: r.sqlError };
        if (/MR_SAVED=\d+/.test(r.data || '')) return { ok: true };
        return { error: 'The sheet was saved by someone else at the same moment; try again.' };
    }

    function readStaff() {
        const r = runSQLRows(`SELECT Id, Name, ISNULL(CAST(Active AS INT),1) AS Active FROM Staff`);
        if (!r.ok) return { error: 'Could not read staff: ' + r.error };
        const byFirst = {};
        r.rows.forEach(s => {
            if (String(s.Active) === '0') return;
            const first = String(s.Name || '').trim().split(/\s+/)[0].toLowerCase();
            (byFirst[first] = byFirst[first] || []).push(s);
        });
        return { byFirst };
    }

    function staffFor(rowName, byFirst) {
        const first = String(rowName || '').trim().split(/[\s-]+/)[0].toLowerCase();
        const keys = ALIASES[first] || [first];
        let found = [];
        keys.forEach(k => { found = found.concat(byFirst[k] || []); });
        return found.length === 1 ? found[0] : null;   // none or ambiguous: leave the row alone
    }

    /* Days worked per staff id in one calendar month, from every saved week touching it. */
    function daysInMonth(fy, month) {
        const y = calYear(fy, month);
        const first = new Date(Date.UTC(y, month - 1, 1));
        const last = new Date(Date.UTC(y, month, 0));
        const from = isoOf(new Date(first.getTime() - 6 * 86400000));
        const r = runSQLRows(`SELECT StaffId, WeekStart, ISNULL(Mon,'') AS Mon, ISNULL(Tue,'') AS Tue, ISNULL(Wed,'') AS Wed,
            ISNULL(Thu,'') AS Thu, ISNULL(Fri,'') AS Fri FROM StaffSchedule
            WHERE StaffId > 0 AND WeekStart >= N'${from}' AND WeekStart <= N'${isoOf(last)}'`);
        if (!r.ok) return { error: 'Could not read the schedule: ' + r.error };
        const days = {}, anyRow = {};
        r.rows.forEach(w => {
            const [wy, wm, wd] = String(w.WeekStart).split('-').map(Number);
            anyRow[w.StaffId] = true;
            DAY_COLS.forEach((c, i) => {
                const dt = new Date(Date.UTC(wy, wm - 1, wd + i));
                if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== month - 1) return;
                if (worked(w[c])) days[w.StaffId] = (days[w.StaffId] || 0) + 1;
            });
        });
        return { days };
    }

    /* Recompute the given months of one fiscal year. months = array of 1..12. */
    function syncFy(fy, months, by) {
        fy = parseInt(fy, 10);
        if (!(fy >= FIRST_FY && fy <= 2100)) return { ok: true, changed: 0, note: 'before the first schedule-driven year' };
        const cur = readDoc(fy);
        if (cur.error) return { ok: false, error: cur.error };
        const doc = cur.doc;
        if (!Array.isArray(doc.operational)) doc.operational = [];
        if (!Array.isArray(doc.admin)) doc.admin = [];
        doc.rates = doc.rates && typeof doc.rates === 'object' ? doc.rates : {};
        // Missing rates are filled from the defaults, never overwriting what is already there.
        let ratesAdded = false;
        doc.operational.forEach(p => {
            if (!doc.rates[p.name] && DEFAULT_RATES[p.name]) { doc.rates[p.name] = Object.assign({}, DEFAULT_RATES[p.name]); ratesAdded = true; }
        });
        const st = readStaff();
        if (st.error) return { ok: false, error: st.error };

        let changed = 0;
        const unmatched = {};
        /* A month whose report the employee has signed is frozen: the signed paper is the
           record, so a later scheduler edit must not move the number on the sheet. If the
           locks cannot be read, stop rather than risk overwriting a signed figure. */
        let locked = new Set();
        try { if (lockProvider) locked = lockProvider(fy) || new Set(); }
        catch (e) { return { ok: false, error: 'Could not check which months are signed: ' + (e.message || e) }; }
        for (const month of months) {
            const dm = daysInMonth(fy, month);
            if (dm.error) return { ok: false, error: dm.error };
            doc.operational.forEach(p => {
                const rt = doc.rates[p.name];
                const rate = rt ? parseFloat(rt.rate) : NaN, hpd = rt ? parseFloat(rt.hpd) : NaN;
                if (!(rate > 0) || !(hpd > 0)) return;
                const s = staffFor(p.name, st.byFirst);
                if (!s) { unmatched[p.name] = true; return; }
                if (locked.has(s.Id + '|' + month)) return;
                const d = dm.days[s.Id] || 0;
                if (d <= 0) return;                       // nothing scheduled: leave the cell alone
                const v = String(round2(d * hpd * rate));
                p.cells = p.cells || {};
                if (p.cells[month] !== v) { p.cells[month] = v; changed++; }
            });
        }
        if (!changed && !ratesAdded) return { ok: true, changed: 0, unmatched: Object.keys(unmatched) };
        const w = writeDoc(fy, doc, cur.version, by || 'staff scheduler');
        if (w.error) return { ok: false, error: w.error };
        return { ok: true, changed, unmatched: Object.keys(unmatched) };
    }

    /* A saved scheduler week: refresh the months its days fall in. Never throws. */
    function onWeekSaved(weekStart) {
        try {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(String(weekStart || ''))) return;
            const byFy = {};
            monthsOfWeek(weekStart).forEach(x => { (byFy[x.fy] = byFy[x.fy] || []).push(x.month); });
            Object.keys(byFy).forEach(fy => {
                const r = syncFy(fy, byFy[fy], 'staff scheduler');
                if (!r.ok) console.log('[PERSONNEL SYNC] week ' + weekStart + ' fy ' + fy + ' failed: ' + r.error);
                else if (r.changed) console.log('[PERSONNEL SYNC] week ' + weekStart + ': ' + r.changed + ' cell(s) updated in FY ' + fy);
            });
        } catch (e) { console.log('[PERSONNEL SYNC] ' + (e && e.message || e)); }
    }

    /* Which days each person is scheduled, for a whole fiscal year, in one read:
       { staffId: { calendarMonth: Set(dayOfMonth) } }. The monthly reports read this. */
    function daysByStaffMonth(fy) {
        fy = parseInt(fy, 10);
        const first = new Date(Date.UTC(fy, 9, 1));
        const from = isoOf(new Date(first.getTime() - 6 * 86400000));
        const to = (fy + 1) + '-09-30';
        const r = runSQLRows(`SELECT StaffId, WeekStart, ISNULL(Mon,'') AS Mon, ISNULL(Tue,'') AS Tue, ISNULL(Wed,'') AS Wed,
            ISNULL(Thu,'') AS Thu, ISNULL(Fri,'') AS Fri FROM StaffSchedule
            WHERE StaffId > 0 AND WeekStart >= N'${from}' AND WeekStart <= N'${to}'`);
        if (!r.ok) return { error: 'Could not read the schedule: ' + r.error };
        const out = {};
        r.rows.forEach(w => {
            const [wy, wm, wd] = String(w.WeekStart).split('-').map(Number);
            DAY_COLS.forEach((c, i) => {
                if (!worked(w[c])) return;
                const dt = new Date(Date.UTC(wy, wm - 1, wd + i));
                const m = dt.getUTCMonth() + 1;
                const byMonth = (out[w.StaffId] = out[w.StaffId] || {});
                (byMonth[m] = byMonth[m] || new Set()).add(dt.getUTCDate());
            });
        });
        return { days: out };
    }

    /* Write specific cells on the sheet: updates = [{ group:'operational'|'admin', name, month, value }].
       Used when a report is signed (so the sheet matches the signed paper) and when the
       hand-entered hours of someone like Sara are saved. Creates the row if it is missing. */
    function setCells(fy, updates, by) {
        const cur = readDoc(parseInt(fy, 10));
        if (cur.error) return { ok: false, error: cur.error };
        const doc = cur.doc;
        let changed = 0;
        updates.forEach(u => {
            const g = u.group === 'admin' ? 'admin' : 'operational';
            if (!Array.isArray(doc[g])) doc[g] = [];
            let row = doc[g].find(p => p.name === u.name);
            if (!row) { row = { name: u.name, cells: {} }; doc[g].push(row); }
            row.cells = row.cells || {};
            const v = u.value == null || u.value === '' ? '' : String(u.value);
            if (v === '') { if (row.cells[u.month] != null) { delete row.cells[u.month]; changed++; } }
            else if (row.cells[u.month] !== v) { row.cells[u.month] = v; changed++; }
        });
        if (!changed) return { ok: true, changed: 0 };
        const w = writeDoc(parseInt(fy, 10), doc, cur.version, by || 'activity report');
        return w.error ? { ok: false, error: w.error } : { ok: true, changed };
    }

    return { syncFy, onWeekSaved, FY_MONTHS, DEFAULT_RATES, _monthsOfWeek: monthsOfWeek,
        setLockProvider, daysByStaffMonth, setCells, readDoc, readStaff, staffFor, blankDoc };
};
