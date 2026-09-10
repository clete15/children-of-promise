/* ══════════════════════════════════════════════════════════════════
   PAS worksheet store

   The PAS self-assessment and its supporting worksheets each kept their
   answers in browser localStorage. That made the artifact being prepared
   for submission invisible to anyone on another machine and vulnerable to
   a cleared cache. This moves the answers to the database while changing
   as little as possible in each worksheet.

   Design: the pages already read and write synchronously via localStorage,
   so this exposes `PasStore.storage` with the same getItem/setItem/
   removeItem shape, backed by an in-memory cache that is filled from the
   server before the page initialises and written through on every change.
   A page therefore needs two edits: await PasStore.ready, and use
   PasStore.storage in place of localStorage. Existing keys keep working.

   Migration: on first load any pas_* keys still sitting in this browser's
   localStorage that the server does not yet know about are pushed up, so
   work already typed is preserved rather than appearing to vanish. The
   local copy is left alone as a fallback.
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

    /* Worksheets this browser holds that the server has a DIFFERENT version of.
       Reported rather than resolved: picking a winner by size or date would be a
       guess about whose work matters, and the wrong guess loses a completed
       assessment. */
    const conflicts = [];

    // Lift anything still in this browser that the server has not seen.
    async function migrateLocal() {
        const candidates = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.indexOf('pas_') === 0) candidates.push(k);
        }
        for (const key of candidates) {
            const { worksheet, scope } = splitKey(key);
            let obj;
            try { obj = JSON.parse(localStorage.getItem(key)); } catch (e) { continue; }
            if (!obj || typeof obj !== 'object') continue;

            /* The server already has this worksheet. Previously this skipped in
               silence, which is fine when the local copy is a stale echo of the
               server's and quietly wrong when it is a completed form the server has
               never seen — the case that arises after the store has been falling
               back to localStorage. Counting the answers on each side is enough to
               tell "same thing twice" from "two different pieces of work". */
            if (cache.has(cacheKey(worksheet, scope))) {
                const mine = JSON.stringify(obj);
                const theirs = cache.get(cacheKey(worksheet, scope));
                if (mine !== theirs) {
                    conflicts.push({ key: key, localAnswers: countAnswers(obj),
                                     serverAnswers: countAnswers(safeParse(theirs)) });
                }
                continue;
            }
            try {
                await push(worksheet, scope, obj);
                cache.set(cacheKey(worksheet, scope), JSON.stringify(obj));
                console.info('[PasStore] migrated "' + key + '" from this browser to the server.');
            } catch (e) {
                console.warn('[PasStore] could not migrate "' + key + '": ' + e.message);
            }
        }
    }

    function safeParse(s) { try { return JSON.parse(s); } catch (e) { return {}; } }

    // A rough measure of "how much is filled in", used only to describe a conflict.
    function countAnswers(obj) {
        let n = 0;
        const walk = v => {
            if (v === null || v === undefined || v === '' || v === false) return;
            if (Array.isArray(v)) { v.forEach(walk); return; }
            if (typeof v === 'object') { Object.keys(v).forEach(k => walk(v[k])); return; }
            n++;
        };
        walk(obj);
        return n;
    }

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
            await migrateLocal();
            if (conflicts.length) {
                const list = conflicts.map(c => '&ldquo;' + c.key + '&rdquo; (this browser has '
                    + c.localAnswers + ' entries, the server has ' + c.serverAnswers + ')').join('; ');
                banner('&#9888; This browser holds a different copy of ' + list
                    + '. Nothing has been overwritten. Tell Clete before entering more, '
                    + 'so the right version is the one kept.', '#b45309');
            }
        } catch (e) {
            lastError = e.message;
            offline = true;
            console.error('[PasStore] could not reach the server; falling back to this browser only.', e);
            // Fall back to the real localStorage so a page still works offline
            // rather than silently losing the user's typing.
            storage.getItem = k => localStorage.getItem(k);
            storage.setItem = (k, v) => localStorage.setItem(k, v);
            storage.removeItem = k => localStorage.removeItem(k);
            banner('&#9888; <strong>Not saving to the server.</strong> Anything you enter on this '
                + 'page is being kept in this browser only &mdash; nobody else will see it, and '
                + 'clearing your history would erase it. '
                + 'Sign in again from the staff portal, then reload this page. '
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
        // True when answers are going to this browser only. Exposed so a page can
        // refuse to look finished when nothing has actually been submitted.
        get offline() { return offline; },
        get conflicts() { return conflicts.slice(); }
    };
})();
