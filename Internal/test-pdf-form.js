/* Tests the PDF writer in pdf-form.js.

   A malformed PDF is the worst kind of bug here: it would sit in a child's folder
   looking like filed evidence and only be discovered when a monitor tries to open
   it. So this checks the structural invariants a reader relies on — object count,
   xref offsets pointing at real objects, the page tree, and that a signature image
   is embedded once and referenced — rather than just that the function returned
   something.

   Run: node test-pdf-form.js   ->   writes _pdf_form_test.txt and _sample-form.pdf */
const fs = require('fs');
const path = require('path');
const { buildFormPdf, jpegSize, wrapText, textWidth } = require('./pdf-form.js');

const out = [];
let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; out.push('ok   ' + name); }
    else { fail++; out.push('FAIL ' + name + (detail ? '\n       ' + detail : '')); }
}

// ── A real JPEG, built by hand: the smallest valid baseline grey 8x8 image. ──
// Only the SOF0 marker matters for our purposes, but it is a genuine JPEG so the
// dimension parser is being tested against the real byte layout, not a stub.
function tinyJpeg(width, height) {
    const parts = [];
    parts.push(Buffer.from([0xFF, 0xD8]));                                  // SOI
    // APP0/JFIF, to prove the parser skips length-carrying markers correctly.
    const app0 = Buffer.from([0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00,
        0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
    parts.push(app0);
    const sof = Buffer.alloc(19);
    sof.writeUInt16BE(0xFFC0, 0);
    sof.writeUInt16BE(17, 2);        // length
    sof.writeUInt8(8, 4);            // precision
    sof.writeUInt16BE(height, 5);
    sof.writeUInt16BE(width, 7);
    sof.writeUInt8(3, 9);            // components
    parts.push(sof);
    parts.push(Buffer.from([0xFF, 0xD9]));                                  // EOI
    return Buffer.concat(parts);
}

// ── jpegSize ──
check('jpegSize reads dimensions past a JFIF header',
    JSON.stringify(jpegSize(tinyJpeg(320, 90))) === JSON.stringify({ height: 90, width: 320 }),
    JSON.stringify(jpegSize(tinyJpeg(320, 90))));
check('jpegSize rejects something that is not a JPEG',
    jpegSize(Buffer.from([0x89, 0x50, 0x4E, 0x47])) === null);
check('jpegSize rejects an empty buffer', jpegSize(Buffer.alloc(0)) === null);

// ── text measurement and wrapping ──
check('a bold string measures wider than the same string regular',
    textWidth('Permission', 10, true) > textWidth('Permission', 10, false));
const wrapped = wrapText('the quick brown fox jumps over the lazy dog again and again', 100, 10, false);
check('wrapping produces more than one line', wrapped.length > 1);
check('no wrapped line exceeds the width',
    wrapped.every(l => textWidth(l, 10, false) <= 100),
    wrapped.map(l => l + ' = ' + textWidth(l, 10, false).toFixed(1)).join('\n       '));
check('wrapping preserves every word',
    wrapped.join(' ').split(/\s+/).filter(Boolean).length === 12);
const hard = wrapText('Supercalifragilisticexpialidocious', 40, 10, false);
check('a word too long for a line is broken rather than overflowing',
    hard.length > 1 && hard.every(l => textWidth(l, 10, false) <= 40));
check('blank input still yields a line', wrapText('', 100, 10, false).length === 1);
check('newlines start new lines', wrapText('one\ntwo', 200, 10, false).length === 2);

// ── the document ──
const pdf = buildFormPdf({
    title: 'Permission for Developmental Screening',
    subtitle: 'Children of Promise LLC - Prevention Initiative - 2026-2027',
    rows: [
        { label: 'Child', value: 'Gardner, Zayden' },
        { label: 'Parent/Guardian', value: 'Alicia Gardner' },
        { label: 'School year', value: '2026-2027' },
        { label: 'Empty on purpose', value: '' }
    ],
    blocks: [
        // Long enough to force a page break, because multi-page flow is the part
        // most likely to be wrong and a parent interview really does run this long.
        { heading: 'Permission', text: 'I give permission for the ASQ-3 and ASQ:SE-2 '
            + 'developmental screenings to be completed for my child during this school year. '
            + 'I understand the results will be shared with me. '.repeat(70) },
        { heading: 'Notes', text: 'Parentheses ( ) and a backslash \\ and a curly quote \u2019 '
            + 'must not break the file.' }
    ],
    signatures: [
        { label: 'Parent/Guardian signature', name: 'Alicia Gardner', date: '2026-09-01', jpeg: tinyJpeg(300, 80) },
        { label: 'Teacher signature', name: 'Sue Engel', date: '2026-09-01', jpeg: tinyJpeg(260, 70) }
    ],
    footer: 'Signed electronically - Children of Promise LLC'
});

const text = pdf.toString('latin1');

check('starts with a PDF header', text.startsWith('%PDF-1.4'));
check('ends with EOF', text.trimEnd().endsWith('%%EOF'));
check('declares a catalog', text.includes('/Type /Catalog'));
check('declares a page tree', text.includes('/Type /Pages'));

// Long content must have flowed onto more than one page.
const pageCount = (text.match(/\/Type \/Page[^s]/g) || []).length;
check('long content flowed onto more than one page', pageCount > 1, 'pages=' + pageCount);

const kidsMatch = text.match(/\/Type \/Pages \/Count (\d+)/);
check('the page count matches the number of page objects',
    kidsMatch && Number(kidsMatch[1]) === pageCount,
    'Count=' + (kidsMatch && kidsMatch[1]) + ' pages=' + pageCount);

// Both signatures embedded, each referenced from the page resources.
check('both signature images are embedded',
    (text.match(/\/Subtype \/Image/g) || []).length === 2);
check('images are embedded as JPEG without re-encoding',
    (text.match(/\/DCTDecode/g) || []).length === 2);
check('images are referenced from the page resources', text.includes('/XObject <<'));
check('images are drawn', (text.match(/\/IMG\d Do/g) || []).length === 2);

// Parentheses and backslashes escaped, so no string runs on.
check('a literal parenthesis is escaped', text.includes('\\(') && text.includes('\\)'));
check('a literal backslash is escaped', text.includes('\\\\'));

/* The xref table is what a reader uses to find objects. Every offset must land on
   the "<n> 0 obj" that the entry's position implies; an off-by-one here produces a
   file that some readers repair silently and others refuse. */
const xrefStart = Number((text.match(/startxref\s+(\d+)/) || [])[1]);
check('startxref points at the xref table', text.slice(xrefStart, xrefStart + 4) === 'xref',
    'found: ' + JSON.stringify(text.slice(xrefStart, xrefStart + 12)));

const xrefBody = text.slice(xrefStart);
const sizeMatch = xrefBody.match(/\/Size (\d+)/);
const entries = xrefBody.match(/^(\d{10}) 00000 n $/gm) || [];
check('xref has one entry per object',
    sizeMatch && entries.length === Number(sizeMatch[1]) - 1,
    'entries=' + entries.length + ' size=' + (sizeMatch && sizeMatch[1]));

let badOffsets = [];
entries.forEach((e, i) => {
    const at = Number(e.slice(0, 10));
    const expect = (i + 1) + ' 0 obj';
    if (text.slice(at, at + expect.length) !== expect) {
        badOffsets.push('object ' + (i + 1) + ' at ' + at + ' found '
            + JSON.stringify(text.slice(at, at + 14)));
    }
});
check('every xref offset lands on its object', badOffsets.length === 0, badOffsets.join('\n       '));

// A stream's /Length must match the bytes actually written, or readers truncate it.
let badLengths = [];
const streamRe = /\/Length (\d+) >>\s*stream\r?\n/g;
let m;
while ((m = streamRe.exec(text)) !== null) {
    const declared = Number(m[1]);
    const start = m.index + m[0].length;
    const end = text.indexOf('\nendstream', start);
    if (end - start !== declared) {
        badLengths.push('declared ' + declared + ' actual ' + (end - start));
    }
}
check('every stream length matches its content', badLengths.length === 0, badLengths.join('\n       '));

// A form with no signature at all is still a valid document.
const unsigned = buildFormPdf({ title: 'No signature', rows: [{ label: 'A', value: 'B' }] });
check('a document with no image is valid', unsigned.toString('latin1').includes('/Type /Catalog'));
check('a document with no image embeds no XObject',
    !unsigned.toString('latin1').includes('/XObject'));

// A broken image must be reported, not silently dropped.
let threw = false;
try {
    buildFormPdf({ title: 'x', signatures: [{ label: 'sig', jpeg: Buffer.from([1, 2, 3]) }] });
} catch (e) { threw = true; }
check('an unreadable signature image throws rather than filing a document without it', threw);

fs.writeFileSync(path.join(__dirname, '_sample-form.pdf'), pdf);
out.push('');
out.push('sample written to _sample-form.pdf (' + pdf.length + ' bytes, ' + pageCount + ' pages)');
out.push(fail ? fail + ' FAILED, ' + pass + ' passed' : 'all ' + pass + ' passed');
fs.writeFileSync(path.join(__dirname, '_pdf_form_test.txt'), out.join('\n'), 'utf8');
