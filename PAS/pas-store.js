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

    // cache: "worksheet\u0000scope" -> raw JSON string, mirroring what the pages
    // previously handed to localStorage.
    const cache = new Map();
    let lastError = null;

    function splitKey(key) {
        for (const p of SCOPED_PREFIXES) {
            if (key.indexOf(p) === 0) {
                return { worksheet: p.replace(/_$/, ''), scope: key.slice(p.length) };
            }
        }
        return { worksheet: key, scope: '' };
    }

    const cacheKey = (worksheet, scope) => worksheet + '\u0000' + (scope || '');

    function api(opts) {
        return fetch(ENDPOINT, Object.assign({
            headers: { 'Content-Type': 'application/json' }
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

    // Lift anything still in this browser that the server has not seen.
    async function migrateLocal() {
        const candidates = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.indexOf('pas_') === 0) candidates.push(k);
        }
        for (const key of candidates) {
            const { worksheet, scope } = splitKey(key);
            if (cache.has(cacheKey(worksheet, scope))) continue;   // server already has it
            let obj;
            try { obj = JSON.parse(localStorage.getItem(key)); } catch (e) { continue; }
            if (!obj || typeof obj !== 'object') continue;
            try {
                await push(worksheet, scope, obj);
                cache.set(cacheKey(worksheet, scope), JSON.stringify(obj));
                console.info('[PasStore] migrated "' + key + '" from this browser to the server.');
            } catch (e) {
                console.warn('[PasStore] could not migrate "' + key + '": ' + e.message);
            }
        }
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
            return scope ? worksheet + '_' + scope : worksheet;
        }
    };

    const ready = (async function () {
        try {
            await fetchAll();
            await migrateLocal();
        } catch (e) {
            lastError = e.message;
            console.error('[PasStore] could not reach the server; falling back to this browser only.', e);
            // Fall back to the real localStorage so a page still works offline
            // rather than silently losing the user's typing.
            storage.getItem = k => localStorage.getItem(k);
            storage.setItem = (k, v) => localStorage.setItem(k, v);
            storage.removeItem = k => localStorage.removeItem(k);
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
        get lastError() { return lastError; }
    };
})();
