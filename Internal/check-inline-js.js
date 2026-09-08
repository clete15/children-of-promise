/* Syntax-checks the inline <script> blocks of the given HTML files.
   A broken edit to inline JS is otherwise invisible until the page is opened.
   Companion to check-undefined.js, which does the same job for server.js.
   Usage: node check-inline-js.js menus.html pas.html isbe.html */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const files = process.argv.slice(2);
const out = [];
let bad = 0;

for (const f of files) {
    const full = path.isAbsolute(f) ? f : path.join(__dirname, f);
    if (!fs.existsSync(full)) { out.push('MISSING ' + f); bad++; continue; }
    const html = fs.readFileSync(full, 'utf8');
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let m, n = 0, errs = 0;
    while ((m = re.exec(html)) !== null) {
        // Skip external references - they have no body to check.
        if (/\bsrc\s*=/.test(m[1])) continue;
        n++;
        const body = m[2];
        const line = html.slice(0, m.index).split('\n').length;
        try {
            new vm.Script(body, { filename: f + ' block#' + n });
        } catch (e) {
            errs++; bad++;
            out.push(`FAIL ${f} inline block #${n} (starts near line ${line}): ${e.message}`);
        }
    }
    if (!errs) out.push(`OK   ${f} - ${n} inline block(s) parse`);
}

out.push('');
out.push(bad ? bad + ' PROBLEM(S)' : 'all inline scripts parse');
// Written to a file because this terminal garbles piped output.
fs.writeFileSync(path.join(__dirname, '_inline_js_report.txt'), out.join('\n'), 'utf8');
