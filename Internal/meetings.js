/* ── Meetings register ─────────────────────────────────────────────────────
   Moved off pas.html on 10 Sep 2026. It was the last block on that page, read
   top-to-bottom after everything else, and it is not part of the PAS instrument:
   PAS wants evidence that administration meets, but so does the staff handbook
   (12.2/12.3) for staff meetings, and the PFA and PI checklists for family and
   community meetings. One register serving all of them beats a log per screen.

   The storage key is unchanged — 'pas_admin_meetings'. Renaming it would have
   orphaned every meeting already logged, since the server keys the record on that
   string. The name is now a little historical; the data is worth more than the tidy
   name.

   No new table: PasWorksheets is already a (key, scope, JSON) store, so this is one
   more key in it. Depends on app.js for apiFetch.

   Two fields were added, both optional so existing records keep working:
     type     what kind of meeting it was; blank means Administrative
     dateISO  the date in a form an <input type="date"> can load again

   dateISO is the one that matters for editing. Records used to store only a
   display string ("Tuesday, August 11, 2026"), which cannot be put back into a date
   input without reparsing English, so an edit would silently drop the date. New
   entries save both; older ones are reparsed on a best effort and, if that fails,
   the original text is shown beside an empty date box so the person can re-pick it
   rather than having it quietly changed underneath them. */

const MEETINGS_KEY = 'pas_admin_meetings';

/* The meeting that used to be hardcoded into the table markup on pas.html. Kept so
   the move to shared storage loses no history, and seeded only when the server has
   never held a log - after which it is an ordinary record. */
const MEETING_SEED = [{
    date: 'Tuesday, August 11, 2026',
    dateISO: '2026-08-11',
    time: '11:00 AM \u2013 1:00 PM',
    type: 'Administrative',
    attendees: 'Clete Holliday, Megan Nooney',
    topic: 'PAS Section Review',
    notes: 'Reviewed new PAS section on internal staff site \u2014 documentation guide, '
        + 'forms, compliance checklists, and annual timeline.'
}];

/* Deliberately short, and only kinds this centre already has a documented
   requirement for somewhere in the tool. It is a datalist-style default rather than
   a fixed vocabulary: the select carries whatever types are already in the log too,
   so adding a kind is a matter of typing it once, not editing this file. */
const MEETING_TYPES = [
    'Administrative',
    'Staff',
    'Team / Classroom',
    'Family / Parent',
    'Community Partner'
];

const DEFAULT_TYPE = 'Administrative';

let adminMeetings = [];
let editingId = null;      // null when the form is adding rather than editing
let activeFilter = 'All';

// Meeting text is typed by staff, so it is escaped before going into markup. A note
// containing "<" is an accident, not an attack, but it would still break the page.
function escHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function meetingStatus(text, colour) {
    const el = document.getElementById('mtgStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = colour || '#166534';
}

/* Rows are addressed by id rather than by array index, because the table is sorted
   by date: editing a date moves the row, and an index captured before the sort would
   then point at somebody else's meeting. */
function ensureIds() {
    let n = 0;
    adminMeetings.forEach(m => {
        if (!m.id) m.id = 'm' + Date.now().toString(36) + (n++).toString(36)
            + Math.random().toString(36).slice(2, 6);
    });
}

function typeOf(m) { return (m && m.type) ? m.type : DEFAULT_TYPE; }

// Turns 'YYYY-MM-DD' into the long form the log displays. Noon avoids the
// day-before shift that midnight gives west of UTC.
function formatISO(iso) {
    return new Date(iso + 'T12:00:00').toLocaleDateString('en-US',
        { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

/* Best-effort ISO for a record saved before dateISO existed. Returns '' rather than
   a guess when the string will not parse, so the caller can ask instead of assuming. */
function isoOf(m) {
    if (m.dateISO && /^\d{4}-\d{2}-\d{2}$/.test(m.dateISO)) return m.dateISO;
    const d = new Date(m.date);
    if (isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// Newest first. Anything undateable sorts last rather than throwing the order out.
function sortedMeetings() {
    return adminMeetings.slice().sort((a, b) => {
        const x = isoOf(a), y = isoOf(b);
        if (!x && !y) return 0;
        if (!x) return 1;
        if (!y) return -1;
        return y.localeCompare(x);
    });
}

function renderFilters() {
    const el = document.getElementById('mtgFilters');
    if (!el) return;
    const counts = {};
    adminMeetings.forEach(m => { counts[typeOf(m)] = (counts[typeOf(m)] || 0) + 1; });
    const present = Object.keys(counts).sort();
    // No chips at all when everything is one type: a filter that cannot change
    // anything is just clutter.
    if (present.length < 2) { el.innerHTML = ''; return; }
    const chip = (label, count, value) =>
        '<button class="mtg-chip' + (activeFilter === value ? ' active' : '') + '"'
        + ' onclick="setFilter(' + JSON.stringify(value).replace(/"/g, '&quot;') + ')">'
        + escHtml(label) + ' (' + count + ')</button>';
    el.innerHTML = chip('All', adminMeetings.length, 'All')
        + present.map(t => chip(t, counts[t], t)).join('');
}

function setFilter(value) {
    activeFilter = value;
    renderFilters();
    renderMeetings();
}

function renderMeetings() {
    const tbody = document.getElementById('adminMeetingsBody');
    if (!tbody) return;

    const rows = sortedMeetings()
        .filter(m => activeFilter === 'All' || typeOf(m) === activeFilter);

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="mtg-empty">'
            + (adminMeetings.length ? 'No ' + escHtml(activeFilter) + ' meetings logged yet.'
                                    : 'No meetings logged yet.')
            + '</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map(m =>
        '<tr' + (m.id === editingId ? ' class="mtg-editing"' : '') + '>'
        + '<td class="mtg-date">' + escHtml(m.dateISO ? formatISO(m.dateISO) : m.date) + '</td>'
        + '<td>' + escHtml(m.time || '\u2014') + '</td>'
        + '<td><span class="mtg-type">' + escHtml(typeOf(m)) + '</span></td>'
        + '<td>' + escHtml(m.attendees || '\u2014') + '</td>'
        + '<td>' + escHtml(m.topic) + '</td>'
        + '<td>' + escHtml(m.notes || '') + '</td>'
        + '<td><button class="mtg-row-btn" onclick="editMeeting('
        + JSON.stringify(m.id).replace(/"/g, '&quot;') + ')">Edit</button></td>'
        + '</tr>').join('');
}

function fillTypeOptions(selected) {
    const sel = document.getElementById('mtgType');
    if (!sel) return;
    // Types already used in the log are offered alongside the defaults, so a type
    // someone introduced once does not disappear from the list afterwards.
    const used = adminMeetings.map(typeOf);
    const all = MEETING_TYPES.slice();
    used.concat(selected ? [selected] : []).forEach(t => {
        if (t && all.indexOf(t) === -1) all.push(t);
    });
    sel.innerHTML = all.map(t =>
        '<option value="' + escHtml(t) + '"' + (t === (selected || DEFAULT_TYPE) ? ' selected' : '')
        + '>' + escHtml(t) + '</option>').join('');
}

function setFormFields(m) {
    document.getElementById('mtgDate').value = m ? isoOf(m) : '';
    document.getElementById('mtgTime').value = m ? (m.time || '') : '';
    document.getElementById('mtgAttendees').value = m ? (m.attendees || '') : '';
    document.getElementById('mtgTopic').value = m ? (m.topic || '') : '';
    document.getElementById('mtgNotes').value = m ? (m.notes || '') : '';
    fillTypeOptions(m ? typeOf(m) : '');

    /* Only shown when the stored date could not be parsed back. Better to say "this
       said X, pick it again" than to save a record whose date silently became today. */
    const was = document.getElementById('mtgDateWas');
    if (m && !isoOf(m) && m.date) {
        was.textContent = 'Stored as \u201c' + m.date + '\u201d \u2014 please re-pick the date.';
        was.style.display = 'block';
    } else {
        was.textContent = '';
        was.style.display = 'none';
    }
}

function openNewMeeting() {
    editingId = null;
    document.getElementById('mtgFormTitle').textContent = 'New meeting';
    document.getElementById('mtgSaveBtn').textContent = 'Save Meeting';
    setFormFields(null);
    meetingStatus('');
    document.getElementById('meetingForm').style.display = 'block';
    renderMeetings();
    document.getElementById('mtgDate').focus();
}

function editMeeting(id) {
    const m = adminMeetings.find(x => x.id === id);
    if (!m) return;
    editingId = id;
    document.getElementById('mtgFormTitle').textContent = 'Editing \u2014 ' + (m.topic || 'meeting');
    document.getElementById('mtgSaveBtn').textContent = 'Save Changes';
    setFormFields(m);
    meetingStatus('');
    document.getElementById('meetingForm').style.display = 'block';
    renderMeetings();
    document.getElementById('meetingForm').scrollIntoView({ block: 'nearest' });
}

function closeMeetingForm() {
    editingId = null;
    document.getElementById('meetingForm').style.display = 'none';
    meetingStatus('');
    renderMeetings();
}

// Publishes the current list. Throws on failure so the caller can roll back and say
// so, rather than leaving a row on screen that nobody else will ever see.
async function saveMeetings() {
    const res = await apiFetch('/api/pas-worksheets', {
        method: 'POST',
        body: JSON.stringify({
            worksheet: MEETINGS_KEY, scope: '',
            payload: { meetings: adminMeetings }
        })
    });
    if (!res.ok) {
        throw new Error(res.status === 401 ? 'your staff sign-in has lapsed'
                                          : 'the server returned ' + res.status);
    }
    const d = await res.json();
    if (!d || !d.success) throw new Error((d && d.error) || 'the server rejected it');
    // A local copy is kept only as a fallback for a failed read; the server is the record.
    try { localStorage.setItem(MEETINGS_KEY, JSON.stringify(adminMeetings)); } catch (_) {}
}

async function loadMeetings() {
    try {
        const res = await apiFetch('/api/pas-worksheets');
        if (!res.ok) throw new Error('the server returned ' + res.status);
        const rows = await res.json();
        const row = (Array.isArray(rows) ? rows : [])
            .find(r => r.WorksheetKey === MEETINGS_KEY && !r.ScopeKey);

        if (row && row.Payload && Array.isArray(row.Payload.meetings)) {
            adminMeetings = row.Payload.meetings;
            ensureIds();
            renderFilters();
            renderMeetings();
            return;
        }

        /* The server has never held this log. Lift whatever this browser has, so the
           move loses nothing, and fall back to the seed. Then publish it, which is
           what makes it visible to everyone else. Only reached when the read
           SUCCEEDED and genuinely found no record - a failed read is caught below
           and must never overwrite what is on the server. */
        let local = [];
        try { local = JSON.parse(localStorage.getItem(MEETINGS_KEY) || '[]'); } catch (_) {}
        adminMeetings = Array.isArray(local) && local.length ? local : MEETING_SEED.slice();
        ensureIds();
        renderFilters();
        renderMeetings();
        try {
            await saveMeetings();
            meetingStatus('\u2713 Meeting log moved to the server \u2014 everyone can see it now');
        } catch (e) {
            meetingStatus('\u26a0 Could not publish the meeting log: ' + e.message, '#b91c1c');
        }
    } catch (e) {
        // Show the local copy if there is one, but never let it pass for the shared log.
        let local = [];
        try { local = JSON.parse(localStorage.getItem(MEETINGS_KEY) || '[]'); } catch (_) {}
        adminMeetings = Array.isArray(local) ? local : [];
        ensureIds();
        renderFilters();
        renderMeetings();
        meetingStatus('\u26a0 Could not load the shared meeting log (' + e.message
            + '). Showing this browser\u2019s copy only.', '#b91c1c');
    }
}

/* One handler for both adding and editing. The rollback matters as much as the save:
   on failure the list goes back to exactly what the server still holds, so the screen
   never shows an edit that was not stored. */
async function saveMeetingForm() {
    const iso = document.getElementById('mtgDate').value;
    const time = document.getElementById('mtgTime').value.trim();
    const type = document.getElementById('mtgType').value;
    const attendees = document.getElementById('mtgAttendees').value.trim();
    const topic = document.getElementById('mtgTopic').value.trim();
    const notes = document.getElementById('mtgNotes').value.trim();
    if (!iso || !topic) { alert('Please fill in at least a date and topic.'); return; }

    const previous = JSON.parse(JSON.stringify(adminMeetings));
    const wasEditing = editingId;

    const record = {
        date: formatISO(iso),   // kept for anything still reading the display string
        dateISO: iso,
        time: time,
        type: type,
        attendees: attendees,
        topic: topic,
        notes: notes
    };

    if (editingId) {
        const i = adminMeetings.findIndex(x => x.id === editingId);
        if (i === -1) { meetingStatus('\u26a0 That meeting is no longer in the log.', '#b91c1c'); return; }
        record.id = editingId;
        adminMeetings[i] = record;
    } else {
        adminMeetings.unshift(record);
        ensureIds();
    }
    renderFilters();
    renderMeetings();
    meetingStatus('Saving\u2026', '#64748b');

    try {
        await saveMeetings();
        meetingStatus(wasEditing ? '\u2713 Changes saved' : '\u2713 Saved');
        editingId = null;
        document.getElementById('meetingForm').style.display = 'none';
        renderMeetings();
        setTimeout(() => meetingStatus(''), 2500);
    } catch (e) {
        // Put the list back, so what is on screen matches what is actually stored.
        adminMeetings = previous;
        ensureIds();
        renderFilters();
        renderMeetings();
        meetingStatus('\u26a0 NOT saved \u2014 ' + e.message + '. Your entry is still in the form.',
            '#b91c1c');
    }
}

loadMeetings();
