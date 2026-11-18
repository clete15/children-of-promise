'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Monthly Personnel Activity Reports (ISBE 67-54), signed twice.

   One report per person per month. The employee signs that it is accurate, then an
   authorised representative signs the director's section. When both have signed, the
   finished PDF is filed in the person's personnel folder and linked to their card.

   Where the numbers come from
     - Scheduled staff: the day grid is the person's scheduled days that month (staff
       scheduler), each worth their CACFP hours per day, at their wage. Nothing is typed.
     - Sara: her hours vary, so she enters her own administrative and operational hours
       day by day, and a wage. Her totals are written to her two lines on the sheet.

   A report is a LIVE view until the employee signs it. Signing freezes it: the figures are
   copied into the row and the sheet stops recalculating that person's month, so what was
   signed is what stays. Nothing can be signed before the month has ended.

   Who may sign (identity is the sign-in token, never anything in the request body)
     employee: the person themselves
     authorised representative: Sara signs everyone's, except her own. Her own is signed by
       Megan or Clete, so nobody countersigns their own time.
   ══════════════════════════════════════════════════════════════════════════ */

const FOLDER = 'Staff Personnel Activity Reports';
const FIRST_FY = 2026;

/* People whose hours are typed in rather than scheduled. */
const MANUAL = {
    'sara holliday': { op: 'Sara Holliday- Operational', adm: 'Sara Holliday-Admin', rate: 19 },
};

const REP_LOGINS = ['sarah'];                 // countersign everyone else
const REP_FOR_REP_LOGINS = ['megann', 'cleteh'];   // countersign Sara's own
const REP_OWNER_LOGIN = 'sarah';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
    'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FY_MONTHS = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const round2 = n => Math.round(n * 100) / 100;
const calYear = (fy, m) => (m >= 10 ? fy : fy + 1);
const pad = n => String(n).padStart(2, '0');
const todayIso = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const safe = s => String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim();

const ENSURE = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='PersonnelReports')
    CREATE TABLE PersonnelReports (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        StaffId INT NOT NULL,
        FiscalYear INT NOT NULL,
        Month INT NOT NULL,
        SnapshotJson NVARCHAR(MAX) NULL,
        EmpSigPath NVARCHAR(500) NULL,
        EmpSignedAt NVARCHAR(30) NULL,
        EmpSignedName NVARCHAR(200) NULL,
        RepSigPath NVARCHAR(500) NULL,
        RepSignedAt NVARCHAR(30) NULL,
        RepSignedName NVARCHAR(200) NULL,
        RepStaffId INT NULL,
        PdfRelPath NVARCHAR(500) NULL,
        UpdatedAt DATETIME DEFAULT GETDATE(),
        CONSTRAINT UQ_PersonnelReports UNIQUE (StaffId, FiscalYear, Month)
    );
GO
`;

module.exports = function PersonnelReports(deps) {
    const { runSQL, runSQLRows, esc, buildFormPdf, findDocRoot, invalidateDocCache, sync,
        staffFileLinksEnsureSQL, STAFF_ROOT } = deps;
    const fs = require('fs');
    const path = require('path');

    // ── reading ──
    function readRows(where) {
        const r = runSQLRows(`SELECT StaffId, FiscalYear, Month, ISNULL(SnapshotJson,'') AS SnapshotJson,
            ISNULL(EmpSignedAt,'') AS EmpSignedAt, ISNULL(EmpSignedName,'') AS EmpSignedName,
            ISNULL(RepSignedAt,'') AS RepSignedAt, ISNULL(RepSignedName,'') AS RepSignedName,
            ISNULL(PdfRelPath,'') AS PdfRelPath, ISNULL(EmpSigPath,'') AS EmpSigPath, ISNULL(RepSigPath,'') AS RepSigPath FROM PersonnelReports WHERE ${where}`, ENSURE);
        if (!r.ok) return { error: 'Could not read the reports: ' + r.error };
        return { rows: r.rows };
    }

    /* 'staffId|month' for every report the employee has signed, i.e. frozen. Throws if it
       cannot be read, so the sheet sync stops instead of overwriting a signed figure. */
    function lockedSet(fy) {
        const r = readRows(`FiscalYear=${parseInt(fy, 10)} AND ISNULL(EmpSignedAt,'') <> ''`);
        if (r.error) throw new Error(r.error);
        return new Set(r.rows.map(x => x.StaffId + '|' + x.Month));
    }

    function staffById(id) {
        const r = runSQLRows(`SELECT Id, ISNULL(Name,'') AS Name, ISNULL(LoginName,'') AS LoginName,
            ISNULL(CAST(Active AS INT),1) AS Active FROM Staff WHERE Id=${parseInt(id, 10) || 0}`);
        if (!r.ok) return { error: r.error };
        return { staff: r.rows[0] || null };
    }

    function loginOf(staffId) {
        const s = staffById(staffId);
        return s.staff ? String(s.staff.LoginName || '').toLowerCase() : '';
    }

    /* What a viewer may do to one person's report. The two roles are separate on purpose. */
    function mayCountersign(actorLogin, subjectLogin, actorId, subjectId) {
        if (!actorLogin || String(actorId) === String(subjectId)) return false;
        if (String(subjectLogin).toLowerCase() === REP_OWNER_LOGIN) return REP_FOR_REP_LOGINS.indexOf(actorLogin) !== -1;
        return REP_LOGINS.indexOf(actorLogin) !== -1;
    }

    // ── the report itself ──
    function monthMeta(fy, month) {
        const y = calYear(fy, month);
        const dim = new Date(Date.UTC(y, month, 0)).getUTCDate();
        const first = y + '-' + pad(month) + '-01', last = y + '-' + pad(month) + '-' + pad(dim);
        const t = todayIso();
        return { year: y, dim, first, last, label: MONTHS[month - 1] + ' ' + y,
            started: t >= first, ended: t >= last };
    }

    function loadContext(fy) {
        const d = sync.readDoc(fy);
        if (d.error) return { error: d.error };
        const doc = d.doc;
        doc.rates = doc.rates && typeof doc.rates === 'object' ? doc.rates : {};
        (doc.operational || []).forEach(p => {
            if (!doc.rates[p.name] && sync.DEFAULT_RATES[p.name]) doc.rates[p.name] = Object.assign({}, sync.DEFAULT_RATES[p.name]);
        });
        const st = sync.readStaff();
        if (st.error) return { error: st.error };
        const sc = sync.daysByStaffMonth(fy);
        if (sc.error) return { error: sc.error };
        return { doc, byFirst: st.byFirst, sched: sc.days };
    }

    /* The sheet row that belongs to this staff member, if any, and its rate. */
    function scheduledRow(ctx, staff) {
        const rows = ctx.doc.operational || [];
        for (const p of rows) {
            const rt = ctx.doc.rates[p.name];
            const rate = rt ? parseFloat(rt.rate) : NaN, hpd = rt ? parseFloat(rt.hpd) : NaN;
            if (!(rate > 0) || !(hpd > 0)) continue;
            const s = sync.staffFor(p.name, ctx.byFirst);
            if (s && String(s.Id) === String(staff.Id)) return { name: p.name, rate, hpd };
        }
        return null;
    }

    function manualFor(staff) {
        return MANUAL[String(staff.Name || '').trim().toLowerCase()] || null;
    }

    /* The report as it stands now. For scheduled staff the day grid is derived; for manual
       staff it is the saved draft (or an empty month). Returns null when this person has
       no activity report at all. */
    function buildLive(ctx, staff, fy, month, stored) {
        const meta = monthMeta(fy, month);
        const sr = scheduledRow(ctx, staff);
        const man = manualFor(staff);
        let source = null;
        if (sr) source = 'schedule'; else if (man) source = 'manual';
        if (!source) return null;

        let draft = null;
        if (source === 'manual' && stored && stored.SnapshotJson) {
            try { draft = JSON.parse(stored.SnapshotJson); } catch (e) { draft = null; }
        }
        const sched = (ctx.sched[staff.Id] || {})[month] || new Set();
        const rate = source === 'schedule' ? sr.rate : (draft && draft.rate > 0 ? draft.rate : man.rate);
        const days = [];
        for (let d = 1; d <= meta.dim; d++) {
            const dt = new Date(Date.UTC(meta.year, month - 1, d));
            const dow = dt.getUTCDay();
            const wknd = dow === 0 || dow === 6;
            let oper = 0, admin = 0;
            if (source === 'schedule') {
                if (sched.has(d)) oper = sr.hpd;
            } else if (draft && Array.isArray(draft.days)) {
                const x = draft.days.find(q => q.d === d);
                if (x) { oper = +x.oper || 0; admin = +x.admin || 0; }
            }
            days.push({ d, dow: DOW[dow], wknd, oper, admin });
        }
        const operHours = round2(days.reduce((s, x) => s + x.oper, 0));
        const adminHours = round2(days.reduce((s, x) => s + x.admin, 0));
        return {
            v: 1, source, staffId: staff.Id, name: staff.Name, fy, month, year: meta.year, monthLabel: meta.label,
            days, operHours, adminHours, rate, hpd: sr ? sr.hpd : null,
            opTotal: round2(operHours * rate), adTotal: round2(adminHours * rate),
            sheetRows: source === 'schedule' ? { op: sr.name } : { op: man.op, adm: man.adm },
        };
    }

    function statusOf(meta, snap, row) {
        if (row && row.RepSignedAt) return 'complete';
        if (row && row.EmpSignedAt) return 'awaitRep';
        if (!snap) return 'none';
        if (!meta.started) return 'future';
        if (!meta.ended) return 'upcoming';
        if (snap.operHours + snap.adminHours <= 0) return 'none';
        return 'ready';
    }

    function summary(meta, snap, row, month) {
        const status = statusOf(meta, snap, row);
        return {
            month, label: meta.label, status,
            hours: snap ? round2(snap.operHours + snap.adminHours) : 0,
            total: snap ? round2(snap.opTotal + snap.adTotal) : 0,
            source: snap ? snap.source : '',
            emp: row && row.EmpSignedAt ? { at: row.EmpSignedAt, name: row.EmpSignedName, sig: row.EmpSigPath } : null,
            rep: row && row.RepSignedAt ? { at: row.RepSignedAt, name: row.RepSignedName, sig: row.RepSigPath } : null,
            pdf: row ? row.PdfRelPath : '',
            endsOn: meta.last,
        };
    }

    function parseStored(row) {
        if (!row || !row.SnapshotJson || !row.EmpSignedAt) return null;
        try { return JSON.parse(row.SnapshotJson); } catch (e) { return null; }
    }

    /* The twelve months for one person. */
    function list(staffId, fy) {
        const s = staffById(staffId);
        if (s.error) return { ok: false, status: 500, error: s.error };
        if (!s.staff) return { ok: false, status: 404, error: 'No such staff member' };
        const ctx = loadContext(fy);
        if (ctx.error) return { ok: false, status: 500, error: ctx.error };
        const rr = readRows(`StaffId=${parseInt(staffId, 10)} AND FiscalYear=${fy}`);
        if (rr.error) return { ok: false, status: 500, error: rr.error };
        const byMonth = {};
        rr.rows.forEach(r => { byMonth[r.Month] = r; });
        let tracked = false;
        const months = FY_MONTHS.map(m => {
            const meta = monthMeta(fy, m);
            const row = byMonth[m] || null;
            const snap = parseStored(row) || buildLive(ctx, s.staff, fy, m, row);
            if (snap) tracked = true;
            return summary(meta, snap, row, m);
        });
        return { ok: true, fy, staff: { id: s.staff.Id, name: s.staff.Name }, tracked, months };
    }

    /* One month in full. */
    function detail(staffId, fy, month) {
        const s = staffById(staffId);
        if (s.error) return { ok: false, status: 500, error: s.error };
        if (!s.staff) return { ok: false, status: 404, error: 'No such staff member' };
        const ctx = loadContext(fy);
        if (ctx.error) return { ok: false, status: 500, error: ctx.error };
        const rr = readRows(`StaffId=${parseInt(staffId, 10)} AND FiscalYear=${fy} AND Month=${month}`);
        if (rr.error) return { ok: false, status: 500, error: rr.error };
        const row = rr.rows[0] || null;
        const snap = parseStored(row) || buildLive(ctx, s.staff, fy, month, row);
        if (!snap) return { ok: false, status: 404, error: 'There is no activity report for this person.' };
        const meta = monthMeta(fy, month);
        return { ok: true, report: snap, summary: summary(meta, snap, row, month),
            subjectLogin: String(s.staff.LoginName || '').toLowerCase() };
    }

    // ── saving a hand-entered month (Sara) ──
    function saveDraft(actor, actorLogin, d) {
        const staffId = parseInt(d.staffId, 10), fy = parseInt(d.fy, 10), month = parseInt(d.month, 10);
        if (!staffId || !(fy >= FIRST_FY) || !(month >= 1 && month <= 12)) return { status: 400, body: { error: 'Which report?' } };
        const sObj = staffById(staffId);
        if (!sObj.staff) return { status: 404, body: { error: 'No such staff member' } };
        const man = manualFor(sObj.staff);
        if (!man) return { status: 400, body: { error: 'This report is filled from the schedule, not typed in.' } };
        if (!(actor.admin || String(actor.staffId) === String(staffId))) return { status: 403, body: { error: 'You can only enter your own hours.' } };
        const rr = readRows(`StaffId=${staffId} AND FiscalYear=${fy} AND Month=${month}`);
        if (rr.error) return { status: 500, body: { error: rr.error } };
        if (rr.rows[0] && rr.rows[0].EmpSignedAt) return { status: 409, body: { error: 'This report is already signed, so it cannot be changed.' } };
        const meta = monthMeta(fy, month);
        const days = [];
        (Array.isArray(d.days) ? d.days : []).forEach(x => {
            const dd = parseInt(x.d, 10);
            if (!(dd >= 1 && dd <= meta.dim)) return;
            const op = Math.min(24, Math.max(0, parseFloat(x.oper) || 0));
            const ad = Math.min(24, Math.max(0, parseFloat(x.admin) || 0));
            if (op || ad) days.push({ d: dd, oper: round2(op), admin: round2(ad) });
        });
        const rate = Math.min(500, Math.max(0, parseFloat(d.rate) || man.rate));
        const json = JSON.stringify({ rate, days });
        const w = runSQL(ENSURE + `SET NOCOUNT ON;
IF EXISTS (SELECT 1 FROM PersonnelReports WHERE StaffId=${staffId} AND FiscalYear=${fy} AND Month=${month})
    UPDATE PersonnelReports SET SnapshotJson=N${esc(json)}, UpdatedAt=GETDATE() WHERE StaffId=${staffId} AND FiscalYear=${fy} AND Month=${month};
ELSE
    INSERT INTO PersonnelReports (StaffId, FiscalYear, Month, SnapshotJson) VALUES (${staffId}, ${fy}, ${month}, N${esc(json)});`);
        if (!w.ok || w.sqlError) return { status: 500, body: { error: 'Could not save: ' + (w.error || w.sqlError) } };
        const out = detail(staffId, fy, month);
        if (!out.ok) return { status: out.status, body: { error: out.error } };
        pushToSheet(out.report, 'activity report draft');
        return { status: 200, body: { success: true, report: out.report, summary: out.summary } };
    }

    function pushToSheet(snap, by) {
        const ups = [];
        if (snap.sheetRows && snap.sheetRows.op) ups.push({ group: 'operational', name: snap.sheetRows.op, month: snap.month, value: snap.opTotal > 0 ? snap.opTotal : '' });
        if (snap.sheetRows && snap.sheetRows.adm) ups.push({ group: 'admin', name: snap.sheetRows.adm, month: snap.month, value: snap.adTotal > 0 ? snap.adTotal : '' });
        if (!ups.length) return;
        const r = sync.setCells(snap.fy, ups, by);
        if (!r.ok) console.log('[ACTIVITY REPORT] sheet update failed: ' + r.error);
    }

    // ── signing ──
    function jpegFrom(dataUrl) {
        const m = String(dataUrl || '').match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
        if (!m) return { error: 'Expected a JPEG signature' };
        const bytes = Buffer.from(m[1], 'base64');
        if (!bytes.length) return { error: 'The signature was empty' };
        if (bytes.length > 2 * 1024 * 1024) return { error: 'The signature image is unreasonably large' };
        return { bytes };
    }

    function writeSigFile(personName, fy, month, role, bytes) {
        const root = findDocRoot();
        if (!root) return { error: 'The document library is not reachable from the server.' };
        const dir = path.join(root, STAFF_ROOT, FOLDER, 'Signatures');
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { error: e.message }; }
        const base = safe(personName) + ' - ' + calYear(fy, month) + '-' + pad(month) + ' - ' + role + ' signature';
        let name = base + '.jpg', n = 2;
        while (fs.existsSync(path.join(dir, name))) { name = base + ' (' + n + ').jpg'; n++; }
        try { fs.writeFileSync(path.join(dir, name), bytes); } catch (e) { return { error: e.message }; }
        return { rel: STAFF_ROOT + '/' + FOLDER + '/Signatures/' + name };
    }

    function sign(actor, actorLogin, actorName, d) {
        if (!actor || !actor.staffId) {
            return { status: 403, body: { error: 'Sign in as yourself to sign a report. The shared password cannot sign.' } };
        }
        const staffId = parseInt(d.staffId, 10), fy = parseInt(d.fy, 10), month = parseInt(d.month, 10);
        const role = d.role === 'rep' ? 'rep' : d.role === 'employee' ? 'employee' : null;
        if (!staffId || !(fy >= FIRST_FY) || !(month >= 1 && month <= 12) || !role) {
            return { status: 400, body: { error: 'Which report, and which signature?' } };
        }
        const sig = jpegFrom(d.dataUrl);
        if (sig.error) return { status: 400, body: { error: sig.error } };

        const det = detail(staffId, fy, month);
        if (!det.ok) return { status: det.status, body: { error: det.error } };
        const meta = monthMeta(fy, month);
        const rr = readRows(`StaffId=${staffId} AND FiscalYear=${fy} AND Month=${month}`);
        if (rr.error) return { status: 500, body: { error: rr.error } };
        const row = rr.rows[0] || null;
        const snap = det.report;
        const personName = snap.name;

        if (role === 'employee') {
            if (String(actor.staffId) !== String(staffId)) {
                return { status: 403, body: { error: 'Only ' + personName + ' can sign as the employee.' } };
            }
            if (row && row.EmpSignedAt) return { status: 409, body: { error: 'Already signed.' } };
            if (!meta.ended) return { status: 400, body: { error: 'This month is not over yet. You can sign on ' + meta.last + ' or after.' } };
            if (snap.operHours + snap.adminHours <= 0) return { status: 400, body: { error: 'There are no hours on this report to sign.' } };
            const f = writeSigFile(personName, fy, month, 'employee', sig.bytes);
            if (f.error) return { status: 500, body: { error: 'Could not store the signature: ' + f.error } };
            const at = new Date().toISOString();
            const w = runSQL(ENSURE + `SET NOCOUNT ON;
IF EXISTS (SELECT 1 FROM PersonnelReports WHERE StaffId=${staffId} AND FiscalYear=${fy} AND Month=${month})
    UPDATE PersonnelReports SET SnapshotJson=N${esc(JSON.stringify(snap))}, EmpSigPath=${esc(f.rel)}, EmpSignedAt=${esc(at)},
        EmpSignedName=${esc(personName)}, UpdatedAt=GETDATE() WHERE StaffId=${staffId} AND FiscalYear=${fy} AND Month=${month};
ELSE
    INSERT INTO PersonnelReports (StaffId, FiscalYear, Month, SnapshotJson, EmpSigPath, EmpSignedAt, EmpSignedName)
    VALUES (${staffId}, ${fy}, ${month}, N${esc(JSON.stringify(snap))}, ${esc(f.rel)}, ${esc(at)}, ${esc(personName)});`);
            if (!w.ok || w.sqlError) return { status: 500, body: { error: 'Could not record the signature: ' + (w.error || w.sqlError) } };
            pushToSheet(snap, 'signed by ' + personName);
            console.log('[ACTIVITY REPORT] ' + personName + ' signed ' + meta.label);
            return { status: 200, body: { success: true, status: 'awaitRep' } };
        }

        // role === 'rep'
        if (!row || !row.EmpSignedAt) return { status: 409, body: { error: personName + ' has to sign first.' } };
        if (row.RepSignedAt) return { status: 409, body: { error: 'Already countersigned.' } };
        if (!mayCountersign(actorLogin, det.subjectLogin, actor.staffId, staffId)) {
            return { status: 403, body: { error: det.subjectLogin === REP_OWNER_LOGIN
                ? 'Sara\u2019s own report is countersigned by Megan or Clete.'
                : 'Only Sara can sign the authorised representative section.' } };
        }
        const stored = parseStored(row) || snap;
        const empRel = (runSQLRows(`SELECT ISNULL(EmpSigPath,'') AS P FROM PersonnelReports WHERE StaffId=${staffId} AND FiscalYear=${fy} AND Month=${month}`).rows[0] || {}).P;
        const root = findDocRoot();
        let empBytes = null;
        try { if (root && empRel) empBytes = fs.readFileSync(path.join(root, empRel)); } catch (e) { empBytes = null; }
        if (!empBytes) return { status: 500, body: { error: 'The employee\u2019s signature image could not be found on disk, so the report cannot be filed.' } };
        const f = writeSigFile(actorName, fy, month, 'authorized representative', sig.bytes);
        if (f.error) return { status: 500, body: { error: 'Could not store the signature: ' + f.error } };

        const at = new Date().toISOString();
        const pdf = buildPdf(stored, { jpeg: empBytes, name: row.EmpSignedName, date: row.EmpSignedAt.slice(0, 10) },
            { jpeg: sig.bytes, name: actorName, date: at.slice(0, 10) });
        if (pdf.error) return { status: 500, body: { error: pdf.error } };
        const filed = filePdf(stored, pdf.buffer);
        if (filed.error) return { status: 500, body: { error: filed.error } };
        const w = runSQL(ENSURE + `UPDATE PersonnelReports SET RepSigPath=${esc(f.rel)}, RepSignedAt=${esc(at)}, RepSignedName=${esc(actorName)},
            RepStaffId=${parseInt(actor.staffId, 10)}, PdfRelPath=${esc(filed.rel)}, UpdatedAt=GETDATE()
            WHERE StaffId=${staffId} AND FiscalYear=${fy} AND Month=${month}`);
        if (!w.ok || w.sqlError) {
            return { status: 500, body: { error: 'The PDF was filed as "' + filed.name + '" but could not be recorded against the report: ' + (w.error || w.sqlError) } };
        }
        console.log('[ACTIVITY REPORT] ' + actorName + ' countersigned ' + personName + ' ' + meta.label + ' -> ' + filed.rel);
        return { status: 200, body: { success: true, status: 'complete', pdf: filed.rel } };
    }

    // ── the document ──
    function fmtH(n) { return String(round2(n)); }
    function money(n) { return '$' + round2(n).toFixed(2); }

    function buildPdf(snap, emp, rep) {
        try {
            const lines = [];
            if (snap.operHours > 0) lines.push('Operational: ' + fmtH(snap.operHours) + ' hours x ' + money(snap.rate) + ' (hourly wage) = ' + money(snap.opTotal));
            if (snap.adminHours > 0) lines.push('Administrative: ' + fmtH(snap.adminHours) + ' hours x ' + money(snap.rate) + ' (hourly wage) = ' + money(snap.adTotal));
            const buffer = buildFormPdf({
                title: 'Personnel Activity Report',
                subtitle: 'Child and Adult Care Food Program (CACFP) \u2014 Children of Promise LLC',
                rows: [
                    { label: 'Employee name', value: snap.name },
                    { label: 'Month / year', value: snap.monthLabel },
                    { label: 'Hours per day on the CACFP', value: snap.hpd ? fmtH(snap.hpd) + ' (from the staff schedule)' : 'entered by the employee' },
                ],
                blocks: [{ daygrid: { days: snap.days, totalAdmin: snap.adminHours, totalOper: snap.operHours } }]
                    .concat(lines.map((t, i) => (i === 0
                        ? { heading: 'Center director / authorised representative: hourly paid staff', text: t }
                        : { text: t })))
                    .concat([{ heading: 'Certification', text: 'I certify that this is an accurate record of the number of hours worked on the Child and Adult Care Food Program. Payroll records are on file that verify the total wages as listed above.' }]),
                signatures: [
                    { label: 'Employee\u2019s signature', name: emp.name, date: emp.date, jpeg: emp.jpeg },
                    { label: 'Signature of Center Director / Authorized Representative', name: rep.name, date: rep.date, jpeg: rep.jpeg },
                ],
                footer: 'Signed electronically in the Children of Promise staff portal. Format follows ISBE 67-54.',
            });
            return { buffer };
        } catch (e) { return { error: 'Could not build the report PDF: ' + e.message }; }
    }

    function filePdf(snap, buffer) {
        const root = findDocRoot();
        if (!root) return { error: 'The document library is not reachable from the server.' };
        const dir = path.join(root, STAFF_ROOT, FOLDER);
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { error: e.message }; }
        const base = safe(snap.name) + ' - Personnel Activity Report - ' + snap.monthLabel;
        let name = base + '.pdf', n = 2;
        while (fs.existsSync(path.join(dir, name))) { name = base + ' (' + n + ').pdf'; n++; }
        try { fs.writeFileSync(path.join(dir, name), buffer); } catch (e) { return { error: 'Could not write the report: ' + e.message }; }
        const rel = STAFF_ROOT + '/' + FOLDER + '/' + name;
        // Confirmed (not Pending): both signatures are on it, and it is the centre's own record.
        const w = runSQL(staffFileLinksEnsureSQL() + 'GO\n'
            + `DELETE FROM StaffFileLinks WHERE RelPath=${esc(rel)};\n`
            + `INSERT INTO StaffFileLinks (StaffId, RelPath, Status, UploadedBy, UploadedDate) VALUES (${parseInt(snap.staffId, 10)}, ${esc(rel)}, ${esc('Confirmed')}, ${esc('activity report')}, ${esc(new Date().toISOString())})`);
        if (!w.ok) return { error: 'The report was written but could not be linked to the card: ' + w.error };
        invalidateDocCache();
        return { rel, name };
    }

    // ── Sara's queue ──
    function queue(actor, actorLogin, fy) {
        const isRep = !!actor.staffId && (REP_LOGINS.indexOf(actorLogin) !== -1 || REP_FOR_REP_LOGINS.indexOf(actorLogin) !== -1);
        if (!isRep) return { ok: true, isRep: false, items: [] };
        const r = runSQLRows(`SELECT p.StaffId, p.Month, ISNULL(p.SnapshotJson,'') AS SnapshotJson, p.EmpSignedAt,
            ISNULL(s.Name,'') AS Name, ISNULL(s.LoginName,'') AS LoginName
            FROM PersonnelReports p JOIN Staff s ON s.Id = p.StaffId
            WHERE p.FiscalYear=${parseInt(fy, 10)} AND ISNULL(p.EmpSignedAt,'') <> '' AND ISNULL(p.RepSignedAt,'') = ''`, ENSURE);
        if (!r.ok) return { ok: false, status: 500, error: 'Could not read the signing queue: ' + r.error };
        const items = [];
        r.rows.forEach(x => {
            if (!mayCountersign(actorLogin, String(x.LoginName).toLowerCase(), actor.staffId, x.StaffId)) return;
            let snap = null;
            try { snap = JSON.parse(x.SnapshotJson); } catch (e) { snap = null; }
            items.push({ staffId: x.StaffId, name: x.Name, month: x.Month, label: snap ? snap.monthLabel : '',
                hours: snap ? round2(snap.operHours + snap.adminHours) : 0, total: snap ? round2(snap.opTotal + snap.adTotal) : 0,
                signedAt: x.EmpSignedAt });
        });
        items.sort((a, b) => (a.signedAt < b.signedAt ? -1 : 1));
        return { ok: true, isRep: true, items };
    }

    function who(id) {
        const s = staffById(id);
        return s.staff ? { login: String(s.staff.LoginName || '').toLowerCase(), name: String(s.staff.Name || '') } : { login: '', name: '' };
    }

    return { list, detail, saveDraft, sign, queue, lockedSet, who, mayCountersign, FOLDER, FIRST_FY, _buildPdf: buildPdf, _monthMeta: monthMeta };
};
