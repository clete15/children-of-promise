#!/usr/bin/env python3
"""
Build the two ASQ / Teaching Strategies handouts as one-page PDFs, with the
Children of Promise logo embedded at the top.

WHY IT IS WRITTEN THIS WAY
--------------------------
reportlab is not installed on this machine and cannot be assumed, so the PDF is
written byte-for-byte with the standard library only (zlib + struct). That has
two consequences the content must respect:

  * The built-in PDF fonts (Helvetica) have no glyphs for smart quotes, bullets
    or em-dashes -- those render as blank/box. So all text is ASCII: straight
    quotes ('), hyphens (-), and "-" as the bullet marker.

  * A PNG cannot be dropped into a PDF as-is. PDF image streams hold raw samples
    (optionally Flate-compressed), not a PNG file. So the logo PNG is decoded
    here: zlib-inflate the IDAT, reverse the per-scanline PNG filters, split the
    RGBA pixels into an RGB image plus an 8-bit alpha channel, and re-deflate
    each. The alpha becomes the image's SMask so the logo's transparency is kept.

Run from anywhere; paths are resolved relative to this file's repo.
"""

import os
import re
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
LOGO = os.path.join(REPO, "External", "images", "Logos",
                    "ChildrenOfPromise - Black on White_Transparent.png")

# ---------------------------------------------------------------------------
# PNG -> (rgb_bytes, alpha_bytes, width, height)
# ---------------------------------------------------------------------------
def decode_png_rgba(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos = 8
    width = height = bit_depth = color_type = None
    idat = bytearray()
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        ctype = data[pos + 4:pos + 8]
        cdata = data[pos + 8:pos + 8 + length]
        if ctype == b"IHDR":
            width, height, bit_depth, color_type = struct.unpack(">IIBB", cdata[:10])
        elif ctype == b"IDAT":
            idat += cdata
        elif ctype == b"IEND":
            break
        pos += 12 + length  # length + type + data + crc

    if bit_depth != 8 or color_type != 6:
        raise ValueError("expected 8-bit RGBA PNG (bit_depth=8, color_type=6); "
                         "got bit_depth=%s color_type=%s" % (bit_depth, color_type))

    raw = zlib.decompress(bytes(idat))
    channels = 4
    stride = width * channels
    # Reverse PNG scanline filters. Each row is prefixed with 1 filter-type byte.
    out = bytearray(height * stride)
    prev = bytearray(stride)
    src = 0
    for y in range(height):
        ftype = raw[src]; src += 1
        line = bytearray(raw[src:src + stride]); src += stride
        if ftype == 0:                      # None
            pass
        elif ftype == 1:                    # Sub
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif ftype == 2:                    # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:                    # Average
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                line[i] = (line[i] + ((a + b) >> 1)) & 0xFF
        elif ftype == 4:                    # Paeth
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                if pa <= pb and pa <= pc:
                    pr = a
                elif pb <= pc:
                    pr = b
                else:
                    pr = c
                line[i] = (line[i] + pr) & 0xFF
        else:
            raise ValueError("bad PNG filter type %d" % ftype)
        out[y * stride:(y + 1) * stride] = line
        prev = line

    rgb = bytearray(width * height * 3)
    alpha = bytearray(width * height)
    for i in range(width * height):
        rgb[i * 3]     = out[i * 4]
        rgb[i * 3 + 1] = out[i * 4 + 1]
        rgb[i * 3 + 2] = out[i * 4 + 2]
        alpha[i]       = out[i * 4 + 3]
    return bytes(rgb), bytes(alpha), width, height


# ---------------------------------------------------------------------------
# Minimal PDF writer
# ---------------------------------------------------------------------------
class PDF:
    def __init__(self):
        self.objects = []   # list of raw byte bodies; index+1 = object number

    def add(self, body):
        self.objects.append(body)
        return len(self.objects)  # object number (1-based)

    def build(self):
        out = bytearray()
        out += b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
        offsets = []
        for i, body in enumerate(self.objects, start=1):
            offsets.append(len(out))
            out += ("%d 0 obj\n" % i).encode("latin1")
            out += body
            out += b"\nendobj\n"
        xref_pos = len(out)
        n = len(self.objects) + 1
        out += ("xref\n0 %d\n" % n).encode("latin1")
        out += b"0000000000 65535 f \n"
        for off in offsets:
            out += ("%010d 00000 n \n" % off).encode("latin1")
        out += b"trailer\n"
        out += ("<< /Size %d /Root 1 0 R >>\n" % n).encode("latin1")
        out += b"startxref\n"
        out += ("%d\n" % xref_pos).encode("latin1")
        out += b"%%EOF"
        return bytes(out)


def esc(s):
    """Escape a string for a PDF literal ( ) string. ASCII only by contract."""
    return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


# US Letter, points.
PAGE_W, PAGE_H = 612.0, 792.0
MARGIN = 54.0


# ---------------------------------------------------------------------------
# Design system / palette
# ---------------------------------------------------------------------------
# Sampled from the logo (dominant opaque ink is RGB 48,24,56, a dark plum).
PURPLE      = (0.188, 0.094, 0.220)   # headings, title bar, accents
PURPLE_MID  = (0.42, 0.30, 0.48)      # subtitle / secondary
INK         = (0.15, 0.15, 0.18)      # body text
INK_SOFT    = (0.30, 0.31, 0.36)      # muted text
CARD_FILL   = (0.965, 0.955, 0.975)   # very light lavender section panel
CARD_EDGE   = (0.86, 0.83, 0.90)      # panel hairline
QA_FILL     = (0.945, 0.93, 0.965)    # slightly deeper lavender for the Q&A box
RULE        = (0.80, 0.78, 0.85)
WHITE       = (1.0, 1.0, 1.0)

# ---- content geometry ----
CONTENT_L = MARGIN
CONTENT_R = PAGE_W - MARGIN
CONTENT_W = CONTENT_R - CONTENT_L
CARD_PAD_X = 13.0          # inner left/right padding of a section card
CARD_PAD_TOP = 8.0
CARD_PAD_BOT = 8.0
ACCENT_W = 4.0             # width of the purple bar down a card's left edge
BODY_SIZE = 9.5
BODY_LEAD = 12.2
HEAD_SIZE = 11.0
PARA_GAP = 4.5             # gap between paragraphs within a card
BULLET_GAP = 2.5


# ---------------------------------------------------------------------------
# Low-level content-stream primitives
# ---------------------------------------------------------------------------
class Canvas:
    """Thin wrapper over a PDF content-stream operator list."""
    def __init__(self):
        self.ops = []

    def rect(self, x, y, w, h, fill=None, stroke=None, lw=0.7):
        self.ops.append("q")
        if fill:
            self.ops.append("%.3f %.3f %.3f rg" % fill)
        if stroke:
            self.ops.append("%.3f %.3f %.3f RG" % stroke)
            self.ops.append("%.2f w" % lw)
        self.ops.append("%.2f %.2f %.2f %.2f re" % (x, y, w, h))
        if fill and stroke:
            self.ops.append("B")
        elif fill:
            self.ops.append("f")
        else:
            self.ops.append("S")
        self.ops.append("Q")

    def hline(self, x1, x2, y, color=RULE, lw=0.8):
        self.ops.append("q")
        self.ops.append("%.3f %.3f %.3f RG" % color)
        self.ops.append("%.2f w" % lw)
        self.ops.append("%.2f %.2f m %.2f %.2f l S" % (x1, y, x2, y))
        self.ops.append("Q")

    def text(self, x, y, s, font, size, color=INK):
        self.ops.append("BT")
        self.ops.append("%.3f %.3f %.3f rg" % color)
        self.ops.append("/%s %.1f Tf" % (font, size))
        self.ops.append("1 0 0 1 %.2f %.2f Tm" % (x, y))
        self.ops.append("(%s) Tj" % esc(s))
        self.ops.append("ET")

    def text_center(self, cx, y, s, font, size, color=INK):
        self.text(cx - string_width(s, font, size) / 2.0, y, s, font, size, color)

    def image(self, name, x, y, w, h):
        self.ops.append("q")
        self.ops.append("%.3f 0 0 %.3f %.2f %.2f cm" % (w, h, x, y))
        self.ops.append("/%s Do" % name)
        self.ops.append("Q")

    def render(self):
        return "\n".join(self.ops).encode("latin1")


# ---------------------------------------------------------------------------
# Layout model: a list of "flow" items measured, then drawn, so the whole body
# can be vertically fitted/centred and nothing silently overflows the page.
# Each section is a card: a heading plus its paragraphs/bullets/Q&A, wrapped in
# a tinted panel with a purple accent bar. Bullets can be laid out in two
# columns to keep the page to one sheet.
# ---------------------------------------------------------------------------
def _wrap_para(text, font, size, w):
    return wrap(text, font, size, w)


def build_sections(blocks):
    """Group the flat block list into sections: each 'h' starts a new card;
    any leading blocks before the first 'h' form an intro card with no title."""
    sections = []
    cur = {"title": None, "items": []}
    for kind, text in blocks:
        if kind == "h":
            if cur["items"] or cur["title"]:
                sections.append(cur)
            cur = {"title": text, "items": []}
        else:
            cur["items"].append((kind, text))
    if cur["items"] or cur["title"]:
        sections.append(cur)
    return sections


def measure_card(sec, two_col_bullets):
    """Return (height, layout) for a section card at the current CONTENT_W.
    layout is a list of draw directives with y-offsets from the card's inner
    top, so the drawer just translates by the card's top."""
    inner_w = CONTENT_W - ACCENT_W - 2 * CARD_PAD_X
    y = 0.0
    directives = []

    if sec["title"]:
        directives.append(("head", y, sec["title"]))
        y += HEAD_SIZE + 5.0

    items = sec["items"]
    i = 0
    while i < len(items):
        kind, text = items[i]
        if kind == "bullet":
            # gather the consecutive bullet run
            run = []
            while i < len(items) and items[i][0] == "bullet":
                run.append(items[i][1]); i += 1
            if two_col_bullets and len(run) >= 4:
                col_w = (inner_w - 16.0) / 2.0
                rows = (len(run) + 1) // 2
                left = run[:rows]
                right = run[rows:]
                start_y = y
                maxh = 0.0
                # left column
                yy = y
                for b in left:
                    lines = _wrap_para(b, "F", BODY_SIZE, col_w - 12.0)
                    directives.append(("bullet", yy, lines, 0.0, col_w))
                    yy += len(lines) * BODY_LEAD + BULLET_GAP
                maxh = max(maxh, yy - start_y)
                # right column
                yy = y
                for b in right:
                    lines = _wrap_para(b, "F", BODY_SIZE, col_w - 12.0)
                    directives.append(("bullet", yy, lines, col_w + 16.0, col_w))
                    yy += len(lines) * BODY_LEAD + BULLET_GAP
                maxh = max(maxh, yy - start_y)
                y += maxh + 2.0
            else:
                for b in run:
                    lines = _wrap_para(b, "F", BODY_SIZE, inner_w - 12.0)
                    directives.append(("bullet", y, lines, 0.0, inner_w))
                    y += len(lines) * BODY_LEAD + BULLET_GAP
            y += PARA_GAP - BULLET_GAP
            continue
        if kind in ("p", "q"):
            font = "FB" if kind == "q" else "F"
            lines = _wrap_para(text, font, BODY_SIZE, inner_w)
            directives.append(("para", y, lines, font, kind))
            y += len(lines) * BODY_LEAD + PARA_GAP
            i += 1
            continue
        i += 1

    # trim the trailing paragraph gap, then add the card's bottom padding
    if directives:
        y -= PARA_GAP
    height = CARD_PAD_TOP + y + CARD_PAD_BOT
    return height, directives


def draw_card(cv, sec, top, height, directives):
    """Draw one section card with its background panel, accent bar, and text."""
    card_bottom = top - height
    # panel
    cv.rect(CONTENT_L, card_bottom, CONTENT_W, height, fill=CARD_FILL, stroke=CARD_EDGE, lw=0.7)
    # purple accent bar down the left edge
    cv.rect(CONTENT_L, card_bottom, ACCENT_W, height, fill=PURPLE)

    text_l = CONTENT_L + ACCENT_W + CARD_PAD_X
    inner_top = top - CARD_PAD_TOP

    for d in directives:
        kind = d[0]
        oy = d[1]
        if kind == "head":
            cv.text(text_l, inner_top - oy - HEAD_SIZE + 2, d[2], "FB", HEAD_SIZE, color=PURPLE)
            # small accent underline under the heading
            hw = string_width(d[2], "FB", HEAD_SIZE)
            cv.hline(text_l, text_l + min(hw, 220), inner_top - oy - HEAD_SIZE - 2.5,
                     color=(0.72, 0.66, 0.80), lw=1.2)
        elif kind == "para":
            _, _, lines, font, pk = d
            yy = inner_top - oy
            color = PURPLE if pk == "q" else INK
            for ln in lines:
                cv.text(text_l, yy - BODY_SIZE, ln, font, BODY_SIZE, color=color)
                yy -= BODY_LEAD
        elif kind == "bullet":
            _, _, lines, dx, _cw = d
            bx = text_l + dx
            yy = inner_top - oy
            # square bullet marker (ASCII-safe: drawn, not a glyph)
            cv.rect(bx, yy - BODY_SIZE + 2.0, 3.4, 3.4, fill=PURPLE_MID)
            for k, ln in enumerate(lines):
                cv.text(bx + 11.0, yy - BODY_SIZE, ln, "F", BODY_SIZE, color=INK)
                yy -= BODY_LEAD


def build_pdf(out_path, title, subtitle, blocks, rgb, alpha, iw, ih):
    """Overhauled one-page layout: header with logo, purple title bar, tinted
    section cards with accent bars and drawn bullets, footer. Two passes:
    measure all cards, then place them (auto-fits and reports overflow)."""
    pdf = PDF()

    cat = pdf.add(b"")
    pages = pdf.add(b"")
    page = pdf.add(b"")

    f_reg = pdf.add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    f_bold = pdf.add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")
    f_obl = pdf.add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>")

    comp_rgb = zlib.compress(rgb, 9)
    comp_a = zlib.compress(alpha, 9)
    smask = pdf.add(
        (b"<< /Type /XObject /Subtype /Image /Width %d /Height %d "
         b"/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode "
         b"/Length %d >>\nstream\n" % (iw, ih, len(comp_a)))
        + comp_a + b"\nendstream"
    )
    img = pdf.add(
        (b"<< /Type /XObject /Subtype /Image /Width %d /Height %d "
         b"/ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask %d 0 R "
         b"/Filter /FlateDecode /Length %d >>\nstream\n"
         % (iw, ih, smask, len(comp_rgb)))
        + comp_rgb + b"\nendstream"
    )

    cv = Canvas()

    # ---- Header: logo on white, then a purple title bar ----
    logo_w = 62.0
    logo_h = logo_w * ih / iw
    logo_x = (PAGE_W - logo_w) / 2.0
    logo_top = PAGE_H - 22.0
    cv.image("Im0", logo_x, logo_top - logo_h, logo_w, logo_h)

    bar_y2 = logo_top - logo_h - 9.0      # top edge of the purple bar
    title_size = 17.0
    sub_size = 10.0
    pad_top = 11.0
    gap = 6.0
    pad_bot = 9.0
    bar_h = pad_top + title_size + ((gap + sub_size) if subtitle else 0) + pad_bot
    bar_y1 = bar_y2 - bar_h
    cv.rect(0, bar_y1, PAGE_W, bar_h, fill=PURPLE)
    # Title baseline sits one title-height below the bar's top padding.
    title_baseline = bar_y2 - pad_top - title_size
    cv.text_center(PAGE_W / 2.0, title_baseline, title, "FB", title_size, color=WHITE)
    if subtitle:
        cv.text_center(PAGE_W / 2.0, title_baseline - gap - sub_size, subtitle,
                       "FO", sub_size, color=(0.88, 0.83, 0.92))

    # ---- Body: measure cards, then place ----
    two_col = True
    sections = build_sections(blocks)
    measured = [measure_card(s, two_col) for s in sections]
    card_gap = 6.0

    body_top = bar_y1 - 14.0
    footer_h = 26.0
    body_bottom_limit = footer_h + 8.0
    total_h = sum(h for h, _ in measured) + card_gap * (len(measured) - 1)
    avail = body_top - body_bottom_limit
    overflow = total_h - avail

    # Draw cards from body_top downward.
    y = body_top
    for (h, directives), sec in zip(measured, sections):
        draw_card(cv, sec, y, h, directives)
        y -= h + card_gap

    # ---- Footer ----
    cv.hline(CONTENT_L, CONTENT_R, footer_h + 6.0, color=RULE, lw=0.8)
    cv.text_center(PAGE_W / 2.0, footer_h - 6.0, SCHOOL, "F", 8.5, color=INK_SOFT)

    content = cv.render()
    content_obj = pdf.add(
        (b"<< /Length %d >>\nstream\n" % len(content)) + content + b"\nendstream"
    )

    pdf.objects[cat - 1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    pdf.objects[pages - 1] = b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>"
    resources = (
        b"<< /Font << /F %d 0 R /FB %d 0 R /FO %d 0 R >> "
        b"/XObject << /Im0 %d 0 R >> >>" % (f_reg, f_bold, f_obl, img)
    )
    pdf.objects[page - 1] = (
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources " + resources +
        (b" /Contents %d 0 R >>" % content_obj)
    )

    with open(out_path, "wb") as f:
        f.write(pdf.build())

    return overflow  # >0 means content ran past the safe area


# ---- Helvetica AFM widths (units per 1000 em) for measuring/wrapping ----
# Compact table: covers printable ASCII. Regular and Bold share close-enough
# metrics for wrapping purposes; we use the regular table for both.
_HELV = {
    ' ':278,'!':278,'"':355,'#':556,'$':556,'%':889,'&':667,"'":191,'(':333,')':333,
    '*':389,'+':584,',':278,'-':333,'.':278,'/':278,'0':556,'1':556,'2':556,'3':556,
    '4':556,'5':556,'6':556,'7':556,'8':556,'9':556,':':278,';':278,'<':584,'=':584,
    '>':584,'?':556,'@':1015,'A':667,'B':667,'C':722,'D':722,'E':667,'F':611,'G':778,
    'H':722,'I':278,'J':500,'K':667,'L':556,'M':833,'N':722,'O':778,'P':667,'Q':778,
    'R':722,'S':667,'T':611,'U':722,'V':667,'W':944,'X':667,'Y':667,'Z':611,'[':278,
    '\\':278,']':278,'^':469,'_':556,'`':333,'a':556,'b':556,'c':500,'d':556,'e':556,
    'f':278,'g':556,'h':556,'i':222,'j':222,'k':500,'l':222,'m':833,'n':556,'o':556,
    'p':556,'q':556,'r':333,'s':500,'t':278,'u':556,'v':500,'w':722,'x':500,'y':500,
    'z':500,'{':334,'|':260,'}':334,'~':584,
}


def string_width(s, font, size):
    total = sum(_HELV.get(ch, 556) for ch in s)
    return total / 1000.0 * size


def wrap(text, font, size, max_w):
    words = text.split(" ")
    lines, cur = [], ""
    for w in words:
        trial = w if not cur else cur + " " + w
        if string_width(trial, font, size) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def draw_wrapped(cs, text, x, y, font, size):
    cs.append("BT")
    cs.append("/%s %.1f Tf" % (font, size))
    cs.append("1 0 0 1 %.2f %.2f Tm" % (x, y))
    cs.append("(%s) Tj" % esc(text))
    cs.append("ET")


# ---------------------------------------------------------------------------
# Content
# ---------------------------------------------------------------------------
SCHOOL = "Children of Promise Christian Dayschool"

STAFF_BLOCKS = [
    ("h", "Ages & Stages Questionnaires (ASQ)"),
    ("p", "A short developmental screening that checks whether a child is developing on track for their age. The parent fills out the questionnaire; the teacher scores it. It is a screening, not a diagnosis."),
    ("p", "It looks at five areas:"),
    ("bullet", "Communication - talking and understanding"),
    ("bullet", "Gross motor - big movements like crawling, walking, jumping"),
    ("bullet", "Fine motor - small movements like grasping, stacking, drawing"),
    ("bullet", "Problem solving - learning, playing, figuring things out"),
    ("bullet", "Personal-social - interacting with others and self-help skills"),
    ("p", "(ASQ:SE focuses on social-emotional development: feelings, behavior, relationships.)"),
    ("h", "How we score it (updated process)"),
    ("p", "Parents fill out the questionnaire. Do NOT send the summary page home for the parent to score - the teacher scores it in the staff portal."),
    ("bullet", "Parent completes the ASQ / ASE questionnaire."),
    ("bullet", "Teacher uploads it in the portal (Beg ASQ / Beg ASE button) and enters the summary scores."),
    ("bullet", "Teacher collects the parent and staff signatures on the Lenovo IdeaTab - for every PI child, even if they already signed the paper document."),
    ("h", "Teaching Strategies (GOLD)"),
    ("p", "An observation-based assessment and curriculum system. Teachers observe children during everyday activities and document progress over the year across social-emotional, physical, language, cognitive, literacy, and math development."),
    ("h", "What to say when a parent signs"),
    ("p", "'We use two tools to help your child grow. For Ages & Stages, you fill out the questionnaire and we do the scoring here. Teaching Strategies is how we track their learning through the year. This form is your permission for both. Any questions?'"),
    ("h", "If a parent asks..."),
    ("q", "'Is something wrong with my child?'"),
    ("p", "'Not at all. This is not a test. We do it for every child to make sure they are on track and getting what they need.'"),
    ("q", "'What do you do with the information?'"),
    ("p", "'We use it to plan activities and support your child. It stays private, and we share the results with you.'"),
    ("h", "Quick tips"),
    ("bullet", "Lead with the child's benefit, and invite the parent in - their questionnaire answers matter for ASQ."),
    ("bullet", "Reassure it is routine - every child does this. Keep it short, then sign on the IdeaTab."),
]

PARENT_BLOCKS = [
    ("p", "Dear Families,"),
    ("p", "As part of our program, we use two friendly tools to help every child thrive. Neither is a test, and neither means anything is wrong - we use them for every child. Here is a quick look at what they are and why."),
    ("h", "Ages & Stages (ASQ)"),
    ("p", "A short check-in on how your child is growing and developing for their age. You fill out the questionnaire, because you know your child best, and your child's teacher scores it. It looks at everyday things like:"),
    ("bullet", "Communication - talking and understanding"),
    ("bullet", "Movement - both big movements and small hand skills"),
    ("bullet", "Problem solving - learning, playing, and figuring things out"),
    ("bullet", "Getting along with others - social and self-help skills"),
    ("p", "It helps us notice early if your child could use a little extra support in any area, so we can be there for them right away."),
    ("h", "Ages & Stages: Social-Emotional (ASE)"),
    ("p", "A companion check-in to the ASQ (we often just say 'ASE') focused on your child's social and emotional growth - managing big feelings, getting along with others, and building confidence. Like the ASQ, you fill out the questionnaire and the teacher scores it, it is not a test, and we use it for every child."),
    ("h", "Teaching Strategies"),
    ("p", "This is how our teachers track your child's learning throughout the year, just by watching them during normal play. It is not a sit-down test. It helps us plan activities that fit your child and celebrate their progress."),
    ("h", "Your part is simple"),
    ("bullet", "Fill out the ASQ / ASE questionnaire - your answers make the picture complete."),
    ("bullet", "Sign the permission form so we can include your child."),
    ("bullet", "Sign the finished screening when your teacher brings it on the tablet."),
    ("bullet", "Ask us anything - we are always happy to talk it through."),
    ("h", "Questions you might have"),
    ("q", "Is something wrong with my child?"),
    ("p", "No. This is not a test and it is not because of any concern. We do it for every child to make sure they are on track and getting what they need."),
    ("q", "What happens with the information?"),
    ("p", "We use it to plan activities and support your child's learning. It stays private, and we will share updates with you along the way."),
    ("p", "Thank you for partnering with us. Together we can give your child the best possible start."),
    ("p", "- The Children of Promise Team"),
]


def main():
    rgb, alpha, iw, ih = decode_png_rgba(LOGO)

    # Optional arg limits which handout is (re)built: "staff", "parent", or
    # "both" (default). Handy when one PDF is open/locked, or when only one
    # actually changed, so the other file is left exactly as it is.
    which = sys.argv[1].lower() if len(sys.argv) > 1 else "both"

    results = []
    if which in ("staff", "both"):
        of = build_pdf(
            os.path.join(HERE, "ASQ and Teaching Strategies - Staff Guide.pdf"),
            "Ages & Stages and Teaching Strategies",
            "A quick guide for staff  |  " + SCHOOL,
            STAFF_BLOCKS, rgb, alpha, iw, ih,
        )
        results.append(("Staff Guide", of))
    if which in ("parent", "both"):
        of = build_pdf(
            os.path.join(HERE, "ASQ and Teaching Strategies - Parent Guide.pdf"),
            "Helping Your Child Grow",
            "What Ages & Stages and Teaching Strategies mean for your family",
            PARENT_BLOCKS, rgb, alpha, iw, ih,
        )
        results.append(("Parent Guide", of))

    print("Built:", which, "->", HERE)
    for name, of in results:
        if of > 0.5:
            print("  OVERFLOW: %s runs %.0f pt past the safe area - tighten content/spacing." % (name, of))
        else:
            print("  OK: %s fits with %.0f pt to spare." % (name, -of))


if __name__ == "__main__":
    main()
