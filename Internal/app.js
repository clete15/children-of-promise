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
    if (document.getElementById(p + 'benCCAP')?.checked)     b.push('CCAP');
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
