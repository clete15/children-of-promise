/* ExceleRate Silver -- Standard 4, staff training, and the classroom self-assessments.

   Lifted out of pas.html unchanged on 10 Sep 2026. It had grown to be most of that page
   while having nothing to do with the PAS instrument itself: PAS is a 25-item scale scored
   on one document, whereas this is a rolling readiness check against staff credentials,
   training completions and one environment rating per classroom. They were only together
   because the Padlet submission happens to want both.

   Loaded by excelerate.html. pas.html no longer needs it.

   Depends on app.js for apiFetch, and on its `classrooms` and `students` -- both are
   top-level `let` bindings there, so they are lexical globals and NOT properties of
   window. They are referenced by bare name and guarded with typeof.
*/

/* ── Staff training ──────────────────────────────────────────────────────
   ExceleRate Silver sets thresholds against roles rather than headcount, so
   the requirement has to be evaluated, not just counted. Per the Standard 1A
   guidance on Padlet, "How ERS Works" is required for the Director or
   Administrator plus 50% of teaching staff, where teachers and assistants both
   count toward ratio, and at least one teacher per classroom is strongly
   encouraged.

   The same completion records satisfy PICC PI9, which wants a professional
   development record for every staff member.                                */

const TRAINING_CATALOG = [
    {
        key: 'howERSWorks',
        name: 'How ERS Works',
        via: 'iLearning',
        // Required, not merely encouraged.
        rule: 'directorPlusHalfTeaching',
        note: 'Director/Administrator plus 50% of teaching staff. At least one teacher per classroom is strongly encouraged.'
    },
    {
        key: 'ecers3',
        name: 'Making ECERS-3 Work For You',
        via: 'iLearning',
        rule: 'none',
        note: 'Per IDHS, preschool classrooms using ECERS-3 need some knowledge of the tool before receiving classroom support from the CCR&R. Full title: Making ECERS-3 Work For You: Supporting Children\u2019s Engagement in Learning.'
    },
    {
        key: 'iters3',
        name: 'ITERS-3 classroom training',
        via: 'iLearning',
        rule: 'none',
        note: 'The ITERS-3 equivalent, for classrooms assessed with ITERS-3. Same IDHS expectation of tool knowledge before classroom support.'
    }
];

/* ── Silver self-assessments, one per classroom ──────────────────────────
   The instrument is set by the ages served, per the Standard 1A guidance:
     ITERS-3   infants, toddlers, twos
     ECERS-3   3-5 year olds
     SACERS-U  school age
   A 2-3 year old room uses ECERS-3 when 75% or more of the children are 3,
   which is computed below from actual enrolled birth dates rather than left
   to a judgement call.                                                    */

const SILVER_INSTRUMENTS = {
    iters3: { name: 'ITERS-3', scoresheet: 'One per classroom (Infants, Toddlers, Twos). Rate all indicators and make detailed notes.' },
    ecers3: { name: 'ECERS-3', scoresheet: 'One per classroom (3-5 year olds). The profile sheet at the end is what gets submitted with the application.' },
    sacersU: { name: 'SACERS-U', scoresheet: 'School-age classrooms.' }
};

const THREE_YEAR_MAJORITY = 0.75;

function ageInYears(birthDate, asOf) {
    const b = new Date(birthDate);
    if (isNaN(b)) return null;
    return (asOf - b) / (365.25 * 24 * 3600 * 1000);
}

// Share of a room's active children who are 3 or older. Returns null when we
// cannot tell, so the caller can say so rather than guess.
function shareAgedThreePlus(roomNumber) {
    const today = new Date();
    // `students` is a top-level `let` in app.js, so it lives in the global lexical
    // scope and is NOT a property of window. Reference it by bare name.
    const kids = (typeof students === 'undefined' ? [] : students).filter(s =>
        String(s.RoomNumber) === String(roomNumber)
        && (s.Active === 'Yes' || s.Active === 'YES')
        && s.Birth_date);
    if (!kids.length) return null;
    const threes = kids.filter(s => {
        const y = ageInYears(s.Birth_date, today);
        return y !== null && y >= 3;
    });
    return { share: threes.length / kids.length, threes: threes.length, total: kids.length };
}

// Decides the instrument for a room from its age range, applying the 75% rule to
// two-to-three rooms. Returns the instrument key plus the reasoning to display.
function instrumentForRoom(room) {
    const label = ((room.AgeRange || '') + ' ' + (room.Room || '')).toLowerCase();

    if (/school\s*age|before|after|b\/a|\bba\b/.test(label)) {
        return { key: 'sacersU', why: 'School-age room.' };
    }
    // A room spanning 2-3 is the ambiguous case the guidance calls out.
    const isTwoToThree = /2\s*-\s*3|two.*three|\b2-3\b/.test(label);
    if (isTwoToThree) {
        const m = shareAgedThreePlus(room.RoomNumber);
        if (!m) {
            return { key: 'iters3', why: 'Two-to-three room with no birth dates on file, so the 75% rule cannot be applied. Defaulting to ITERS-3.', unsure: true };
        }
        const pct = Math.round(m.share * 100);
        return m.share >= THREE_YEAR_MAJORITY
            ? { key: 'ecers3', why: pct + '% of enrolled children are 3 or older (' + m.threes + ' of ' + m.total + '), so the 75% rule puts this room on ECERS-3.' }
            : { key: 'iters3', why: 'Only ' + pct + '% of enrolled children are 3 or older (' + m.threes + ' of ' + m.total + '), below the 75% threshold, so ITERS-3 applies.' };
    }
    if (/infant|toddler|two|\b2\b|0-2|birth/.test(label)) {
        return { key: 'iters3', why: 'Infant, toddler or twos room.' };
    }
    if (/pre-?school|preschool|3-5|3\s*-\s*5|pre-?k/.test(label)) {
        return { key: 'ecers3', why: 'Preschool room serving 3-5 year olds.' };
    }
    return { key: 'ecers3', why: 'Age range not recognised from "' + (room.AgeRange || room.Room || '') + '". Defaulting to ECERS-3 \u2014 confirm this is right.', unsure: true };
}

let silverAssessments = [];

function assessmentRecord(roomNumber, instrumentKey) {
    const name = SILVER_INSTRUMENTS[instrumentKey].name;
    return silverAssessments.find(a =>
        String(a.RoomNumber) === String(roomNumber) && a.Instrument === name) || null;
}

function renderSilverAssessments() {
    const host = document.getElementById('silverAssessments');
    if (!host) return;
    // Same as students: a top-level `let` in app.js, not on window.
    const rooms = (typeof classrooms === 'undefined' ? [] : classrooms).filter(c => c.Room);
    if (!rooms.length) {
        host.innerHTML = '<div style="padding:14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:0.8rem;color:#64748b;">No classrooms loaded.</div>';
        return;
    }

    let done = 0, uploaded = 0;
    const rows = rooms.map(room => {
        const inst = instrumentForRoom(room);
        const meta = SILVER_INSTRUMENTS[inst.key];
        const rec = assessmentRecord(room.RoomNumber, inst.key);
        const cDate = rec ? (rec.CompletedDate || '') : '';
        const uDate = rec ? (rec.UploadedDate || '') : '';
        if (cDate) done++;
        if (uDate) uploaded++;

        return '<tr style="border-bottom:1px solid #f1f5f9;">'
            + '<td style="padding:7px 10px;font-size:0.78rem;font-weight:600;color:#1e293b;white-space:nowrap;">' + room.Room + '</td>'
            + '<td style="padding:7px 10px;"><span style="font-size:0.7rem;font-weight:700;padding:2px 8px;border-radius:10px;background:#eff6ff;color:#1d4ed8;">' + meta.name + '</span>'
            + (inst.unsure ? ' <span title="' + inst.why.replace(/"/g, '&quot;') + '" style="font-size:0.66rem;font-weight:700;color:#92400e;">check</span>' : '')
            + '<div style="font-size:0.68rem;color:#94a3b8;margin-top:2px;max-width:320px;line-height:1.45;">' + inst.why + '</div></td>'
            + '<td style="padding:7px 10px;text-align:center;"><input type="date" value="' + cDate + '" onchange="saveAssessment(\'' + room.RoomNumber + '\',\'' + inst.key + '\',\'completedDate\',this.value)" title="Date the scoresheet was completed" style="padding:3px 6px;border:1px solid ' + (cDate ? '#bbf7d0' : '#d1d5db') + ';border-radius:5px;font-size:0.7rem;font-family:inherit;background:' + (cDate ? '#f0fdf4' : 'white') + ';"></td>'
            + '<td style="padding:7px 10px;text-align:center;"><input type="date" value="' + uDate + '" onchange="saveAssessment(\'' + room.RoomNumber + '\',\'' + inst.key + '\',\'uploadedDate\',this.value)" title="Date it was uploaded to the Padlet Self Assessment Documents column" style="padding:3px 6px;border:1px solid ' + (uDate ? '#bbf7d0' : '#d1d5db') + ';border-radius:5px;font-size:0.7rem;font-family:inherit;background:' + (uDate ? '#f0fdf4' : 'white') + ';"></td>'
            + '</tr>';
    }).join('');

    const pill = (met, text) => {
        const bg = met ? '#f0fdf4' : '#fffbeb', fg = met ? '#166534' : '#92400e';
        return '<span style="font-size:0.7rem;font-weight:700;padding:3px 9px;border-radius:11px;background:' + bg + ';color:' + fg + ';">' + (met ? '\u2713 ' : '') + text + '</span>';
    };

    host.innerHTML =
        '<div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:14px;">'
        + '<div style="font-size:0.85rem;font-weight:800;color:#1e293b;margin-bottom:6px;">Classroom self-assessments</div>'
        + '<div style="font-size:0.74rem;color:#64748b;line-height:1.6;margin-bottom:10px;">'
        + 'One scoresheet per classroom, then upload it to the Padlet <em>Self Assessment Documents</em> column.</div>'
        + '<div style="display:flex;flex-wrap:wrap;gap:8px;">'
        + pill(done === rooms.length, 'Completed: ' + done + ' of ' + rooms.length)
        + pill(uploaded === rooms.length, 'Uploaded to Padlet: ' + uploaded + ' of ' + rooms.length)
        + '</div></div>'
        + '<div style="background:white;border:1.5px solid #e2e8f0;border-radius:10px;overflow-x:auto;margin-bottom:14px;">'
        + '<table style="width:100%;border-collapse:collapse;">'
        + '<thead><tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0;">'
        + ['Classroom', 'Instrument', 'Scoresheet done', 'Uploaded'].map(h =>
            '<th style="padding:8px 10px;text-align:' + (h === 'Classroom' || h === 'Instrument' ? 'left' : 'center') + ';font-size:0.66rem;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;color:#64748b;">' + h + '</th>').join('')
        + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

async function saveAssessment(roomNumber, instrumentKey, field, value) {
    const name = SILVER_INSTRUMENTS[instrumentKey].name;
    const existing = assessmentRecord(roomNumber, instrumentKey) || {};
    const body = {
        roomNumber: roomNumber,
        instrument: name,
        completedDate: existing.CompletedDate || '',
        uploadedDate: existing.UploadedDate || '',
        evidenceLink: existing.EvidenceLink || '',
        notes: existing.Notes || ''
    };
    body[field] = value;
    try {
        const res = await apiFetch('/api/silver-assessments', { method: 'POST', body: JSON.stringify(body) });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Save failed');
        const aRes = await apiFetch('/api/silver-assessments');
        silverAssessments = await aRes.json();
        renderSilverAssessments();
    } catch (e) {
        alert('Could not save that assessment: ' + e.message);
    }
}

let staffRecords = [];
let trainingRecords = [];

// Role-based classification. The email is explicit that assistants count toward
// ratio, so paraprofessionals and assistants are teaching staff here.
function isDirector(s) {
    return /director|administrator/i.test(s.Role || '');
}
function isTeachingStaff(s) {
    return /teacher|assistant|paraprofessional|para\b/i.test(s.Role || '');
}

function trainingDone(staffId, key) {
    return trainingRecords.some(t =>
        String(t.StaffId) === String(staffId) && t.TrainingKey === key && (t.CompletedDate || '').trim());
}

function trainingRecord(staffId, key) {
    return trainingRecords.find(t =>
        String(t.StaffId) === String(staffId) && t.TrainingKey === key) || null;
}

// Evaluates the How ERS Works requirement and reports each part separately, so a
// partial pass is visible rather than collapsed into one red or green light.
function evaluateHowErsWorks() {
    const directors = staffRecords.filter(isDirector);
    const teaching = staffRecords.filter(isTeachingStaff);

    const directorsDone = directors.filter(s => trainingDone(s.Id, 'howERSWorks'));
    const teachingDone = teaching.filter(s => trainingDone(s.Id, 'howERSWorks'));
    const needed = Math.ceil(teaching.length / 2);

    // Per-classroom coverage, using the classroom recorded on the staff card.
    const rooms = {};
    teaching.forEach(s => {
        const room = (s.Classroom || '').trim();
        if (!room || /^tbd$/i.test(room)) return;
        if (!rooms[room]) rooms[room] = { total: 0, done: 0 };
        rooms[room].total++;
        if (trainingDone(s.Id, 'howERSWorks')) rooms[room].done++;
    });
    const roomsWithout = Object.keys(rooms).filter(r => !rooms[r].done).sort();

    return {
        directorMet: directors.length > 0 && directorsDone.length > 0,
        directors: directors, directorsDone: directorsDone,
        teachingTotal: teaching.length, teachingDone: teachingDone.length, teachingNeeded: needed,
        halfMet: teaching.length > 0 && teachingDone.length >= needed,
        roomsWithout: roomsWithout, roomCount: Object.keys(rooms).length
    };
}

function reqPill(met, text) {
    const bg = met ? '#f0fdf4' : '#fffbeb';
    const fg = met ? '#166534' : '#92400e';
    return '<span style="font-size:0.7rem;font-weight:700;padding:3px 9px;border-radius:11px;background:' + bg + ';color:' + fg + ';white-space:nowrap;">'
        + (met ? '\u2713 ' : '') + text + '</span>';
}

/* ─────────────────────────────────────────────────────────────────────────────
   Standard 4 readiness — 4A director credential, 4B staff credentials,
   4C professional development.

   Computed from the staff records rather than typed, so the panel and the printed
   qualification worksheets can never disagree. Three rules shape the maths:

     · The ownership group is excluded. Genni confirmed owners and administrators
       are left out of the ExceleRate totals, and including them changes whether
       4B passes.
     · A person is counted once even when they teach in two rooms, but they count
       toward both rooms' requirements. Double counting would inflate the
       denominator and understate compliance.
     · Percentages are reported against the number of PEOPLE needed, because 30%
       of nine people is three people, not 2.7.
   ──────────────────────────────────────────────────────────────────────────── */

const IT_ROOMS = ['Infant', 'Infants / Toddlers', '2 Year Olds / Toddlers'];
const PD_HOURS_REQUIRED = 20;
const PD_YEAR = String(new Date().getFullYear());

function roomKey(v) {
    return String(v || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
        .map(w => (w.length > 2 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).join('/');
}
function servesRoom(s, room) {
    return roomKey(s.Classroom) === roomKey(room) || roomKey(s.SecondaryClassroom) === roomKey(room);
}
function isPartTimeIn(s, room) {
    return roomKey(s.SecondaryClassroom) === roomKey(room) && roomKey(s.Classroom) !== roomKey(room);
}
function credLevel(s, kind) {
    const src = [s.EceCredentials, s.Gateways].filter(Boolean).join(', ');
    const re = kind === 'ece' ? /ECE(?:\s*Credential)?\s*-?\s*Level\s*(\d)/i
        : kind === 'it' ? /(?:IT|ITC|Infant\s*\/?\s*Toddler)(?:\s*Credential)?\s*-?\s*Level\s*(\d)/i
        : /Director(?:\s*Credential)?\s*-?\s*Level\s*(III|II|I|\d)/i;
    const m = src.match(re);
    if (!m) return 0;
    if (kind === 'dir') return /^\d$/.test(m[1]) ? +m[1] : { I: 1, II: 2, III: 3 }[m[1].toUpperCase()] || 0;
    return +m[1];
}
// Everyone the ExceleRate percentages are calculated over.
function countedStaff() {
    return staffRecords
        .filter(s => (s.StaffGroup || '') !== 'Ownership')
        .filter(s => isTeachingStaff(s))
        .filter(s => (s.Classroom || '').trim() || (s.SecondaryClassroom || '').trim());
}
const peopleNeeded = n => Math.ceil(n * 0.3);

function evaluate4A() {
    // The credential belongs to whoever administers the programme.
    const directors = staffRecords.filter(isDirector);
    const qualified = directors.filter(s => credLevel(s, 'dir') >= 1
        || /principal endorsement/i.test([s.EceCredentials, s.Gateways, s.Notes].join(' ')));
    return { met: qualified.length > 0, directors, qualified };
}

function evaluate4B() {
    const staff = countedStaff();
    const ece3 = staff.filter(s => credLevel(s, 'ece') >= 3);
    const itStaff = staff.filter(s => IT_ROOMS.some(r => servesRoom(s, r)));
    const itOk = itStaff.filter(s => credLevel(s, 'it') >= 2);
    return {
        staff, ece3, itStaff, itOk,
        eceNeeded: peopleNeeded(staff.length), itNeeded: peopleNeeded(itStaff.length),
        eceMet: staff.length > 0 && ece3.length >= peopleNeeded(staff.length),
        itMet: itStaff.length > 0 && itOk.length >= peopleNeeded(itStaff.length),
        // No spare capacity means one schedule change breaks compliance.
        eceMargin: ece3.length - peopleNeeded(staff.length),
        itMargin: itOk.length - peopleNeeded(itStaff.length),
        itPartTimeReliant: itOk.filter(s => IT_ROOMS.some(r => isPartTimeIn(s, r))).length
    };
}

/* 4C runs on the CALENDAR year, not the school year: the centre is open year
   round and PAS applies centre-wide, to children who are PI, PFA or neither.
   Hours recorded against an earlier year do not count, and are reported as
   unknown rather than as a shortfall — the figure is stale, not proven low. */
function pdHoursCurrent(s) {
    const v = String(s.PdHoursYtd || '').trim();
    if (v === '') return null;
    const yr = String(s.PdHoursYear || '').trim();
    // A total with no year recorded is treated as unknown rather than assumed current.
    if (yr !== String(new Date().getFullYear())) return null;
    const n = parseFloat(v);
    return isFinite(n) ? n : null;
}

function evaluate4C() {
    const staff = countedStaff();
    const withHours = staff.filter(s => pdHoursCurrent(s) !== null);
    const met = withHours.filter(s => pdHoursCurrent(s) >= PD_HOURS_REQUIRED);
    const short = withHours.filter(s => pdHoursCurrent(s) < PD_HOURS_REQUIRED);
    const unknown = staff.filter(s => pdHoursCurrent(s) === null);
    // Unknown is not the same as failing, and must not be reported as either.
    return { staff, withHours, met, short, unknown, allMet: staff.length > 0 && met.length === staff.length };
}

function stdRow(label, value, tone) {
    const c = tone === 'good' ? '#166534' : tone === 'bad' ? '#991b1b' : '#92400e';
    return '<div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0;font-size:0.75rem;">'
        + '<span style="color:#64748b;">' + label + '</span>'
        + '<span style="color:' + c + ';font-weight:700;text-align:right;">' + value + '</span></div>';
}
function stdCard(code, title, met, bodyHtml, footNote) {
    const border = met ? '#86efac' : '#fcd34d';
    const bg = met ? '#f0fdf4' : '#fffbeb';
    return '<div style="flex:1 1 300px;min-width:280px;background:' + bg + ';border:1.5px solid ' + border
        + ';border-radius:10px;padding:14px 16px;">'
        + '<div style="font-size:0.8rem;font-weight:800;color:#1e293b;margin-bottom:6px;">' + code + ' ' + title
        + ' ' + reqPill(met, met ? 'met' : 'not met') + '</div>'
        + bodyHtml
        + (footNote ? '<div style="margin-top:8px;font-size:0.7rem;color:#64748b;line-height:1.5;">' + footNote + '</div>' : '')
        + '</div>';
}
const nameList = arr => arr.length ? arr.map(s => (s.Name || '').split(' ')[0]).join(', ') : 'none';

function renderExcelerate4() {
    const host = document.getElementById('excelerate4');
    if (!host) return;
    if (!staffRecords.length) {
        host.innerHTML = '<div style="padding:14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:0.8rem;color:#64748b;">No staff records loaded.</div>';
        return;
    }

    const a = evaluate4A(), b = evaluate4B(), c = evaluate4C();

    const cardA = stdCard('4A', 'Director credential', a.met,
        stdRow('Directors on record', a.directors.length ? nameList(a.directors) : 'none', a.directors.length ? 'good' : 'bad')
        + stdRow('Holding Director Level I+', a.qualified.length ? nameList(a.qualified) : 'none', a.met ? 'good' : 'bad')
        + (a.qualified.length ? stdRow('Level', a.qualified.map(s => 'L' + credLevel(s, 'dir')).join(', '), 'good') : ''),
        'Needs a Gateways Illinois Director Credential at Level I or above, or a Principal Endorsement.');

    const cardB = stdCard('4B', 'Staff credentials', b.eceMet && b.itMet,
        stdRow('Teaching staff counted', b.staff.length, 'good')
        + stdRow('ECE Level 3+', b.ece3.length + ' of ' + b.staff.length + ' — need ' + b.eceNeeded
            + ' (' + Math.round(b.ece3.length / (b.staff.length || 1) * 100) + '%)', b.eceMet ? 'good' : 'bad')
        + stdRow('', nameList(b.ece3), b.eceMet ? 'good' : 'bad')
        + '<div style="height:6px;"></div>'
        + stdRow('Infant/toddler staff', b.itStaff.length, 'good')
        + stdRow('Infant/Toddler Level 2+', b.itOk.length + ' of ' + b.itStaff.length + ' — need ' + b.itNeeded
            + ' (' + Math.round(b.itOk.length / (b.itStaff.length || 1) * 100) + '%)', b.itMet ? 'good' : 'bad')
        + stdRow('', nameList(b.itOk), b.itMet ? 'good' : 'bad'),
        (b.eceMargin === 0 || b.itMargin === 0
            ? '<strong style="color:#92400e;">Passing with no margin.</strong> '
              + (b.eceMargin === 0 ? 'ECE has exactly the minimum. ' : '')
              + (b.itMargin === 0 ? 'Infant/toddler has exactly the minimum. ' : '')
              + 'One person changing rooms or leaving drops you below.'
            : '')
        + (b.itPartTimeReliant
            ? ' <strong style="color:#92400e;">' + b.itPartTimeReliant + ' of the infant/toddler credential holders '
              + 'are there on a part-time assignment</strong>, so the schedule is what supports this.'
            : '')
        + ' Ownership is excluded from both counts, per Genni. Staff teaching two rooms are counted once.');

    const cardC = stdCard('4C', 'Professional development', c.allMet,
        stdRow('Teaching staff', c.staff.length, 'good')
        + stdRow('At ' + PD_HOURS_REQUIRED + '+ hours in ' + PD_YEAR, c.met.length + ' of ' + c.staff.length, c.allMet ? 'good' : 'bad')
        + (c.short.length ? stdRow('Below ' + PD_HOURS_REQUIRED + ' hours',
            c.short.map(s => (s.Name || '').split(' ')[0] + ' (' + pdHoursCurrent(s) + ')').join(', '), 'bad') : '')
        + (c.unknown.length ? stdRow('No hours for ' + PD_YEAR, nameList(c.unknown), 'warn') : ''),
        (c.unknown.length
            ? '<strong>' + c.unknown.length + ' staff have no PD hours recorded for ' + PD_YEAR + '</strong>, which is not '
              + 'the same as being short — it is unknown. Enter hours on the staff cards to make this a real answer.'
            : '')
        + ' ' + PD_HOURS_REQUIRED + ' clock hours per classroom teaching staff member, per calendar year. '
        + 'This runs on the actual year, not the school year: the centre is open year round and PAS applies '
        + 'centre-wide, to children who are PI, PFA or neither. Hours logged against an earlier year stop '
        + 'counting on 1 January, so the count resets rather than carrying a stale total forward. '
        + 'Kept as a running total on each staff card, because PD comes from Gateways, in-house sessions '
        + 'and conferences that are not all itemised here.');

    const allMet = a.met && b.eceMet && b.itMet && c.allMet;
    host.innerHTML =
        '<div style="background:' + (allMet ? '#f0fdf4' : '#f8fafc') + ';border:1.5px solid '
        + (allMet ? '#86efac' : '#e2e8f0') + ';border-radius:10px;padding:14px 16px;margin-bottom:12px;">'
        + '<div style="font-size:0.85rem;font-weight:800;color:#1e293b;">Standard 4 '
        + reqPill(allMet, allMet ? 'all three met' : 'outstanding items') + '</div>'
        + '<div style="font-size:0.74rem;color:#64748b;line-height:1.6;margin-top:4px;">'
        + 'Calculated live from the staff records, so this matches what the Teaching Staff Qualifications '
        + 'worksheets print. Fix a credential or a room assignment on the staff cards and this updates.</div>'
        + '</div>'
        + '<div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:14px;">' + cardA + cardB + cardC + '</div>';
}

function renderTrainingReqs() {
    const host = document.getElementById('trainingReqs');
    if (!host) return;
    if (!staffRecords.length) {
        host.innerHTML = '<div style="padding:14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:0.8rem;color:#64748b;">No staff records loaded.</div>';
        return;
    }
    const e = evaluateHowErsWorks();
    const allMet = e.directorMet && e.halfMet;

    host.innerHTML =
        '<div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:14px;">'
        + '<div style="font-size:0.85rem;font-weight:800;color:#1e293b;margin-bottom:4px;">How ERS Works '
        + reqPill(allMet, allMet ? 'requirement met' : 'not yet met') + '</div>'
        + '<div style="font-size:0.74rem;color:#64748b;line-height:1.6;margin-bottom:10px;">'
        + 'Required for the Director/Administrator and 50% of teaching staff. Assistants count toward ratio.</div>'
        + '<div style="display:flex;flex-wrap:wrap;gap:8px;">'
        + reqPill(e.directorMet, 'Director: ' + e.directorsDone.length + ' of ' + e.directors.length + ' trained')
        + reqPill(e.halfMet, 'Teaching staff: ' + e.teachingDone + ' of ' + e.teachingTotal
            + ' (need ' + e.teachingNeeded + ')')
        + reqPill(e.roomsWithout.length === 0,
            e.roomsWithout.length === 0
                ? 'Every classroom covered'
                : 'No one trained in: ' + e.roomsWithout.join(', '))
        + '</div>'
        + (e.roomsWithout.length
            ? '<div style="font-size:0.72rem;color:#92400e;margin-top:9px;">One trained teacher per classroom is strongly encouraged rather than required, so this does not block the standard.</div>'
            : '')
        + '</div>';
}

function renderTrainingMatrix() {
    const host = document.getElementById('trainingMatrix');
    if (!host) return;
    if (!staffRecords.length) { host.innerHTML = ''; return; }

    // Director first, then teaching staff, then everyone else.
    const ordered = staffRecords.slice().sort((a, b) => {
        const rank = s => isDirector(s) ? 0 : isTeachingStaff(s) ? 1 : 2;
        const d = rank(a) - rank(b);
        return d !== 0 ? d : (a.Name || '').localeCompare(b.Name || '');
    });

    const head = TRAINING_CATALOG.map(t =>
        '<th style="padding:8px 10px;text-align:center;font-size:0.66rem;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;color:#64748b;" title="'
        + t.note.replace(/"/g, '&quot;') + '">' + t.name + '</th>').join('');

    const rows = ordered.map(s => {
        const tags = (isDirector(s) ? '<span style="font-size:0.62rem;font-weight:700;color:#1d4ed8;background:#eff6ff;padding:1px 6px;border-radius:8px;margin-left:6px;">Director</span>' : '')
            + (isTeachingStaff(s) ? '<span style="font-size:0.62rem;font-weight:700;color:#166534;background:#f0fdf4;padding:1px 6px;border-radius:8px;margin-left:6px;">Teaching</span>' : '');
        const cells = TRAINING_CATALOG.map(t => {
            const rec = trainingRecord(s.Id, t.key);
            const date = rec ? (rec.CompletedDate || '') : '';
            return '<td style="padding:6px 10px;text-align:center;">'
                + '<input type="date" value="' + date + '" onchange="saveTraining(' + s.Id + ',\'' + t.key + '\',this.value)" '
                + 'title="Date completed. Clear the date to mark it not done." '
                + 'style="padding:3px 6px;border:1px solid ' + (date ? '#bbf7d0' : '#d1d5db') + ';border-radius:5px;font-size:0.7rem;font-family:inherit;background:' + (date ? '#f0fdf4' : 'white') + ';">'
                + '</td>';
        }).join('');
        return '<tr style="border-bottom:1px solid #f1f5f9;">'
            + '<td style="padding:6px 10px;font-size:0.78rem;font-weight:600;color:#1e293b;white-space:nowrap;">' + (s.Name || '') + tags + '</td>'
            + '<td style="padding:6px 10px;font-size:0.72rem;color:#64748b;white-space:nowrap;">' + (s.Classroom || '—') + '</td>'
            + cells + '</tr>';
    }).join('');

    host.innerHTML =
        '<div style="background:white;border:1.5px solid #e2e8f0;border-radius:10px;overflow-x:auto;margin-bottom:14px;">'
        + '<table style="width:100%;border-collapse:collapse;">'
        + '<thead><tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0;">'
        + '<th style="padding:8px 10px;text-align:left;font-size:0.66rem;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;color:#64748b;">Staff</th>'
        + '<th style="padding:8px 10px;text-align:left;font-size:0.66rem;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;color:#64748b;">Classroom</th>'
        + head + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
        + '<div style="font-size:0.72rem;color:#64748b;margin-bottom:6px;">Enter the completion date. Clearing a date marks the training as not done.</div>';
}

async function saveTraining(staffId, trainingKey, completedDate) {
    try {
        const res = await apiFetch('/api/staff-training', {
            method: 'POST',
            body: JSON.stringify({ staffId: staffId, trainingKey: trainingKey, completedDate: completedDate })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Save failed');
        await loadTrainingData();
        renderExcelerate4();
        renderTrainingReqs();
        renderTrainingMatrix();
    } catch (e) {
        alert('Could not save that training: ' + e.message);
    }
}

async function loadTrainingData() {
    try {
        // Classrooms and students come from app.js's shared loaders; the 75% rule
        // for two-to-three rooms needs the enrolled birth dates.
        const [sRes, tRes, aRes] = await Promise.all([
            apiFetch('/api/staff'),
            apiFetch('/api/staff-training'),
            apiFetch('/api/silver-assessments')
        ]);
        staffRecords = await sRes.json();
        trainingRecords = await tRes.json();
        silverAssessments = await aRes.json();
        if (!Array.isArray(staffRecords)) staffRecords = [];
        if (!Array.isArray(trainingRecords)) trainingRecords = [];
        if (!Array.isArray(silverAssessments)) silverAssessments = [];
        await Promise.all([loadClassrooms(), loadStudents()]);
    } catch (e) {
        console.error('Failed to load training data', e);
    }
}

/* Renders only what the host page actually contains, so this file can be loaded anywhere
   without assuming a layout. The original ran unconditionally and also drew the PAS
   cross-check, which has stayed behind on pas.html. */
(async function () {
    const wanted = ['excelerate4', 'trainingReqs', 'trainingMatrix', 'silverAssessments'];
    if (!wanted.some(id => document.getElementById(id))) return;
    await loadTrainingData();
    renderExcelerate4();
    renderTrainingReqs();
    renderTrainingMatrix();
    renderSilverAssessments();
})();
