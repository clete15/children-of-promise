/* ══════════════════════════════════════════════════════════════════
   PAS worksheet store

   The PAS self-assessment and its supporting worksheets once kept their
   answers in browser localStorage. That made the artifact being prepared
   for submission invisible to anyone on another machine and vulnerable to
   a cleared cache. Answers now live in the database, and the SERVER IS THE
   SINGLE SOURCE OF TRUTH — this store no longer touches localStorage at all.

   Design: the pages already read and write synchronously via a
   localStorage-shaped object, so this exposes `PasStore.storage` with the
   same getItem/setItem/removeItem shape, backed by an in-memory cache that
   is filled from the server before the page initialises and written through
   to the server on every change. A page needs two edits: await
   PasStore.ready, and use PasStore.storage in place of localStorage.

   No caching, no migration: nothing is mirrored in the browser, so there is
   no stale local drawer to diverge from the server and no "this browser
   holds a different copy" conflict to reconcile. If the server cannot be
   reached the page goes read-only (see the connectivity banner below) rather
   than quietly saving to a machine no one else can see.
   ══════════════════════════════════════════════════════════════════ */

(function () {
    'use strict';
    if (window.PasStore) return;

    // Authorization is deliberately NOT set here. The browser attaches the
// staff Basic credentials to same-origin requests by itself, so hardcoding
// the password would ship it to every visitor and break on every rotation.
    const ENDPOINT = '/api/pas-worksheets';

    // Keys of the form <prefix><scope>, where the trailing part identifies a
    // classroom. Everything else is a single program-level worksheet.
    const SCOPED_PREFIXES = ['pas_teaching_staff_quals_'];

    /* Generic scope separator, for worksheets that exist once per person per year
       rather than once for the programme: "pas_annual_appraisal__staff7_2026-2027".

       A double underscore rather than another entry in SCOPED_PREFIXES, so a new
       per-person form needs no change here at all. Safe to introduce: no existing
       key contains "__", so nothing already stored is re-interpreted. */
    const SCOPE_SEPARATOR = '__';

    // cache: "worksheet\u0000scope" -> raw JSON string, mirroring what the pages
    // previously handed to localStorage.
    const cache = new Map();
    let lastError = null;

    function splitKey(key) {
        // Explicit separator wins: it is unambiguous and needs no prefix registered.
        const at = key.indexOf(SCOPE_SEPARATOR);
        if (at > 0) {
            return {
                worksheet: key.slice(0, at),
                scope: key.slice(at + SCOPE_SEPARATOR.length)
            };
        }
        for (const p of SCOPED_PREFIXES) {
            if (key.indexOf(p) === 0) {
                return { worksheet: p.replace(/_$/, ''), scope: key.slice(p.length) };
            }
        }
        return { worksheet: key, scope: '' };
    }

    const cacheKey = (worksheet, scope) => worksheet + '\u0000' + (scope || '');

    /* Credentials come from a sign-in, never from source. Asking for the whole
       header set rather than the Basic one alone is what lets an individual staff
       member open their own appraisal: their browser carries a session token, and
       the server returns and accepts only the worksheets scoped to them. */
    function api(opts) {
        return fetch(ENDPOINT, Object.assign({
            headers: Object.assign({ 'Content-Type': 'application/json' },
                (window.CofpAuth && CofpAuth.headers) ? CofpAuth.headers() : {})
        }, opts));
    }

    async function fetchAll() {
        const res = await api({ method: 'GET' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const rows = await res.json();
        cache.clear();
        (Array.isArray(rows) ? rows : []).forEach(r => {
            cache.set(cacheKey(r.WorksheetKey, r.ScopeKey), JSON.stringify(r.Payload || {}));
        });
    }

    async function push(worksheet, scope, payloadObj) {
        const res = await api({
            method: 'POST',
            body: JSON.stringify({ worksheet: worksheet, scope: scope, payload: payloadObj })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Save failed');
    }

    /* The server is the single source of truth for this system. This store no longer
       reads, writes, or migrates browser localStorage at all — the old migration and
       the "this browser holds a different copy" conflict banner are gone with it.

       History (10 Sep 2026): the store used to mirror answers in localStorage and, on
       load, reconcile that mirror against the server. That reconciliation is what
       produced the recurring "3 here / 16 on the server" banner: a machine carried a
       stale drawer the server had long since surpassed, and the code refused to guess
       which won. With localStorage out of the picture there is nothing to diverge, so
       the banner cannot occur. The only banner left is the connectivity guard below,
       which is not caching — it stops a page pretending a save happened when the
       server was unreachable. */

    /* The failure this exists to stop being invisible.

       When the first read fails the store keeps working against localStorage, which
       is the right call — it beats losing what someone is typing. What was wrong was
       doing it silently: a director could complete all 25 PAS items, see every answer
       on screen, and have none of it leave her laptop. Nobody finds that out until
       somebody else opens the page and sees "not started". */
    function banner(html, colour) {
        const show = () => {
            if (document.getElementById('pasStoreBanner')) return;
            const el = document.createElement('div');
            el.id = 'pasStoreBanner';
            el.setAttribute('role', 'alert');
            el.style.cssText = 'position:sticky;top:0;z-index:99999;background:' + colour
                + ';color:#fff;padding:10px 16px;font:600 0.82rem/1.5 system-ui,sans-serif;'
                + 'box-shadow:0 2px 8px rgba(0,0,0,0.2);';
            el.innerHTML = html;
            document.body.insertBefore(el, document.body.firstChild);
        };
        if (document.body) show();
        else document.addEventListener('DOMContentLoaded', show);
    }

    // localStorage-shaped facade. Reads hit the cache so existing synchronous
    // page code keeps working; writes update the cache and fire the save.
    const storage = {
        getItem: function (key) {
            const { worksheet, scope } = splitKey(key);
            const v = cache.get(cacheKey(worksheet, scope));
            return v === undefined ? null : v;
        },
        setItem: function (key, value) {
            const { worksheet, scope } = splitKey(key);
            cache.set(cacheKey(worksheet, scope), value);
            let obj;
            try { obj = JSON.parse(value); } catch (e) { return; }
            push(worksheet, scope, obj).catch(e => {
                lastError = e.message;
                console.error('[PasStore] save failed for ' + key + ': ' + e.message);
                alert('That did not save to the server: ' + e.message
                    + '\n\nYour entry is still on screen. Check the connection and save again.');
            });
        },
        removeItem: function (key) {
            const { worksheet, scope } = splitKey(key);
            cache.delete(cacheKey(worksheet, scope));
            // An empty payload is how the server records "not started".
            push(worksheet, scope, {}).catch(e =>
                console.error('[PasStore] clear failed for ' + key + ': ' + e.message));
        },
        // Present so a page iterating keys still behaves.
        get length() { return cache.size; },
        key: function (i) {
            const keys = [...cache.keys()];
            if (i < 0 || i >= keys.length) return null;
            const [worksheet, scope] = keys[i].split('\u0000');
            if (!scope) return worksheet;
            /* Rebuild the key the same way it was split, or a round trip through
               key() would not resolve back to the same worksheet. Classroom keys
               used a bare underscore; everything else uses the explicit separator. */
            const wasPrefixed = SCOPED_PREFIXES.some(p => p.replace(/_$/, '') === worksheet);
            return worksheet + (wasPrefixed ? '_' : SCOPE_SEPARATOR) + scope;
        }
    };

    let offline = false;

    const ready = (async function () {
        try {
            await fetchAll();
        } catch (e) {
            lastError = e.message;
            offline = true;
            console.error('[PasStore] could not reach the server. The page is now read-only.', e);
            /* Deliberately does NOT repoint storage at localStorage. That fallback is
               what caused the PAS self-assessment to be lost: the page kept working,
               wrote every answer to one laptop, and nobody could tell it had never
               reached the server. The menu planner already learned this — a failed
               read there shows a warning and refuses to let a browser copy pass for
               the shared record. This now does the same.

               getItem still serves the in-memory cache (empty here, since the read
               failed), so the page renders blank rather than resurrecting a stale
               local draft. setItem is made to fail loudly: nothing is persisted as
               though it were saved, and the person is told plainly. */
            storage.setItem = function () {
                if (!document.getElementById('pasStoreBlockedMsg')) {
                    banner('&#9888; <strong>Nothing you enter here is being saved.</strong> '
                        + 'This page could not reach the server, so it is read-only to protect '
                        + 'the shared records. <strong>Do not fill it in.</strong> Sign in again '
                        + 'from the Staff Portal, then reload before entering anything. '
                        + '<span id="pasStoreBlockedMsg" style="font-weight:400;opacity:0.85;">('
                        + lastError + ')</span>', '#b91c1c');
                }
            };
            storage.removeItem = function () {};
            banner('&#9888; <strong>Not connected to the server.</strong> This page is '
                + 'read-only right now, so anything you type will not be saved and will not be '
                + 'seen by anyone else. Nothing already on the server has been touched. '
                + 'Sign in again from the Staff Portal and reload this page before working. '
                + '<span style="font-weight:400;opacity:0.85;">(' + lastError + ')</span>',
                '#b91c1c');
        }
        return true;
    })();

    window.PasStore = {
        ready: ready,
        storage: storage,
        // Exposed so a page can show which scopes are saved without re-fetching.
        savedScopes: function (worksheet) {
            const out = [];
            cache.forEach((_, k) => {
                const [w, s] = k.split('\u0000');
                if (w === worksheet && s) out.push(s);
            });
            return out;
        },
        refresh: fetchAll,
        get lastError() { return lastError; },
        // True when the server could not be reached, so the page is read-only and
        // nothing is being saved. Exposed so a page can refuse to look finished when
        // nothing has actually reached the server.
        get offline() { return offline; }
    };
})();
