/* Shared staff authentication.

   Replaces the old arrangement, where every page carried a hardcoded copy of the
   password. That shipped the secret to every browser and meant one rotation broke
   every page at once.

   How it works now:
     - The styled Staff Portal page asks for the password and VERIFIES it against
       the server, rather than comparing it to a constant in the page.
     - The verified password is kept for this browser (localStorage when "remember
       me" is ticked, sessionStorage otherwise) and attached to API calls.
     - Because requests carry credentials explicitly, the browser never needs to
       raise its own grey sign-in dialog.

   The password is held in the browser only after the person typed it. It is not
   present in the source, so rotating it on the server simply asks everyone to
   sign in again instead of breaking the site. */
(function () {
    /* ── HTTPS FIRST, BEFORE ANY CREDENTIAL MOVES ──
       Reaching a staff page over http:// made the correct password report as
       wrong. Every request below uses a RELATIVE url, so on an http:// page it
       goes out as http:// too, meets the server's 301 to https, and the browser
       strips the Authorization header when a redirect changes origin — a scheme
       change counts as one. The server then saw no credentials and answered 401,
       which the sign-in page shows as "That password was not accepted."

       Nothing was wrong with the password; it was being removed in transit. This
       became possible the day the certificate was installed, because before that
       sslOptions was falsy, there was no redirect, and http:// worked end to end.
       Every old http:// bookmark kept loading the page fine — only the credential
       check broke, which is why it read as a password problem.

       So swap scheme before anything else runs. This lives here rather than on
       the portal page because every page that sends credentials loads this file,
       including the PAS pages via /staff/auth.js; a bookmark straight to
       isbe.html or roster.html had the same fault.

       replace() rather than assign() keeps the http:// url out of history, so
       Back cannot land on it and autocomplete stops offering it. hostname rather
       than host drops any explicit :80 so the result is plain https on 443.
       localhost is left alone — there is no certificate in development. */
    var h = location.hostname;
    if (location.protocol === 'http:'
        && h !== 'localhost' && h !== '127.0.0.1' && h !== '[::1]') {
        location.replace('https://' + h + location.pathname
            + location.search + location.hash);
        return;   // stop here; the page is being replaced
    }

    if (window.CofpAuth) return;

    var KEY = 'copStaffPw';
    /* A signed-in staff member's session token. Separate from the shared password
       because they mean different things to the server: the password says "the
       director", the token says which individual. Kept apart so one cannot be
       mistaken for the other, and so signing a staff member out does not disturb
       a director signed in on the same browser. */
    var TOKEN_KEY = 'copStaffToken';
    var TOKEN_NAME_KEY = 'copStaffTokenName';

    /* ── Purge any PERSISTED credential the moment this script loads ──
       A sign-in must be an act you perform each session — the gate should appear
       every fresh visit, even on the centre's own machine. Sessions therefore live
       ONLY in sessionStorage (cleared when the browser closes). Older builds, and the
       "keep me signed in" option, wrote the token and the shared password into
       localStorage, which persists across browser restarts — so a machine used for
       testing kept getting carried straight in past the login screen. That is the
       "something is saving and letting me bypass" behaviour.

       Wiping localStorage here, before anything reads a credential, guarantees no
       leftover persisted token or password can silently authorise a session. It is a
       no-op on a clean browser and self-heals the ones that still carry old state.
       sessionStorage is untouched, so a sign-in done this session still works until
       the browser is closed. */
    /* ── One-time token HANDOFF for a new tab ──
       A link with target="_blank" no longer carries the opener's sessionStorage:
       modern browsers treat target="_blank" as implicitly rel="noopener", so the new
       tab opens with an EMPTY sessionStorage and a personal page (a PAS form) bounces
       straight to /me — the "it keeps kicking me to the login" bug, which dropping
       rel="noopener" no longer fixes because the browser applies it anyway.

       So the opener hands the token across explicitly: just before opening the tab it
       writes the token to this one localStorage key, and here — the instant the new
       tab's auth.js runs — we lift it into THIS tab's sessionStorage and delete it
       again. It exists in localStorage only for the blink between click and load, is
       consumed exactly once, and never persists a session across a browser restart
       (the purge below still runs), so the "a session must be re-made each visit"
       guarantee holds. Only fills an empty sessionStorage, so it can never override a
       real sign-in already in this tab. */
    try {
        var HANDOFF_KEY = 'copTokenHandoff';
        var HANDOFF_NAME = 'copTokenHandoffName';
        var ho = localStorage.getItem(HANDOFF_KEY);
        if (ho) {
            if (!sessionStorage.getItem(TOKEN_KEY)) {
                sessionStorage.setItem(TOKEN_KEY, ho);
                var hn = localStorage.getItem(HANDOFF_NAME);
                if (hn) sessionStorage.setItem(TOKEN_NAME_KEY, hn);
            }
            localStorage.removeItem(HANDOFF_KEY);
            localStorage.removeItem(HANDOFF_NAME);
        }
    } catch (e) { /* storage disabled — fall through to the normal gate */ }

    try {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(TOKEN_NAME_KEY);
        localStorage.removeItem(KEY);
        localStorage.removeItem('copStaffAuth');
    } catch (e) { /* private mode / storage disabled — nothing persisted anyway */ }

    function stored() {
        try {
            // sessionStorage only: a persisted shared password must not carry a session.
            return sessionStorage.getItem(KEY) || '';
        } catch (e) { return ''; }
    }

    function token() {
        try {
            // sessionStorage only, for the same reason as stored(): no silent carry-in
            // from a token a previous build left in localStorage.
            return sessionStorage.getItem(TOKEN_KEY) || '';
        } catch (e) { return ''; }
    }

    function tokenName() {
        try {
            return sessionStorage.getItem(TOKEN_NAME_KEY) || '';
        } catch (e) { return ''; }
    }

    function header() {
        var pw = stored();
        // The server ignores the username half and checks only the password.
        return pw ? 'Basic ' + btoa(':' + pw) : null;
    }

    /* Every credential this browser holds, as headers.

       For the centre-wide pages — roster, ISBE, enrolment — the shared password is
       what matters, and the server prefers it when both are present. That is the
       director at their own desk expecting to see everything.

       Deliberately NOT used by the personal pages; see personalHeaders below. */
    function headers() {
        var h = {};
        var a = header();
        if (a) h['Authorization'] = a;
        var t = token();
        if (t) h['X-Staff-Token'] = t;
        return h;
    }

    /* Credentials for a page that is about ONE person.

       Here a session token WINS over the shared password, which is the opposite of
       the rule above, and the reason is that holding a token is an explicit
       statement of who you are acting as. Sending both let the server prefer the
       shared password, so when Paige signed in on the office computer — which still
       has the centre password saved — her own page came back as the director's: the
       full staff list, a chooser, and Clete's record showing first because he sorts
       first alphabetically.

       The shared password is still the fallback, so a director who has never signed
       in personally keeps the chooser and can look at anyone. Signing out of a
       personal session on that browser returns it to the director view. */
    function personalHeaders() {
        var t = token();
        if (t) return { 'X-Staff-Token': t };
        var a = header();
        return a ? { 'Authorization': a } : {};
    }

    // apiFetch's counterpart for the personal pages.
    function personalFetch(url, opts) {
        opts = opts || {};
        var h = Object.assign({ 'Content-Type': 'application/json' },
            personalHeaders(), opts.headers || {});
        opts.headers = h;
        return fetch(url, opts);
    }

    function remember(pw, persist) {
        /* Always session-scoped, never localStorage, regardless of `persist`. A
           remembered shared password in localStorage is exactly what let a browser
           skip the login screen across restarts; keeping it in sessionStorage means
           the gate returns every fresh visit. `persist` is ignored (kept for callers). */
        void persist;
        try {
            sessionStorage.setItem(KEY, pw);
            localStorage.removeItem(KEY);
        } catch (e) { /* private browsing — the session still works in memory */ }
    }

    function forget() {
        try { localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); } catch (e) {}
        try { localStorage.removeItem('copStaffAuth'); sessionStorage.removeItem('copStaffAuth'); } catch (e) {}
    }

    /* Ask the server whether a password is correct. Uses a small authenticated
       GET, so a wrong password costs nothing and a right one proves itself. */
    function verify(pw) {
        return fetch('/api/whoami', {
            headers: { 'Authorization': 'Basic ' + btoa(':' + pw) }
        }).then(function (r) {
            if (r.status === 200) return true;
            if (r.status === 401) return false;
            // Any other status means the check itself failed; do not claim the
            // password is wrong when we simply could not ask.
            throw new Error('Could not reach the server (' + r.status + ')');
        });
    }

    /* Drop-in for the old apiFetch: attaches whatever credentials we have and
       leaves the request alone when we have none, so the browser can still prompt
       as a last resort rather than the page silently failing. */
    function apiFetch(url, opts) {
        opts = opts || {};
        var h = Object.assign({ 'Content-Type': 'application/json' }, headers(), opts.headers || {});
        opts.headers = h;
        return fetch(url, opts);
    }

    /* ── Staff sign-in ──
       Signs one individual in and keeps the token this browser was given. The
       password is used for the one request and never stored; the token replaces
       it, so a stolen browser yields a session that expires rather than a
       password that does not. */
    function staffLogin(login, password, persist) {
        return fetch('/api/staff-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ login: login, password: password })
        }).then(function (r) {
            return r.json().then(function (body) {
                if (!r.ok) throw new Error(body && body.error ? body.error : 'Could not sign in');
                try {
                    /* The token is ALWAYS session-scoped (sessionStorage), never
                       localStorage, regardless of any "remember me" choice. That is what
                       makes the sign-in a gate on every fresh visit: when the browser is
                       closed and reopened, the session token is gone and /me asks again.
                       The PASSWORD is still remembered by the browser's own credential
                       store and prefills the field, so signing back in is one click — but
                       it is a deliberate click, not a silent carry-through. `persist` is
                       accepted for call-compatibility and intentionally ignored. */
                    void persist;
                    sessionStorage.setItem(TOKEN_KEY, body.token);
                    sessionStorage.setItem(TOKEN_NAME_KEY, body.name || '');
                    // A fresh sign-in invalidates any cached identity from a prior token.
                    try { sessionStorage.removeItem('copStaffWho'); } catch (e) {}
                    // Clear any token a previous build left in localStorage, so an old
                    // persisted session cannot keep silently signing someone in.
                    try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_NAME_KEY); } catch (e) {}
                } catch (e) { /* private browsing — the tab still works */ }
                return body;
            });
        });
    }

    function staffLogout() {
        try { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
        try { localStorage.removeItem(TOKEN_NAME_KEY); sessionStorage.removeItem(TOKEN_NAME_KEY); } catch (e) {}
        try { sessionStorage.removeItem('copStaffWho'); } catch (e) {}
    }

    /* Changes the signed-in staff member's own password. The server requires the
       current one as well, so this cannot be used to take over a left-open screen.

       Sends the token and nothing else, rather than going through apiFetch. On a
       computer that has been used for the staff portal the shared password is also
       in local storage, and apiFetch attaches both — which made the server read the
       request as the director and refuse, because a director has no personal
       password. Being explicit about which credential this acts on removes the
       ambiguity instead of relying on the server to pick correctly. */
    function staffChangePassword(current, next) {
        var h = { 'Content-Type': 'application/json' };
        var t = token();
        if (t) h['X-Staff-Token'] = t;
        return fetch('/api/staff-password', {
            method: 'POST',
            headers: h,
            body: JSON.stringify({ current: current, next: next })
        }).then(function (r) {
            return r.json().then(function (body) {
                if (!r.ok) throw new Error(body && body.error ? body.error : 'Could not change it');
                return body;
            });
        });
    }

    /* Who the server thinks we are. The page never decides this for itself.

       Asks with the personal credentials, so on a browser holding both this answers
       "you are Paige" rather than "you are the director". Getting that wrong is what
       put the staff chooser on a staff member's own page. */
    /* Per-session cache of the resolved identity, keyed by the token it was resolved
       for. whoAmI() used to hit /api/staff-whoami on EVERY page load, so each
       navigation between staff pages paid one blocking round-trip before it could
       render or redirect — the "slight delay" on links. The token already lives in
       sessionStorage for the whole browser session (12h TTL, server-enforced), so the
       identity it maps to is stable for that session; caching it in sessionStorage
       lets a second/third page resolve instantly from memory instead of the network.

       Keyed by token so a sign-out + different sign-in can't return a stale identity:
       the cache only hits when the stored token matches the one it was cached against.
       On a cache miss it still fetches and the answer is authoritative. */
    var WHO_KEY = 'copStaffWho';
    function cachedWho(t) {
        try {
            var raw = sessionStorage.getItem(WHO_KEY);
            if (!raw) return undefined;
            var o = JSON.parse(raw);
            if (o && o.t === t) return o.who;   // who may be null (known "not this token")
        } catch (e) {}
        return undefined;
    }
    function storeWho(t, who) {
        try { sessionStorage.setItem(WHO_KEY, JSON.stringify({ t: t, who: who })); } catch (e) {}
    }

    function whoAmI(opts) {
        /* Identity is asked with the TOKEN ONLY — never the shared password. Who you
           are is a person; the shared centre password is not a person. Sending it here
           is what let a browser holding the password report as "director" and walk
           straight into the staff dashboard with no sign-in. So this deliberately does
           NOT use personalHeaders() (which falls back to the password): no token means
           not signed in, which is the honest answer and sends the visitor to /me. */
        var t = token();
        if (!t) { storeWho('', null); return Promise.resolve(null); }
        // Serve from the per-session cache unless the caller explicitly forces a refresh.
        if (!(opts && opts.fresh)) {
            var c = cachedWho(t);
            if (c !== undefined) return Promise.resolve(c);
        }
        return fetch('/api/staff-whoami', { headers: { 'X-Staff-Token': t } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (who) { storeWho(t, who); return who; })
            .catch(function () { return null; });
    }

    window.CofpAuth = {
        header: header, headers: headers, stored: stored, remember: remember,
        forget: forget, verify: verify, apiFetch: apiFetch,
        personalHeaders: personalHeaders, personalFetch: personalFetch,
        token: token, tokenName: tokenName,
        staffLogin: staffLogin, staffLogout: staffLogout,
        staffChangePassword: staffChangePassword, whoAmI: whoAmI,
        // True when this browser holds either kind of credential.
        signedIn: function () { return !!stored() || !!token(); },
        isStaffSession: function () { return !stored() && !!token(); },
        /* Stage this tab's token for a new tab about to be opened (target="_blank").
           The new tab's auth.js lifts it into its own sessionStorage and deletes it.
           Call this in the click handler, immediately before the tab opens. No-op when
           there is no personal token (a shared-password director has no token to pass —
           the opened page's own 401→/me handling covers that case). */
        handoffToken: function () {
            try {
                var t = token();
                if (!t) return;
                localStorage.setItem('copTokenHandoff', t);
                var n = tokenName();
                if (n) localStorage.setItem('copTokenHandoffName', n);
            } catch (e) { /* storage disabled — nothing to hand off */ }
        }
    };

    /* ── Carry the sign-in into every new tab, automatically ──
       Any link that opens a same-origin /pas/ page in a new tab (target="_blank")
       would otherwise land there with an empty sessionStorage and bounce to /me (see
       the handoff note above). Rather than tag each link, we stage the token here for
       ANY such click — current and future PAS links alike. Capture phase so it runs
       before the browser follows the link; only same-origin /pas/ new-tab links, so it
       never leaks the token to an external site or a middle-click to elsewhere. */
    try {
        document.addEventListener('click', function (ev) {
            // Ignore modified clicks the browser may handle oddly? No — a ctrl/middle
            // click that opens a background tab needs the handoff too, so we don't skip
            // those. We only require that it is an anchor to our own /pas/ in a new tab.
            var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
            if (!a) return;
            if ((a.getAttribute('target') || '') !== '_blank') return;
            var href = a.getAttribute('href') || '';
            // Resolve relative hrefs against this page, then require same origin + /pas/.
            var u;
            try { u = new URL(href, location.href); } catch (e) { return; }
            if (u.origin !== location.origin) return;
            if (!/^\/pas\//i.test(u.pathname)) return;   // absolute path; URL() resolved it
            window.CofpAuth.handoffToken();
        }, true);
    } catch (e) { /* no document (shouldn't happen for a page script) — skip */ }
})();
