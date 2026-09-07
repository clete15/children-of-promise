/* Find identifiers used but never declared in server.js.

   Written because I shipped this class of bug twice in one day: MIME_TYPES
   (a table that was actually called MIME) and crypto (a module never required).
   Both produced the same symptom — a request that hangs forever, because the
   ReferenceError fires before any response is written and the uncaughtException
   handler swallows it. Neither was caught by `node --check`, which only validates
   syntax, nor by any test that did not exercise that exact line.

   This is a crude scan, not a real linter, but it catches the specific mistake:
   something used as X.y(...) or new X(...) where X is never defined anywhere. */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'server.js');
const src = fs.readFileSync(SRC, 'utf8');
const out = [];

// Strip comments and strings so their contents are not mistaken for code.
let code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');

// Everything declared in the file, however it was declared.
const declared = new Set();
for (const re of [
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /\bfunction\s+([A-Za-z_$][\w$]*)/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
    // Destructured requires: const { execSync } = require(...)
    /\b(?:const|let|var)\s*\{([^}]*)\}/g,
    // Parameters, loosely: (a, b) => and function f(a, b)
    /\(([^()]*)\)\s*(?:=>|\{)/g
]) {
    let m;
    while ((m = re.exec(code)) !== null) {
        m[1].split(',').forEach(p => {
            const name = p.trim().split(/[:=\s]/)[0].replace(/^\.\.\./, '');
            if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
        });
    }
}

// Node and JavaScript globals that are legitimately available.
const GLOBALS = new Set([
    'console','process','Buffer','URL','URLSearchParams','JSON','Math','Date','Object','Array',
    'String','Number','Boolean','RegExp','Error','TypeError','Promise','Map','Set','WeakMap',
    'Symbol','parseInt','parseFloat','isNaN','isFinite','encodeURIComponent','decodeURIComponent',
    'setTimeout','setInterval','clearTimeout','clearInterval','setImmediate','require','module',
    'exports','__dirname','__filename','globalThis','TextDecoder','TextEncoder','Intl','BigInt',
    'AbortController','structuredClone','queueMicrotask','performance'
]);

/* Look for X.something( and new X( — the shapes that produced both bugs.
   Property accesses like foo.crypto are skipped by requiring the identifier not
   to be preceded by a dot. */
const suspects = new Map();
const patterns = [
    // X.method(...)  — how the missing crypto module showed up.
    /(?:^|[^.\w$])([A-Z][\w$]*|[a-z][\w$]*)\s*\.\s*[A-Za-z_$][\w$]*\s*\(/g,
    /\bnew\s+([A-Za-z_$][\w$]*)\s*\(/g,
    // X[...]  — how MIME_TYPES showed up. Without this the scan misses a lookup
    // against a table that does not exist, which is the bug it exists to find.
    /(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\[/g
];
for (const re of patterns) {
    let m;
    while ((m = re.exec(code)) !== null) {
        const name = m[1];
        if (declared.has(name) || GLOBALS.has(name)) continue;
        // Ignore obvious locals seen everywhere in callbacks.
        if (['res','req','e','err','r','d','v','m','s','t','x','k','p','f','c'].includes(name)) continue;
        const line = code.slice(0, m.index).split('\n').length;
        if (!suspects.has(name)) suspects.set(name, []);
        if (suspects.get(name).length < 4) suspects.get(name).push(line);
    }
}

out.push('--- identifiers used but never declared in server.js ---');
out.push('(the check that would have caught MIME_TYPES and crypto)');
out.push('');
if (!suspects.size) {
    out.push('  none  ');
} else {
    for (const [name, lines] of [...suspects].sort()) {
        out.push('  ' + name.padEnd(28) + 'lines ' + lines.join(', '));
    }
}
out.push('');
out.push('declared names found: ' + declared.size);
out.push(suspects.size ? suspects.size + ' TO REVIEW' : 'CLEAN');

// Print to the console rather than a file: this is meant to be run by hand
// before committing a change to server.js.
console.log(out.join('\n'));
process.exit(suspects.size ? 1 : 0);
