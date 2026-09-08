/* ══════════════════════════════════════════════════════════════════════════
   Signature capture.

   WHY THIS EXISTS

   The permission slip and parent interview had fields labelled "Parent/Guardian
   Signature" holding a typed name. A typed name is not a signature, so the real
   signature lived on a printed sheet, and the loop was: type it here, print it,
   get it signed, scan it, file the scan somewhere with no link back. The record
   in the database and the evidence in the drawer were two different things.

   In a daycare the parent walks through the door twice a day, so the signature
   can be taken on the spot instead. This draws one.

   POINTER EVENTS, NOT MOUSE OR TOUCH

   One code path covers a mouse, a finger and a stylus. Handling mouse and touch
   separately means two sets of coordinate maths, double-fired events on hybrid
   laptops, and a pen that works in neither. setPointerCapture keeps the stroke
   alive when the pointer leaves the canvas mid-signature, which happens
   constantly with a finger.

   touch-action: none on the canvas is what stops a finger stroke scrolling the
   page instead of drawing. Without it this is unusable on a tablet, which is the
   device it is for.

   RESOLUTION

   The canvas backing store is sized to devicePixelRatio, not to CSS pixels. A
   signature captured at 1x on a retina tablet and then printed looks like it was
   drawn with a marker pen.

   WHAT IT PRODUCES

   A PNG data URL, trimmed to the ink so a signature is not mostly white space,
   plus whether anything was actually drawn. It stores nothing and knows nothing
   about the forms; the caller decides what a signature means.
   ══════════════════════════════════════════════════════════════════════════ */

(function () {
    'use strict';
    if (window.SignPad) return;

    var INK = '#1a1a2e';
    var LINE_WIDTH = 2.2;

    function create(host, opts) {
        opts = opts || {};
        host.innerHTML =
            '<div class="sig-wrap">'
            + '<canvas class="sig-canvas"></canvas>'
            + '<div class="sig-baseline"></div>'
            + '<span class="sig-hint">Sign here</span>'
            + '</div>'
            + '<div class="sig-actions">'
            + '<button type="button" class="sig-btn sig-clear">Clear</button>'
            + '<span class="sig-status"></span>'
            + '</div>';

        var canvas = host.querySelector('.sig-canvas');
        var wrap = host.querySelector('.sig-wrap');
        var hint = host.querySelector('.sig-hint');
        var status = host.querySelector('.sig-status');
        var ctx = canvas.getContext('2d');

        var drawn = false;          // has anything been drawn since the last clear
        var strokes = [];           // points in CSS pixels, so a resize can redraw
        var currentStroke = null;
        var ratio = 1;

        function setStatus(text, colour) {
            status.textContent = text || '';
            status.style.color = colour || '#64748b';
        }

        /* Sizes the backing store to the element and the device. Called on create
           and on resize, because a canvas that is resized loses its contents: the
           strokes are replayed from the points rather than scaled from pixels, so
           nothing softens. */
        function fit() {
            var w = wrap.clientWidth;
            var h = wrap.clientHeight;
            if (!w || !h) return;
            ratio = window.devicePixelRatio || 1;
            canvas.width = Math.round(w * ratio);
            canvas.height = Math.round(h * ratio);
            canvas.style.width = w + 'px';
            canvas.style.height = h + 'px';
            ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
            ctx.lineWidth = LINE_WIDTH;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.strokeStyle = INK;
            replay();
        }

        function replay() {
            ctx.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio);
            strokes.forEach(function (stroke) {
                if (stroke.length === 1) {
                    // A single tap is a dot, and a dot is a legitimate mark.
                    ctx.beginPath();
                    ctx.arc(stroke[0].x, stroke[0].y, LINE_WIDTH / 2, 0, Math.PI * 2);
                    ctx.fillStyle = INK;
                    ctx.fill();
                    return;
                }
                ctx.beginPath();
                ctx.moveTo(stroke[0].x, stroke[0].y);
                for (var i = 1; i < stroke.length; i++) ctx.lineTo(stroke[i].x, stroke[i].y);
                ctx.stroke();
            });
        }

        function pointFrom(e) {
            var r = canvas.getBoundingClientRect();
            return { x: e.clientX - r.left, y: e.clientY - r.top };
        }

        canvas.addEventListener('pointerdown', function (e) {
            // Ignore a second finger: a palm resting on a tablet would otherwise
            // draw its own stroke across the signature.
            if (currentStroke) return;
            canvas.setPointerCapture(e.pointerId);
            currentStroke = [pointFrom(e)];
            strokes.push(currentStroke);
            drawn = true;
            hint.style.display = 'none';
            setStatus('');
            if (opts.onChange) opts.onChange();
            replay();
            e.preventDefault();
        });

        canvas.addEventListener('pointermove', function (e) {
            if (!currentStroke) return;
            /* getCoalescedEvents recovers the points the browser merged into one
               move event. Without it a fast stroke is a polygon of long straight
               segments; a signature is mostly fast strokes. */
            var events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
            if (!events.length) events = [e];
            events.forEach(function (ev) { currentStroke.push(pointFrom(ev)); });
            replay();
            e.preventDefault();
        });

        function endStroke(e) {
            if (!currentStroke) return;
            currentStroke = null;
            if (e && canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
                canvas.releasePointerCapture(e.pointerId);
            }
        }
        canvas.addEventListener('pointerup', endStroke);
        canvas.addEventListener('pointercancel', endStroke);

        host.querySelector('.sig-clear').addEventListener('click', function () {
            strokes = [];
            currentStroke = null;
            drawn = false;
            hint.style.display = '';
            replay();
            setStatus('');
            if (opts.onChange) opts.onChange();
        });

        window.addEventListener('resize', fit);
        // The host is usually inside a modal that is display:none at create time,
        // so clientWidth is 0 until it opens. api.refresh() re-fits on open.
        fit();

        /* Trims the transparent margin so the stored image is the signature rather
           than a mostly empty rectangle. Returns null when nothing was drawn, so
           "not signed" can never come back as a blank PNG that looks signed. */
        function toDataUrl() {
            if (!drawn) return null;
            var w = canvas.width, h = canvas.height;
            var data = ctx.getImageData(0, 0, w, h).data;
            var minX = w, minY = h, maxX = -1, maxY = -1;
            for (var y = 0; y < h; y++) {
                for (var x = 0; x < w; x++) {
                    if (data[(y * w + x) * 4 + 3] === 0) continue;   // fully transparent
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
            if (maxX < 0) return null;      // drawn flag set but no ink landed
            var pad = Math.round(6 * ratio);
            minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
            maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);

            var out = document.createElement('canvas');
            out.width = maxX - minX + 1;
            out.height = maxY - minY + 1;
            var octx = out.getContext('2d');
            // White rather than transparent: a transparent signature disappears on
            // anything with a dark background, including some print drivers.
            octx.fillStyle = '#ffffff';
            octx.fillRect(0, 0, out.width, out.height);
            octx.drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
            return out.toDataURL('image/png');
        }

        var api = {
            get drawn() { return drawn; },
            toDataUrl: toDataUrl,
            clear: function () { host.querySelector('.sig-clear').click(); },
            refresh: fit,
            setStatus: setStatus,
            // Shows a signature already on file. Read-only until Clear is pressed,
            // so reopening a signed form does not invite an accidental re-signature.
            showExisting: function (url) {
                strokes = [];
                drawn = false;
                hint.style.display = 'none';
                var img = new Image();
                img.onload = function () {
                    fit();
                    var scale = Math.min(canvas.width / ratio / img.width,
                                         canvas.height / ratio / img.height, 1);
                    ctx.drawImage(img, 4, 4, img.width * scale, img.height * scale);
                };
                img.src = url;
            }
        };
        return api;
    }

    var CSS = `
        .sig-wrap { position:relative;height:110px;border:1px solid #cbd5e1;border-radius:8px;
            background:#fdfdff;overflow:hidden; }
        /* touch-action:none is what makes a finger draw instead of scrolling the page. */
        .sig-canvas { display:block;width:100%;height:100%;touch-action:none;cursor:crosshair; }
        .sig-baseline { position:absolute;left:12px;right:12px;bottom:26px;border-bottom:1px dashed #cbd5e1;
            pointer-events:none; }
        .sig-hint { position:absolute;left:14px;bottom:6px;font-size:0.68rem;color:#94a3b8;
            pointer-events:none; }
        .sig-actions { display:flex;align-items:center;gap:10px;margin-top:6px; }
        .sig-btn { padding:3px 11px;font-size:0.7rem;font-weight:700;border:1px solid #cbd5e1;
            background:white;border-radius:6px;cursor:pointer;color:#475569; }
        .sig-btn:hover { background:#f1f5f9; }
        .sig-status { font-size:0.7rem; }
        .sig-onfile { font-size:0.7rem;color:#166534;font-weight:700; }
        @media print {
            .sig-wrap { border:none;background:none;height:auto; }
            .sig-baseline, .sig-hint, .sig-actions { display:none !important; }
        }`;

    function injectCss() {
        if (document.getElementById('sig-pad-css')) return;
        var s = document.createElement('style');
        s.id = 'sig-pad-css';
        s.textContent = CSS;
        document.head.appendChild(s);
    }

    window.SignPad = {
        create: function (host, opts) { injectCss(); return create(host, opts); }
    };
})();
