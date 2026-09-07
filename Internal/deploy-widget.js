/* ══════════════════════════════════════════════════════════════════
   Deploy / Restart controls widget

   A small fixed-position control with a Deploy button and a Restart
   button, for pages that are under active development so the director
   does not have to return to the portal to ship a change.

   The two actions are genuinely different and the server treats them
   that way:
     Deploy  → POST /api/deploy   pulls latest code from GitHub. HTML/JS
               changes take effect on the next page load. server.js
               changes do NOT take effect until a restart.
     Restart → POST /api/restart  relaunches the Node process. Needed
               after server.js changes. Briefly drops the server (a few
               seconds), so it confirms first.

   Self-contained on purpose: it defines its own auth and injects its own
   markup, so it can be dropped onto any staff page with a single script
   tag regardless of whether that page loads app.js. It guards every
   global it defines so including it twice, or alongside app.js, cannot
   throw a redeclaration error.
   ══════════════════════════════════════════════════════════════════ */

(function () {
    'use strict';
    if (window.__deployWidgetLoaded) return;   // idempotent
    window.__deployWidgetLoaded = true;

    // Authorization is deliberately NOT set here. The browser attaches the
// staff Basic credentials to same-origin requests by itself, so hardcoding
// the password would ship it to every visitor and break on every rotation.

    function inject() {
        if (document.getElementById('deployWidget')) return;

        const wrap = document.createElement('div');
        wrap.id = 'deployWidget';
        wrap.innerHTML =
            '<button type="button" id="dwDeploy" class="dw-btn dw-deploy" title="Pull the latest code from GitHub. Page and script changes take effect on reload; server.js changes need a restart.">🚀 Deploy</button>'
            + '<button type="button" id="dwRestart" class="dw-btn dw-restart" title="Restart the server. Needed after server.js changes. Briefly takes the site offline.">♻️ Restart</button>';
        document.body.appendChild(wrap);

        document.getElementById('dwDeploy').addEventListener('click', onDeploy);
        document.getElementById('dwRestart').addEventListener('click', onRestart);

        injectStyle();
    }

    // Runs an action button through the shared pending → success/fail cycle so
    // both buttons behave and look identical to the portal's Deploy.
    async function runAction(btn, opts) {
        const original = btn.textContent;
        btn.disabled = true;
        btn.dataset.state = 'pending';
        btn.textContent = opts.pendingText;
        try {
            // Credentials come from the Staff Portal sign-in via the shared helper.
            const res = await fetch(opts.url, {
                method: 'POST',
                headers: (window.CofpAuth && CofpAuth.header())
                    ? { 'Authorization': CofpAuth.header() } : {}
            });
            let json = {};
            try { json = await res.json(); } catch (e) { /* restart may cut the response short */ }
            const ok = res.ok && (json.success !== false);
            if (ok) {
                btn.dataset.state = 'ok';
                btn.textContent = opts.okText;
                if (opts.onOk) opts.onOk(json);
            } else {
                throw new Error(json.error || ('HTTP ' + res.status));
            }
        } catch (e) {
            // A restart deliberately kills the connection, so a network error
            // right after asking to restart is expected, not a failure.
            if (opts.tolerateNetworkError) {
                btn.dataset.state = 'ok';
                btn.textContent = opts.okText;
                if (opts.onOk) opts.onOk(null);
            } else {
                btn.dataset.state = 'fail';
                btn.textContent = opts.failText;
                alert(opts.label + ' failed: ' + e.message);
            }
        } finally {
            setTimeout(() => {
                btn.disabled = false;
                btn.dataset.state = '';
                btn.textContent = original;
            }, opts.resetMs || 3500);
        }
    }

    function onDeploy() {
        if (!confirm('Pull the latest code from GitHub?\n\nPage and script changes take effect when you reload. If server.js changed, use Restart afterward.')) return;
        runAction(document.getElementById('dwDeploy'), {
            label: 'Deploy',
            url: '/api/deploy',
            pendingText: '⏳ Deploying…',
            okText: '✓ Deployed',
            failText: '✗ Failed'
        });
    }

    function onRestart() {
        if (!confirm('Restart the server now?\n\nThis takes the site offline for a few seconds while it relaunches. Do this after a Deploy that changed server.js.')) return;
        runAction(document.getElementById('dwRestart'), {
            label: 'Restart',
            url: '/api/restart',
            pendingText: '⏳ Restarting…',
            okText: '✓ Restarting',
            failText: '✗ Failed',
            tolerateNetworkError: true,
            resetMs: 8000,
            onOk: function () {
                // The old process is exiting; a short reload lands on the fresh one.
                setTimeout(() => location.reload(), 6000);
            }
        });
    }

    function injectStyle() {
        if (document.getElementById('dwStyle')) return;
        const s = document.createElement('style');
        s.id = 'dwStyle';
        s.textContent =
            '#deployWidget{position:fixed;right:16px;bottom:16px;z-index:9999;display:flex;gap:8px;background:rgba(255,255,255,0.96);'
            + 'padding:8px;border-radius:10px;box-shadow:0 3px 14px rgba(0,0,0,0.18);border:1px solid #e5e7eb;}'
            + '.dw-btn{padding:8px 14px;border:none;border-radius:7px;font-size:0.8rem;font-weight:700;cursor:pointer;color:white;'
            + 'font-family:inherit;transition:background 0.15s,opacity 0.15s;white-space:nowrap;}'
            + '.dw-btn:disabled{opacity:0.65;cursor:default;}'
            + '.dw-deploy{background:#16a34a;} .dw-deploy:hover:not(:disabled){background:#15803d;}'
            + '.dw-restart{background:#b45309;} .dw-restart:hover:not(:disabled){background:#92400e;}'
            + '.dw-btn[data-state=ok]{background:#16a34a;} .dw-btn[data-state=fail]{background:#dc2626;}'
            + '@media print{#deployWidget{display:none !important;}}';
        document.head.appendChild(s);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inject);
    } else {
        inject();
    }
})();
