/* Food Program → Monthly Reporting.

   Replaces the two FY workbooks, keeping each sheet's own layout:
     Monthly Food Check  months down, years across (every year on one sheet), total row
     Food Costs          purchase log: Year, Month, Date, Amount Paid, Vendor, Gallons of
                         Milk, Food Cost, Non-Food Costs (plus a monthly totals table)
     Overhead Costs      Monroe / WM / Mortgage / Overhead Costs, Oct..Sep, total column
     Personnel Activity  staff down, Oct..Sep across, Operational + Admin totals
     Yearly Summary      one fiscal year, every sheet's monthly and yearly totals

   Each sheet saves to /api/monthly-reporting as one document per fiscal year. Number
   cells accept a sum like "332+4225" (the workbook enters the food check that way); the
   text is kept and totals use its value.

   A failed read shows an error, never an empty sheet: an empty sheet would read as
   "nothing entered" and invite someone to type it all in again. */
(function () {
    'use strict';

    const esc = s => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // Month numbers, in each sheet's own column order, with the sheet's own labels.
    const FY_MONTHS = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    // Overhead uses the same Oct..Sep fiscal year as every other sheet (the old workbook
    // sheet ran Sep..Aug; the director confirmed it should be Oct..Sep, Nov 2026).
    const OH_MONTHS = FY_MONTHS;
    const REV_LABEL = { 10: 'Oct', 11: 'Nov', 12: 'Dec', 1: 'Jan', 2: 'Feb', 3: 'Mar', 4: 'Apr', 5: 'May', 6: 'June', 7: 'July', 8: 'Aug', 9: 'Sep' };
    const SHORT = { 10: 'Oct', 11: 'Nov', 12: 'Dec', 1: 'Jan', 2: 'Feb', 3: 'Mar', 4: 'Apr', 5: 'May', 6: 'Jun', 7: 'Jul', 8: 'Aug', 9: 'Sep' };
    const PER_LABEL = Object.assign({}, SHORT, { 7: 'July' });

    /* The overhead COST lines. The old workbook's 5th line ("Overhead Costs") was the food
       program's share, typed in by hand; it is now calculated (OH_ALLOC_PCT of these lines),
       so it is not a line anyone enters and it is never added into the cost total. */
    const DEFAULT_OVERHEAD = ['Monroe County Electric', 'Aspen Waste', 'Shellpoint Mortgage'];
    const OH_ALLOC_PCT = 17.75;   // share of overhead allocated to the Food Program (Nov 2026)
    const round2 = n => Math.round(n * 100) / 100;
    const DEFAULT_OPERATIONAL = ['Sue', 'Tara', 'Raquel', 'Megan', 'Paige', 'Keyona', 'Janell', 'Lindsey', 'Renee', 'Jeremy', 'Sara Holliday- Operational'];
    const DEFAULT_ADMIN = ['Sara Holliday-Admin', 'Megan-Admin'];

    const SECTIONS = [
        { key: 'revenue', label: 'Monthly Food Check' },
        { key: 'foodcosts', label: 'Food Costs' },
        { key: 'overhead', label: 'Overhead Costs' },
        { key: 'personnel', label: 'Personnel Activity' },
        { key: 'summary', label: 'Yearly Summary' },
    ];

    // ── numbers ──
    // A cell is blank, a number, or a sum/difference of numbers ("332+4225", "3,735 + 249").
    function cellValue(text) {
        const t = String(text == null ? '' : text).replace(/[\s,$]/g, '');
        if (t === '') return { ok: true, value: 0, blank: true };
        if (!/^[+-]?(\d+\.?\d*|\.\d+)([+-](\d+\.?\d*|\.\d+))*$/.test(t)) return { ok: false, value: 0 };
        const parts = t.match(/[+-]?(\d+\.?\d*|\.\d+)/g);
        return { ok: true, value: parts.reduce((s, p) => s + parseFloat(p), 0) };
    }
    const num = text => cellValue(text).value;
    function fmt(n) {
        if (!isFinite(n)) return '';
        const r = Math.round(n * 100) / 100;
        return r.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }

    // ── fiscal years (start year: 2025 = FY 2025-26, Oct 2025 .. Sep 2026) ──
    function currentFy() {
        const d = new Date();
        return d.getMonth() >= 9 ? d.getFullYear() : d.getFullYear() - 1;
    }
    const fyLabel = y => 'FY ' + y + '-' + String(y + 1).slice(2);
    // The calendar year a month falls in, for fiscal year y (Oct..Dec are y, Jan..Sep y+1).
    const calYear = (fy, m) => (m >= 10 ? fy : fy + 1);

    // ── state ──
    /* Which fiscal year opens. The year being reported on, not the calendar's: the director
       is working FY 2025-26 (Oct 2025 to Sep 2026), so that is the default, and whatever
       year is picked is remembered on this browser so moving on to the next year is one
       pick, once. */
    const DEFAULT_FY = 2025;
    const FY_KEY = 'copMrFiscalYear';
    function startFy() {
        try {
            const v = parseInt(localStorage.getItem(FY_KEY), 10);
            if (v >= 2000 && v <= 2100) return v;
        } catch (e) { /* storage blocked: use the default */ }
        return DEFAULT_FY;
    }
    function rememberFy(y) { try { localStorage.setItem(FY_KEY, String(y)); } catch (e) { /* ignore */ } }
    // A fiscal year column/label without the "FY ": 2025 -> "2025-26".
    const fyShort = y => y + '-' + String(+y + 1).slice(2);

    const MR = { section: 'revenue', fy: startFy(), docs: {}, highlight: false };
    const keyOf = (book, fy) => book + '|' + (book === 'revenue' ? 'all' : fy);
    const doc = book => MR.docs[keyOf(book, MR.fy)];
    const anyDirty = () => Object.values(MR.docs).some(d => d && d.dirty);

    function blank(book) {
        if (book === 'revenue') return { years: [String(MR.fy)], cells: {}, highlights: {}, note: '' };
        if (book === 'foodcosts') return { rows: [] };
        if (book === 'overhead') return { rows: DEFAULT_OVERHEAD.map(l => ({ label: l, cells: {} })), allocPct: OH_ALLOC_PCT };
        return {
            operational: DEFAULT_OPERATIONAL.map(n => ({ name: n, cells: {} })),
            admin: DEFAULT_ADMIN.map(n => ({ name: n, cells: {} })),
        };
    }

    async function load(book, fy, force) {
        const k = keyOf(book, fy);
        if (MR.docs[k] && !force) return MR.docs[k];
        const res = await apiFetch('/api/monthly-reporting?book=' + book + '&fy=' + (book === 'revenue' ? 'all' : fy));
        if (res.status === 401) throw Object.assign(new Error('This sheet needs a centre-admin sign-in.'), { auth: true });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || !d.ok) throw new Error(d.error || ('HTTP ' + res.status));
        const data = d.data || blank(book);
        if (book === 'overhead') upgradeOverhead(data);
        MR.docs[k] = { book, fy, data, version: d.version || 0,
            updatedAt: d.updatedAt || '', updatedBy: d.updatedBy || '', dirty: false, isNew: !d.data };
        return MR.docs[k];
    }

    async function save(book) {
        const dc = doc(book);
        if (!dc) return;
        const bad = document.querySelectorAll('#mrBody input.mr-bad');
        if (bad.length) { status('Fix the ' + bad.length + ' red cell(s) first: use numbers, or a sum like 332+4225.', true); bad[0].focus(); return; }
        status('Saving…');
        try {
            const res = await apiFetch('/api/monthly-reporting?book=' + book + '&fy=' + (book === 'revenue' ? 'all' : dc.fy),
                { method: 'PUT', body: JSON.stringify({ data: dc.data, version: dc.version }) });
            const d = await res.json().catch(() => ({}));
            if (res.status === 409) {
                status(d.error || 'Someone else saved this sheet. Reload it, then enter your changes again.', true, true);
                return;
            }
            if (!res.ok || !d.success) throw new Error(d.error || ('HTTP ' + res.status));
            dc.version = d.version; dc.dirty = false; dc.isNew = false;
            dc.updatedAt = 'just now'; dc.updatedBy = 'you';
            status('Saved.');
        } catch (e) {
            status('Not saved: ' + (e.message || e), true);
        }
    }

    // ── shell ──
    function status(text, isErr, offerReload) {
        const el = document.getElementById('mrStatus');
        if (!el) return;
        el.className = 'mr-status' + (isErr ? ' err' : '');
        el.textContent = text;
        if (offerReload) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'fp-btn'; b.textContent = 'Reload (discards your unsaved changes)';
            b.style.marginLeft = '8px';
            b.addEventListener('click', () => { const dc = doc(MR.section); if (dc) dc.dirty = false; renderSection(true); });
            el.appendChild(b);
        }
    }
    function savedLine(dc) {
        if (!dc) return '';
        if (dc.dirty) return 'Unsaved changes';
        if (dc.isNew) return 'Nothing saved for this sheet yet';
        return 'Last saved ' + esc(dc.updatedAt) + (dc.updatedBy ? ' by ' + esc(dc.updatedBy) : '');
    }

    function fyOptions() {
        const now = currentFy();
        let opts = '';
        for (let y = now + 1; y >= now - 4; y--) opts += '<option value="' + y + '"' + (y === MR.fy ? ' selected' : '') + '>' + fyLabel(y) + '</option>';
        return opts;
    }

    function shell() {
        const tabs = SECTIONS.map(s => '<button type="button" class="mr-tab' + (s.key === MR.section ? ' on' : '')
            + '" data-sec="' + s.key + '" aria-pressed="' + (s.key === MR.section) + '">' + esc(s.label) + '</button>').join('');
        return '<div class="mr-bar"><div class="mr-tabs" role="group" aria-label="Monthly Reporting sheets">' + tabs + '</div>'
            + '<label class="mr-fy" id="mrFyWrap">Fiscal year <select id="mrFy">' + fyOptions() + '</select></label></div>'
            + '<div id="mrBody"></div>';
    }

    async function open() {
        const body = document.getElementById('fpBody');
        body.innerHTML = shell();
        body.querySelectorAll('.mr-tab').forEach(b => b.addEventListener('click', () => {
            if (b.dataset.sec === MR.section) return;
            if (doc(MR.section) && doc(MR.section).dirty && !confirm('You have unsaved changes on this sheet. Leave without saving?')) return;
            if (doc(MR.section)) doc(MR.section).dirty = false;
            MR.section = b.dataset.sec;
            body.querySelectorAll('.mr-tab').forEach(x => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
            renderSection();
        }));
        document.getElementById('mrFy').addEventListener('change', e => {
            if (anyDirty() && !confirm('You have unsaved changes. Switch fiscal year without saving?')) { e.target.value = MR.fy; return; }
            Object.values(MR.docs).forEach(d => { if (d) d.dirty = false; });
            MR.fy = parseInt(e.target.value, 10);
            rememberFy(MR.fy);
            renderSection();
        });
        wire(document.getElementById('mrBody'));
        renderSection();
    }

    async function renderSection(force) {
        const box = document.getElementById('mrBody');
        if (!box) return;
        // The food check sheet shows every year at once, so the year picker does not apply.
        document.getElementById('mrFyWrap').style.visibility = MR.section === 'revenue' ? 'hidden' : 'visible';
        box.innerHTML = '<div class="fp-loading">Loading…</div>';
        try {
            if (MR.section === 'summary') return renderSummary(box, force);
            const dc = await load(MR.section, MR.fy, force);
            const r = RENDER[MR.section];
            box.innerHTML = '<div class="mr-actions"><button type="button" class="fp-btn fp-btn-primary" id="mrSave">Save</button>'
                + '<span class="mr-saved" id="mrSaved">' + savedLine(dc) + '</span><span id="mrStatus" class="mr-status" role="status"></span></div>'
                + r.html(dc.data);
            box.querySelector('#mrSave').addEventListener('click', () => save(MR.section).then(() => {
                const s = document.getElementById('mrSaved'); if (s) s.innerHTML = savedLine(doc(MR.section));
            }));
            applyTotals(box, r.totals(dc.data));
        } catch (e) {
            box.innerHTML = '<div class="fp-error">Could not load this sheet: ' + esc(e.message || e)
                + (e.auth ? '' : ' Nothing has been lost; this is a read problem. Try again in a moment.') + '</div>';
        }
    }

    /* One set of handlers on #mrBody, attached ONCE when the tab opens (re-attaching per
       sheet would stack them and apply each edit several times). Every event works on the
       sheet currently showing. Inputs carry data-path into that sheet's document. */
    function wire(box) {
        const current = () => {
            const dc = doc(MR.section), r = RENDER[MR.section];
            return dc && r ? { dc, r } : null;
        };
        const markDirty = dc => { dc.dirty = true; const s = document.getElementById('mrSaved'); if (s) s.textContent = 'Unsaved changes'; };
        box.addEventListener('input', e => {
            const inp = e.target;
            if (!inp.dataset || !inp.dataset.path) return;
            const c = current();
            if (!c) return;
            const { dc, r } = c;
            setPath(dc.data, inp.dataset.path, inp.value);
            if (inp.dataset.num) inp.classList.toggle('mr-bad', !cellValue(inp.value).ok);
            markDirty(dc);
            applyTotals(box, r.totals(dc.data));
        });
        // Correcting a stray Food Costs entry's Year or Month moves it into its month at once.
        box.addEventListener('change', e => {
            const p = e.target.dataset && e.target.dataset.path;
            if (MR.section !== 'foodcosts' || !p || !/^rows\.\d+\.(year|month)$/.test(p)) return;
            const c = current();
            if (c) renderSectionKeep(box, c.dc, c.r);
        });
        box.addEventListener('click', e => {
            const c = current();
            if (!c) return;
            const { dc, r } = c;
            const btn = e.target.closest('[data-act]');
            if (btn) {
                // View settings (highlight mode, opening a month) are not edits.
                const viewOnly = btn.dataset.act === 'hlMode' || (r.viewOnly && r.viewOnly[btn.dataset.act]);
                // Keep the opened/closed month button focused after the redraw (keyboard users).
                const refocus = btn.dataset.act === 'toggle' ? '[data-act="toggle"][data-arg="' + btn.dataset.arg + '"]' : null;
                if (!viewOnly) markDirty(dc);
                r.action(dc.data, btn.dataset.act, btn.dataset.arg);
                const y = window.scrollY;
                renderSectionKeep(box, dc, r);
                window.scrollTo(0, y);
                const target = MR.focus ? box.querySelector('[data-path="' + MR.focus + '"]') : (refocus ? box.querySelector(refocus) : null);
                MR.focus = null;
                if (target) target.focus({ preventScroll: true });
                return;
            }
            // Highlight mode on the food check sheet: click a cell to mark it yellow.
            const cell = e.target.closest('input[data-hl]');
            if (cell && MR.highlight) {
                const k = cell.dataset.hl;
                if (dc.data.highlights[k]) delete dc.data.highlights[k]; else dc.data.highlights[k] = true;
                cell.classList.toggle('mr-hl', !!dc.data.highlights[k]);
                markDirty(dc);
            }
        });
    }
    function renderSectionKeep(box, dc, r) {
        const saved = savedLine(dc);
        const actions = box.querySelector('.mr-actions');
        const holder = document.createElement('div');
        holder.innerHTML = r.html(dc.data);
        while (box.lastChild && box.lastChild !== actions) box.removeChild(box.lastChild);
        while (holder.firstChild) box.appendChild(holder.firstChild);
        const s = document.getElementById('mrSaved'); if (s) s.innerHTML = saved;
        box.querySelectorAll('input[data-num]').forEach(i => i.classList.toggle('mr-bad', !cellValue(i.value).ok));
        applyTotals(box, r.totals(dc.data));
    }
    function applyTotals(box, map) {
        Object.keys(map).forEach(id => { const el = box.querySelector('[data-total="' + id + '"]'); if (el) el.textContent = map[id]; });
        if (map.__scale) map.__scale(box);
    }
    function setPath(obj, path, value) {
        const parts = path.split('.');
        let o = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            const p = /^\d+$/.test(parts[i]) ? +parts[i] : parts[i];
            if (o[p] == null) o[p] = {};
            o = o[p];
        }
        o[parts[parts.length - 1]] = value;
    }
    const numInput = (path, value, extra) => '<input type="text" inputmode="decimal" data-num="1" data-path="' + esc(path)
        + '" value="' + esc(value) + '"' + (extra || '') + ' class="' + (cellValue(value).ok ? '' : 'mr-bad') + '">';
    const textInput = (path, value, label) => '<input type="text" class="mr-text" data-path="' + esc(path) + '" value="' + esc(value) + '" aria-label="' + esc(label) + '">';

    // ── Monthly Food Check: months down, years across, total row ──
    const revenue = {
        html(d) {
            const yrs = d.years;
            let h = '<div class="mr-sheet-head"><h3>Monthly Food Check</h3><div class="mr-tools">'
                + '<button type="button" class="fp-btn" data-act="addYear">+ Add year</button>'
                + '<button type="button" class="fp-btn' + (MR.highlight ? ' fp-btn-primary' : '') + '" data-act="hlMode" aria-pressed="' + MR.highlight + '">'
                + (MR.highlight ? 'Highlighting: click cells (done)' : 'Highlight cells') + '</button></div></div>'
                + '<p class="mr-hint">Each column is a fiscal year, October to September. '
                + 'Enter the check as one amount or as a sum, e.g. <code>332+4225</code>.</p>'
                // Sized to its content (not the page width), so each box sits beside its month.
                + '<div class="fp-table-wrap mr-rev-wrap"><table class="fp-table mr-grid mr-rev"><colgroup><col class="mr-c-rmonth">'
                + yrs.map(() => '<col class="mr-c-ryear">').join('') + '</colgroup><thead><tr><th scope="col"><span class="mr-sr">Month</span></th>'
                + yrs.map(y => '<th scope="col" class="center">' + esc(fyShort(y)) + '</th>').join('') + '</tr></thead><tbody>';
            FY_MONTHS.forEach(m => {
                h += '<tr><th scope="row">' + REV_LABEL[m] + '</th>' + yrs.map(y => {
                    const k = y + '|' + m;
                    return '<td>' + numInput('cells.' + y + '.' + m, ((d.cells[y] || {})[m]) || '',
                        ' data-hl="' + k + '" aria-label="' + REV_LABEL[m] + ', ' + esc(fyShort(y)) + '"' + (d.highlights[k] ? ' data-on="1"' : '')) + '</td>';
                }).join('') + '</tr>';
            });
            h += '<tr class="mr-total"><th scope="row">Total</th>' + yrs.map(y => '<td class="right" data-total="y' + esc(y) + '"></td>').join('') + '</tr>';
            h += '</tbody></table></div>'
                + '<div class="mr-note"><span class="mr-swatch" aria-hidden="true"></span>'
                + '<label class="mr-sr" for="mrRevNote">Note for highlighted cells</label>'
                + '<input type="text" id="mrRevNote" class="mr-text" data-path="note" value="' + esc(d.note) + '" placeholder="Note for highlighted cells, e.g. * opened rehabbed 2\'s building"></div>';
            return h.replace(/(<input[^>]*data-on="1"[^>]*class=")/g, '$1mr-hl ');
        },
        totals(d) {
            const t = {};
            d.years.forEach(y => { t['y' + y] = fmt(FY_MONTHS.reduce((s, m) => s + num((d.cells[y] || {})[m]), 0)); });
            return t;
        },
        action(d, act) {
            if (act === 'addYear') {
                const last = d.years.length ? Math.max.apply(null, d.years.map(Number)) : MR.fy - 1;
                d.years.push(String(last + 1));
            } else if (act === 'hlMode') {
                MR.highlight = !MR.highlight;
            }
        },
    };

    // ── Food Costs: purchase log, plus monthly totals for the fiscal year ──
    const FC_COLS = [
        ['year', 'Year', 'num'], ['month', 'Month', 'num'], ['date', 'Date', 'text'], ['amountPaid', 'Amount Paid', 'num'],
        ['vendor', 'Vendor', 'text'], ['milk', 'Gallons of Milk', 'num'], ['foodCost', 'Food Cost', 'num'],
        ['nonFood', 'Non-Food Costs (Plates, napkins, plasticware)', 'num'],
    ];
    const FC_SUM = ['amountPaid', 'milk', 'foodCost', 'nonFood'];
    const inFy = (row, fy) => { const y = parseInt(row.year, 10), m = parseInt(row.month, 10); return m >= 1 && m <= 12 && y === calYear(fy, m); };
    // The purchase fields entered inside an opened month. Year and Month come from the month.
    const FC_FIELDS = FC_COLS.filter(c => c[0] !== 'year' && c[0] !== 'month');
    const pad2 = n => String(n).padStart(2, '0');
    const lastDay = (y, m) => new Date(y, m, 0).getDate();

    /* Which months are opened. Starts with the current month (when it is in the year being
       viewed) so the usual case, entering this month's receipts, is one click away. Opening
       and closing a month is a view choice, not an edit. */
    function fcOpenSet() {
        if (MR.fcOpenFy !== MR.fy) {
            MR.fcOpenFy = MR.fy;
            MR.fcOpen = new Set();
            const now = new Date(), m = now.getMonth() + 1;
            if (calYear(MR.fy, m) === now.getFullYear()) MR.fcOpen.add(m);
        }
        return MR.fcOpen;
    }

    const foodcosts = {
        html(d) {
            const open = fcOpenSet();
            const totalCols = FC_SUM.length;
            // (The workbook's three reminder notes were removed from this sheet, Nov 2026.)
            let h = '<div class="mr-sheet-head"><h3>Food Costs, ' + fyLabel(MR.fy) + '</h3></div>'
                + '<p class="mr-hint">Click a month to open it, then add that month\u2019s purchases. The month\u2019s totals add up for you.</p>'
                + '<div class="fp-table-wrap mr-fit"><table class="fp-table mr-grid mr-fc"><colgroup><col class="mr-c-month">'
                + '<col class="mr-c-count">' + FC_SUM.map(() => '<col>').join('') + '</colgroup><thead><tr><th scope="col">Month</th>'
                + '<th scope="col" class="center">Purchases</th>'
                + FC_SUM.map(k => '<th scope="col" class="center">' + esc(FC_COLS.find(c => c[0] === k)[1].replace(/ \(.*\)/, '')) + '</th>').join('')
                + '</tr></thead><tbody>';
            FY_MONTHS.forEach(m => {
                const y = calYear(MR.fy, m);
                const isOpen = open.has(m);
                const idx = d.rows.map((r, i) => i).filter(i => inFy(d.rows[i], MR.fy) && parseInt(d.rows[i].month, 10) === m);
                const label = SHORT[m] + ' ' + y;
                h += '<tr class="mr-month' + (isOpen ? ' open' : '') + '"><th scope="row">'
                    + '<button type="button" class="mr-month-btn" data-act="toggle" data-arg="' + m + '" aria-expanded="' + isOpen
                    + '" aria-controls="mrFc' + m + '"><span class="mr-caret" aria-hidden="true">' + (isOpen ? '\u25BE' : '\u25B8') + '</span>' + label + '</button></th>'
                    + '<td class="center" data-total="c' + m + '"></td>'
                    + FC_SUM.map(k => '<td class="center" data-total="m' + m + k + '"></td>').join('') + '</tr>';
                if (!isOpen) return;
                // The opened month: its purchases, every field visible, plus "add".
                const min = y + '-' + pad2(m) + '-01', max = y + '-' + pad2(m) + '-' + pad2(lastDay(y, m));
                h += '<tr class="mr-detail" id="mrFc' + m + '"><td colspan="' + (2 + totalCols) + '">'
                    + '<table class="fp-table mr-grid mr-fc-in"><caption class="mr-sr">Purchases in ' + label + '</caption>'
                    + '<colgroup><col class="mr-c-date"><col class="mr-c-num"><col><col class="mr-c-num"><col class="mr-c-num"><col class="mr-c-nf"><col class="mr-c-x"></colgroup>'
                    + '<thead><tr>' + FC_FIELDS.map(c => '<th scope="col" class="center">' + esc(c[1]) + '</th>').join('')
                    + '<th scope="col"><span class="mr-sr">Remove</span></th></tr></thead><tbody>';
                if (!idx.length) h += '<tr><td colspan="7" class="mr-empty">No purchases in ' + label + ' yet.</td></tr>';
                idx.forEach((i, n) => {
                    const r = d.rows[i], row = label + ' purchase ' + (n + 1);
                    h += '<tr>' + FC_FIELDS.map(c => '<td>' + (c[0] === 'date'
                        ? '<input type="date" data-path="rows.' + i + '.date" value="' + esc(r.date || '') + '" min="' + min + '" max="' + max + '" aria-label="Date, ' + esc(row) + '">'
                        : c[2] === 'num'
                            ? numInput('rows.' + i + '.' + c[0], r[c[0]] || '', ' aria-label="' + esc(c[1]) + ', ' + esc(row) + '"')
                            : textInput('rows.' + i + '.' + c[0], r[c[0]] || '', c[1] + ', ' + row)) + '</td>').join('')
                        + '<td class="center"><button type="button" class="mr-x" data-act="delRow" data-arg="' + i + '" aria-label="Remove ' + esc(row) + '">\u2715</button></td></tr>';
                });
                h += '</tbody></table><button type="button" class="fp-btn mr-add" data-act="addRow" data-arg="' + m + '">+ Add purchase to ' + label + '</button></td></tr>';
            });
            h += '<tr class="mr-total"><th scope="row">Total</th><td class="center" data-total="call"></td>'
                + FC_SUM.map(k => '<td class="center" data-total="t' + k + '"></td>').join('') + '</tr></tbody></table></div>';

            // Never hide data: an entry whose Year/Month is not in this fiscal year is listed
            // here with every field (Year and Month included) so it can be corrected.
            const strays = d.rows.map((r, i) => i).filter(i => !inFy(d.rows[i], MR.fy));
            if (strays.length) {
                h += '<h4 class="mr-sub">Entries outside ' + fyLabel(MR.fy) + ' (not in the totals)</h4>'
                    + '<p class="mr-hint">Fix the Year and Month and each moves into its month above.</p>'
                    + '<div class="fp-table-wrap mr-fit"><table class="fp-table mr-grid mr-fc-in"><thead><tr>'
                    + FC_COLS.map(c => '<th scope="col">' + esc(c[1]) + '</th>').join('') + '<th scope="col"><span class="mr-sr">Remove</span></th></tr></thead><tbody>';
                strays.forEach(i => {
                    const r = d.rows[i];
                    h += '<tr>' + FC_COLS.map(c => '<td>' + (c[2] === 'num'
                        ? numInput('rows.' + i + '.' + c[0], r[c[0]] || '', ' aria-label="' + esc(c[1]) + '"')
                        : textInput('rows.' + i + '.' + c[0], r[c[0]] || '', c[1])) + '</td>').join('')
                        + '<td class="center"><button type="button" class="mr-x" data-act="delRow" data-arg="' + i + '" aria-label="Remove this entry">\u2715</button></td></tr>';
                });
                h += '</tbody></table></div>';
            }
            return h;
        },
        totals(d) {
            const t = {};
            const yr = d.rows.filter(r => inFy(r, MR.fy));
            FY_MONTHS.forEach(m => {
                const rows = yr.filter(r => parseInt(r.month, 10) === m);
                t['c' + m] = rows.length ? String(rows.length) : '';
                FC_SUM.forEach(k => { t['m' + m + k] = fmt(rows.reduce((s, r) => s + num(r[k]), 0)); });
            });
            t.call = String(yr.length);
            FC_SUM.forEach(k => { t['t' + k] = fmt(yr.reduce((s, r) => s + num(r[k]), 0)); });
            return t;
        },
        // Opening/closing a month changes nothing that is saved.
        viewOnly: { toggle: true },
        action(d, act, arg) {
            const open = fcOpenSet();
            if (act === 'toggle') {
                const m = +arg;
                if (open.has(m)) open.delete(m); else open.add(m);
            } else if (act === 'addRow') {
                const m = +arg;
                d.rows.push({ year: String(calYear(MR.fy, m)), month: String(m), date: '', amountPaid: '', vendor: '', milk: '', foodCost: '', nonFood: '' });
                open.add(m);
                MR.focus = 'rows.' + (d.rows.length - 1) + '.date';   // ready to type
            } else if (act === 'delRow') {
                const r = d.rows[+arg];
                const filled = r && Object.keys(r).some(k => k !== 'year' && k !== 'month' && String(r[k] || '').trim());
                if (!filled || confirm('Remove this purchase?')) d.rows.splice(+arg, 1);
            }
        },
    };

    /* A sheet saved before the allocation was calculated may still carry the hand-typed 5th
       line ("Overhead Costs"). If it is empty it is dropped, since the page now calculates
       it; if it holds figures it is kept for the user to review and remove, never deleted
       silently. */
    function upgradeOverhead(d) {
        if (d.allocPct == null) d.allocPct = OH_ALLOC_PCT;
        d.rows = (d.rows || []).filter(r => {
            const isOldAlloc = String(r.label || '').trim() === 'Overhead Costs';
            const empty = !Object.values(r.cells || {}).some(v => String(v || '').trim());
            return !(isOldAlloc && empty);
        });
    }
    // Overhead for one month: the cost lines, and the food program's share (to the cent).
    const ohMonthCost = (d, m) => d.rows.reduce((s, r) => s + num((r.cells || {})[m]), 0);
    const ohMonthAlloc = (d, m) => round2(ohMonthCost(d, m) * (Number(d.allocPct) || OH_ALLOC_PCT) / 100);
    // The year's allocation is the sum of the rounded months, so the row adds up across.
    const ohYearAlloc = d => round2(OH_MONTHS.reduce((s, m) => s + ohMonthAlloc(d, m), 0));
    const pctLabel = d => (Number(d.allocPct) || OH_ALLOC_PCT) + '%';

    /* Column widths for the "label + 12 months + total" sheets, so all twelve months fit
       on screen without a sideways scroll bar (fixed layout; the months share the rest). */
    const monthCols = withRemove => '<colgroup><col class="mr-c-label">' + FY_MONTHS.map(() => '<col>').join('')
        + '<col class="mr-c-total">' + (withRemove ? '<col class="mr-c-x">' : '') + '</colgroup>';

    // ── Overhead Costs: lines down, Oct..Sep across, total column; colour scale like the sheet ──
    const overhead = {
        html(d) {
            let h = '<div class="mr-sheet-head"><h3>Overhead Costs, ' + fyLabel(MR.fy) + '</h3><div class="mr-tools">'
                + '<button type="button" class="fp-btn" data-act="addRow">+ Add line</button></div></div>'
                + '<p class="mr-hint">Oct ' + MR.fy + ' to Sep ' + (MR.fy + 1) + '. Enter each bill; the Food Program share ('
                + pctLabel(d) + ' of the total) is calculated for you. Lines that change month to month are shaded low (green) to high (red).</p>'
                + '<div class="fp-table-wrap"><table class="fp-table mr-grid mr-wide">' + monthCols(true) + '<thead><tr><th scope="col">Line</th>'
                + OH_MONTHS.map(m => '<th scope="col" class="center">' + SHORT[m] + '</th>').join('') + '<th scope="col" class="center">Total</th><th scope="col"><span class="mr-sr">Remove</span></th></tr></thead><tbody>';
            d.rows.forEach((r, i) => {
                h += '<tr data-row="' + i + '"><th scope="row">' + textInput('rows.' + i + '.label', r.label, 'Line ' + (i + 1) + ' name') + '</th>'
                    + OH_MONTHS.map(m => '<td>' + numInput('rows.' + i + '.cells.' + m, (r.cells || {})[m] || '', ' data-scale="' + i + '" aria-label="' + esc(r.label) + ' ' + SHORT[m] + '"') + '</td>').join('')
                    + '<td class="right mr-strong" data-total="r' + i + '"></td>'
                    + '<td class="center"><button type="button" class="mr-x" data-act="delRow" data-arg="' + i + '" aria-label="Remove line ' + (i + 1) + '">✕</button></td></tr>';
            });
            h += '<tr class="mr-total"><th scope="row">Total overhead</th>' + OH_MONTHS.map(m => '<td class="right" data-total="m' + m + '"></td>').join('')
                + '<td class="right" data-total="all"></td><td></td></tr>'
                + '<tr class="mr-total mr-alloc"><th scope="row">Food Program share (' + pctLabel(d) + ')</th>'
                + OH_MONTHS.map(m => '<td class="right" data-total="a' + m + '"></td>').join('')
                + '<td class="right" data-total="aall"></td><td></td></tr></tbody></table></div>';
            return h;
        },
        totals(d) {
            const t = {};
            d.rows.forEach((r, i) => { t['r' + i] = fmt(OH_MONTHS.reduce((s, m) => s + num((r.cells || {})[m]), 0)); });
            OH_MONTHS.forEach(m => { t['m' + m] = fmt(ohMonthCost(d, m)); t['a' + m] = fmt(ohMonthAlloc(d, m)); });
            t.all = fmt(OH_MONTHS.reduce((s, m) => s + ohMonthCost(d, m), 0));
            t.aall = fmt(ohYearAlloc(d));
            t.__scale = box => {
                d.rows.forEach((r, i) => {
                    const cells = box.querySelectorAll('input[data-scale="' + i + '"]');
                    const vals = [...cells].map(c => cellValue(c.value)).filter(v => v.ok && !v.blank).map(v => v.value);
                    const lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
                    cells.forEach(c => {
                        const v = cellValue(c.value);
                        if (!v.ok || v.blank || vals.length < 2 || hi === lo) { c.style.background = ''; return; }
                        const f = (v.value - lo) / (hi - lo);          // 0 = lowest (green) .. 1 = highest (red)
                        const hue = Math.round(120 * (1 - f));
                        c.style.background = 'hsla(' + hue + ', 70%, 50%, 0.35)';
                    });
                });
            };
            return t;
        },
        action(d, act, arg) {
            if (act === 'addRow') d.rows.push({ label: 'New line', cells: {} });
            else if (act === 'delRow' && confirm('Remove the line "' + (d.rows[+arg] || {}).label + '"?')) d.rows.splice(+arg, 1);
        },
    };

    // ── Personnel Activity: staff down, Oct..Sep across, Operational and Admin totals ──
    const personnel = {
        html(d) {
            /* The month names sit on the Operational line itself (no separate header row
               above it), centred over their boxes. Admin's line is just its name. */
            const group = (g, title, withMonths) => {
                let h = withMonths
                    ? '<tr class="mr-group"><th scope="col">' + title + '</th>'
                        + FY_MONTHS.map(m => '<th scope="col" class="center">' + PER_LABEL[m] + '</th>').join('')
                        + '<th scope="col" class="center">Total</th><th scope="col"><span class="mr-sr">Remove</span></th></tr>'
                    : '<tr class="mr-group"><th colspan="15" scope="colgroup">' + title + '</th></tr>';
                d[g].forEach((p, i) => {
                    h += '<tr><th scope="row">' + textInput(g + '.' + i + '.name', p.name, title + ' name ' + (i + 1)) + '</th>'
                        + FY_MONTHS.map(m => '<td>' + numInput(g + '.' + i + '.cells.' + m, (p.cells || {})[m] || '', ' aria-label="' + esc(p.name) + ' ' + PER_LABEL[m] + '"') + '</td>').join('')
                        + '<td class="center mr-strong" data-total="' + g + 'r' + i + '"></td>'
                        + '<td class="center"><button type="button" class="mr-x" data-act="del" data-arg="' + g + ':' + i + '" aria-label="Remove ' + esc(p.name) + '">✕</button></td></tr>';
                });
                // "+ Add" on its own row: in the narrow last column it overflowed and caused the scroll bar.
                h += '<tr class="mr-addrow"><td colspan="15"><button type="button" class="fp-btn mr-mini" data-act="add" data-arg="' + g + '">+ Add ' + title + ' staff</button></td></tr>'
                    + '<tr class="mr-total"><th scope="row">' + title + ' total</th>' + FY_MONTHS.map(m => '<td class="center" data-total="' + g + 'm' + m + '"></td>').join('')
                    + '<td class="center" data-total="' + g + 'all"></td><td></td></tr>';
                return h;
            };
            return '<div class="mr-sheet-head"><h3>Personnel Activity Calculations, ' + fyLabel(MR.fy) + '</h3></div>'
                + '<div class="fp-table-wrap"><table class="fp-table mr-grid mr-wide">' + monthCols(true) + '<tbody>'
                + group('operational', 'Operational', true) + group('admin', 'Admin', false) + '</tbody></table></div>';
        },
        totals(d) {
            const t = {};
            ['operational', 'admin'].forEach(g => {
                d[g].forEach((p, i) => { t[g + 'r' + i] = fmt(FY_MONTHS.reduce((s, m) => s + num((p.cells || {})[m]), 0)); });
                FY_MONTHS.forEach(m => { t[g + 'm' + m] = fmt(d[g].reduce((s, p) => s + num((p.cells || {})[m]), 0)); });
                t[g + 'all'] = fmt(d[g].reduce((s, p) => s + FY_MONTHS.reduce((a, m) => a + num((p.cells || {})[m]), 0), 0));
            });
            return t;
        },
        action(d, act, arg) {
            if (act === 'add') d[arg].push({ name: 'New staff', cells: {} });
            else if (act === 'del') {
                const [g, i] = arg.split(':');
                if (confirm('Remove "' + (d[g][+i] || {}).name + '" from this year\u2019s sheet?')) d[g].splice(+i, 1);
            }
        },
    };

    const RENDER = { revenue, foodcosts, overhead, personnel };

    // ── Yearly Summary: one fiscal year, every sheet ──
    async function renderSummary(box, force) {
        const fy = MR.fy;
        const books = ['revenue', 'foodcosts', 'overhead', 'personnel'];
        const got = {}, failed = [];
        await Promise.all(books.map(b => load(b, fy, force).then(dc => { got[b] = dc.data; })
            .catch(e => { failed.push(SECTIONS.find(s => s.key === b).label + ' (' + (e.message || e) + ')'); })));
        const y = String(fy);
        const rev = got.revenue, fc = got.foodcosts, oh = got.overhead, pe = got.personnel;
        const fcMonth = (m, k) => fc ? fc.rows.filter(r => inFy(r, fy) && parseInt(r.month, 10) === m).reduce((s, r) => s + num(r[k]), 0) : NaN;
        const peMonth = (g, m) => pe ? pe[g].reduce((s, p) => s + num((p.cells || {})[m]), 0) : NaN;
        const revMonth = m => rev ? num(((rev.cells || {})[y] || {})[m]) : NaN;
        const cols = [
            ['Food Check', m => revMonth(m)],
            ['Amount Paid', m => fcMonth(m, 'amountPaid')], ['Food Cost', m => fcMonth(m, 'foodCost')],
            ['Non-Food', m => fcMonth(m, 'nonFood')], ['Milk (gal)', m => fcMonth(m, 'milk')],
            ['Overhead share', m => (oh ? ohMonthAlloc(oh, m) : NaN)],
            ['Personnel: Operational', m => peMonth('operational', m)], ['Personnel: Admin', m => peMonth('admin', m)],
        ];
        // A sheet that could not be read shows "?" rather than a confident 0.
        const show = v => (isFinite(v) ? fmt(v) : '?');
        let h = '<div class="mr-sheet-head"><h3>Yearly Summary, ' + fyLabel(fy) + '</h3><div class="mr-tools">'
            + '<button type="button" class="fp-btn" id="mrPrint">Print</button></div></div>';
        if (failed.length) h += '<div class="fp-error" style="margin-bottom:12px;">Could not read: ' + esc(failed.join('; '))
            + '. Those columns show "?" (not zero). Nothing has been lost; try again in a moment.</div>';
        h += '<p class="mr-hint">Oct ' + fy + ' to Sep ' + (fy + 1) + '. Read only; enter figures on each sheet.</p>'
            + '<div class="fp-table-wrap"><table class="fp-table mr-grid mr-wide" id="mrSumTable"><thead><tr><th scope="col">Month</th>'
            + cols.map(c => '<th scope="col" class="right">' + c[0] + '</th>').join('') + '</tr></thead><tbody>';
        FY_MONTHS.forEach(m => { h += '<tr><th scope="row">' + SHORT[m] + ' ' + calYear(fy, m) + '</th>' + cols.map(c => '<td class="right">' + show(c[1](m)) + '</td>').join('') + '</tr>'; });
        h += '<tr class="mr-total"><th scope="row">Year total</th>' + cols.map(c => '<td class="right">' + show(FY_MONTHS.reduce((s, m) => s + c[1](m), 0)) + '</td>').join('') + '</tr></tbody></table></div>';
        h += '<h4 class="mr-sub">Overhead Costs (Oct ' + fy + ' to Sep ' + (fy + 1) + ')</h4>';
        if (!oh) h += '<div class="fp-error">Overhead Costs could not be read.</div>';
        else {
            h += '<div class="fp-table-wrap"><table class="fp-table mr-grid mr-wide">' + monthCols(false) + '<thead><tr><th scope="col">Line</th>'
                + OH_MONTHS.map(m => '<th scope="col" class="right">' + SHORT[m] + '</th>').join('') + '<th scope="col" class="right">Total</th></tr></thead><tbody>';
            oh.rows.forEach(r => {
                h += '<tr><th scope="row">' + esc(r.label) + '</th>' + OH_MONTHS.map(m => '<td class="right">' + fmt(num((r.cells || {})[m])) + '</td>').join('')
                    + '<td class="right mr-strong">' + fmt(OH_MONTHS.reduce((s, m) => s + num((r.cells || {})[m]), 0)) + '</td></tr>';
            });
            h += '<tr class="mr-total"><th scope="row">Total overhead</th>' + OH_MONTHS.map(m => '<td class="right">' + fmt(ohMonthCost(oh, m)) + '</td>').join('')
                + '<td class="right">' + fmt(OH_MONTHS.reduce((s, m) => s + ohMonthCost(oh, m), 0)) + '</td></tr>'
                + '<tr class="mr-total mr-alloc"><th scope="row">Food Program share (' + pctLabel(oh) + ')</th>'
                + OH_MONTHS.map(m => '<td class="right">' + fmt(ohMonthAlloc(oh, m)) + '</td>').join('')
                + '<td class="right">' + fmt(ohYearAlloc(oh)) + '</td></tr></tbody></table></div>';
        }
        box.innerHTML = h;
        box.querySelector('#mrPrint').addEventListener('click', () => printSummary(box, fy));
    }

    function printSummary(box, fy) {
        const tables = [...box.querySelectorAll('table')].map(t => t.outerHTML).join('<br>');
        const heads = [...box.querySelectorAll('h4')].map(x => x.textContent);
        const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Food Program ' + fyLabel(fy) + ' Yearly Summary</title>'
            + '<style>body{font-family:Arial,sans-serif;margin:20px;color:#000}h1{font-size:16px}table{border-collapse:collapse;width:100%;font-size:11px;margin-top:8px}'
            + 'th,td{border:1px solid #999;padding:3px 5px}td{text-align:right}tr.mr-total{font-weight:bold;background:#eee}</style></head><body>'
            + '<h1>Children Of Promise: Food Program ' + fyLabel(fy) + ' Yearly Summary</h1>'
            + tables.replace('<br>', '<h2 style="font-size:13px">' + esc(heads[0] || 'Overhead Costs') + '</h2>') + '</body></html>';
        const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        const w = window.open(url, '_blank');
        if (!w) alert('Allow pop-ups for this site to print the summary.');
        else setTimeout(() => { try { w.print(); } catch (e) { /* print from the tab */ } }, 600);
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    window.addEventListener('beforeunload', e => { if (anyDirty()) { e.preventDefault(); e.returnValue = ''; } });

    window.MonthlyReporting = { open, anyDirty, _cellValue: cellValue, _blank: blank, _RENDER: RENDER, _MR: MR };
})();
