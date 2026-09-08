/* Audits every staff-facing HTML page for whether its fields can actually be filled
   in and saved on screen, or whether someone has to print it and write on it.

   Three failure modes, in descending badness:
     NO FIELDS      - print-only. Anything asked for gets handwritten.
     FIELDS, NO SAVE- worse in practice: you type, it looks fine, and it is gone on
                      reload. Handwriting at least survives.
     FIELDS + SAVE  - what we want.

   The standing rule this enforces: a teacher should never have to hand-write into a
   form. Run it after adding or changing a form.

   Two things it gets right that a naive version does not, both learned the hard way:
   it counts fields built in JavaScript (the menu grid, the 25-item self-assessment
   and the documentation guide have no static fields at all), and it treats PUT and
   PATCH as saving (the CCAP, food-report and alerts pages edit inline with PUT).

   Companion to check-undefined.js and check-inline-js.js.
   Usage: node check-form-persistence.js     -> writes _form_audit.txt */
const fs = require('fs');
const path = require('path');

const ROOTS = [
    { dir: path.join(__dirname), label: 'Internal' },
    { dir: path.join(__dirname, 'pas'), label: 'Internal/pas' },
    { dir: path.join(__dirname, '..', 'PAS'), label: 'PAS' }
];
const out = [];

// Pages that are navigation, auth or public-facing rather than a form to complete.
const NOT_A_FORM = /^(index|parent|preenrollment|office|login)\.html$/i;

/* Counts data-entry fields in a chunk of markup. Buttons, hidden inputs and file
   pickers are not data entry. */
function countFields(markup) {
    const inputs = (markup.match(/<input\b[^>]*>/gi) || []).filter(t =>
        !/type\s*=\s*["']?(button|submit|reset|hidden|file|image)/i.test(t));
    return inputs.length
        + (markup.match(/<textarea\b/gi) || []).length
        + (markup.match(/<select\b/gi) || []).length;
}

function analyse(file) {
    const html = fs.readFileSync(file, 'utf8');
    const scripts = (html.match(/<script[\s\S]*?<\/script>/gi) || []).join('\n');
    const body = html.replace(/<script[\s\S]*?<\/script>/gi, '');

    /* Count fields in the markup AND in the scripts. Several pages here build their
       whole form in JavaScript - the menu grid, the 25-item self-assessment, the
       documentation guide - so counting only static markup reports them as
       print-only when they are the most interactive pages in the app. */
    const staticFields = countFields(body);
    const dynamicFields = countFields(scripts);
    const fieldCount = staticFields + dynamicFields;

    const hasPrint = /window\.print\(\)/.test(html);
    /* Persistence, in any of the shapes this codebase uses. PUT and PATCH matter as
       much as POST: the CCAP, food-report and alerts pages all edit a student inline
       and save with PUT, and reading only POST reported them as losing your typing. */
    const savesToServer = /PasStore\.storage\.setItem/.test(html)
        || /method:\s*['"](POST|PUT|PATCH)['"]/i.test(html);
    const savesLocalOnly = /localStorage\.setItem/.test(html) && !savesToServer;
    const dataField = (html.match(/data-field=/g) || []).length;

    let verdict, severity;
    if (fieldCount === 0) {
        verdict = hasPrint ? 'PRINT-ONLY - no fields to fill in on screen' : 'reference page, no fields';
        severity = hasPrint ? 'high' : 'none';
    } else if (savesToServer) {
        verdict = 'fields + saves to the server';
        severity = 'none';
    } else if (savesLocalOnly) {
        verdict = 'fields but saves ONLY to this browser';
        severity = 'high';
    } else {
        verdict = 'fields but NOTHING saves them';
        severity = 'high';
    }

    return { fieldCount, staticFields, dynamicFields, dataField, hasPrint,
             savesToServer, savesLocalOnly, verdict, severity };
}

const rows = [];
ROOTS.forEach(({ dir, label }) => {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).filter(f => /\.html$/i.test(f)).forEach(f => {
        if (NOT_A_FORM.test(f)) return;
        const r = analyse(path.join(dir, f));
        rows.push(Object.assign({ file: label + '/' + f }, r));
    });
});

const bad = rows.filter(r => r.severity === 'high');
const ok = rows.filter(r => r.severity !== 'high');

out.push('=== NEEDS ATTENTION (' + bad.length + ') ===');
out.push('');
['fields but NOTHING saves them', 'fields but saves ONLY to this browser',
 'PRINT-ONLY - no fields to fill in on screen'].forEach(kind => {
    const group = bad.filter(r => r.verdict === kind);
    if (!group.length) return;
    out.push('-- ' + kind + ' (' + group.length + ')');
    group.sort((a, b) => b.fieldCount - a.fieldCount).forEach(r => {
        out.push('   ' + r.file.padEnd(52) + ' fields=' + String(r.fieldCount).padStart(3)
            + ' (static ' + r.staticFields + ', built in js ' + r.dynamicFields + ')'
            + (r.hasPrint ? '  has print' : ''));
    });
    out.push('');
});

out.push('=== FINE (' + ok.length + ') ===');
ok.sort((a, b) => a.file.localeCompare(b.file)).forEach(r => {
    out.push('   ' + r.file.padEnd(52) + ' ' + r.verdict + ' (fields=' + r.fieldCount + ')');
});

fs.writeFileSync(path.join(__dirname, '_form_audit.txt'), out.join('\n'), 'utf8');
