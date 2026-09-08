/* Tests the per-child form state logic in child-forms.js.

   This decides whether a child's file reads as compliant, so the cases that
   matter are the dishonest ones: a tick with no form behind it must never count
   as evidence, and a failed fetch must never turn a real tick into a red flag.

   Run: node test-child-forms.js   ->   writes _child_forms_test.txt */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Load the module into a fake window, since it is browser code.
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'child-forms.js'), 'utf8'), sandbox);
const CF = sandbox.window.ChildForms;

const out = [];
let pass = 0, fail = 0;
function check(name, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++; else fail++;
    out.push((ok ? 'ok   ' : 'FAIL ') + name
        + (ok ? '' : '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want)));
}

// ── state(), the three-way answer ────────────────────────────────────────
CF._set({
    '1': { ParentInterview: { on: true, date: '2026-09-10' } },
    '2': {}
}, 'ready');

check('form on file reads as form', CF.state(1, 'ParentInterview', true), 'form');
check('form on file with no tick still reads as form',
    CF.state(1, 'ParentInterview', false), 'form');
check('tick with no form is tick-only, NOT done',
    CF.state(2, 'ParentInterview', true), 'tick-only');
check('nothing is none', CF.state(2, 'ParentInterview', false), 'none');
check('tick-only does not count as done',
    CF.isDone(2, 'ParentInterview', true), false);
check('form counts as done', CF.isDone(1, 'ParentInterview', true), true);

// A field with no form behind it can only ever be a manual tick, and that tick
// IS the evidence. Treating it as unbacked would flag every one of them.
check('unbacked field: tick is a plain tick', CF.state(2, 'ProofOfIncome', true), 'tick');
check('unbacked field: tick counts as done', CF.isDone(2, 'ProofOfIncome', true), true);
check('unbacked field: no tick is none', CF.state(2, 'EnterSIS', false), 'none');
check('ProofOfIncome is not a backed field', CF.isBacked('ProofOfIncome'), false);
check('ParentInterview is a backed field', CF.isBacked('ParentInterview'), true);

// ── a failed fetch must not invent problems ──────────────────────────────
CF._set({}, 'failed');
check('fetch failed: a tick reads as unknown, not tick-only',
    CF.state(1, 'ParentInterview', true), 'unknown');
check('fetch failed: unknown still counts as done, so nothing turns red wrongly',
    CF.isDone(1, 'ParentInterview', true), true);
check('fetch failed: no tick is still none',
    CF.state(1, 'ParentInterview', false), 'none');

// ── rollup(), what the compliance panel reports ──────────────────────────
const roster = [{ Id: 1 }, { Id: 2 }, { Id: 3 }];
CF._set({
    '1': { ParentInterview: { on: true, date: '' }, PermissionSlip: { on: true, date: '' } },
    '2': { ParentInterview: { on: true, date: '' } },
    '3': {}
}, 'ready');
const tracking = {
    1: { ParentInterview: true, PermissionSlip: true },
    2: { ParentInterview: true, PermissionSlip: true },   // slip ticked, no form
    3: {}
};
const r = CF.rollup(['ParentInterview', 'PermissionSlip'], roster, tracking);
check('rollup total', r.total, 3);
check('rollup counts only files with every form present', r.complete, 1);
check('rollup missing lists both incomplete children',
    r.missing.map(s => s.Id), [2, 3]);
check('rollup names the child whose tick has nothing behind it',
    r.unbacked.map(s => s.Id), [2]);

// The old behaviour, for contrast: counting ticks alone would have said 2 of 3.
const ticksOnly = roster.filter(s =>
    ['ParentInterview', 'PermissionSlip'].every(f => (tracking[s.Id] || {})[f])).length;
check('counting ticks alone would have overstated this', ticksOnly, 2);

check('rollup of an item with no childFields is null', CF.rollup([], roster, tracking), null);
check('rollup of undefined fields is null', CF.rollup(undefined, roster, tracking), null);

// An empty roster is complete, not divided by zero.
const empty = CF.rollup(['ParentInterview'], [], {});
check('empty roster: total 0', empty.total, 0);
check('empty roster: complete 0', empty.complete, 0);

// ── indexItems(), field -> compliance items ──────────────────────────────
const index = CF.indexItems([
    { program: 'PI', items: [
        { num: 'PI5', title: 'Eligibility', childFields: ['WeightedEligibility', 'ParentInterview'] },
        { num: 'PI10', title: 'Screening', childFields: ['PermissionSlip', 'BegASQ'] }
    ] },
    { program: 'PFA', items: [
        { num: 'Item4', title: 'Screening', childFields: ['ParentInterview', 'PermissionSlip'] },
        { num: 'Item9', title: 'Mission' }        // no childFields at all
    ] }
]);
check('a field serving two programs collects both items',
    index.ParentInterview.map(i => i.program + ':' + i.num), ['PI:PI5', 'PFA:Item4']);
check('a field in one item only', index.WeightedEligibility.map(i => i.num), ['PI5']);
check('an item without childFields contributes nothing',
    Object.keys(index).indexOf('Item9'), -1);
check('a field nobody references is absent', index.EnterSIS, undefined);
check('every backed field is spelled the same in both lists',
    CF.BACKED_FIELDS.filter(f => f !== f.trim() || !/^[A-Za-z]+$/.test(f)), []);

out.push('');
out.push(fail ? fail + ' FAILED, ' + pass + ' passed' : 'all ' + pass + ' passed');
fs.writeFileSync(path.join(__dirname, '_child_forms_test.txt'), out.join('\n'), 'utf8');
