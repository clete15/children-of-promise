/* ══════════════════════════════════════════════════════════════════
   Children Of Promise — Shared staff app module
   Loaded as a classic script (globals) by every staff page.
   Contains auth, API access, eligibility thresholds, shared data
   loading, and small formatting/compare helpers.
   ══════════════════════════════════════════════════════════════════ */

// ── AUTH / API ──
// Authorization is deliberately NOT set here. The browser attaches the
// staff Basic credentials to same-origin requests by itself, so hardcoding
// the password would ship it to every visitor and break on every rotation.

/* Credentials come from a sign-in, never from source. Asking CofpAuth for the
   whole header set rather than just the Basic one is what lets an individual staff
   member use these pages: their browser carries a session token instead of the
   shared password, and the server scopes the answer to them. Reading only the
   Basic header here would have left every page working for the director and
   silently unauthorised for everyone else. */
function apiFetch(url, opts = {}) {
    opts.headers = Object.assign({ 'Content-Type': 'application/json' },
        (window.CofpAuth && CofpAuth.headers) ? CofpAuth.headers() : {},
        opts.headers || {});
    return fetch(url, opts);
}

// ── ELIGIBILITY THRESHOLDS ──
/* The server (Internal/server.js) is the single source of truth for these numbers,
   because it computes the value that actually gets saved. Each page fetches them at
   load via loadGuidelines() below, so the tables only need updating in ONE place.

   The tables below are a FALLBACK, used only if that fetch fails (offline, or an old
   server) so eligibility hints still render. Keep them roughly current, but the server
   copy is authoritative — if the two ever disagree, the server wins on save. */
const USDA_GUIDELINES = {
    2025: { free: [20163,27339,34515,41691,48867,56043,63219,70395], reduced: [28694,38907,49120,59333,69546,79759,89972,100185] },
    2026: { free: [20748,28132,35516,42900,50284,57668,65052,72436], reduced: [29526,40034,50542,61050,71558,82066,92574,103082] },
};
const CCAP_GUIDELINES = {
    2025: [35213,47588,59963,72338,84713,97088,109463,121838],
    2026: [35910,48690,61470,74250,87030,99810,112590,125370],
};

const _now = new Date();
const _usdaYear = _now.getMonth() >= 6 ? _now.getFullYear() : _now.getFullYear() - 1;
const _guidelines = USDA_GUIDELINES[_usdaYear] || USDA_GUIDELINES[Object.keys(USDA_GUIDELINES).pop()];
// These are `let` so loadGuidelines() can replace them with the server's authoritative
// tables. computeFRP/isCCAPEligible read them at call time, so a later swap is safe.
let USDA_FREE_THRESHOLDS = _guidelines.free;
let USDA_REDUCED_THRESHOLDS = _guidelines.reduced;
let CCAP_THRESHOLDS = CCAP_GUIDELINES[_usdaYear] || CCAP_GUIDELINES[Object.keys(CCAP_GUIDELINES).pop()];
let _thresholdsExpired = !USDA_GUIDELINES[_usdaYear] || !CCAP_GUIDELINES[_usdaYear];

/* Pull the authoritative guidelines from the server. Called alongside loadStudents/
   loadClassrooms in each page's init(), so the tables are fresh before anything renders.
   On any failure it silently keeps the fallback tables above. */
async function loadGuidelines() {
    try {
        const res = await apiFetch('/api/frp-guidelines');
        if (!res.ok) return;
        const g = await res.json();
        if (Array.isArray(g.usdaFree) && Array.isArray(g.usdaReduced) && Array.isArray(g.ccap)) {
            USDA_FREE_THRESHOLDS = g.usdaFree;
            USDA_REDUCED_THRESHOLDS = g.usdaReduced;
            CCAP_THRESHOLDS = g.ccap;
            _thresholdsExpired = false;
        }
    } catch (e) { /* keep the fallback tables */ }
}

// ── SHARED DATA ──
let students = [];
let classrooms = [];

// Pure loaders: fetch and store only. Each page renders after awaiting these.
async function loadClassrooms() {
    try {
        const res = await apiFetch('/api/classrooms');
        classrooms = await res.json();
    } catch (e) {
        showNotification('Failed to load classrooms', 'error');
    }
    return classrooms;
}

async function loadStudents() {
    try {
        const res = await apiFetch('/api/students');
        students = await res.json();
    } catch (e) {
        showNotification('Failed to load students', 'error');
    }
    return students;
}

function getClassroom(roomNumber) {
    return classrooms.find(r => String(r.RoomNumber) === String(roomNumber));
}

function getRoomName(roomNumber) {
    const c = getClassroom(roomNumber);
    return c ? c.Room : '';
}

/* Shared room-picker sidebar. Enrolled Students and Benefits both list every room as
   a button with a name and a per-room note; only the note text, the highlighted room,
   the click handler and the CSS class prefix differ. This renders the common shell so
   each page supplies just those.

   opts:
     el          the sidebar container element (or its id)
     activeRoom  the RoomNumber currently selected (string/number)
     onSelect    name of the global click handler, called as onSelect('<RoomNumber>')
     note        (roomNumber) => HTML for the secondary line (omitted when empty)
     nameHtml    (room) => HTML for the room-name line (defaults to the room name)
     classPrefix 'em' or 'bn' — picks the existing .<prefix>-room name style
     noteClass   CSS class for the secondary line (defaults to '<prefix>-room-count')
   Rooms come from the shared `classrooms` model in room-number order. */
function renderRoomSidebar(opts) {
    const el = typeof opts.el === 'string' ? document.getElementById(opts.el) : opts.el;
    if (!el) return;
    const p = opts.classPrefix || 'em';
    const noteClass = opts.noteClass || (p + '-room-count');
    el.innerHTML = classrooms.map(r => {
        const rn = r.RoomNumber;
        const on = String(opts.activeRoom) === String(rn);
        const note = opts.note ? opts.note(rn) : '';
        const name = opts.nameHtml ? opts.nameHtml(r) : (r.Room || rn);
        return `<button class="${on ? 'active' : ''}" onclick="${opts.onSelect}('${rn}')">`
            + `<div class="${p}-room">${name}</div>`
            + (note ? `<div class="${noteClass}">${note}</div>` : '')
            + `</button>`;
    }).join('');
}

// ── HELPERS ──
function isTruthy(v) {
    if (v === true || v === 1 || v === '1') return true;
    if (typeof v === 'string') return v.toLowerCase() === 'yes';
    return false;
}

// Alphabetical by last name, then first name (case/accent insensitive).
function sortByName(a, b) {
    const cmp = (a.Last_Name || '').localeCompare(b.Last_Name || '', undefined, { sensitivity: 'base' });
    return cmp !== 0 ? cmp : (a.First_Name || '').localeCompare(b.First_Name || '', undefined, { sensitivity: 'base' });
}

// Room number first, then alphabetical by name within the room.
function sortByRoomThenName(a, b) {
    const ra = parseInt(a.RoomNumber), rb = parseInt(b.RoomNumber);
    const aNum = isNaN(ra) ? Infinity : ra, bNum = isNaN(rb) ? Infinity : rb;
    if (aNum !== bNum) return aNum - bNum;
    return sortByName(a, b);
}

function formatDateInput(val) {
    if (!val) return '';
    const d = new Date(val);
    if (isNaN(d)) return '';
    return d.toISOString().split('T')[0];
}

// Normalize legacy pay type values to the current option set.
function normalizePayType(raw) {
    const cat = (raw || '').trim();
    const up = cat.toUpperCase();
    if (up === 'CHASI' || up === 'CCAP') return 'CCAP';
    if (up === 'DCFS' || up === 'FOSTER') return 'Foster';
    if (cat === '1/2 price' || up === 'HALF PRICE') return 'Half Price';
    if (up === 'STAFF') return 'Free';
    if (up === 'PAID') return 'Paid';
    if (up === 'FREE') return 'Free';
    return cat;
}

/* Asks for a child's LAST DAY ATTENDED when they are being marked inactive, so the
   enrollment history knows when they left (they drop off the roster the day after).
   Resolves to 'YYYY-MM-DD', or null if cancelled — callers must not save on null.
   A real <dialog> with a date picker, keyboard and screen-reader friendly. */
function askLastDay(childName) {
    const pad = n => String(n).padStart(2, '0');
    const now = new Date();
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    if (typeof HTMLDialogElement === 'undefined') {
        // Very old browser: fall back to a typed date.
        const v = prompt('Last day ' + childName + ' attended (YYYY-MM-DD):', today);
        if (v === null) return Promise.resolve(null);
        const t = String(v).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || t > today) { alert('Please enter a date that is not in the future, as YYYY-MM-DD.'); return Promise.resolve(null); }
        return Promise.resolve(t);
    }
    return new Promise(resolve => {
        const dlg = document.createElement('dialog');
        dlg.setAttribute('aria-labelledby', 'ldTitle');
        dlg.style.cssText = 'border:1px solid var(--sp-border,#cbd5e1);border-radius:10px;padding:18px 20px;max-width:360px;'
            + 'background:var(--sp-surface,#fff);color:var(--sp-text,#0f172a);box-shadow:0 10px 30px rgba(0,0,0,0.25);';
        dlg.innerHTML =
            '<form method="dialog" style="margin:0;">'
            + '<h3 id="ldTitle" style="margin:0 0 6px;font-size:1rem;"></h3>'
            + '<p style="margin:0 0 12px;font-size:0.82rem;color:var(--sp-muted,#64748b);">They stay on the roster through this day and drop off the day after.</p>'
            + '<label for="ldDate" style="display:block;font-size:0.8rem;font-weight:700;margin-bottom:4px;">Last day attended</label>'
            + '<input type="date" id="ldDate" required style="width:100%;padding:6px 8px;font-size:0.9rem;box-sizing:border-box;">'
            + '<p id="ldErr" role="alert" style="margin:6px 0 0;font-size:0.78rem;color:#dc2626;min-height:1em;"></p>'
            + '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px;">'
            + '<button type="button" id="ldCancel" style="padding:6px 14px;">Cancel</button>'
            + '<button type="submit" id="ldOk" style="padding:6px 14px;font-weight:700;">Mark inactive</button>'
            + '</div></form>';
        dlg.querySelector('#ldTitle').textContent = 'When did ' + childName + ' leave?';
        const input = dlg.querySelector('#ldDate');
        input.value = today;
        input.max = today;
        document.body.appendChild(dlg);
        let result = null;
        const done = () => { dlg.remove(); resolve(result); };
        dlg.querySelector('#ldCancel').addEventListener('click', () => { result = null; dlg.close(); });
        dlg.querySelector('form').addEventListener('submit', e => {
            const v = input.value;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || v > today) {
                e.preventDefault();
                dlg.querySelector('#ldErr').textContent = 'Pick a date that is not in the future.';
                return;
            }
            result = v;
        });
        dlg.addEventListener('close', done);
        dlg.showModal();
        input.focus();
    });
}

function showNotification(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `notification ${type}`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
}

// ── FOOD PROGRAM (F/R/P) ──
// Reads benefit checkboxes for a given id prefix.
function collectBenefits(prefix) {
    const p = prefix || '';
    const b = [];
    if (document.getElementById(p + 'benWIC')?.checked)      b.push('WIC');
    if (document.getElementById(p + 'benMedicaid')?.checked) b.push('Medicaid');
    if (document.getElementById(p + 'benSNAP')?.checked)     b.push('SNAP');
    if (document.getElementById(p + 'benTANF')?.checked)     b.push('TANF');
    // CCAP is a pay type (Category), not a public benefit — it is not collected here.
    return b.join(', ');
}

// Pure F/R/P computation. Free is categorical (benefits, foster, military, PFA)
// or income at/below the free threshold; Reduced is at/below the reduced threshold.
function computeFRP({ income, householdSize, benefits, isFoster, isMilitary, isPFA }) {
    const inc = parseInt(income) || 100000;
    const idx = Math.max(1, Math.min(parseInt(householdSize) || 1, 8)) - 1;
    if (benefits || isFoster || isMilitary || isPFA || inc <= USDA_FREE_THRESHOLDS[idx]) return 'Free';
    if (inc <= USDA_REDUCED_THRESHOLDS[idx]) return 'Reduced';
    return 'Paid';
}

// DOM wrapper used by the enrollment form: reads inputs, writes the result field.
function calcFRP(incomeId, sizeId, outputId, benefitsPrefix) {
    const p = benefitsPrefix || '';
    const frp = computeFRP({
        income: document.getElementById(incomeId)?.value,
        householdSize: document.getElementById(sizeId)?.value,
        benefits: collectBenefits(benefitsPrefix),
        isFoster: document.getElementById(p + 'category')?.value === 'Foster',
        isMilitary: document.getElementById(p + 'military')?.checked,
        isPFA: document.getElementById('pfaPiNa')?.value === 'PFA',
    });
    const out = document.getElementById(outputId);
    if (out) out.value = frp;
}

// True when a student's income/household size falls at or below the CCAP threshold.
function isCCAPEligible(s) {
    if (!isTruthy(s.Active)) return false;
    if (s.Category === 'CCAP' || s.Category === 'Foster') return false;
    const income = parseInt(s.HouseholdIncome) || 0;
    const hh = parseInt(s.HouseholdSize) || 0;
    if (!income || !hh) return false;
    return income <= CCAP_THRESHOLDS[Math.max(0, Math.min(hh - 1, 7))];
}

// ── THEME (light / dark) ──
/* One toggle for the whole staff app. The choice is remembered per browser under
   the same key the staff portal uses (copStaffTheme), so picking dark on one page
   makes every page dark. First-time visitors follow the operating system; once
   someone chooses, that sticks. The class is applied as soon as this script runs
   so pages don't flash light and then switch. */
const THEME_KEY = 'copStaffTheme';

function prefersDark() {
    try {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (e) { return false; }
}

function applyTheme(dark) {
    document.body.classList.toggle('sp-dark', !!dark);
    // Keep <html> in step with <body>. A pre-paint <head> script sets html.sp-dark to
    // avoid a light→dark flash; toggling must clear it too or light mode would stay dark.
    document.documentElement.classList.toggle('sp-dark', !!dark);
    const btn = document.getElementById('spTheme');
    if (btn) {
        // Names what clicking does, not what is currently on.
        btn.textContent = dark ? '\u2600 Light mode' : '\u263e Dark mode';
        btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
    }
}

function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* private browsing */ }
    applyTheme(saved === null ? prefersDark() : saved === 'dark');

    const btn = document.getElementById('spTheme');
    if (btn) {
        btn.addEventListener('click', () => {
            const dark = !document.body.classList.contains('sp-dark');
            applyTheme(dark);
            try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch (e) {}
        });
    }
}

/* Run now if the body is already parsed (app.js is loaded at the end of the body on
   these pages), otherwise wait for it. Either way the button — which lives in the
   page header — exists before we attach the click handler. */
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTheme);
} else {
    initTheme();
}

// ── DISPLAY FORMATTERS ──
/* Small, shared display helpers so every page formats the same way. They only
   change how a value is shown, never what is stored. */

// "6184406114" -> "618-440-6114". Leaves anything that isn't a 10-digit (or
// 11-digit leading-1) US number untouched, so odd data still shows as entered.
function fmtPhone(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    const d = s.replace(/\D/g, '');
    if (d.length === 10) return d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
    if (d.length === 11 && d[0] === '1') return d.slice(1, 4) + '-' + d.slice(4, 7) + '-' + d.slice(7);
    return s;
}

// 50400 -> "50,400". Non-numeric input is returned unchanged.
function fmtMoney(v) {
    if (v == null || v === '') return '';
    const n = Number(String(v).replace(/[^0-9.-]/g, ''));
    if (!isFinite(n)) return String(v);
    return n.toLocaleString('en-US');
}
