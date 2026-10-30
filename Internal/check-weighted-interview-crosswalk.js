/* ══════════════════════════════════════════════════════════════════════════
   Cross-check: every weighted-eligibility input flows pre-enrollment → interview.

   The promise of the generate-and-file Parent Interview is that nothing the
   weighted-eligibility score is built from is lost between the family's
   pre-enrollment application and the interview document we hand them to sign. If a
   factor drives a child's priority score but never reaches the interview, the
   interviewer either re-asks the family a question we already have the answer to, or
   the answer never lands in the child's file — the exact failure this feature exists
   to remove.

   This proves that invariant mechanically, so it cannot quietly rot the way two
   hand-maintained copies of a mapping always eventually do. For every intake field
   that ANY weighted criterion reads, it asserts:

     (1) TRACES TO INTAKE — the field is actually returned by /api/student-intake, so
         the pre-enrollment application is where its value comes from; and
     (2) FLOWS TO INTERVIEW — the field is read by some PI_INTERVIEW_PREFILL rule
         (so it is carried onto the Parent Interview), OR it is listed below as a
         documented, intentional exclusion.

   It reads the three sources of truth directly — SEEDED_WEIGHTED_CRITERIA and the
   /api/student-intake column list from server.js, and PI_INTERVIEW_PREFILL from
   pi-interview-schema.js — rather than a copied list, so adding a criterion or
   dropping a mapping is caught here the next time this runs.

   Run by hand before committing a change to either file:  node check-weighted-interview-crosswalk.js
   Exit 0 = every weighted input is accounted for; exit 1 = something is not.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, 'server.js');
const serverSrc = fs.readFileSync(SERVER, 'utf8');
const schema = require('./pi-interview-schema.js');

const out = [];
const problems = [];

/* A one-level Proxy over a record (intake or enrollment) that logs every field
   read against it into `sink`, then returns a plain-string leaf. A string leaf is
   enough because the rules only ever do simple things with a field value —
   String(x||''), x.split(' '), piBenefitList(x), a truthiness test — never a
   further property chain, so there is no need for nested recording proxies.

   `leaf` is the value every field read returns. It matters because the rules use
   `||` to express precedence (c.enr.X || c.pe.X, or c.pe.City || c.enr.City_Town),
   and JavaScript short-circuits `||`: whichever side is truthy hides the other from
   a single run. So each rule is run twice — once with this record truthy and the
   other falsy, once the reverse (see below) — and the field reads are unioned, which
   explores BOTH sides of every `||` regardless of which way precedence runs. */
function recorder(sink, leaf) {
    return new Proxy({}, {
        get(_t, prop) {
            if (typeof prop === 'symbol') return undefined;
            sink.add(String(prop));
            return leaf;
        }
    });
}

/* ── 1. The intake fields each weighted criterion reads ──────────────────────
   Pull the SEEDED_WEIGHTED_CRITERIA array literal straight out of server.js and
   evaluate just that literal in a sandbox, with the helper functions it calls
   stubbed so they still touch their arguments (which is all we are measuring).
   Each criterion's from() is then run with recording proxies for the intake (i)
   and enrollment (e) records; the i-side reads are the weighted inputs. */
const critMatch = serverSrc.match(/const SEEDED_WEIGHTED_CRITERIA = (\[[\s\S]*?\n\]);/);
if (!critMatch) {
    console.error('Could not find SEEDED_WEIGHTED_CRITERIA in server.js. If it was renamed or reformatted, update this check.');
    process.exit(1);
}
// Helper stubs: identity-ish, but they READ their arguments so the proxy records.
const sandbox = {
    seededYesNoOrBlank: v => String(v == null ? '' : v),
    isCcapEligibleByIncome: (a, b) => (String(a), String(b), false),
    hasBenefit: (s, n) => (String(s), String(n), false),
    isChildDesertCity: c => (String(c), false)
};
let SEEDED_WEIGHTED_CRITERIA;
try {
    // eslint-disable-next-line no-new-func
    SEEDED_WEIGHTED_CRITERIA = new Function(
        'seededYesNoOrBlank', 'isCcapEligibleByIncome', 'hasBenefit', 'isChildDesertCity',
        'return ' + critMatch[1] + ';'
    )(sandbox.seededYesNoOrBlank, sandbox.isCcapEligibleByIncome, sandbox.hasBenefit, sandbox.isChildDesertCity);
} catch (e) {
    console.error('Could not evaluate SEEDED_WEIGHTED_CRITERIA: ' + e.message);
    process.exit(1);
}

const TRUE_LEAF = 'x';   // non-empty → truthy for `||`
const FALSE_LEAF = '';   // empty    → falsy  for `||`

/* Run fn once with the first arg's record truthy and the rest falsy, then rotate,
   so every branch of every `||` is explored. `argCount` is how many record args fn
   takes; returns the union of reads against the record at index `wantIdx`. */
function readsOf(fn, argCount, wantIdx) {
    const reads = new Set();
    for (let truthy = 0; truthy < argCount; truthy++) {
        const sinks = [];
        const args = [];
        for (let i = 0; i < argCount; i++) {
            const s = new Set();
            sinks.push(s);
            args.push(recorder(s, i === truthy ? TRUE_LEAF : FALSE_LEAF));
        }
        try { fn.apply(null, args); } catch (e) { /* value-shape quirk; reads still captured */ }
        sinks[wantIdx].forEach(f => reads.add(f));
    }
    return reads;
}

const weightedIntakeFields = new Set();
const fieldToCriteria = {};   // field -> [labels] for a readable report
SEEDED_WEIGHTED_CRITERIA.forEach(c => {
    // from(i, e): i is the intake record (index 0), e the enrollment fallback.
    const reads = readsOf(c.from.bind(c), 2, 0);
    reads.forEach(f => {
        weightedIntakeFields.add(f);
        (fieldToCriteria[f] = fieldToCriteria[f] || []).push(c.label);
    });
});

/* ── 2. The intake keys /api/student-intake actually returns ─────────────────
   The endpoint ends with an explicit `const keys = [ ... ]` array naming every
   column it emits, in order. That is the authoritative list of what "traces to
   intake" means, so read it rather than re-deriving it. */
const keysMatch = serverSrc.match(/const keys = (\[[^\]]*'MatchType'[^\]]*\]);/);
if (!keysMatch) {
    console.error('Could not find the /api/student-intake keys array in server.js.');
    process.exit(1);
}
let intakeKeys;
try { intakeKeys = JSON.parse(keysMatch[1].replace(/'/g, '"')); }
catch (e) { console.error('Could not parse the intake keys array: ' + e.message); process.exit(1); }
const intakeKeySet = new Set(intakeKeys);

/* ── 3. The intake (pe) fields each PI_INTERVIEW_PREFILL rule reads ───────────
   Run every crosswalk rule with a recording context. We only care about c.pe.*
   reads — those are the pre-enrollment intake fields carried onto the interview.
   c.enr.* (enrollment) and the derived c.parentName / c.language / c.isFoster are
   recorded too but not required here. */
const prefillPeFields = new Set();
schema.PI_INTERVIEW_PREFILL.forEach(rule => {
    // The rule takes one ctx with both records on it. Run twice so a `||` that puts
    // enrollment first (c.enr.X || c.pe.X) still reveals its c.pe.X fallback, and a
    // `||` that puts pe first (c.pe.City || c.enr.City_Town) still runs.
    [[TRUE_LEAF, FALSE_LEAF], [FALSE_LEAF, TRUE_LEAF]].forEach(([enrLeaf, peLeaf]) => {
        const peReads = new Set();
        const ctx = {
            enr: recorder(new Set(), enrLeaf),
            pe: recorder(peReads, peLeaf),
            parentName: '', language: '', isFoster: false
        };
        try { rule[1](ctx); } catch (e) { /* value-shape quirk; reads still captured */ }
        peReads.forEach(f => prefillPeFields.add(f));
    });
});

/* ── Documented, intentional exclusions ──────────────────────────────────────
   A weighted input that is deliberately NOT mapped onto the interview, each with
   the reason it is safe to leave out. Anything here is exempt from the "flows to
   interview" assertion; anything NOT here must flow. Keep the reasons honest — a
   wrong entry here is how a real gap would hide. */
const INTERVIEW_EXCLUSIONS = {
    // (Currently none. Every weighted input maps onto the interview. If a future
    //  criterion reads an intake field that genuinely should not appear on the
    //  parent-facing form, add it here WITH the reason — never just to silence the
    //  check. An empty set means the stronger thing: nothing is excluded.)
};

/* ── Assertions ──────────────────────────────────────────────────────────────── */
const notInIntake = [];
const notInInterview = [];
[...weightedIntakeFields].sort().forEach(field => {
    if (!intakeKeySet.has(field)) notInIntake.push(field);
    if (!prefillPeFields.has(field) && !INTERVIEW_EXCLUSIONS[field]) notInInterview.push(field);
});

out.push('=== Weighted-eligibility → Parent Interview crosswalk check ===');
out.push('');
out.push('Weighted criteria:                 ' + SEEDED_WEIGHTED_CRITERIA.length);
out.push('Distinct intake fields they read:  ' + weightedIntakeFields.size);
out.push('/api/student-intake columns:       ' + intakeKeySet.size);
out.push('Fields the interview prefill reads: ' + prefillPeFields.size);
out.push('');

out.push('--- (1) Every weighted input traces to /api/student-intake ---');
if (notInIntake.length) {
    notInIntake.forEach(f => out.push('  MISSING  ' + f.padEnd(22) + '← used by: ' + fieldToCriteria[f].join('; ')));
    problems.push(notInIntake.length + ' weighted input(s) are NOT returned by /api/student-intake');
} else {
    out.push('  OK — all ' + weightedIntakeFields.size + ' trace to intake.');
}
out.push('');

out.push('--- (2) Every weighted input flows to the Parent Interview ---');
if (notInInterview.length) {
    notInInterview.forEach(f => out.push('  MISSING  ' + f.padEnd(22) + '← used by: ' + fieldToCriteria[f].join('; ')));
    problems.push(notInInterview.length + ' weighted input(s) do NOT flow to the interview (and are not documented exclusions)');
} else {
    out.push('  OK — all weighted inputs either map onto the interview or are documented exclusions.');
}
if (Object.keys(INTERVIEW_EXCLUSIONS).length) {
    out.push('');
    out.push('  Documented exclusions:');
    Object.keys(INTERVIEW_EXCLUSIONS).forEach(f => out.push('    - ' + f + ': ' + INTERVIEW_EXCLUSIONS[f]));
}
out.push('');

out.push(problems.length ? ('FAIL — ' + problems.join('; ')) : 'PASS — every weighted input traces to intake and flows to the interview.');

console.log(out.join('\n'));
process.exit(problems.length ? 1 : 0);
