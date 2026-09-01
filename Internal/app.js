/* ══════════════════════════════════════════════════════════════════
   Children Of Promise — Shared staff app module
   Loaded as a classic script (globals) by every staff page.
   Contains auth, API access, eligibility thresholds, shared data
   loading, and small formatting/compare helpers.
   ══════════════════════════════════════════════════════════════════ */

// ── AUTH / API ──
const AUTH = 'Basic ' + btoa(':cofpadmin');

function apiFetch(url, opts = {}) {
    opts.headers = Object.assign({ 'Authorization': AUTH, 'Content-Type': 'application/json' }, opts.headers || {});
    return fetch(url, opts);
}

// ── ELIGIBILITY THRESHOLDS ──
// USDA Income Eligibility Guidelines — each entry is effective July 1 of that
// year through June 30 of the next. Only official published numbers, no estimates.
const USDA_GUIDELINES = {
    2025: { free: [20163,27339,34515,41691,48867,56043,63219,70395], reduced: [28694,38907,49120,59333,69546,79759,89972,100185] },
    2026: { free: [20748,28132,35516,42900,50284,57668,65052,72436], reduced: [29526,40034,50542,61050,71558,82066,92574,103082] },
};
// Illinois CCAP eligibility (225% FPL) — update annually when IL DHS publishes.
const CCAP_GUIDELINES = {
    2025: [35213,47588,59963,72338,84713,97088,109463,121838],
    2026: [35910,48690,61470,74250,87030,99810,112590,125370],
};

const _now = new Date();
const _usdaYear = _now.getMonth() >= 6 ? _now.getFullYear() : _now.getFullYear() - 1;
const _guidelines = USDA_GUIDELINES[_usdaYear] || USDA_GUIDELINES[Object.keys(USDA_GUIDELINES).pop()];
const USDA_FREE_THRESHOLDS = _guidelines.free;
const USDA_REDUCED_THRESHOLDS = _guidelines.reduced;
const CCAP_THRESHOLDS = CCAP_GUIDELINES[_usdaYear] || CCAP_GUIDELINES[Object.keys(CCAP_GUIDELINES).pop()];
const _thresholdsExpired = !USDA_GUIDELINES[_usdaYear] || !CCAP_GUIDELINES[_usdaYear];

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
