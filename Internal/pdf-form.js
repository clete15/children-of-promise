/* ══════════════════════════════════════════════════════════════════════════
   A PDF writer for signed compliance forms.

   WHY HAND-ROLLED

   The signed copy of a permission slip or parent interview is what a monitor
   actually reviews, so it has to be a real document in the child's folder, and it
   has to be a PDF because that is what the folder and the portal upload already
   hold. There is no PDF library available here and this project takes no npm
   dependencies, so this writes the file directly.

   That is less mad than it sounds, because these documents are simple: a heading,
   label/value pairs, some wrapped paragraphs, and a signature image. What follows
   is the smallest thing that produces a valid PDF of that shape.

   THE SHORTCUT THAT MAKES IT SMALL

   Signatures arrive as JPEG, not PNG. A PDF can embed JPEG bytes verbatim as an
   image XObject with /DCTDecode — no decoding, no re-encoding, no zlib. Embedding
   a PNG instead would mean inflating the IDAT stream, reversing PNG's per-scanline
   filters, and re-deflating raw RGB, which is most of a PNG decoder for no benefit:
   a signature is black ink on white, where JPEG artefacts are invisible.

   FONTS

   Helvetica and Helvetica-Bold are two of the 14 standard PDF fonts, so they need
   no embedding and are present in every reader. The width tables below are the
   standard AFM advance widths, needed for word wrapping — without them long
   answers would run off the page. A wrong width only shifts a wrap point; it
   cannot corrupt the file.

   WHAT IT DOES NOT DO

   No tables, no colour, no rotation, no compression of the content stream, one
   image format. Every one of those is deliberate: this produces compliance
   documents, not artwork, and every feature is a thing that can break silently in
   a file nobody opens until the visit.
   ══════════════════════════════════════════════════════════════════════════ */

'use strict';

// Standard AFM advance widths, units per 1000, for characters 32..126.
const W_REGULAR = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
];
const W_BOLD = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584
];

function charWidth(code, bold) {
    if (code >= 32 && code <= 126) return (bold ? W_BOLD : W_REGULAR)[code - 32];
    return 500;      // anything outside the table, including accented characters
}

function textWidth(str, size, bold) {
    let total = 0;
    for (let i = 0; i < str.length; i++) total += charWidth(str.charCodeAt(i), bold);
    return total * size / 1000;
}

/* PDF strings are wrapped in parentheses, so a literal parenthesis or backslash
   would end the string early or escape the next character. Characters outside
   WinAnsi's printable range are dropped rather than mangled: a name with an
   unusual character should lose that character, not corrupt the document. */
function pdfString(s) {
    let out = '';
    const str = String(s == null ? '' : s);
    for (let i = 0; i < str.length; i++) {
        const c = str[i];
        const code = str.charCodeAt(i);
        if (c === '(' || c === ')' || c === '\\') out += '\\' + c;
        else if (code >= 32 && code <= 126) out += c;
        else if (code === 8217 || code === 8216) out += "'";     // curly quotes
        else if (code === 8220 || code === 8221) out += '"';
        else if (code === 8211 || code === 8212) out += '-';     // dashes
        else if (code > 126) out += '?';
    }
    return out;
}

// Wraps to a width in points, breaking on spaces and hard-breaking a word that
// cannot fit on a line of its own.
function wrapText(text, maxWidth, size, bold) {
    const lines = [];
    String(text == null ? '' : text).split(/\r?\n/).forEach(paragraph => {
        const words = paragraph.split(/\s+/).filter(w => w.length);
        if (!words.length) { lines.push(''); return; }
        let line = '';
        words.forEach(word => {
            const candidate = line ? line + ' ' + word : word;
            if (textWidth(candidate, size, bold) <= maxWidth) { line = candidate; return; }
            if (line) lines.push(line);
            if (textWidth(word, size, bold) <= maxWidth) { line = word; return; }
            // A single word too long for the line: break it by character.
            let chunk = '';
            for (const ch of word) {
                if (textWidth(chunk + ch, size, bold) > maxWidth) { lines.push(chunk); chunk = ch; }
                else chunk += ch;
            }
            line = chunk;
        });
        if (line) lines.push(line);
    });
    return lines;
}

/* Width and height of a JPEG, read from its SOF marker.

   Needed because the PDF image XObject must declare the pixel dimensions, and
   getting them wrong stretches the signature. Returns null rather than guessing if
   the markers do not parse, so a malformed image is reported instead of producing a
   document with a distorted signature on it. */
function jpegSize(buf) {
    if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
    let i = 2;
    while (i < buf.length - 9) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const marker = buf[i + 1];
        // Standalone markers carry no length.
        if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        // SOF0/1/2/3/5/6/7/9/10/11/13/14/15 all carry the frame dimensions.
        const isSOF = (marker >= 0xC0 && marker <= 0xCF)
            && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
        if (isSOF) {
            return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
    }
    return null;
}

const PAGE = { width: 612, height: 792 };        // US Letter, in points
const MARGIN = 54;                               // 0.75 inch
const BODY = PAGE.width - MARGIN * 2;

/* Builds the document.

   spec = {
     title, subtitle,
     rows:    [{ label, value }]                 label/value pairs
     blocks:  [{ heading, text }]                wrapped paragraphs
     signatures: [{ label, name, date, jpeg }]   jpeg is a Buffer
     footer                                      one line repeated on every page
   }

   Returns a Buffer. Throws only on a malformed signature image, which is a real
   failure worth surfacing rather than filing a document with no signature on it. */
function buildFormPdf(spec) {
    const images = [];       // { name, buf, w, h }
    const pages = [];        // arrays of content-stream fragments
    let ops = [];
    let y = 0;

    const FOOTER_SPACE = 40;

    function newPage() {
        if (ops.length) pages.push(ops);
        ops = [];
        y = PAGE.height - MARGIN;
    }

    function need(space) {
        if (y - space < MARGIN + FOOTER_SPACE) newPage();
    }

    function line(text, size, bold, indent) {
        ops.push('BT /' + (bold ? 'F2' : 'F1') + ' ' + size + ' Tf '
            + (MARGIN + (indent || 0)) + ' ' + (y - size) + ' Td ('
            + pdfString(text) + ') Tj ET');
        y -= size * 1.35;
    }

    function rule() {
        ops.push('0.8 w 0.75 0.79 0.85 RG ' + MARGIN + ' ' + y + ' m '
            + (PAGE.width - MARGIN) + ' ' + y + ' l S');
        y -= 10;
    }

    newPage();

    // ── Heading ──
    line(spec.title || 'Form', 15, true);
    if (spec.subtitle) { y += 3; line(spec.subtitle, 10, false); }
    y -= 2;
    rule();
    y -= 4;

    // ── Label/value pairs, two columns of label then value ──
    const LABEL_W = 150;
    (spec.rows || []).forEach(r => {
        const valueLines = wrapText(r.value || '\u2014', BODY - LABEL_W - 8, 10, false);
        need(valueLines.length * 13 + 4);
        const top = y;
        line(String(r.label || '') + ':', 10, true);
        // Put the value back on the label's line, then continue below it.
        y = top;
        // Drawn from the label's own baseline so the first value line sits beside it,
        // with any wrapped remainder flowing underneath in the value column.
        valueLines.forEach(vl => {
            ops.push('BT /F1 10 Tf ' + (MARGIN + LABEL_W) + ' ' + (y - 10) + ' Td ('
                + pdfString(vl) + ') Tj ET');
            y -= 13;
        });
        y -= 2;
    });

    // ── Paragraph blocks ──
    (spec.blocks || []).forEach(b => {
        if (!b) return;
        need(40);
        y -= 8;
        if (b.heading) line(b.heading, 11, true);
        const lines = wrapText(b.text || '\u2014', BODY, 10, false);
        lines.forEach(l => { need(14); line(l, 10, false); });
        y -= 4;
    });

    // ── Signatures ──
    (spec.signatures || []).forEach((sig, idx) => {
        if (!sig || !sig.jpeg) return;
        const size = jpegSize(sig.jpeg);
        if (!size) throw new Error('That signature image could not be read as a JPEG');

        // Scaled to a fixed height, so a signature drawn on a big screen and one
        // drawn on a phone are the same size on the page.
        const drawH = 40;
        const drawW = Math.min(BODY / 2, size.width * (drawH / size.height));

        need(drawH + 46);
        y -= 12;
        if (sig.label) line(sig.label, 10, true);

        const name = 'IMG' + idx;
        images.push({ name: name, buf: sig.jpeg, w: size.width, h: size.height });
        const imgY = y - drawH;
        ops.push('q ' + drawW.toFixed(2) + ' 0 0 ' + drawH + ' ' + MARGIN + ' '
            + imgY.toFixed(2) + ' cm /' + name + ' Do Q');
        y = imgY - 4;

        // A ruled line under the signature, as a signature block has on paper.
        ops.push('0.6 w 0.4 0.45 0.5 RG ' + MARGIN + ' ' + y + ' m '
            + (MARGIN + Math.max(drawW, 200)) + ' ' + y + ' l S');
        y -= 12;
        const caption = [sig.name ? 'Signed: ' + sig.name : '', sig.date ? 'Date: ' + sig.date : '']
            .filter(Boolean).join('    ');
        if (caption) line(caption, 9, false);
    });

    pages.push(ops);

    // ── Assemble ──
    const objects = [];
    function addObject(body) { objects.push(body); return objects.length; }   // 1-based

    const fontRegular = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const fontBold = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

    const imageIds = {};
    images.forEach(img => {
        imageIds[img.name] = addObject({
            dict: '<< /Type /XObject /Subtype /Image /Width ' + img.w + ' /Height ' + img.h
                + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length '
                + img.buf.length + ' >>',
            stream: img.buf
        });
    });

    const pagesId = objects.length + 1 + pages.length * 2;   // reserved below
    const pageIds = [];
    pages.forEach((pageOps, i) => {
        const footer = spec.footer
            ? 'BT /F1 8 Tf ' + MARGIN + ' ' + (MARGIN - 12) + ' Td ('
              + pdfString(spec.footer + '   Page ' + (i + 1) + ' of ' + pages.length)
              + ') Tj ET'
            : '';
        const content = ['0 0 0 rg 0 0 0 RG'].concat(pageOps).concat(footer ? [footer] : []).join('\n');
        const contentId = addObject({ dict: '<< /Length ' + Buffer.byteLength(content, 'latin1') + ' >>',
                                     stream: Buffer.from(content, 'latin1') });
        // Only the images this document actually uses are referenced.
        const xobjects = images.length
            ? ' /XObject << ' + images.map(im => '/' + im.name + ' ' + imageIds[im.name] + ' 0 R').join(' ') + ' >>'
            : '';
        pageIds.push(addObject('<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 '
            + PAGE.width + ' ' + PAGE.height + '] /Resources << /Font << /F1 ' + fontRegular
            + ' 0 R /F2 ' + fontBold + ' 0 R >>' + xobjects + ' >> /Contents ' + contentId + ' 0 R >>'));
    });

    const realPagesId = addObject('<< /Type /Pages /Count ' + pageIds.length + ' /Kids ['
        + pageIds.map(id => id + ' 0 R').join(' ') + '] >>');
    const catalogId = addObject('<< /Type /Catalog /Pages ' + realPagesId + ' 0 R >>');

    /* Every page's /Parent must point at the real Pages object. It was written from
       a predicted id above, because a page has to name its parent before the parent
       can list its children. Assert rather than trust the arithmetic: a mismatch
       produces a file that some readers open and others reject, which is the worst
       possible failure for evidence nobody looks at until the visit. */
    if (realPagesId !== pagesId) {
        throw new Error('PDF page tree id mismatch: predicted ' + pagesId + ', got ' + realPagesId);
    }

    const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    let offset = parts[0].length;
    const offsets = [];
    objects.forEach((obj, i) => {
        offsets.push(offset);
        const head = Buffer.from((i + 1) + ' 0 obj\n', 'latin1');
        let chunk;
        if (typeof obj === 'string') {
            chunk = Buffer.concat([head, Buffer.from(obj + '\nendobj\n', 'latin1')]);
        } else {
            chunk = Buffer.concat([
                head, Buffer.from(obj.dict + '\nstream\n', 'latin1'),
                obj.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')
            ]);
        }
        parts.push(chunk);
        offset += chunk.length;
    });

    let xref = 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
    offsets.forEach(o => { xref += String(o).padStart(10, '0') + ' 00000 n \n'; });
    xref += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root ' + catalogId
        + ' 0 R >>\nstartxref\n' + offset + '\n%%EOF\n';
    parts.push(Buffer.from(xref, 'latin1'));

    return Buffer.concat(parts);
}

module.exports = { buildFormPdf, jpegSize, wrapText, textWidth };
