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
    if (window.CofpAuth) return;

    var KEY = 'copStaffPw';

    function stored() {
        try {
            return localStorage.getItem(KEY) || sessionStorage.getItem(KEY) || '';
        } catch (e) { return ''; }
    }

    function header() {
        var pw = stored();
        // The server ignores the username half and checks only the password.
        return pw ? 'Basic ' + btoa(':' + pw) : null;
    }

    function remember(pw, persist) {
        try {
            if (persist) localStorage.setItem(KEY, pw);
            else sessionStorage.setItem(KEY, pw);
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

    /* Drop-in for the old apiFetch: attaches credentials when we have them and
       leaves the request alone when we do not, so the browser can still prompt
       as a last resort rather than the page silently failing. */
    function apiFetch(url, opts) {
        opts = opts || {};
        var h = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
        var a = header();
        if (a) h['Authorization'] = a;
        opts.headers = h;
        return fetch(url, opts);
    }

    window.CofpAuth = {
        header: header, stored: stored, remember: remember,
        forget: forget, verify: verify, apiFetch: apiFetch,
        signedIn: function () { return !!stored(); }
    };
})();
