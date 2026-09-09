/* ══════════════════════════════════════════════════════════════════
   Shared plumbing for the PAS paper forms.

   These forms were print-only: staff printed them and wrote on them, which meant
   nothing was searchable, nothing could be reviewed without finding the paper, and
   a lost sheet was lost evidence. Rather than repeat a save/load block in each of
   them, a form declares what it is and this handles the rest.

   A form opts in with two things:

     1. Mark every blank as editable and give it a name:
            <div class="line" contenteditable="true" data-k="supervisor"></div>
        Ratings use a group and a value per cell:
            <td data-radio="job" data-val="E">&#9633;</td>

     2. Call PasForm.init({ key, scope, prefill }) at the end of the page.

   Editing is contenteditable rather than <input> on purpose: an input prints as a
   grey box with a border, which looks wrong on a document that goes in a staff
   file. A contenteditable div prints as the text on the ruled line it replaced.

   Storage is the shared PAS worksheet store, so these inherit its behaviour: one
   row per (form, scope) in the database, visible to everyone, no new table.

   NOTE ON PRIVACY: performance appraisals are HR records, and the worksheet store
   is readable by anyone holding the single shared staff password. That is a real
   difference from compliance evidence and is worth addressing before these are
   used in anger.
   ══════════════════════════════════════════════════════════════════ */

(function () {
    'use strict';
    if (window.PasForm) return;

    const TICKED = '\u2611';     // ballot box with check
    const EMPTY = '\u2610';      // empty ballot box

    let cfg = null;
    let staffList = [];
    let current = null;          // selected staff record, when the form is per-person
    let records = [];            // {id,label} index, when the form holds many records
    let recordId = null;         // which of them is on screen

    const $ = id => document.getElementById(id);
    const esc = s => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    function schoolYear(d) {
        const now = d || new Date();
        const start = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
        return start + '-' + (start + 1);
    }
    function yearOptions() {
        const y = schoolYear();
        const start = parseInt(y.slice(0, 4), 10);
        const out = [];
        for (let s = start; s >= start - 2; s--) out.push(s + '-' + (s + 1));
        return out;
    }

    /* There is no hire-date column on the staff record, but the notes consistently
       carry "At CofP since 10/15/2012" or "since 01/2016", so a start date can be read
       from there. Returns the precision as well, because a month-only note gives a day
       that was assumed rather than recorded and any form showing it should say so.
       Returns null rather than guessing when nothing can be read. */
    function hireDate(staff) {
        const text = String((staff && staff.Notes) || '');
        // Full date first, so "10/15/2012" is not read as October 2015.
        let m = text.match(/since\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
        if (m) return { d: new Date(+m[3], +m[1] - 1, +m[2]), precision: 'day' };
        m = text.match(/since\s+(\d{1,2})\/(\d{4})/i);
        if (m) return { d: new Date(+m[2], +m[1] - 1, 1), precision: 'month' };
        return null;
    }

    function fmtDate(d) {
        return d ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
    }

    /* Role and room read as one line on a form asking for a position. */
    function position(staff) {
        if (!staff) return '';
        return (staff.Role || '') + (staff.Classroom ? ' \u2014 ' + staff.Classroom : '');
    }

    /* The whole header set, not just the Basic one, so a staff member signed in as
       themselves can open and save their own copy of these forms. */
    function api(url, opts) {
        opts = opts || {};
        opts.headers = Object.assign({ 'Content-Type': 'application/json' },
            (window.CofpAuth && CofpAuth.headers) ? CofpAuth.headers() : {},
            opts.headers || {});
        return fetch(url, opts);
    }

    /* The storage key. Scope keeps one record per person per year where that is what
       the form is, and the double underscore is what the store splits on. */
    function storageKey() {
        const year = $('pfYear') ? $('pfYear').value : schoolYear();
        if (cfg.scope === 'staff-year') {
            if (!current) return null;
            return cfg.key + '__staff' + current.Id + '_' + year;
        }
        if (cfg.scope === 'staff') {
            if (!current) return null;
            return cfg.key + '__staff' + current.Id;
        }
        if (cfg.scope === 'year') return cfg.key + '__' + year;
        if (cfg.scope === 'list') return recordId ? cfg.key + '__' + recordId : null;
        return cfg.key;
    }

    /* ── many records of the same form ────────────────────────────────────
       Meeting minutes and survey responses happen repeatedly, so one row per year
       would mean each new one overwrote the last. These keep an index of records
       alongside them: the index is a list of {id, label} and each record is stored
       under its own id. The id is generated rather than taken from the label, so a
       label containing a slash or a name can never break the storage key. */
    function indexKey() { return cfg.key + '__index'; }

    function loadIndex() {
        records = [];
        const raw = PasStore.storage.getItem(indexKey());
        if (!raw) return;
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                records = parsed.filter(r => r && r.id).map(r => ({
                    id: String(r.id), label: String(r.label || r.id)
                }));
            }
        } catch (e) { records = []; }
    }

    function saveIndex() {
        PasStore.storage.setItem(indexKey(), JSON.stringify(records));
    }

    function newId() {
        // Short, unique, and safe in a storage key.
        let id = 'r' + Date.now().toString(36);
        while (records.some(r => r.id === id)) id += 'x';
        return id;
    }

    function renderRecordPicker() {
        const sel = $('pfRecord');
        if (!sel) return;
        const label = cfg.listLabel || 'Record';
        sel.innerHTML =
            '<option value="">' + (records.length ? '\u2014 choose \u2014' : 'None yet \u2014 add one') + '</option>'
            + records.map(r => '<option value="' + esc(r.id) + '">' + esc(r.label) + '</option>').join('')
            + '<option value="__new">\uff0b New ' + esc(label.toLowerCase()) + '\u2026</option>';
        sel.value = recordId || '';
    }

    function addRecord() {
        const label = cfg.listLabel || 'Record';
        const suggestion = cfg.newDefault ? cfg.newDefault() : '';
        const answer = prompt('Name this ' + label.toLowerCase()
            + ' so it can be found again (a date works well):', suggestion);
        if (answer === null) return false;           // cancelled
        const text = answer.trim() || suggestion || label + ' ' + (records.length + 1);
        const rec = { id: newId(), label: text };
        records.unshift(rec);                        // newest first: that is what gets opened
        saveIndex();
        recordId = rec.id;
        renderRecordPicker();
        return true;
    }

    // ── reading and writing the page ──────────────────────────────────────
    function collect() {
        const data = { fields: {}, ratings: {} };
        document.querySelectorAll('[data-k]').forEach(el => {
            data.fields[el.getAttribute('data-k')] = el.innerText.replace(/\u00a0/g, ' ').trim();
        });
        document.querySelectorAll('[data-radio][data-val]').forEach(el => {
            if (el.textContent.trim() === TICKED) {
                data.ratings[el.getAttribute('data-radio')] = el.getAttribute('data-val');
            }
        });
        return data;
    }

    function apply(data) {
        const f = (data && data.fields) || {};
        const r = (data && data.ratings) || {};
        document.querySelectorAll('[data-k]').forEach(el => {
            const k = el.getAttribute('data-k');
            // hasOwnProperty, so a field deliberately cleared comes back cleared.
            el.textContent = Object.prototype.hasOwnProperty.call(f, k) ? f[k] : '';
        });
        document.querySelectorAll('[data-radio][data-val]').forEach(el => {
            const group = el.getAttribute('data-radio');
            el.textContent = r[group] === el.getAttribute('data-val') ? TICKED : EMPTY;
        });
    }

    function clearPage() { apply({ fields: {}, ratings: {} }); }

    // Anything typed on the page, so a switch of person can warn before discarding.
    function hasContent() {
        const d = collect();
        return Object.keys(d.fields).some(k => d.fields[k]) || Object.keys(d.ratings).length > 0;
    }

    // ── status ────────────────────────────────────────────────────────────
    let dirty = false;
    function setStatus(text, colour) {
        const el = $('pfStatus');
        if (el) { el.textContent = text || ''; el.style.color = colour || '#166534'; }
    }
    function markDirty() {
        if (dirty) return;
        dirty = true;
        setStatus('Unsaved changes', '#92400e');
    }

    // ── save and load ─────────────────────────────────────────────────────
    async function save() {
        const key = storageKey();
        if (!key) {
            setStatus(cfg.scope === 'list'
                ? 'Add a ' + (cfg.listLabel || 'record').toLowerCase() + ' first, so this has '
                  + 'somewhere to be filed'
                : 'Choose a staff member first', '#b91c1c');
            return;
        }
        const btn = $('pfSave');
        if (btn) { btn.disabled = true; btn.textContent = 'Saving\u2026'; }
        try {
            const payload = collect();
            if (cfg.scope === 'staff-year' || cfg.scope === 'staff') {
                // Stamp who it belongs to, so a row is identifiable on its own.
                payload.staffId = String(current.Id);
                payload.staffName = current.Name;
            }
            if (cfg.scope === 'list') {
                const rec = records.find(r => r.id === recordId);
                if (rec) payload.recordLabel = rec.label;
            }
            payload.savedAt = new Date().toISOString();
            /* setItem writes through to the server and alerts on failure, so a
               refusal is never silent. Await nothing: it is fire-and-write-through. */
            PasStore.storage.setItem(key, JSON.stringify(payload));
            dirty = false;
            setStatus('\u2713 Saved');
            setTimeout(() => { if (!dirty) setStatus(''); }, 2500);
        } catch (e) {
            setStatus('\u26a0 NOT saved: ' + e.message, '#b91c1c');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '\ud83d\udcbe Save'; }
        }
    }

    function loadCurrent() {
        clearPage();
        const key = storageKey();
        let saved = null;
        if (key) {
            const raw = PasStore.storage.getItem(key);
            if (raw) { try { saved = JSON.parse(raw); } catch (e) { saved = null; } }
        }

        /* Prefill first, then let anything saved win, so a correction someone typed is
           never undone by the derived value it replaced. Per-staff forms only prefill
           once a person is selected; the second argument is the year, or the record
           label for a form that holds many records. */
        const perStaff = cfg.scope === 'staff-year' || cfg.scope === 'staff';
        if (cfg.prefill && (current || !perStaff)) {
            const rec = records.find(r => r.id === recordId);
            const context = cfg.scope === 'list'
                ? (rec ? rec.label : '')
                : ($('pfYear') ? $('pfYear').value : schoolYear());
            const pre = cfg.prefill(current, context) || {};
            Object.keys(pre).forEach(k => {
                const el = document.querySelector('[data-k="' + k + '"]');
                if (el) el.textContent = pre[k] == null ? '' : String(pre[k]);
            });
        }
        if (saved) apply(saved);

        dirty = false;
        // Lets a page refresh anything it derives from the page, such as a count.
        if (cfg.onLoad) { try { cfg.onLoad(); } catch (e) { /* never block loading */ } }
        if (!key) {
            setStatus(cfg.scope === 'list'
                ? 'Choose one of the saved ' + (cfg.listLabel || 'record').toLowerCase()
                  + 's above, or add a new one'
                : 'Choose a staff member first', '#64748b');
            return;
        }
        setStatus(saved ? 'Saved copy loaded' : 'Nothing saved yet for this selection', '#64748b');
    }

    // ── toolbar ───────────────────────────────────────────────────────────
    function toolbarHtml() {
        const perStaff = cfg.scope === 'staff-year' || cfg.scope === 'staff';
        const perYear = cfg.scope === 'staff-year' || cfg.scope === 'year';
        return '<div class="pf-toolbar no-print" id="pfToolbar">'
            + (perStaff
                ? '<strong>Staff:</strong> <select id="pfStaff"><option value="">Loading\u2026</option></select>'
                : '')
            + (cfg.scope === 'list'
                ? '<strong>' + esc(cfg.listLabel || 'Record') + ':</strong> <select id="pfRecord"></select>'
                : '')
            + (perYear
                ? ' <label>Year <select id="pfYear">'
                  + yearOptions().map(y => '<option value="' + y + '">' + y + '</option>').join('')
                  + '</select></label>'
                : '')
            + ' <button id="pfSave" class="pf-btn pf-save">\ud83d\udcbe Save</button>'
            + ' <button id="pfPrint" class="pf-btn pf-print">\ud83d\udda8\ufe0f Print</button>'
            + ' <span id="pfStatus" class="pf-status"></span>'
            + '<span class="pf-hint">Click any underlined space to type. Nothing needs printing '
            + 'unless you want a signed paper copy.'
            + (cfg.scope === 'list'
                ? ' Each ' + esc((cfg.listLabel || 'record').toLowerCase())
                  + ' is kept separately \u2014 add a new one rather than typing over an old one.'
                : '')
            + '</span>'
            + '</div>';
    }

    const TOOLBAR_CSS = `
        .pf-toolbar { position: sticky; top: 0; z-index: 60; background: #f8fafc;
            border-bottom: 1px solid #e2e8f0; padding: 9px 14px; margin-bottom: 16px;
            display: flex; flex-wrap: wrap; gap: 9px; align-items: center; font-size: 10pt; }
        .pf-toolbar select { padding: 5px 8px; border: 1px solid #cbd5e1; border-radius: 5px; font-size: 10pt; }
        .pf-btn { padding: 6px 13px; border: none; border-radius: 5px; font-size: 9.5pt;
            font-weight: 700; cursor: pointer; color: #fff; }
        .pf-btn:disabled { background: #94a3b8; cursor: default; }
        .pf-save { background: #16a34a; }
        .pf-print { background: #2c5282; }
        .pf-status { font-size: 9pt; font-weight: 700; }
        .pf-hint { font-size: 8.5pt; color: #64748b; flex-basis: 100%; }
        /* Editable spaces: visible to click on screen, invisible on paper. */
        [contenteditable="true"]:hover { background: #fcfcfd; }
        [contenteditable="true"]:focus { outline: none; background: #fffbeb;
            box-shadow: 0 0 0 2px rgba(245,158,11,0.25); }
        [contenteditable="true"]:empty::after { content: '\\00a0'; }
        [data-radio] { cursor: pointer; user-select: none; font-size: 12pt; }
        [data-radio]:hover { background: #eff6ff; }
        @media print {
            .pf-toolbar { display: none !important; }
            [contenteditable="true"] { background: none !important; box-shadow: none !important; }
        }`;

    async function init(options) {
        cfg = options || {};
        if (!cfg.key) throw new Error('PasForm.init needs a key');

        const style = document.createElement('style');
        style.textContent = TOOLBAR_CSS;
        document.head.appendChild(style);

        document.body.insertAdjacentHTML('afterbegin', toolbarHtml());

        // Every named blank becomes editable without each form repeating the attribute.
        document.querySelectorAll('[data-k]').forEach(el => {
            if (!el.hasAttribute('contenteditable')) el.setAttribute('contenteditable', 'true');
        });

        document.addEventListener('input', e => {
            if (e.target.hasAttribute && e.target.hasAttribute('data-k')) markDirty();
        });
        // One choice per rating row, so clicking a cell clears its siblings.
        document.addEventListener('click', e => {
            const cell = e.target.closest ? e.target.closest('[data-radio][data-val]') : null;
            if (!cell) return;
            const group = cell.getAttribute('data-radio');
            const already = cell.textContent.trim() === TICKED;
            document.querySelectorAll('[data-radio="' + group + '"]').forEach(c => {
                c.textContent = EMPTY;
            });
            // Clicking the ticked cell again clears the row, so a mistake is undoable.
            cell.textContent = already ? EMPTY : TICKED;
            markDirty();
        });

        $('pfSave').addEventListener('click', save);
        $('pfPrint').addEventListener('click', () => window.print());
        if ($('pfYear')) $('pfYear').addEventListener('change', loadCurrent);

        await PasStore.ready;

        if (cfg.scope === 'list') {
            loadIndex();
            // Open the newest on arrival: that is nearly always the one being worked on.
            recordId = records.length ? records[0].id : null;
            renderRecordPicker();
            const sel = $('pfRecord');
            sel.addEventListener('change', () => {
                if (dirty && !confirm('You have unsaved changes. Switch anyway and lose them?')) {
                    sel.value = recordId || '';
                    return;
                }
                if (sel.value === '__new') {
                    if (!addRecord()) { sel.value = recordId || ''; return; }
                } else {
                    recordId = sel.value || null;
                }
                loadCurrent();
            });
        }

        if (cfg.scope === 'staff-year' || cfg.scope === 'staff') {
            try {
                const res = await api('/api/staff');
                staffList = res.ok ? await res.json() : [];
                if (!Array.isArray(staffList)) staffList = [];
            } catch (e) { staffList = []; }
            // Ownership is included here: they are employees and get reviewed too.
            staffList = staffList.filter(s => String(s.Name || '').trim()
                && !/^new teacher$/i.test(s.Name));

            const sel = $('pfStaff');
            if (!staffList.length) {
                sel.innerHTML = '<option value="">No staff records found</option>';
            } else {
                sel.innerHTML = staffList.map(s =>
                    '<option value="' + s.Id + '">' + esc(s.Name) + '</option>').join('');
                const wanted = new URLSearchParams(location.search).get('staffId');
                if (wanted && staffList.some(s => String(s.Id) === String(wanted))) sel.value = wanted;
                current = staffList.find(s => String(s.Id) === String(sel.value)) || staffList[0];
                sel.addEventListener('change', () => {
                    if (dirty && !confirm('You have unsaved changes. Switch anyway and lose them?')) {
                        sel.value = current.Id;
                        return;
                    }
                    current = staffList.find(s => String(s.Id) === String(sel.value));
                    loadCurrent();
                });
            }
        }

        // Marks which selections already have a record, so the gap list is the dropdown.
        refreshPickerMarks();
        loadCurrent();

        window.addEventListener('beforeunload', e => {
            if (dirty) { e.preventDefault(); e.returnValue = ''; }
        });
    }

    /* A tick beside a name shows at a glance who has been done for the selected year,
       which is the question anyone opening an appraisal form actually has. */
    function refreshPickerMarks() {
        const sel = $('pfStaff');
        if (!sel || !staffList.length) return;
        const year = $('pfYear') ? $('pfYear').value : schoolYear();
        [...sel.options].forEach(opt => {
            const s = staffList.find(x => String(x.Id) === String(opt.value));
            if (!s) return;
            const key = cfg.scope === 'staff'
                ? cfg.key + '__staff' + s.Id
                : cfg.key + '__staff' + s.Id + '_' + year;
            opt.textContent = s.Name + (PasStore.storage.getItem(key) ? '  \u2713' : '  \u2014 not done');
        });
    }

    window.PasForm = {
        init: init,
        schoolYear: schoolYear,
        // Exposed so a page can add its own prefill logic or extra buttons.
        get current() { return current; },
        get staff() { return staffList; },
        save: save,
        reload: loadCurrent,
        refreshPickerMarks: refreshPickerMarks,
        // Derivations several forms need, kept in one place so they cannot drift apart.
        hireDate: hireDate,
        fmtDate: fmtDate,
        position: position,
        // The saved records of a list-scoped form, for a page that wants to summarise them.
        get records() { return records.slice(); }
    };
})();
