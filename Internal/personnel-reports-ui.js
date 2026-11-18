/* ══════════════════════════════════════════════════════════════════════════
   Monthly Activity Reports: the panel on a staff card, the report sheet, and
   Sara's signing queue.

   Design intent
     - One glance answers "what do I owe?". A month card says what state it is in and,
       when the next move is the viewer's, wears an accent ring and says so in words.
     - The report opens as the paper form it replaces, so what is signed is recognisable.
     - Signing is one gesture: draw, press the button. The queue lets Sara sign every
       waiting report with one signature, because twelve identical signings is a chore.
     - Only the pad the viewer may use is live. The other says whose turn it is.

   The module owns its markup and styles (prefixed pr-) and takes everything it needs
   from the host page through init(), so it never reaches for page globals.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    var H = null;              // host: { fetch, getWho, openFile }
    var ST = { fy: null, staffId: null, list: null, queue: null, error: '', busy: false, pad: null };
    var FIRST_FY = 2026;
    var MON = { 10: 'Oct', 11: 'Nov', 12: 'Dec', 1: 'Jan', 2: 'Feb', 3: 'Mar', 4: 'Apr', 5: 'May', 6: 'Jun', 7: 'Jul', 8: 'Aug', 9: 'Sep' };
    var MON_LONG = { 10: 'October', 11: 'November', 12: 'December', 1: 'January', 2: 'February', 3: 'March', 4: 'April', 5: 'May', 6: 'June', 7: 'July', 8: 'August', 9: 'September' };

    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function $(id) { return document.getElementById(id); }
    function money(n) { return '$' + (Math.round((+n || 0) * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function hrs(n) { var v = Math.round((+n || 0) * 100) / 100; return String(v); }
    function dayShort(iso) {
        var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
        return m ? (+m[2]) + '/' + (+m[3]) + '/' + m[1].slice(2) : '';
    }
    function currentFy() {
        var n = new Date();
        var v = n.getMonth() >= 9 ? n.getFullYear() : n.getFullYear() - 1;
        return Math.max(v, FIRST_FY);
    }
    function fyLabel(y) { return 'FY ' + y + '-' + String(y + 1).slice(2); }
    function calYear(fy, m) { return m >= 10 ? fy : fy + 1; }

    async function api(url, opts) {
        var r = await H.fetch(url, opts);
        var d = {};
        try { d = await r.json(); } catch (e) { /* not JSON */ }
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        return d;
    }

    // ── styles ──
    var CSS = [
        '.pr{display:block}',
        '.pr-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px;margin:2px 2px 14px}',
        '.pr-head h2{margin:0 0 3px;text-align:left;font-size:1.12rem}',
        '.pr-head p{margin:0;color:var(--sp-muted);font-size:.9rem;line-height:1.5;max-width:560px}',
        '.pr-fy{display:inline-flex;align-items:center;gap:2px;background:var(--sp-surface);border:1.5px solid var(--sp-border);border-radius:999px;padding:3px}',
        '.pr-fy button{border:0;background:transparent;color:var(--sp-text-2);width:30px;height:28px;border-radius:999px;cursor:pointer;font-size:1rem;line-height:1}',
        '.pr-fy button:hover:not(:disabled){background:var(--sp-surface-2)}',
        '.pr-fy button:disabled{opacity:.35;cursor:default}',
        '.pr-fy span{font-weight:700;font-size:.86rem;padding:0 8px;color:var(--sp-text)}',
        '.pr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}',
        '.pr-card{position:relative;text-align:left;background:var(--sp-surface);border:1.5px solid var(--sp-border);border-radius:12px;padding:13px 14px 12px;cursor:pointer;color:var(--sp-text);font:inherit;display:flex;flex-direction:column;gap:8px;min-height:132px;transition:border-color .15s,box-shadow .15s,transform .15s}',
        '.pr-card:hover{border-color:var(--sp-border-in);box-shadow:0 2px 10px rgba(15,23,42,.08);transform:translateY(-1px)}',
        '.pr-card:focus-visible{outline:2px solid var(--sp-accent);outline-offset:2px}',
        '.pr-card.future{opacity:.55;cursor:default}',
        '.pr-card.future:hover{transform:none;box-shadow:none;border-color:var(--sp-border)}',
        '.pr-card.action{border-color:var(--sp-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--sp-accent) 18%,transparent)}',
        '.pr-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px}',
        '.pr-mon{font-weight:800;font-size:1rem}',
        '.pr-yr{color:var(--sp-quiet);font-weight:600;font-size:.78rem;margin-left:5px}',
        '.pr-chip{display:inline-block;font-size:.68rem;font-weight:800;letter-spacing:.03em;text-transform:uppercase;padding:2px 8px;border-radius:999px;border:1px solid var(--sp-border);background:var(--sp-pill-bg);color:var(--sp-muted);white-space:nowrap}',
        '.pr-chip.good{background:var(--sp-good-bg);border-color:var(--sp-good-br);color:var(--sp-good-fg)}',
        '.pr-chip.warn{background:var(--sp-warn-bg);border-color:var(--sp-warn-br);color:var(--sp-warn-fg)}',
        '.pr-big{font-size:1.5rem;font-weight:800;line-height:1.1;letter-spacing:-.01em}',
        '.pr-big small{font-size:.78rem;font-weight:600;color:var(--sp-muted);margin-left:3px;letter-spacing:0}',
        '.pr-money{color:var(--sp-text-2);font-size:.86rem;font-weight:600}',
        '.pr-steps{display:flex;gap:12px;font-size:.74rem;color:var(--sp-muted);margin-top:auto}',
        '.pr-step{display:inline-flex;align-items:center;gap:5px}',
        '.pr-dot{width:9px;height:9px;border-radius:50%;border:1.5px solid var(--sp-border-in);background:transparent;flex:none}',
        '.pr-step.on .pr-dot{background:var(--sp-good-fg);border-color:var(--sp-good-fg)}',
        '.pr-step.on{color:var(--sp-good-fg);font-weight:700}',
        '.pr-hint{font-size:.76rem;color:var(--sp-muted);min-height:1em}',
        '.pr-card.action .pr-hint{color:var(--sp-accent);font-weight:700}',
        '.pr-empty{padding:26px 18px;text-align:center;color:var(--sp-muted);background:var(--sp-surface);border:1.5px dashed var(--sp-border);border-radius:12px}',
        '.pr-err{padding:12px 14px;border-radius:10px;background:var(--sp-bad-bg);border:1px solid var(--sp-bad-br);color:var(--sp-bad-fg);font-size:.9rem}',
        /* queue */
        '.pr-queue{background:var(--sp-accent-soft);border:1.5px solid var(--sp-accent);border-radius:14px;padding:16px 18px;margin-bottom:18px}',
        '.pr-queue h3{margin:0 0 2px;font-size:1.02rem}',
        '.pr-queue .pr-sub{color:var(--sp-muted);font-size:.86rem;margin:0 0 12px}',
        '.pr-qlist{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}',
        '.pr-qrow{display:flex;align-items:center;gap:12px;background:var(--sp-surface);border:1px solid var(--sp-border);border-radius:10px;padding:8px 12px}',
        '.pr-qrow input{width:18px;height:18px;accent-color:var(--sp-accent);flex:none}',
        '.pr-av{width:30px;height:30px;border-radius:50%;background:var(--sp-warn-bg);color:var(--sp-warn-fg);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:.76rem;flex:none}',
        '.pr-qname{font-weight:700;font-size:.92rem}',
        '.pr-qmeta{color:var(--sp-muted);font-size:.8rem}',
        '.pr-qgrow{flex:1;min-width:0}',
        '.pr-qamt{font-weight:700;font-size:.88rem;white-space:nowrap}',
        '.pr-link{border:0;background:none;color:var(--sp-accent);font:inherit;font-size:.82rem;font-weight:700;cursor:pointer;padding:4px 6px;border-radius:6px}',
        '.pr-link:hover{background:var(--sp-surface-2)}',
        '.pr-qsign{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:end}',
        '@media(max-width:620px){.pr-qsign{grid-template-columns:1fr}}',
        '.pr-btn{border:1.5px solid var(--sp-border-in);background:var(--sp-surface);color:var(--sp-text);font:inherit;font-weight:700;font-size:.9rem;padding:9px 16px;border-radius:9px;cursor:pointer}',
        '.pr-btn:hover:not(:disabled){background:var(--sp-surface-2)}',
        '.pr-btn:disabled{opacity:.45;cursor:default}',
        '.pr-btn.primary{background:var(--sp-accent);border-color:var(--sp-accent);color:#fff}',
        '.pr-btn.primary:hover:not(:disabled){filter:brightness(1.08);background:var(--sp-accent)}',
        '.pr-msg{font-size:.84rem;margin-top:8px;min-height:1.1em}',
        '.pr-msg.bad{color:var(--sp-bad-fg)} .pr-msg.good{color:var(--sp-good-fg)}',
        /* modal */
        '.pr-modal{position:fixed;inset:0;z-index:1000;background:rgba(15,23,42,.55);display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:28px 14px}',
        '.pr-sheet{background:var(--sp-surface);color:var(--sp-text);border-radius:14px;width:100%;max-width:760px;box-shadow:0 24px 70px rgba(0,0,0,.35);overflow:hidden}',
        '.pr-sh-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 22px 14px;border-bottom:1px solid var(--sp-border)}',
        '.pr-sh-head h3{margin:0;font-size:1.12rem}',
        '.pr-sh-head .pr-sub{margin:2px 0 0;color:var(--sp-muted);font-size:.8rem}',
        '.pr-x{border:0;background:var(--sp-surface-2);color:var(--sp-text-2);width:32px;height:32px;border-radius:50%;font-size:1.1rem;cursor:pointer;flex:none}',
        '.pr-x:hover{background:var(--sp-border)}',
        '.pr-body{padding:16px 22px 6px}',
        '.pr-meta{display:flex;flex-wrap:wrap;gap:8px 28px;margin-bottom:14px}',
        '.pr-meta div{font-size:.8rem;color:var(--sp-muted)}',
        '.pr-meta b{display:block;color:var(--sp-text);font-size:1.02rem}',
        '.pr-days{display:grid;grid-template-columns:1fr 1fr;gap:14px}',
        '@media(max-width:640px){.pr-days{grid-template-columns:1fr}}',
        '.pr-t{width:100%;border-collapse:collapse;font-size:.84rem;border:1px solid var(--sp-border);border-radius:8px;overflow:hidden}',
        '.pr-t th{background:var(--sp-surface-2);font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;color:var(--sp-muted);padding:6px 8px;text-align:right}',
        '.pr-t th:first-child{text-align:left}',
        '.pr-t td{padding:3px 8px;text-align:right;border-top:1px solid var(--sp-border);font-variant-numeric:tabular-nums;height:25px}',
        '.pr-t td:first-child{text-align:left;color:var(--sp-text-2);font-weight:600}',
        '.pr-t td:first-child i{font-style:normal;font-weight:500;color:var(--sp-quiet);margin-left:6px;font-size:.72rem}',
        '.pr-t tr.wk td{background:var(--sp-surface-2);color:var(--sp-quiet)}',
        '.pr-t tr.tot td{background:var(--sp-surface-2);font-weight:800;color:var(--sp-text)}',
        '.pr-t input{width:62px;text-align:right;border:1px solid var(--sp-border-in);background:var(--sp-surface);color:var(--sp-text);border-radius:6px;padding:2px 5px;font:inherit}',
        '.pr-sum{display:flex;flex-direction:column;gap:6px;margin:14px 0 4px;padding:12px 14px;border-radius:10px;background:var(--sp-surface-2);border:1px solid var(--sp-border)}',
        '.pr-sum div{display:flex;justify-content:space-between;gap:12px;font-size:.92rem}',
        '.pr-sum b{font-variant-numeric:tabular-nums}',
        '.pr-wage{display:inline-flex;align-items:center;gap:6px;margin-top:10px;font-size:.86rem;color:var(--sp-muted)}',
        '.pr-wage input{width:78px;text-align:right;border:1px solid var(--sp-border-in);background:var(--sp-surface);color:var(--sp-text);border-radius:6px;padding:3px 6px;font:inherit}',
        '.pr-cert{font-size:.82rem;color:var(--sp-muted);line-height:1.55;margin:12px 0 4px}',
        '.pr-sigs{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:6px 22px 4px}',
        '@media(max-width:640px){.pr-sigs{grid-template-columns:1fr}}',
        '.pr-sig{border:1.5px solid var(--sp-border);border-radius:12px;padding:12px 12px 10px;background:var(--sp-surface)}',
        '.pr-sig.live{border-color:var(--sp-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--sp-accent) 14%,transparent)}',
        '.pr-sig h4{margin:0 0 2px;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;color:var(--sp-muted)}',
        '.pr-sig .who{font-weight:700;font-size:.92rem;margin-bottom:8px}',
        '.pr-sigimg{display:flex;align-items:center;justify-content:center;height:96px;background:#fff;border-radius:8px;border:1px solid var(--sp-border);overflow:hidden}',
        '.pr-sigimg img{max-width:100%;max-height:92px}',
        '.pr-signed{margin-top:8px;font-size:.8rem;color:var(--sp-good-fg);font-weight:700}',
        '.pr-wait{display:flex;align-items:center;justify-content:center;text-align:center;height:96px;border:1.5px dashed var(--sp-border-in);border-radius:8px;color:var(--sp-muted);font-size:.86rem;padding:0 12px}',
        '.pr-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:10px;padding:14px 22px 18px}',
        '.pr-foot .pr-msg{flex:1;margin:0;min-width:160px}',
        '.pr-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--sp-text);color:var(--sp-surface);padding:11px 18px;border-radius:999px;font-weight:700;font-size:.9rem;z-index:1100;box-shadow:0 8px 28px rgba(0,0,0,.3)}',
        '@media print{.pr-modal{position:static;background:none;padding:0}.pr-foot,.pr-x{display:none}}'
    ].join('\n');
    function injectCss() {
        if ($('pr-css')) return;
        var s = document.createElement('style');
        s.id = 'pr-css';
        s.textContent = CSS;
        document.head.appendChild(s);
    }

    function toast(text) {
        var old = document.querySelector('.pr-toast');
        if (old) old.remove();
        var t = document.createElement('div');
        t.className = 'pr-toast';
        t.setAttribute('role', 'status');
        t.textContent = text;
        document.body.appendChild(t);
        setTimeout(function () { if (t.parentNode) t.remove(); }, 3200);
    }

    // ── who is looking ──
    function who() { return (H && H.getWho && H.getWho()) || {}; }
    function isSelf(staffId) { var w = who(); return !!w.staffId && String(w.staffId) === String(staffId); }
    function queueHas(staffId, month) {
        return !!(ST.queue && ST.queue.items.some(function (x) { return String(x.staffId) === String(staffId) && x.month === month; }));
    }
    function needsMe(m) {
        return (m.status === 'ready' && isSelf(ST.staffId)) || (m.status === 'awaitRep' && queueHas(ST.staffId, m.month));
    }

    /* The number shown on the tab: reports waiting on the viewer. */
    function count(s) {
        var n = 0;
        try {
            if (ST.list && String(ST.staffId) === String(s && s.Id) && isSelf(s.Id)) {
                n += ST.list.months.filter(function (m) { return m.status === 'ready'; }).length;
            }
            if (ST.queue && ST.queue.isRep && isSelf(s && s.Id)) n += ST.queue.items.length;
        } catch (e) { /* a badge must never break the page */ }
        return n;
    }
    function paintBadge() {
        var tab = $('sptab_reports');
        if (!tab) return;
        var span = tab.querySelector('.sp-count');
        var n = count({ Id: ST.staffId });
        if (!n) { if (span) span.remove(); return; }
        if (!span) { span = document.createElement('span'); span.className = 'sp-count'; tab.appendChild(span); }
        span.textContent = String(n);
    }

    // ── panel ──
    function panelHtml() { return '<div class="pr" id="prRoot"><div class="pr-empty">Loading your reports\u2026</div></div>'; }

    async function load(s) {
        ST.staffId = s.Id;
        ST.error = '';
        if (!ST.fy) ST.fy = currentFy();
        try {
            var q = isSelf(s.Id) || (who().admin || who().director)
                ? api('/api/personnel-reports-queue?fy=' + ST.fy).catch(function () { return { isRep: false, items: [] }; })
                : Promise.resolve({ isRep: false, items: [] });
            var l = await api('/api/personnel-reports?staffId=' + encodeURIComponent(s.Id) + '&fy=' + ST.fy);
            ST.list = l;
            ST.queue = await q;
        } catch (e) {
            ST.error = e.message || String(e);
            ST.list = null;
        }
    }

    async function wire(s) {
        if (!s || !s.Id) return;
        injectCss();
        var root = $('prRoot');
        if (!root) return;
        if (!ST.list || String(ST.staffId) !== String(s.Id)) await load(s);
        renderPanel(s);
        paintBadge();
    }

    function chip(m) {
        var map = { complete: ['good', 'Complete'], awaitRep: ['warn', 'Needs Sara'], ready: ['warn', 'Ready to sign'],
            upcoming: ['', 'In progress'], future: ['', 'Upcoming'], none: ['', 'No hours'] };
        var c = map[m.status] || ['', m.status];
        return '<span class="pr-chip ' + c[0] + '">' + c[1] + '</span>';
    }

    function hintFor(m) {
        if (m.status === 'complete') return 'Filed ' + dayShort(m.rep && m.rep.at);
        if (m.status === 'awaitRep') return queueHas(ST.staffId, m.month) ? 'Your signature' : 'Waiting for Sara';
        if (m.status === 'ready') return isSelf(ST.staffId) ? 'Your signature' : 'Waiting for ' + firstName();
        if (m.status === 'upcoming') return 'Signs on ' + dayShort(m.endsOn);
        if (m.status === 'future') return '';
        return 'Nothing to sign';
    }
    function firstName() { return String((ST.list && ST.list.staff && ST.list.staff.name) || 'them').split(' ')[0]; }

    function monthCard(m) {
        var y = calYear(ST.fy, m.month);
        var cls = 'pr-card' + (m.status === 'future' ? ' future' : '') + (needsMe(m) ? ' action' : '');
        var big = m.status === 'future' ? '' : (m.hours > 0 ? '<div class="pr-big">' + hrs(m.hours) + '<small>hrs</small></div><div class="pr-money">' + money(m.total) + '</div>'
            : '<div class="pr-big" style="color:var(--sp-quiet)">\u2014</div>');
        return '<button type="button" class="' + cls + '" data-month="' + m.month + '"' + (m.status === 'future' ? ' disabled' : '')
            + ' aria-label="' + esc(MON_LONG[m.month] + ' ' + y + ': ' + chipText(m)) + '">'
            + '<div class="pr-top"><span class="pr-mon">' + MON[m.month] + '<span class="pr-yr">' + y + '</span></span>' + (m.status === 'future' ? '' : chip(m)) + '</div>'
            + big
            + (m.status === 'future' ? '' : '<div class="pr-steps">'
                + '<span class="pr-step' + (m.emp ? ' on' : '') + '"><span class="pr-dot"></span>' + esc(firstName()) + '</span>'
                + '<span class="pr-step' + (m.rep ? ' on' : '') + '"><span class="pr-dot"></span>Sara</span></div>')
            + '<div class="pr-hint">' + esc(hintFor(m)) + '</div></button>';
    }
    function chipText(m) { var d = document.createElement('div'); d.innerHTML = chip(m); return d.textContent; }

    function queueCard() {
        var q = ST.queue;
        if (!q || !q.isRep || !q.items.length || !isSelf(ST.staffId)) return '';
        var rows = q.items.map(function (x, i) {
            var ini = String(x.name || '?').split(/\s+/).map(function (p) { return p[0]; }).slice(0, 2).join('').toUpperCase();
            return '<label class="pr-qrow"><input type="checkbox" checked data-q="' + i + '" aria-label="Select ' + esc(x.name + ' ' + x.label) + '">'
                + '<span class="pr-av" aria-hidden="true">' + esc(ini) + '</span>'
                + '<span class="pr-qgrow"><span class="pr-qname">' + esc(x.name) + '</span><br><span class="pr-qmeta">' + esc(x.label) + ' \u00b7 signed ' + esc(dayShort(x.signedAt)) + '</span></span>'
                + '<span class="pr-qamt">' + hrs(x.hours) + ' hrs \u00b7 ' + money(x.total) + '</span>'
                + '<button type="button" class="pr-link" data-review="' + i + '">Review</button></label>';
        }).join('');
        return '<section class="pr-queue" aria-labelledby="prQh"><h3 id="prQh">Waiting for your signature</h3>'
            + '<p class="pr-sub">Each of these has been signed by the employee. Look over any you like, then sign once to countersign every ticked report.</p>'
            + '<div class="pr-qlist">' + rows + '</div>'
            + '<div class="pr-qsign"><div><div id="prQPad"></div><div class="pr-msg" id="prQMsg" role="status"></div></div>'
            + '<button type="button" class="pr-btn primary" id="prQGo" disabled>Sign ' + q.items.length + ' report' + (q.items.length === 1 ? '' : 's') + '</button></div>'
            + '</section>';
    }

    function renderPanel(s) {
        var root = $('prRoot');
        if (!root) return;
        var h = '';
        if (ST.error) {
            root.innerHTML = '<div class="pr-err">Could not load the reports: ' + esc(ST.error) + ' Nothing has been lost; this is a read problem. <button type="button" class="pr-link" id="prRetry">Try again</button></div>';
            var rt = $('prRetry'); if (rt) rt.onclick = function () { ST.list = null; wire(s); };
            return;
        }
        var l = ST.list;
        h += queueCard();
        h += '<div class="pr-head"><div><h2>Monthly activity reports</h2><p>'
            + (isSelf(s.Id) ? 'Your time on the Food Program, month by month. Sign each one when the month ends; Sara signs after you, and the finished PDF is filed here.'
                : 'The Food Program time report for ' + esc(String(s.Name || '').split(' ')[0]) + ', month by month.')
            + '</p></div>'
            + '<div class="pr-fy" role="group" aria-label="Fiscal year"><button type="button" id="prPrev" aria-label="Previous year"' + (ST.fy <= FIRST_FY ? ' disabled' : '') + '>\u2039</button>'
            + '<span>' + fyLabel(ST.fy) + '</span><button type="button" id="prNext" aria-label="Next year"' + (ST.fy >= currentFy() ? ' disabled' : '') + '>\u203a</button></div></div>';
        if (!l.tracked) {
            h += '<div class="pr-empty">There are no activity reports for ' + esc(String(s.Name || 'this person')) + '. Reports exist for staff who are on the Personnel Activity sheet.</div>';
        } else {
            h += '<div class="pr-grid">' + l.months.map(monthCard).join('') + '</div>';
        }
        root.innerHTML = h;

        var prev = $('prPrev'), next = $('prNext');
        if (prev) prev.onclick = function () { changeFy(s, -1); };
        if (next) next.onclick = function () { changeFy(s, 1); };
        root.querySelectorAll('.pr-card:not(.future)').forEach(function (b) {
            b.onclick = function () { openReport(s.Id, ST.fy, +b.getAttribute('data-month')); };
        });
        wireQueue(s);
    }

    async function changeFy(s, d) {
        var v = ST.fy + d;
        if (v < FIRST_FY || v > currentFy()) return;
        ST.fy = v; ST.list = null;
        var root = $('prRoot'); if (root) root.innerHTML = '<div class="pr-empty">Loading\u2026</div>';
        await load(s); renderPanel(s); paintBadge();
    }

    // ── Sara's queue ──
    function wireQueue(s) {
        var host = $('prQPad');
        ST.pad = null;
        if (!host || !window.SignPad) return;
        var go = $('prQGo');
        var q = ST.queue;
        function selected() {
            return Array.prototype.slice.call(document.querySelectorAll('.pr-qrow input:checked'))
                .map(function (c) { return q.items[+c.getAttribute('data-q')]; });
        }
        function sync() {
            var n = selected().length;
            go.textContent = n ? 'Sign ' + n + ' report' + (n === 1 ? '' : 's') : 'Select a report';
            go.disabled = !(n && ST.pad && ST.pad.drawn);
        }
        ST.pad = window.SignPad.create(host, { onChange: sync });
        setTimeout(function () { if (ST.pad) ST.pad.refresh(); }, 30);
        document.querySelectorAll('.pr-qrow input').forEach(function (c) { c.onchange = sync; });
        document.querySelectorAll('[data-review]').forEach(function (b) {
            b.onclick = function (e) {
                e.preventDefault(); e.stopPropagation();
                var it = q.items[+b.getAttribute('data-review')];
                openReport(it.staffId, ST.fy, it.month);
            };
        });
        sync();
        go.onclick = async function () {
            var items = selected();
            var url = ST.pad.toDataUrl();
            var msg = $('prQMsg');
            if (!items.length || !url) return;
            go.disabled = true;
            var done = 0, failed = [];
            for (var i = 0; i < items.length; i++) {
                msg.className = 'pr-msg'; msg.textContent = 'Signing ' + (i + 1) + ' of ' + items.length + '\u2026';
                try {
                    await api('/api/personnel-report-sign', { method: 'POST', body: JSON.stringify({
                        staffId: items[i].staffId, fy: ST.fy, month: items[i].month, role: 'rep', dataUrl: url }) });
                    done++;
                } catch (e) { failed.push(items[i].name + ' ' + items[i].label + ': ' + (e.message || e)); }
            }
            ST.list = null;
            await load(s);
            renderPanel(s);
            paintBadge();
            if (failed.length) {
                var m2 = $('prQMsg') || $('prRoot');
                if (m2) { m2.className = 'pr-msg bad'; m2.textContent = done + ' signed. Not signed: ' + failed.join('; '); }
            } else {
                toast(done + ' report' + (done === 1 ? '' : 's') + ' signed and filed');
            }
        };
    }

    // ── the report sheet ──
    async function openReport(staffId, fy, month) {
        injectCss();
        var prevFocus = document.activeElement;
        var wrap = document.createElement('div');
        wrap.className = 'pr-modal';
        wrap.innerHTML = '<div class="pr-sheet" role="dialog" aria-modal="true" aria-labelledby="prTitle"><div class="pr-body"><div class="pr-empty">Opening the report\u2026</div></div></div>';
        document.body.appendChild(wrap);
        document.body.style.overflow = 'hidden';
        function close() {
            document.removeEventListener('keydown', onKey, true);
            wrap.remove();
            document.body.style.overflow = '';
            if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch (e) { /* gone */ }
        }
        function onKey(e) {
            if (e.key === 'Escape') { e.preventDefault(); close(); return; }
            if (e.key !== 'Tab') return;
            var f = wrap.querySelectorAll('button:not(:disabled),input,canvas,a[href]');
            if (!f.length) return;
            var first = f[0], last = f[f.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
        document.addEventListener('keydown', onKey, true);
        wrap.addEventListener('mousedown', function (e) { if (e.target === wrap) close(); });

        var d;
        try {
            d = await api('/api/personnel-report?staffId=' + encodeURIComponent(staffId) + '&fy=' + fy + '&month=' + month);
        } catch (e) {
            wrap.querySelector('.pr-body').innerHTML = '<div class="pr-err">Could not open the report: ' + esc(e.message || e) + '</div><div class="pr-foot"><button type="button" class="pr-btn" id="prCloseErr">Close</button></div>';
            $('prCloseErr').onclick = close;
            return;
        }
        paintSheet(wrap, d, staffId, fy, month, close);
    }

    function dayTable(days, withTotal, rep, editable) {
        var rows = days.map(function (x) {
            var a = x.admin > 0 ? hrs(x.admin) : '', o = x.oper > 0 ? hrs(x.oper) : '';
            if (editable) {
                a = '<input inputmode="decimal" data-d="' + x.d + '" data-k="admin" value="' + esc(a) + '" aria-label="Administrative hours, day ' + x.d + '">';
                o = '<input inputmode="decimal" data-d="' + x.d + '" data-k="oper" value="' + esc(o) + '" aria-label="Operational hours, day ' + x.d + '">';
            }
            return '<tr' + (x.wknd ? ' class="wk"' : '') + '><td>' + x.d + '<i>' + x.dow + '</i></td><td>' + a + '</td><td>' + o + '</td></tr>';
        }).join('');
        if (withTotal) rows += '<tr class="tot"><td>Total</td><td data-tot="admin">' + (rep.adminHours > 0 ? hrs(rep.adminHours) : '') + '</td><td data-tot="oper">' + (rep.operHours > 0 ? hrs(rep.operHours) : '') + '</td></tr>';
        return '<table class="pr-t"><thead><tr><th>Date</th><th>Administrative</th><th>Operational</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }

    function sigBox(kind, d, padId) {
        var sm = d.summary, can = d.can;
        var rec = kind === 'emp' ? sm.emp : sm.rep;
        var title = kind === 'emp' ? 'Employee' : 'Director / authorized representative';
        var name = kind === 'emp' ? d.report.name : (rec ? rec.name : 'Sara Holliday');
        if (rec) {
            return '<div class="pr-sig"><h4>' + title + '</h4><div class="who">' + esc(name) + '</div>'
                + '<div class="pr-sigimg" id="' + padId + 'Img"></div>'
                + '<div class="pr-signed">\u2713 Signed ' + esc(dayShort(rec.at)) + '</div></div>';
        }
        var mine = kind === 'emp' ? can.signEmployee : can.signRep;
        if (mine) {
            return '<div class="pr-sig live"><h4>' + title + '</h4><div class="who">' + esc(kind === 'emp' ? d.report.name : (who().name || 'You')) + ', sign below</div>'
                + '<div id="' + padId + '"></div></div>';
        }
        var why;
        if (kind === 'emp') why = sm.status === 'upcoming' ? 'Opens for signing on ' + dayShort(sm.endsOn)
            : (sm.status === 'none' ? 'There are no hours to sign' : 'Waiting for ' + String(d.report.name).split(' ')[0] + ' to sign');
        else why = sm.emp ? 'Waiting for the authorized representative' : 'Signs after ' + String(d.report.name).split(' ')[0];
        return '<div class="pr-sig"><h4>' + title + '</h4><div class="who">' + esc(kind === 'emp' ? d.report.name : 'Sara Holliday') + '</div><div class="pr-wait">' + esc(why) + '</div></div>';
    }

    function totalsBlock(r) {
        var h = '';
        if (r.operHours > 0 || r.adminHours <= 0) h += '<div><span>Operational: ' + hrs(r.operHours) + ' hrs \u00d7 ' + money(r.rate) + '</span><b data-sum="oper">' + money(r.opTotal) + '</b></div>';
        if (r.adminHours > 0) h += '<div><span>Administrative: ' + hrs(r.adminHours) + ' hrs \u00d7 ' + money(r.rate) + '</span><b data-sum="admin">' + money(r.adTotal) + '</b></div>';
        return h;
    }

    function paintSheet(wrap, d, staffId, fy, month, close) {
        var r = d.report, sm = d.summary, can = d.can;
        var editable = !!can.edit;
        var left = r.days.filter(function (x) { return x.d <= 16; }), right = r.days.filter(function (x) { return x.d > 16; });
        var statusChip = chip(sm);
        var h = '<div class="pr-sheet" role="dialog" aria-modal="true" aria-labelledby="prTitle">'
            + '<div class="pr-sh-head"><div><h3 id="prTitle">Personnel Activity Report</h3><p class="pr-sub">Child and Adult Care Food Program (CACFP)</p></div>'
            + '<div style="display:flex;gap:10px;align-items:center">' + statusChip + '<button type="button" class="pr-x" id="prX" aria-label="Close">\u00d7</button></div></div>'
            + '<div class="pr-body">'
            + '<div class="pr-meta"><div>Employee<b>' + esc(r.name) + '</b></div><div>Month<b>' + esc(r.monthLabel) + '</b></div>'
            + '<div>Hours per day<b>' + (r.hpd ? hrs(r.hpd) + ' on scheduled days' : 'entered by hand') + '</b></div></div>'
            + '<div class="pr-days" id="prDays"><div>' + dayTable(left, false, r, editable) + '</div><div>' + dayTable(right, true, r, editable) + '</div></div>'
            + (editable ? '<label class="pr-wage">Hourly wage $<input inputmode="decimal" id="prRate" value="' + esc(r.rate) + '" aria-label="Hourly wage"></label>' : '')
            + '<div class="pr-sum" id="prSum">' + totalsBlock(r) + '</div>'
            + '<p class="pr-cert">I certify that this is an accurate record of the number of hours worked on the Child and Adult Care Food Program, and that payroll records are on file that verify the wages listed above.</p>'
            + '</div>'
            + '<div class="pr-sigs">' + sigBox('emp', d, 'prSigE') + sigBox('rep', d, 'prSigR') + '</div>'
            + '<div class="pr-foot"><div class="pr-msg" id="prMsg" role="status"></div>'
            + (sm.pdf ? '<button type="button" class="pr-btn" id="prPdf">Open the PDF</button>' : '')
            + (editable ? '<button type="button" class="pr-btn" id="prSave">Save hours</button>' : '')
            + (can.signEmployee ? '<button type="button" class="pr-btn primary" id="prSignE" disabled>Sign my report</button>' : '')
            + (can.signRep ? '<button type="button" class="pr-btn primary" id="prSignR" disabled>Sign as authorized representative</button>' : '')
            + '<button type="button" class="pr-btn" id="prDone">Close</button></div></div>';
        wrap.innerHTML = h;
        wrap.setAttribute('role', 'presentation');
        $('prX').onclick = close; $('prDone').onclick = close;
        $('prX').focus();
        if (sm.pdf && $('prPdf')) $('prPdf').onclick = function () { H.openFile(sm.pdf); };

        // Signatures already on file, shown as the real ink.
        [['prSigEImg', sm.emp], ['prSigRImg', sm.rep]].forEach(function (p) {
            var host = $(p[0]);
            if (!host || !p[1] || !p[1].sig) return;
            H.fetch('/api/doc-file?path=' + encodeURIComponent(p[1].sig)).then(function (res) { return res.ok ? res.blob() : null; })
                .then(function (b) { if (b) host.innerHTML = '<img alt="Signature" src="' + URL.createObjectURL(b) + '">'; });
        });

        function wirePad(hostId, btnId, role) {
            var host = $(hostId), btn = $(btnId);
            if (!host || !btn || !window.SignPad) return;
            var pad = window.SignPad.create(host, { onChange: function () { btn.disabled = !pad.drawn; } });
            setTimeout(function () { pad.refresh(); }, 30);
            btn.onclick = async function () {
                var url = pad.toDataUrl(), msg = $('prMsg');
                if (!url) return;
                btn.disabled = true; msg.className = 'pr-msg'; msg.textContent = 'Signing\u2026';
                try {
                    // Hand-entered hours are saved first, so what is signed is what is on screen.
                    if (role === 'employee' && wrap._save) await wrap._save();
                    var out = await api('/api/personnel-report-sign', { method: 'POST', body: JSON.stringify({ staffId: staffId, fy: fy, month: month, role: role, dataUrl: url }) });
                    close();
                    toast(out.status === 'complete' ? 'Signed and filed to ' + String(r.name).split(' ')[0] + '\u2019s card' : 'Signed. It goes to Sara next.');
                    ST.list = null;
                    var s = { Id: ST.staffId };
                    await load(s);
                    renderPanel({ Id: ST.staffId, Name: (ST.list && ST.list.staff && ST.list.staff.name) || '' });
                    paintBadge();
                } catch (e) {
                    msg.className = 'pr-msg bad'; msg.textContent = e.message || String(e);
                    btn.disabled = !pad.drawn;
                }
            };
        }
        if (can.signEmployee) wirePad('prSigE', 'prSignE', 'employee');
        if (can.signRep) wirePad('prSigR', 'prSignR', 'rep');

        if (editable) wireEditor(wrap, r, staffId, fy, month);
    }

    // Sara's hand-entered hours.
    function wireEditor(wrap, r, staffId, fy, month) {
        function numOf(v) { var n = parseFloat(String(v).replace(/[^0-9.]/g, '')); return isFinite(n) ? n : 0; }
        function collect() {
            var map = {};
            wrap.querySelectorAll('#prDays input[data-d]').forEach(function (i) {
                var dd = +i.getAttribute('data-d');
                map[dd] = map[dd] || { d: dd, admin: 0, oper: 0 };
                map[dd][i.getAttribute('data-k')] = numOf(i.value);
            });
            return Object.keys(map).map(function (k) { return map[k]; });
        }
        function recalc() {
            var days = collect(), a = 0, o = 0, rate = numOf($('prRate').value);
            days.forEach(function (x) { a += x.admin; o += x.oper; });
            var tA = wrap.querySelector('[data-tot="admin"]'), tO = wrap.querySelector('[data-tot="oper"]');
            if (tA) tA.textContent = a > 0 ? hrs(a) : ''; if (tO) tO.textContent = o > 0 ? hrs(o) : '';
            $('prSum').innerHTML = totalsBlock({ operHours: o, adminHours: a, rate: rate, opTotal: o * rate, adTotal: a * rate });
        }
        wrap.querySelectorAll('#prDays input').forEach(function (i) { i.oninput = recalc; });
        $('prRate').oninput = recalc;
        // The one place hand-entered hours are sent. Also called before the employee signs.
        wrap._save = function () {
            return api('/api/personnel-report-draft', { method: 'POST', body: JSON.stringify({ staffId: staffId, fy: fy, month: month, days: collect(), rate: numOf($('prRate').value) }) });
        };
        $('prSave').onclick = async function () {
            var msg = $('prMsg'), b = $('prSave');
            b.disabled = true; msg.className = 'pr-msg'; msg.textContent = 'Saving\u2026';
            try {
                await wrap._save();
                msg.className = 'pr-msg good'; msg.textContent = 'Saved. The Personnel Activity sheet is updated.';
                ST.list = null;
                await load({ Id: ST.staffId });
                renderPanel({ Id: ST.staffId, Name: (ST.list && ST.list.staff && ST.list.staff.name) || '' });
                paintBadge();
            } catch (e) { msg.className = 'pr-msg bad'; msg.textContent = e.message || String(e); }
            b.disabled = false;
        };
    }

    window.PersonnelReportsUI = {
        init: function (host) { H = host; },
        panelHtml: panelHtml,
        wire: wire,
        count: count,
        prefetch: async function (s) {
            if (!s || !s.Id || !isSelf(s.Id)) return;
            if (!ST.list || String(ST.staffId) !== String(s.Id)) { await load(s); paintBadge(); }
        }
    };
})();
