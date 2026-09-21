/* classroom-forms.js — shared child-record form modals for the PFA/PI system.

   ONE source of truth for the three per-child forms — Parent Interview,
   Permission Slip and Screening (ASQ-3 / ASQ:SE-2) — plus their signature pads,
   printing, Print All, and the screening-deadline helpers.

   Used by TWO pages:
     • isbe.html        — the [form] links in the roster / compliance / follow-up
                          views open these modals.
     • staff-portal.html — the My Classroom tab opens the same modals.

   Before this file existed the code lived only in isbe.html, so putting the
   classroom checklist in My Page would have meant a second copy of all of it.
   Extracting it here means a change to a form (a new field, a changed screening
   rule, a signature tweak) happens in one place and both pages stay in step.

   HOW IT GETS ITS DATA
   The forms need the student list, classrooms, tracking flags, screenings, the
   year in view, and the signature index — all of which each host page already
   loads for its own reasons. Rather than reach into either page's variables,
   the host registers a small context object once (CofpForms.init({...})) and the
   module reads through it. That keeps the two pages' data-loading untouched and
   this file free of any assumption about where the data lives.

   The modal markup and the .pi-* / print CSS are injected by this file on init,
   so neither HTML page carries its own copy of ~370 lines of modal markup. */
(function (global) {
    'use strict';

    var SCREENING_DEADLINE_DAYS = 45;
    var SCHOOL_YEAR_START_MONTH_DAY = '09-08';   // September 8 — change only if the first day of school moves.

    // ── Host context ──────────────────────────────────────────────────────────
    // Filled by init(). Every accessor is a function so the host can keep its own
    // state live: we always read the current value, never a snapshot.
    var ctx = null;

    function students()      { return ctx.getStudents() || []; }
    function classrooms()    { return ctx.getClassrooms() || []; }
    function tracking()      { return ctx.getTracking() || {}; }
    function screening()     { return ctx.getScreening() || {}; }
    function year()          { return ctx.getYear(); }
    function apiFetch()      { return ctx.apiFetch.apply(null, arguments); }
    function ChildForms()    { return ctx.ChildForms; }
    // Optional hooks — a host that does not have them gets safe no-ops.
    function refreshActiveView() { if (ctx.refreshActiveView) ctx.refreshActiveView(); }
    function activeProgram() { return ctx.getActiveProgram ? ctx.getActiveProgram() : null; }
    function activeRoom()    { return ctx.getActiveRoom ? ctx.getActiveRoom() : null; }
    function rosterForPrint() { return ctx.classroomRoster ? ctx.classroomRoster(activeRoom()) : null; }

    // yearQS: append the year in view as a query string, matching isbe.html's helper.
    function yearQS(path) {
        var y = year();
        if (!y) return path;
        return path + (path.indexOf('?') === -1 ? '?' : '&') + 'year=' + encodeURIComponent(y);
    }

    // ── Small shared helpers (ported verbatim from isbe.html) ──────────────────
    function yesNo(v) {
        if (v === true || v === 1 || v === '1') return 'Yes';
        if (typeof v === 'string' && v.trim().toLowerCase() === 'yes') return 'Yes';
        return 'No';
    }

    function sortByName(a, b) {
        var cmp = (a.Last_Name || '').localeCompare(b.Last_Name || '', undefined, { sensitivity: 'base' });
        return cmp !== 0 ? cmp : (a.First_Name || '').localeCompare(b.First_Name || '', undefined, { sensitivity: 'base' });
    }

    function sortByRoomThenName(a, b) {
        var ra = parseInt(a.RoomNumber), rb = parseInt(b.RoomNumber);
        var aNum = isNaN(ra) ? Infinity : ra, bNum = isNaN(rb) ? Infinity : rb;
        if (aNum !== bNum) return aNum - bNum;
        return sortByName(a, b);
    }

    function daysBetween(a, b) {
        var d1 = new Date(a), d2 = new Date(b);
        if (isNaN(d1) || isNaN(d2)) return null;
        return Math.round((d2 - d1) / 86400000);
    }

    function schoolYearStartDate(y) {
        var start = parseInt(String(y || year()).split('-')[0], 10);
        return isNaN(start) ? null : start + '-' + SCHOOL_YEAR_START_MONTH_DAY;
    }

    function screeningAnchorDate(student, y) {
        var yearStart = schoolYearStartDate(y);
        var enrolled = student.Start_Date || null;
        if (!enrolled) return yearStart;
        if (!yearStart) return enrolled;
        return enrolled > yearStart ? enrolled : yearStart;
    }

    function isLateEnrollee(student, y) {
        var yearStart = schoolYearStartDate(y);
        if (!yearStart || !student.Start_Date) return false;
        var into = daysBetween(yearStart, student.Start_Date);
        return into !== null && into > SCREENING_DEADLINE_DAYS;
    }

    function screeningDeadline(student, screeningDate, y) {
        var anchor = screeningAnchorDate(student, y);
        if (!anchor) return null;
        if (screeningDate) {
            var used = daysBetween(anchor, screeningDate);
            if (used === null) return null;
            if (used < 0) return { state: 'ok', text: 'on file' };
            return used <= SCREENING_DEADLINE_DAYS
                ? { state: 'ok', text: 'day ' + used }
                : { state: 'late', text: used + 'd (late)' };
        }
        var today = new Date().toISOString().split('T')[0];
        if (today < anchor) return { state: 'ok', text: 'not started' };
        var elapsed = daysBetween(anchor, today);
        if (elapsed === null) return null;
        var left = SCREENING_DEADLINE_DAYS - elapsed;
        if (left < 0) return { state: 'overdue', text: Math.abs(left) + 'd overdue' };
        if (left <= 10) return { state: 'due', text: left + 'd left' };
        return { state: 'ok', text: left + 'd left' };
    }

    /* The checklist column a screening type+period maps to. One place, so
       openScreening, saveScreening and the questionnaire upload all agree. */
    function screeningField(type, period) {
        var beg = period === 'Beginning';
        if (type === 'ASQ-3') return beg ? 'BegASQ' : 'EndASQ';
        return beg ? 'BegASE' : 'EndASE';   // ASQ:SE-2
    }

    /* Draw the state of an upload slot: a green "on file" line with a view link, or
       a grey prompt when nothing is filed yet. rec is { on, name, relPath } or null. */
    function setUploadStatus(elId, rec, emptyText) {
        var el = document.getElementById(elId);
        if (!el) return;
        if (rec && rec.on) {
            var link = rec.relPath
                ? ' \u2014 <a href="/api/doc-file?path=' + encodeURIComponent(rec.relPath)
                  + '" target="_blank" rel="noopener">view</a>'
                : '';
            el.innerHTML = '\u2713 On file: ' + escapeHtml(rec.name || 'uploaded') + link;
            el.style.color = '#166534';
        } else {
            el.textContent = emptyText || 'Nothing uploaded yet.';
            el.style.color = '#64748b';
        }
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /* Upload one child evidence file (a parent questionnaire or a report card) to the
       child's folder via /api/child-file-upload. Multipart, so the credentials are
       attached by hand and Content-Type is left for the browser to set with its own
       boundary — the same shape as the staff-file upload. Returns the server's JSON,
       or throws. */
    async function uploadChildFile(studentId, field, kind, file) {
        var form = new FormData();
        form.append('file', file, file.name);
        var headers = (global.CofpAuth && CofpAuth.headers) ? CofpAuth.headers() : {};
        // Some hosts sign requests with a plain object; strip any JSON content type.
        var h = {};
        Object.keys(headers).forEach(function (k) {
            if (k.toLowerCase() !== 'content-type') h[k] = headers[k];
        });
        var url = '/api/child-file-upload?studentId=' + encodeURIComponent(studentId)
            + '&field=' + encodeURIComponent(field) + '&kind=' + encodeURIComponent(kind)
            + '&year=' + encodeURIComponent(year());
        var res = await fetch(url, { method: 'POST', headers: h, body: form });
        var d = await res.json();
        if (!res.ok || !d.success) throw new Error((d && d.error) || ('HTTP ' + res.status));
        return d;
    }

    function computeScreeningFlag(type, body) {
        if (type === 'ASQ-3') {
            var st = [body.commStatus, body.grossStatus, body.fineStatus, body.problemStatus, body.personalStatus];
            if (st.indexOf('Below') !== -1) return 'concern';
            if (st.indexOf('Monitor') !== -1) return 'monitor';
            return 'ok';
        }
        if (body.seResult === 'Above') return 'concern';
        if (body.seResult === 'Monitor') return 'monitor';
        return 'ok';
    }

    function calcAgeMonths(birthDate) {
        if (!birthDate) return '';
        var bd = new Date(birthDate);
        var now = new Date();
        var months = (now.getFullYear() - bd.getFullYear()) * 12 + (now.getMonth() - bd.getMonth());
        return months + ' months';
    }

    function getRoom(roomNum) {
        var r = classrooms().find(function (c) { return String(c.RoomNumber) === String(roomNum); });
        return r ? r.Room : roomNum;
    }

    function getTeacher(roomNum) {
        var r = classrooms().find(function (c) { return String(c.RoomNumber) === String(roomNum); });
        return r ? r.TeacherDescription : '';
    }

    // The checklist columns a teacher is responsible for, shared so the classroom
    // view and Print All agree on which forms exist and which field each maps to.
    var COLUMNS = [
        { field: 'PermissionSlip', teacher: true, label: 'Permission<br>Slip' },
        { field: 'ParentInterview', teacher: true, label: 'Parent<br>Interview' },
        { field: 'BegASQ', teacher: true, label: 'Beg ASQ' },
        { field: 'BegASE', teacher: true, label: 'Beg ASE' },
        { field: 'MidYearReport', teacher: true, label: 'Mid Year<br>Report Card' },
        { field: 'EndASQ', teacher: true, label: 'End ASQ' },
        { field: 'EndASE', teacher: true, label: 'End ASE' },
        { field: 'EndYearReport', teacher: true, label: 'End Year<br>Report Card' },
        // Screening results shared with the parent (PICC PI10.H). A signed classroom
        // form: captured when the teacher hands the report card / screening results to
        // the family. Moved here from the ISBE roster's editable [form].
        { field: 'ScreeningResultsShared', teacher: true, label: 'Results<br>Shared' }
    ];
    var SCREENING_FIELDS = ['BegASQ', 'BegASE', 'EndASQ', 'EndASE'];
    // A column has a form behind it when opening it produces a modal. Mid/End year
    // report cards are tick-only, so they are deliberately excluded.
    function columnHasForm(field) {
        return field === 'PermissionSlip' || field === 'ParentInterview'
            || field === 'ScreeningResultsShared'
            || SCREENING_FIELDS.indexOf(field) !== -1;
    }

    // ── Signatures ─────────────────────────────────────────────────────────────
    function sigKey(studentId, field, role) {
        return String(studentId) + '|' + field + '|' + role;
    }
    function signatureFor(studentId, field, role) {
        return (ctx.getSignatures() || {})[sigKey(studentId, field, role)] || null;
    }
    // Loading the signature index is the host's job (it does it in its own init
    // alongside its other data), but the module offers this so a host without its
    // own loader can borrow one.
    async function loadSignatures(y) {
        var out = {};
        try {
            var res = await apiFetch('/api/child-signatures?year=' + encodeURIComponent(y));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var d = await res.json();
            (d.signatures || []).forEach(function (s) {
                out[sigKey(s.StudentId, s.FormField, s.Role)] = s;
            });
        } catch (e) {
            console.warn('Could not load signatures', e);
        }
        if (ctx.setSignatures) ctx.setSignatures(out);
        return out;
    }

    // The live pads on whichever modal is open, keyed by the element they live in.
    var sigPads = {};

    function mountSigPad(hostId, studentId, field, role, opts) {
        var host = document.getElementById(hostId);
        if (!host || !global.SignPad) return;
        opts = opts || {};
        var pad = global.SignPad.create(host);
        sigPads[hostId] = { pad: pad, field: field, role: role, studentId: studentId,
                            label: opts.label || '', printedName: opts.printedName || '',
                            dateField: opts.dateField || '' };
        var existing = signatureFor(studentId, field, role);
        /* Prefer the standalone signature IMAGE (SigImagePath). RelPath is the whole
           signed form as a PDF, and the pad draws its on-file signature into an <img>,
           which a PDF cannot populate — so pointing the pad at RelPath left it blank.
           Fall back to RelPath only when there is no image (older rows filed before the
           image was kept), where it will still fail to render but does no harm. */
        var onFileRel = (existing && existing.SigImagePath) ? existing.SigImagePath
                      : (existing && existing.RelPath) ? existing.RelPath : '';
        if (onFileRel) {
            /* Fetch the on-file signature WITH credentials and hand the pad a blob URL.
               A bare <img src="/api/doc-file?..."> is a plain GET that carries no auth
               header, so the thumbnail came back Unauthorized and showed blank. */
            (function (p, rel) {
                apiFetch('/api/doc-file?path=' + encodeURIComponent(rel))
                    .then(function (r) { return r.ok ? r.blob() : null; })
                    .then(function (b) { if (b) p.showExisting(URL.createObjectURL(b)); })
                    .catch(function () { /* leave the pad empty on failure */ });
            })(pad, onFileRel);
            pad.setStatus('Signed' + (existing.SignedAt ? ' ' + existing.SignedAt.slice(0, 10) : '')
                + ' \u2014 press Clear to sign again', '#166534');
        } else if (field === 'PermissionSlip') {
            // The Permission Slip has no Print button (sign-and-save only, no paper
            // copy), so the note only mentions the on-screen signature.
            pad.setStatus('Not signed yet. Hand the screen to the parent to sign, then Save.', '#64748b');
        } else {
            pad.setStatus('Not signed yet. Hand the screen to the parent, or print and scan the '
                + 'signed sheet into the child\u2019s file.', '#64748b');
        }
        setTimeout(function () { pad.refresh(); }, 30);
    }

    /* Re-fit every mounted signature pad now that its modal is actually visible.

       A canvas sized while its modal is display:none gets a zero-size backing store
       and bails out of fit(); the canvas then renders at its default 300x150 while
       CSS stretches it to fill the wrapper. Pointer coordinates are measured in the
       stretched (displayed) space but drawn into the unscaled backing store, so ink
       lands offset and mis-scaled from the pen tip — the "half an inch up and to the
       right" the stylus showed. mountSigPad's own 30ms refresh often fires during the
       await before the modal opens, so it re-fits while still hidden and misses. This
       runs after .open is set, across two animation frames so layout has settled. */
    function refreshSigPads() {
        var doFit = function () {
            Object.keys(sigPads).forEach(function (k) {
                if (sigPads[k] && sigPads[k].pad && sigPads[k].pad.refresh) sigPads[k].pad.refresh();
            });
        };
        requestAnimationFrame(function () { requestAnimationFrame(doFit); });
    }

    async function fileSignedForm(studentId, field, content) {
        var drawn = Object.keys(sigPads)
            .map(function (k) { return sigPads[k]; })
            .filter(function (e) { return e.field === field && e.pad.drawn; });
        if (!drawn.length) return [];

        var student = students().find(function (s) { return String(s.Id) === String(studentId); });
        var payload = {
            studentId: studentId,
            year: year(),
            program: student && student.PFA_PI_na === 'PFA' ? 'PFA' : 'PI',
            childName: student ? student.Last_Name + ', ' + student.First_Name : '',
            field: field,
            formTitle: content.formTitle,
            rows: content.rows || [],
            blocks: content.blocks || [],
            capturedOn: navigator.userAgent.slice(0, 55),
            signatures: []
        };
        drawn.forEach(function (e) {
            var url = e.pad.toDataUrl();
            if (!url) return;
            payload.signatures.push({
                role: e.role, label: e.label,
                name: e.printedName ? (document.getElementById(e.printedName) || {}).value || '' : '',
                date: e.dateField ? (document.getElementById(e.dateField) || {}).value || '' : '',
                dataUrl: url
            });
        });
        if (!payload.signatures.length) return [];

        try {
            var res = await apiFetch('/api/child-signed-form', {
                method: 'POST', body: JSON.stringify(payload)
            });
            var d = await res.json();
            if (!res.ok || !d.success) {
                drawn.forEach(function (e) { e.pad.setStatus('\u26a0 Not filed', '#b91c1c'); });
                return [(d && d.error) || 'the signed document was not filed'];
            }
            var sigs = ctx.getSignatures() || {};
            var sigImages = d.sigImages || {};
            payload.signatures.forEach(function (s) {
                sigs[sigKey(studentId, field, s.role)] = {
                    StudentId: String(studentId), FormField: field, Role: s.role,
                    SignedName: s.name, RelPath: d.relPath,
                    SigImagePath: sigImages[s.role] || '',
                    SignedAt: new Date().toISOString().slice(0, 10)
                };
            });
            if (ctx.setSignatures) ctx.setSignatures(sigs);
            drawn.forEach(function (e) { e.pad.setStatus('\u2713 Filed as ' + d.name, '#166534'); });
            if (ctx.onDocsChanged) ctx.onDocsChanged();
            return [];
        } catch (e) {
            drawn.forEach(function (p) { p.pad.setStatus('\u26a0 Not filed: ' + e.message, '#b91c1c'); });
            return [e.message];
        }
    }

    // ── Parent Interview ───────────────────────────────────────────────────────
    var currentInterviewStudentId = null;

    var INTAKE_RISK_FACTORS = [
        ['ScreeningDelayNoEi', 'Screening-indicated delay, no EI referral'],
        ['ParentEll', 'Parent is an English language learner'],
        ['IncomeBelow50Fpl', 'Income at or below 50% FPL'],
        ['Homeless', 'Homeless / unstable housing'],
        ['FosterAdopted', 'Foster or adopted'],
        ['IEP', 'IEP'],
        ['EarlyIntervention', 'Early Intervention history'],
        ['AbuseHistory', 'Abuse / domestic violence'],
        ['MentalIllness', 'Mental illness in home'],
        ['DcfsInvolvement', 'DCFS involvement'],
        ['SubstanceAbuse', 'Substance abuse in home'],
        ['CaregiverOther', 'Other caregiver'],
        ['FamilyDeath', 'Death in family'],
        ['LowBirthWeight', 'Low birth weight'],
        ['ParentIncarcerated', 'Parent incarcerated'],
        ['TeenParent', 'Teen parent'],
        ['NoHSDiploma', 'No HS diploma'],
        ['BornOutsideUS', 'Born outside US'],
        ['NonEnglishHome', 'Non-English home'],
        ['ActiveMilitary', 'Active military']
    ];

    var PROGRAM_LABELS = { '0-2': 'Infant & Toddler', '2-3': '2-Year Olds', '3-5': 'Pre-School', 'ba': 'Before & Afterschool' };

    async function openInterview(studentId) {
        currentInterviewStudentId = studentId;
        var student = students().find(function (s) { return String(s.Id) === String(studentId); });
        if (!student) return;

        document.getElementById('piModalTitle').textContent = 'Parent Interview \u2013 ' + student.First_Name + ' ' + student.Last_Name;
        document.getElementById('piChildName').textContent = student.First_Name + ' ' + student.Last_Name;
        document.getElementById('piDOB').textContent = student.Birth_date || '\u2014';
        document.getElementById('piRoom').textContent = getRoom(student.RoomNumber) || '\u2014';
        document.getElementById('piIncome').textContent = student.HouseholdIncome ? '$' + Number(student.HouseholdIncome).toLocaleString() : '\u2014';
        document.getElementById('piHHSize').textContent = student.HouseholdSize || '\u2014';
        document.getElementById('piBenefits').textContent = student.PublicBenefits || 'None';
        document.getElementById('piFRP').textContent = student.F_R_P_Food || '\u2014';
        document.getElementById('piIEP').textContent = yesNo(student.IEP);
        document.getElementById('piFoster').textContent = student.Category === 'Foster' ? 'Yes' : 'No';
        document.getElementById('piMilitary').textContent = yesNo(student.Military);
        document.getElementById('piCategory').textContent = student.Category || '\u2014';

        var oldCarry = document.getElementById('piCarryNote');
        if (oldCarry) oldCarry.remove();
        document.getElementById('piDate').value = new Date().toISOString().split('T')[0];
        document.getElementById('piGoals').value = '';
        document.getElementById('piConcerns').value = '';
        document.getElementById('piStrengths').value = '';
        document.getElementById('piNotes').value = '';
        document.getElementById('piParentSig').value = '';
        document.getElementById('piStaffSig').value = '';
        /* Preferred language defaults from the child's enrollment HomeLanguage so the
           ISBE-required language field is pre-filled rather than retyped. A saved
           interview value (loaded below) still wins. Blank HomeLanguage or plain
           "English" leaves it for the interviewer to confirm. */
        document.getElementById('piPreferredLanguage').value = student.HomeLanguage || '';
        document.getElementById('piTranslatorNeeded').value = '';
        document.getElementById('piTranslatorArrangements').value = '';
        document.getElementById('piSavedBadge').style.display = 'none';

        sigPads = {};
        mountSigPad('piParentSigPad', studentId, 'ParentInterview', 'parent',
            { label: 'Parent/Guardian signature', printedName: 'piParentSig', dateField: 'piDate' });
        mountSigPad('piStaffSigPad', studentId, 'ParentInterview', 'staff',
            { label: 'Staff signature', printedName: 'piStaffSig', dateField: 'piDate' });

        try {
            var res = await apiFetch(yearQS('/api/parent-interview/' + studentId));
            var data = await res.json();
            if (data && data.Id) {
                document.getElementById('piDate').value = data.InterviewDate || '';
                document.getElementById('piGoals').value = data.ParentGoals || '';
                document.getElementById('piConcerns').value = data.ParentConcerns || '';
                document.getElementById('piStrengths').value = data.ChildStrengths || '';
                document.getElementById('piNotes').value = data.Notes || '';
                document.getElementById('piParentSig').value = data.ParentSignature || '';
                document.getElementById('piStaffSig').value = data.StaffSignature || '';
                // A saved language wins, but keep the HomeLanguage pre-fill when the
                // saved record has none (older interviews predate the language field).
                if (data.PreferredLanguage) document.getElementById('piPreferredLanguage').value = data.PreferredLanguage;
                document.getElementById('piTranslatorNeeded').value = data.TranslatorNeeded || '';
                document.getElementById('piTranslatorArrangements').value = data.TranslatorArrangements || '';
            } else {
                /* No interview for this year yet. For a returning child, carry the most
                   recent PRIOR year's answers forward as a starting point so this is an
                   update, not a blank restart. Signatures and the interview date are NOT
                   carried (each year is signed fresh); the narrative and language are. */
                await carryForwardInterview(studentId);
            }
        } catch (e) { console.error('Failed to load interview', e); }

        loadIntakeRecord(studentId);
        document.getElementById('piOverlay').classList.add('open');
        refreshSigPads();
    }

    /* Pull the newest interview from an earlier year and pre-fill the narrative +
       language fields so a returning child's interview starts from last year rather
       than blank. Best-effort: on any failure the form simply stays empty. Shows a
       small "carried forward" note so staff know to review and update it. */
    async function carryForwardInterview(studentId) {
        try {
            var res = await apiFetch('/api/parent-interview/' + studentId + '?priorTo=' + encodeURIComponent(year()));
            var prior = await res.json();
            if (!prior || !prior.Id) return;
            document.getElementById('piGoals').value = prior.ParentGoals || '';
            document.getElementById('piConcerns').value = prior.ParentConcerns || '';
            document.getElementById('piStrengths').value = prior.ChildStrengths || '';
            document.getElementById('piNotes').value = prior.Notes || '';
            if (prior.PreferredLanguage) document.getElementById('piPreferredLanguage').value = prior.PreferredLanguage;
            if (prior.TranslatorNeeded) document.getElementById('piTranslatorNeeded').value = prior.TranslatorNeeded;
            if (prior.TranslatorArrangements) document.getElementById('piTranslatorArrangements').value = prior.TranslatorArrangements;
            // A visible cue on the modal title area that this is last year's content.
            var title = document.getElementById('piModalTitle');
            if (title && title.textContent.indexOf('(carried forward') === -1) {
                title.insertAdjacentHTML('afterend',
                    '<div id="piCarryNote" style="font-size:0.72rem;color:#b45309;font-weight:600;margin:2px 0 0;">'
                    + 'Pre-filled from last year\u2019s interview \u2014 review, update, and sign for this year.</div>');
            }
        } catch (e) { /* leave blank on failure */ }
    }

    async function loadIntakeRecord(studentId) {
        var meta = document.getElementById('piIntakeMeta');
        var body = document.getElementById('piIntakeBody');
        meta.textContent = '';
        body.innerHTML = '<div style="font-size:0.78rem;color:#9ca3af;">Loading intake record\u2026</div>';
        try {
            var res = await apiFetch('/api/student-intake/' + studentId);
            var d = await res.json();
            if (!d || !d.found) {
                meta.textContent = '';
                body.innerHTML = '<div style="font-size:0.78rem;color:#9ca3af;">No pre-enrollment record on file for this child. '
                    + 'Children enrolled before the online form went live will not have one.</div>';
                return;
            }
            var submitted = (d.SubmittedAt || '').split(' ')[0];
            meta.textContent = '\u00b7 submitted ' + (submitted || 'unknown') + (d.MatchType === 'name+dob' ? ' (matched by name + DOB)' : '');
            var yes = function (v) { return String(v).trim().toLowerCase() === 'yes'; };
            var flags = INTAKE_RISK_FACTORS.filter(function (p) { return yes(d[p[0]]); }).map(function (p) {
                return '<span class="pi-flag">' + p[1] + '</span>';
            }).join('');
            var field = function (label, value) {
                return '<div class="pi-field"><label>' + label + '</label><div class="pi-value">' + (value || '\u2014') + '</div></div>';
            };
            var parent = [d.ParentFirst, d.ParentLast].filter(Boolean).join(' ');
            var program = PROGRAM_LABELS[d.AgeGroup] || d.AgeGroup || '';
            body.innerHTML =
                '<div class="pi-grid three" style="margin-bottom:12px;">'
                + field('Parent / Guardian', parent) + field('Phone', d.Phone) + field('Email', d.Email)
                + '</div>'
                + '<div class="pi-grid three" style="margin-bottom:12px;">'
                + field('Program Applied For', program) + field('Days Requested', d.DaysRequested) + field('Priority Score', d.Score)
                + '</div>'
                + '<div class="pi-grid" style="margin-bottom:12px;">'
                + field('Living Situation', d.LivingSituation) + field('Prior Early Learning', d.PriorEarlyLearning)
                + '</div>'
                + '<div class="pi-field pi-full"><label>Risk Factors Reported at Intake</label>'
                + '<div class="pi-flags">' + (flags || '<span style="font-size:0.78rem;color:#9ca3af;">None reported</span>') + '</div></div>'
                + (d.Notes ? '<div class="pi-field pi-full" style="margin-top:10px;"><label>Intake Notes</label><div class="pi-value" style="white-space:normal;">' + d.Notes + '</div></div>' : '');
        } catch (e) {
            meta.textContent = '';
            body.innerHTML = '<div style="font-size:0.78rem;color:#dc2626;">Could not load intake record.</div>';
        }
    }

    function closeInterview() {
        document.getElementById('piOverlay').classList.remove('open');
        currentInterviewStudentId = null;
    }

    async function saveInterview() {
        if (!currentInterviewStudentId) return;
        var btn = document.getElementById('piSaveBtn');
        var body = {
            interviewDate: document.getElementById('piDate').value,
            parentGoals: document.getElementById('piGoals').value,
            parentConcerns: document.getElementById('piConcerns').value,
            childStrengths: document.getElementById('piStrengths').value,
            notes: document.getElementById('piNotes').value,
            year: year(),
            parentSignature: document.getElementById('piParentSig').value,
            staffSignature: document.getElementById('piStaffSig').value,
            preferredLanguage: document.getElementById('piPreferredLanguage').value,
            translatorNeeded: document.getElementById('piTranslatorNeeded').value,
            translatorArrangements: document.getElementById('piTranslatorArrangements').value
        };
        var missing = [];
        if (!body.preferredLanguage.trim()) missing.push('Preferred Language (PI5.L)');
        if (!body.translatorNeeded) missing.push('Translator Needed (PI5.M)');
        if (!body.translatorArrangements.trim()) missing.push('Translator Arrangements (PI5.M)');
        if (missing.length && !confirm('The PICC requires these sections to be filled in:\n\n  \u2022 '
            + missing.join('\n  \u2022 ') + '\n\nSave anyway?')) {
            return;
        }
        btn.disabled = true;
        btn.textContent = 'Saving...';
        try {
            var res = await apiFetch('/api/parent-interview/' + currentInterviewStudentId, {
                method: 'POST', body: JSON.stringify(body)
            });
            var data = await res.json();
            if (data.success) {
                var t = tracking();
                if (!t[currentInterviewStudentId]) t[currentInterviewStudentId] = {};
                t[currentInterviewStudentId].ParentInterview = 1;
                ChildForms().mark(currentInterviewStudentId, 'ParentInterview', body.interviewDate);
                var student = students().find(function (s) { return String(s.Id) === String(currentInterviewStudentId); });
                var sigProblems = await fileSignedForm(currentInterviewStudentId, 'ParentInterview', {
                    formTitle: 'Parent Interview',
                    rows: [
                        { label: 'Child', value: student ? student.Last_Name + ', ' + student.First_Name : '' },
                        { label: 'Date of birth', value: student ? (student.Birth_date || '') : '' },
                        { label: 'Interview date', value: body.interviewDate },
                        { label: 'Preferred language', value: body.preferredLanguage },
                        { label: 'Translator needed', value: body.translatorNeeded },
                        { label: 'Translator arrangements', value: body.translatorArrangements }
                    ],
                    blocks: [
                        { heading: 'Parent goals for their child', text: body.parentGoals },
                        { heading: 'Parent concerns', text: body.parentConcerns },
                        { heading: 'Child strengths', text: body.childStrengths },
                        { heading: 'Notes', text: body.notes }
                    ]
                });
                refreshActiveView();
                if (sigProblems.length) {
                    alert('The interview was saved, but the signed copy was not filed:\n\n' + sigProblems.join('\n'));
                }
                document.getElementById('piSavedBadge').style.display = 'inline-flex';
                setTimeout(function () { document.getElementById('piSavedBadge').style.display = 'none'; }, 3000);
            } else {
                alert('Save failed: ' + (data.error || 'Unknown error'));
            }
        } catch (e) {
            alert('Save failed: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save Interview';
        }
    }

    function printInterview() {
        document.getElementById('piOverlay').setAttribute('data-printing', '1');
        window.print();
        document.getElementById('piOverlay').removeAttribute('data-printing');
    }

    // ── Permission Slip ──────────────────────────────────────────────────────
    var currentPSStudentId = null;

    async function openPermissionSlip(studentId) {
        currentPSStudentId = studentId;
        var student = students().find(function (s) { return String(s.Id) === String(studentId); });
        if (!student) return;
        var teacher = getTeacher(student.RoomNumber);
        var schoolYear = year();

        var today = new Date().toISOString().split('T')[0];

        document.getElementById('psModalTitle').textContent = 'Permission Slip \u2013 ' + student.First_Name + ' ' + student.Last_Name;

        document.getElementById('psParentName').value = '';
        document.getElementById('psSchoolYear').value = schoolYear;
        // Every date on the slip defaults to today, since it is normally signed the
        // day it is filled out — staff can change any of them if that is not so
        // (e.g. filling it out after the fact, or a different pickup date).
        document.getElementById('psDate').value = today;
        document.getElementById('psTeacher').value = teacher;
        document.getElementById('psParentSig').value = '';
        document.getElementById('psParentSigDate').value = today;
        document.getElementById('psTeacherSig').value = '';
        document.getElementById('psTeacherSigDate').value = today;
        document.getElementById('psSavedBadge').style.display = 'none';

        sigPads = {};
        mountSigPad('psParentSigPad', studentId, 'PermissionSlip', 'parent',
            { label: 'Parent/Guardian signature', printedName: 'psParentSig', dateField: 'psParentSigDate' });
        mountSigPad('psTeacherSigPad', studentId, 'PermissionSlip', 'staff',
            { label: 'Teacher signature', printedName: 'psTeacherSig', dateField: 'psTeacherSigDate' });

        var hasSavedSlip = false;
        try {
            var res = await apiFetch(yearQS('/api/permission-slip/' + studentId));
            var data = await res.json();
            if (data && data.Id) {
                hasSavedSlip = true;
                document.getElementById('psParentName').value = data.ParentName || '';
                document.getElementById('psSchoolYear').value = data.SchoolYear || schoolYear;
                document.getElementById('psDate').value = data.SignedDate || today;
                document.getElementById('psTeacher').value = data.Teacher || teacher;
                document.getElementById('psParentSig').value = data.ParentSignature || '';
                document.getElementById('psParentSigDate').value = data.ParentSigDate || today;
                document.getElementById('psTeacherSig').value = data.TeacherSignature || '';
                document.getElementById('psTeacherSigDate').value = data.TeacherSigDate || today;
            }
        } catch (e) { console.error('Failed to load permission slip', e); }

        // Autofill the parent's name from the pre-enrollment record, but only when
        // there is no saved slip yet (a saved ParentName, even blank-on-purpose,
        // is left alone) and the field is still empty. Whoever is actually doing
        // pickup can always type over it — this just saves typing the common case.
        if (!hasSavedSlip && !document.getElementById('psParentName').value) {
            try {
                var pres = await apiFetch('/api/student-parent-name/' + studentId);
                var pdata = await pres.json();
                if (pdata && pdata.parentName && !document.getElementById('psParentName').value) {
                    document.getElementById('psParentName').value = pdata.parentName;
                }
            } catch (e) { /* no name on file — leave blank for staff to type */ }
        }

        document.getElementById('psOverlay').classList.add('open');
        refreshSigPads();
    }

    function closePermissionSlip() {
        document.getElementById('psOverlay').classList.remove('open');
        currentPSStudentId = null;
    }

    async function savePermissionSlip() {
        if (!currentPSStudentId) return;
        var btn = document.getElementById('psSaveBtn');
        btn.disabled = true;
        btn.textContent = 'Saving...';
        var body = {
            parentName: document.getElementById('psParentName').value,
            schoolYear: document.getElementById('psSchoolYear').value,
            signedDate: document.getElementById('psDate').value,
            teacher: document.getElementById('psTeacher').value,
            parentSignature: document.getElementById('psParentSig').value,
            parentSigDate: document.getElementById('psParentSigDate').value,
            teacherSignature: document.getElementById('psTeacherSig').value,
            teacherSigDate: document.getElementById('psTeacherSigDate').value
        };
        try {
            var res = await apiFetch('/api/permission-slip/' + currentPSStudentId, {
                method: 'POST', body: JSON.stringify(body)
            });
            var data = await res.json();
            if (data.success) {
                var t = tracking();
                if (!t[currentPSStudentId]) t[currentPSStudentId] = {};
                t[currentPSStudentId].PermissionSlip = 1;
                ChildForms().mark(currentPSStudentId, 'PermissionSlip', body.signedDate);
                var psStudent = students().find(function (s) { return String(s.Id) === String(currentPSStudentId); });
                var sigProblems = await fileSignedForm(currentPSStudentId, 'PermissionSlip', {
                    formTitle: 'Permission for Developmental Screening',
                    rows: [
                        { label: 'Child', value: psStudent ? psStudent.Last_Name + ', ' + psStudent.First_Name : '' },
                        { label: 'Date of birth', value: psStudent ? (psStudent.Birth_date || '') : '' },
                        { label: 'Parent/Guardian', value: body.parentName },
                        { label: 'School year', value: body.schoolYear },
                        { label: 'Teacher', value: body.teacher },
                        { label: 'Date', value: body.signedDate }
                    ],
                    blocks: [
                        { heading: 'Permission granted', text: 'I give permission for the ASQ-3 '
                            + 'developmental screening and the ASQ:SE-2 social-emotional screening to be '
                            + 'completed for my child during the school year shown above. I understand '
                            + 'that the results will be shared with me, and that a referral for further '
                            + 'evaluation may be recommended if a concern is identified.' }
                    ]
                });
                refreshActiveView();
                if (sigProblems.length) {
                    alert('The permission slip was saved, but the signed copy was not filed:\n\n' + sigProblems.join('\n'));
                }
                document.getElementById('psSavedBadge').style.display = 'inline-flex';
                setTimeout(function () { document.getElementById('psSavedBadge').style.display = 'none'; }, 3000);
            } else {
                alert('Save failed: ' + (data.error || 'Unknown error'));
            }
        } catch (e) {
            alert('Save failed: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save Permission Slip';
        }
    }

    // ── Screening Results Shared with Parent (PICC PI10.H) ────────────────────
    var currentRSStudentId = null;

    async function openResultsShared(studentId) {
        currentRSStudentId = studentId;
        var student = students().find(function (s) { return String(s.Id) === String(studentId); });
        if (!student) return;
        var today = new Date().toISOString().split('T')[0];

        document.getElementById('rsModalTitle').textContent = 'Screening Results Shared \u2013 ' + student.First_Name + ' ' + student.Last_Name;
        document.getElementById('rsChildName').textContent = student.First_Name + ' ' + student.Last_Name;
        document.getElementById('rsDOB').textContent = student.Birth_date || '\u2014';
        document.getElementById('rsRoom').textContent = getRoom(student.RoomNumber) || '\u2014';

        // Reset fields.
        ['rsToolUsed','rsToolOther','rsScreeningDate','rsScreenerName','rsResultsSummary',
         'rsSharedWith','rsSharedMethod','rsEvidence','rsParentResponse','rsConcern','rsReferral',
         'rsFollowUp','rsParentSig','rsParentSigDate','rsStaffSig','rsStaffSigDate']
            .forEach(function (id) { var el = document.getElementById(id); if (el) el.value = ''; });
        document.getElementById('rsSharedDate').value = today;
        document.getElementById('rsSavedBadge').style.display = 'none';

        sigPads = {};
        mountSigPad('rsParentSigPad', studentId, 'ScreeningResultsShared', 'parent',
            { label: 'Parent/Guardian signature', printedName: 'rsParentSig', dateField: 'rsParentSigDate' });
        mountSigPad('rsStaffSigPad', studentId, 'ScreeningResultsShared', 'staff',
            { label: 'Staff signature', printedName: 'rsStaffSig', dateField: 'rsStaffSigDate' });

        // Load an existing record so re-opening shows what was captured.
        try {
            var res = await apiFetch(yearQS('/api/pi-doc/screening-results-shared/' + studentId));
            var data = await res.json();
            if (data && data.Id) {
                var set = function (id, v) { var el = document.getElementById(id); if (el && v != null) el.value = v; };
                set('rsToolUsed', data.ToolUsed); set('rsToolOther', data.ToolOther);
                set('rsScreeningDate', data.ScreeningDate); set('rsScreenerName', data.ScreenerName);
                set('rsResultsSummary', data.ResultsSummary); set('rsSharedDate', data.SharedDate);
                set('rsSharedWith', data.SharedWith); set('rsSharedMethod', data.SharedMethod);
                set('rsEvidence', data.EvidenceOfSharing); set('rsParentResponse', data.ParentResponse);
                set('rsConcern', data.ConcernIdentified); set('rsReferral', data.ReferralMade);
                set('rsFollowUp', data.FollowUpNotes);
                set('rsParentSig', data.ParentSignature); set('rsStaffSig', data.StaffSignature);
                set('rsParentSigDate', data.SignedDate); set('rsStaffSigDate', data.SignedDate);
            }
        } catch (e) { console.error('Failed to load results-shared record', e); }

        document.getElementById('rsOverlay').classList.add('open');
        refreshSigPads();
    }

    function closeResultsShared() {
        document.getElementById('rsOverlay').classList.remove('open');
        currentRSStudentId = null;
    }

    async function saveResultsShared() {
        if (!currentRSStudentId) return;
        var btn = document.getElementById('rsSaveBtn');
        btn.disabled = true;
        btn.textContent = 'Saving...';
        var val = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
        // Field keys must match the server PI_DOC_FORMS['screening-results-shared'] columns.
        var body = {
            year: year(),
            toolUsed: val('rsToolUsed'), toolOther: val('rsToolOther'),
            screeningDate: val('rsScreeningDate'), screenerName: val('rsScreenerName'),
            resultsSummary: val('rsResultsSummary'), sharedDate: val('rsSharedDate'),
            sharedWith: val('rsSharedWith'), sharedMethod: val('rsSharedMethod'),
            evidenceOfSharing: val('rsEvidence'), parentResponse: val('rsParentResponse'),
            concernIdentified: val('rsConcern'), referralMade: val('rsReferral'),
            followUpNotes: val('rsFollowUp'),
            parentSignature: val('rsParentSig'), staffSignature: val('rsStaffSig'),
            signedDate: val('rsStaffSigDate') || val('rsParentSigDate')
        };
        try {
            // 1. Store the structured record (also ticks the ScreeningResultsShared column,
            //    which is what lights the roster pill and the chip via /api/child-forms).
            var res = await apiFetch('/api/pi-doc/screening-results-shared/' + currentRSStudentId, {
                method: 'POST', body: JSON.stringify(body)
            });
            var data = await res.json();
            if (!data.success) { alert('Save failed: ' + (data.error || 'Unknown error')); return; }

            var t = tracking();
            if (!t[currentRSStudentId]) t[currentRSStudentId] = {};
            t[currentRSStudentId].ScreeningResultsShared = 1;
            ChildForms().mark(currentRSStudentId, 'ScreeningResultsShared', body.sharedDate);

            // 2. File the signed PDF into the child's Teacher folder (if signed).
            var st = students().find(function (s) { return String(s.Id) === String(currentRSStudentId); });
            var sigProblems = await fileSignedForm(currentRSStudentId, 'ScreeningResultsShared', {
                formTitle: 'Screening Results Shared with Parent',
                rows: [
                    { label: 'Child', value: st ? st.Last_Name + ', ' + st.First_Name : '' },
                    { label: 'Date of birth', value: st ? (st.Birth_date || '') : '' },
                    { label: 'Tool used', value: body.toolUsed === 'Other' ? body.toolOther : body.toolUsed },
                    { label: 'Date screened', value: body.screeningDate },
                    { label: 'Screener', value: body.screenerName },
                    { label: 'Date shared', value: body.sharedDate },
                    { label: 'Shared with', value: body.sharedWith },
                    { label: 'How shared', value: body.sharedMethod }
                ],
                blocks: [
                    { heading: 'Results summary', text: body.resultsSummary || '\u2014' },
                    { heading: 'Evidence the results were shared', text: body.evidenceOfSharing || '\u2014' },
                    { heading: 'Parent response', text: body.parentResponse || '\u2014' },
                    { heading: 'Follow-up',
                      text: 'Concern identified: ' + (body.concernIdentified || '\u2014')
                          + '\nReferred for further evaluation: ' + (body.referralMade || '\u2014')
                          + (body.followUpNotes ? '\n' + body.followUpNotes : '') }
                ]
            });
            refreshActiveView();
            if (sigProblems.length) {
                alert('The record was saved, but the signed copy was not filed:\n\n' + sigProblems.join('\n'));
            }
            document.getElementById('rsSavedBadge').style.display = 'inline-flex';
            setTimeout(function () { document.getElementById('rsSavedBadge').style.display = 'none'; }, 3000);
        } catch (e) {
            alert('Save failed: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save Record';
        }
    }

    function printResultsShared() {
        document.getElementById('rsOverlay').setAttribute('data-printing', '1');
        window.print();
        document.getElementById('rsOverlay').removeAttribute('data-printing');
    }

    // ── Screening (ASQ-3 / ASQ:SE-2) ─────────────────────────────────────────
    var currentScrStudentId = null;
    var currentScrType = '';
    var currentScrPeriod = '';

    async function openScreening(studentId, type, period) {
        currentScrStudentId = studentId;
        currentScrType = type;
        currentScrPeriod = period;
        var student = students().find(function (s) { return String(s.Id) === String(studentId); });
        if (!student) return;

        document.getElementById('scrModalTitle').textContent = type + ' Score Entry \u2013 ' + period + ' of Year';
        document.getElementById('scrChildName').textContent = student.First_Name + ' ' + student.Last_Name;
        document.getElementById('scrDOB').textContent = student.Birth_date || '\u2014';
        document.getElementById('scrAge').textContent = calcAgeMonths(student.Birth_date) || '\u2014';
        document.getElementById('scrType').textContent = type;
        document.getElementById('scrPeriod').textContent = period + ' of Year';

        document.getElementById('scrASQDomains').style.display = type === 'ASQ-3' ? 'block' : 'none';
        document.getElementById('scrASEDomains').style.display = type === 'ASQ:SE-2' ? 'block' : 'none';

        document.getElementById('scrComm').value = '';
        document.getElementById('scrCommStatus').value = 'Above';
        document.getElementById('scrGross').value = '';
        document.getElementById('scrGrossStatus').value = 'Above';
        document.getElementById('scrFine').value = '';
        document.getElementById('scrFineStatus').value = 'Above';
        document.getElementById('scrProblem').value = '';
        document.getElementById('scrProblemStatus').value = 'Above';
        document.getElementById('scrPersonal').value = '';
        document.getElementById('scrPersonalStatus').value = 'Above';
        document.getElementById('scrSETotal').value = '';
        document.getElementById('scrSECutoff').value = '';
        document.getElementById('scrSEResult').value = 'Below';
        document.getElementById('scrDate').value = new Date().toISOString().split('T')[0];
        document.getElementById('scrCompletedBy').value = 'Parent';
        document.getElementById('scrInterval').value = '';
        document.getElementById('scrReferral').value = 'No';
        document.getElementById('scrNotes').value = '';
        document.getElementById('scrSavedBadge').style.display = 'none';

        // The checklist column this screening belongs to (BegASQ / EndASE / …).
        var scrField = screeningField(type, period);

        // Signature pads for the scored summary, same pattern as the other forms.
        sigPads = {};
        mountSigPad('scrParentSigPad', studentId, scrField, 'parent',
            { label: 'Parent/Guardian signature', printedName: 'scrParentSig', dateField: 'scrDate' });
        mountSigPad('scrStaffSigPad', studentId, scrField, 'staff',
            { label: 'Staff signature', printedName: 'scrStaffSig', dateField: 'scrDate' });

        // Reset and reflect the parent-questionnaire upload slot.
        var qFile = document.getElementById('scrQuestFile');
        if (qFile) qFile.value = '';
        var existingQ = ChildForms().fileFor(studentId, scrField, 'questionnaire');
        setUploadStatus('scrQuestStatus', existingQ
            ? { on: true, name: existingQ.name, relPath: existingQ.relPath }
            : null, 'No questionnaire on file yet.');

        try {
            var res = await apiFetch(yearQS('/api/screening/' + studentId + '?type=' + encodeURIComponent(type) + '&period=' + encodeURIComponent(period)));
            var data = await res.json();
            if (data && data.Id) {
                if (type === 'ASQ-3') {
                    document.getElementById('scrComm').value = data.CommScore || '';
                    document.getElementById('scrCommStatus').value = data.CommStatus || 'Above';
                    document.getElementById('scrGross').value = data.GrossScore || '';
                    document.getElementById('scrGrossStatus').value = data.GrossStatus || 'Above';
                    document.getElementById('scrFine').value = data.FineScore || '';
                    document.getElementById('scrFineStatus').value = data.FineStatus || 'Above';
                    document.getElementById('scrProblem').value = data.ProblemScore || '';
                    document.getElementById('scrProblemStatus').value = data.ProblemStatus || 'Above';
                    document.getElementById('scrPersonal').value = data.PersonalScore || '';
                    document.getElementById('scrPersonalStatus').value = data.PersonalStatus || 'Above';
                } else {
                    document.getElementById('scrSETotal').value = data.SETotal || '';
                    document.getElementById('scrSECutoff').value = data.SECutoff || '';
                    document.getElementById('scrSEResult').value = data.SEResult || 'Below';
                }
                document.getElementById('scrDate').value = data.ScreeningDate || '';
                document.getElementById('scrCompletedBy').value = data.CompletedBy || 'Parent';
                document.getElementById('scrInterval').value = data.Interval || '';
                document.getElementById('scrReferral').value = data.ReferralMade || 'No';
                document.getElementById('scrNotes').value = data.Notes || '';
            }
        } catch (e) { console.error('Failed to load screening', e); }

        document.getElementById('scrOverlay').classList.add('open');
        refreshSigPads();
    }

    function closeScreening() {
        document.getElementById('scrOverlay').classList.remove('open');
        currentScrStudentId = null;
    }

    async function saveScreening() {
        if (!currentScrStudentId) return;
        var btn = document.getElementById('scrSaveBtn');
        btn.disabled = true;
        btn.textContent = 'Saving...';
        var body = {
            type: currentScrType,
            period: currentScrPeriod,
            year: year(),
            screeningDate: document.getElementById('scrDate').value,
            completedBy: document.getElementById('scrCompletedBy').value,
            interval: document.getElementById('scrInterval').value,
            referralMade: document.getElementById('scrReferral').value,
            notes: document.getElementById('scrNotes').value
        };
        if (currentScrType === 'ASQ-3') {
            body.commScore = document.getElementById('scrComm').value;
            body.commStatus = document.getElementById('scrCommStatus').value;
            body.grossScore = document.getElementById('scrGross').value;
            body.grossStatus = document.getElementById('scrGrossStatus').value;
            body.fineScore = document.getElementById('scrFine').value;
            body.fineStatus = document.getElementById('scrFineStatus').value;
            body.problemScore = document.getElementById('scrProblem').value;
            body.problemStatus = document.getElementById('scrProblemStatus').value;
            body.personalScore = document.getElementById('scrPersonal').value;
            body.personalStatus = document.getElementById('scrPersonalStatus').value;
        } else {
            body.seTotal = document.getElementById('scrSETotal').value;
            body.seCutoff = document.getElementById('scrSECutoff').value;
            body.seResult = document.getElementById('scrSEResult').value;
        }
        try {
            var res = await apiFetch('/api/screening/' + currentScrStudentId, {
                method: 'POST', body: JSON.stringify(body)
            });
            var data = await res.json();
            if (data.success) {
                var fieldName = '';
                if (currentScrType === 'ASQ-3' && currentScrPeriod === 'Beginning') fieldName = 'BegASQ';
                else if (currentScrType === 'ASQ-3' && currentScrPeriod === 'End') fieldName = 'EndASQ';
                else if (currentScrType === 'ASQ:SE-2' && currentScrPeriod === 'Beginning') fieldName = 'BegASE';
                else if (currentScrType === 'ASQ:SE-2' && currentScrPeriod === 'End') fieldName = 'EndASE';
                var t = tracking();
                if (fieldName) {
                    if (!t[currentScrStudentId]) t[currentScrStudentId] = {};
                    t[currentScrStudentId][fieldName] = 1;
                    ChildForms().mark(currentScrStudentId, fieldName, body.screeningDate);
                }
                var scr = screening();
                if (!scr[currentScrStudentId]) scr[currentScrStudentId] = {};
                scr[currentScrStudentId][currentScrType + '|' + currentScrPeriod] = {
                    StudentId: String(currentScrStudentId),
                    ScreeningType: currentScrType,
                    Period: currentScrPeriod,
                    ScreeningDate: body.screeningDate,
                    ReferralMade: body.referralMade,
                    Flag: computeScreeningFlag(currentScrType, body)
                };

                /* If anything was signed, file the scored summary as a PDF into the
                   child's folder — the same route the other forms use. Re-signing
                   later files a fresh copy, so the scores stay editable in the app. */
                var sigProblems = await fileSignedForm(currentScrStudentId, fieldName,
                    buildScreeningContent(body));
                if (sigProblems.length) {
                    alert('The scores were saved, but the signed copy was not filed:\n\n'
                        + sigProblems.join('\n'));
                }

                refreshActiveView();
                document.getElementById('scrSavedBadge').style.display = 'inline-flex';
                setTimeout(function () { document.getElementById('scrSavedBadge').style.display = 'none'; }, 3000);
            } else {
                alert('Save failed: ' + (data.error || 'Unknown error'));
            }
        } catch (e) {
            alert('Save failed: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save Screening';
        }
    }

    /* The scored summary, as label/value rows for the filed PDF. Reads the live
       fields so it matches exactly what the teacher entered and signed. */
    function buildScreeningContent(body) {
        var student = students().find(function (s) { return String(s.Id) === String(currentScrStudentId); });
        var rows = [
            { label: 'Child', value: student ? student.First_Name + ' ' + student.Last_Name : '' },
            { label: 'Screening', value: currentScrType + ' \u2014 ' + currentScrPeriod + ' of year' },
            { label: 'Date administered', value: body.screeningDate || '' },
            { label: 'Completed by', value: body.completedBy || '' },
            { label: 'Questionnaire interval', value: body.interval || '' }
        ];
        if (currentScrType === 'ASQ-3') {
            rows.push({ label: 'Communication', value: (body.commScore || '\u2014') + '  (' + body.commStatus + ')' });
            rows.push({ label: 'Gross motor', value: (body.grossScore || '\u2014') + '  (' + body.grossStatus + ')' });
            rows.push({ label: 'Fine motor', value: (body.fineScore || '\u2014') + '  (' + body.fineStatus + ')' });
            rows.push({ label: 'Problem solving', value: (body.problemScore || '\u2014') + '  (' + body.problemStatus + ')' });
            rows.push({ label: 'Personal-social', value: (body.personalScore || '\u2014') + '  (' + body.personalStatus + ')' });
        } else {
            rows.push({ label: 'Total score', value: body.seTotal || '\u2014' });
            rows.push({ label: 'Cutoff', value: body.seCutoff || '\u2014' });
            rows.push({ label: 'Result', value: body.seResult || '' });
        }
        rows.push({ label: 'Referral made', value: body.referralMade || 'No' });
        var blocks = body.notes ? [{ heading: 'Notes / Follow-up', text: body.notes }] : [];
        return {
            formTitle: currentScrType + ' ' + currentScrPeriod + '-of-Year Scored Summary',
            rows: rows, blocks: blocks
        };
    }

    /* Attach the parent's completed questionnaire for the screening currently open.
       Files into the child's folder and marks the cell so it turns green without a
       reload. This is one of the two artefacts a screening needs; the other is the
       scored, signed summary above. */
    async function uploadScreeningQuestionnaire() {
        if (!currentScrStudentId) return;
        var field = screeningField(currentScrType, currentScrPeriod);
        var input = document.getElementById('scrQuestFile');
        var statusEl = document.getElementById('scrQuestStatus');
        if (!input || !input.files || !input.files.length) {
            if (statusEl) { statusEl.textContent = 'Choose a file first.'; statusEl.style.color = '#b91c1c'; }
            return;
        }
        var file = input.files[0];
        if (file.size > 15 * 1024 * 1024) {
            if (statusEl) { statusEl.textContent = 'That is over 15 MB. A PDF scan is usually much smaller.'; statusEl.style.color = '#b91c1c'; }
            return;
        }
        var btn = document.getElementById('scrQuestBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Uploading\u2026'; }
        if (statusEl) { statusEl.textContent = 'Uploading\u2026'; statusEl.style.color = '#64748b'; }
        try {
            var d = await uploadChildFile(currentScrStudentId, field, 'questionnaire', file);
            ChildForms().markFile(currentScrStudentId, field, 'questionnaire', d.relPath, d.name);
            setUploadStatus('scrQuestStatus', { on: true, name: d.name, relPath: d.relPath }, '');
            refreshActiveView();
        } catch (e) {
            if (statusEl) { statusEl.textContent = '\u26a0 ' + e.message; statusEl.style.color = '#b91c1c'; }
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Upload questionnaire'; }
        }
    }

    function printScreening() {
        document.getElementById('scrOverlay').setAttribute('data-printing', '1');
        window.print();
        document.getElementById('scrOverlay').removeAttribute('data-printing');
    }

    // ── Report card uploads (Mid-Year / End-Year) ─────────────────────────────
    var currentRCStudentId = null;
    var currentRCField = null;
    var RC_LABELS = { MidYearReport: 'Mid-Year Report Card', EndYearReport: 'End-Year Report Card' };

    function openReportUpload(studentId, field) {
        currentRCStudentId = studentId;
        currentRCField = field;
        var student = students().find(function (s) { return String(s.Id) === String(studentId); });
        var label = RC_LABELS[field] || 'Report Card';
        document.getElementById('rcModalTitle').textContent = label;
        document.getElementById('rcWhich').textContent = label;
        document.getElementById('rcChildName').textContent =
            student ? student.First_Name + ' ' + student.Last_Name : '';
        var f = document.getElementById('rcFile');
        if (f) f.value = '';
        var existing = ChildForms().fileFor(studentId, field, 'report');
        setUploadStatus('rcStatus', existing
            ? { on: true, name: existing.name, relPath: existing.relPath }
            : null, 'No report card on file yet.');
        document.getElementById('rcOverlay').classList.add('open');
    }

    function closeReportUpload() {
        document.getElementById('rcOverlay').classList.remove('open');
        currentRCStudentId = null;
        currentRCField = null;
    }

    async function uploadReportCard() {
        if (!currentRCStudentId || !currentRCField) return;
        var input = document.getElementById('rcFile');
        var statusEl = document.getElementById('rcStatus');
        if (!input || !input.files || !input.files.length) {
            if (statusEl) { statusEl.textContent = 'Choose a file first.'; statusEl.style.color = '#b91c1c'; }
            return;
        }
        var file = input.files[0];
        if (file.size > 15 * 1024 * 1024) {
            if (statusEl) { statusEl.textContent = 'That is over 15 MB. A PDF is usually much smaller.'; statusEl.style.color = '#b91c1c'; }
            return;
        }
        var btn = document.getElementById('rcBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Uploading\u2026'; }
        if (statusEl) { statusEl.textContent = 'Uploading\u2026'; statusEl.style.color = '#64748b'; }
        try {
            var d = await uploadChildFile(currentRCStudentId, currentRCField, 'report', file);
            ChildForms().markFile(currentRCStudentId, currentRCField, 'report', d.relPath, d.name);
            // A report-card upload ticks the column server-side; mirror that locally.
            var t = tracking();
            if (!t[currentRCStudentId]) t[currentRCStudentId] = {};
            t[currentRCStudentId][currentRCField] = 1;
            setUploadStatus('rcStatus', { on: true, name: d.name, relPath: d.relPath }, '');
            refreshActiveView();
        } catch (e) {
            if (statusEl) { statusEl.textContent = '\u26a0 ' + e.message; statusEl.style.color = '#b91c1c'; }
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Upload report card'; }
        }
    }

    // ── Print All (one job, one form per page) ────────────────────────────────
    function serializeModalForPrint(modalEl) {
        var clone = modalEl.cloneNode(true);
        clone.querySelectorAll('.pi-modal-footer, .pi-close').forEach(function (el) { el.remove(); });
        var liveControls = modalEl.querySelectorAll('input, textarea, select');
        var cloneControls = clone.querySelectorAll('input, textarea, select');
        cloneControls.forEach(function (cEl, i) {
            var live = liveControls[i];
            var val = '';
            if (live) {
                if (live.tagName === 'SELECT') {
                    val = live.options[live.selectedIndex] ? live.options[live.selectedIndex].text : '';
                    if (!live.value) val = '';
                } else if (live.type === 'checkbox' || live.type === 'radio') {
                    val = live.checked ? '\u2611' : '\u2610';
                } else {
                    val = live.value || '';
                }
            }
            var span = document.createElement('span');
            span.className = 'print-value';
            span.textContent = val;
            cEl.replaceWith(span);
        });
        return clone.outerHTML;
    }

    async function printAllForColumn(field) {
        // Scope follows the caller. The classroom host provides classroomRoster();
        // the ISBE roster host provides the active program instead.
        var roster;
        var custom = rosterForPrint();
        if (custom) {
            roster = custom;
        } else {
            var prog = activeProgram();
            roster = students().filter(function (s) {
                return s.PFA_PI_na === prog && (s.Active === 'Yes' || s.Active === 'YES');
            }).sort(sortByRoomThenName);
        }
        var t = tracking();
        var unchecked = roster.filter(function (s) { return !(t[s.Id] || {})[field]; });
        if (!unchecked.length) { alert('All forms in this column are already completed!'); return; }

        var count = unchecked.length;
        if (!confirm('This will build a single print preview with ' + count + ' form(s) \u2014 one per page \u2014 for all unchecked students in this column.\n\nContinue?')) return;

        var openFn, overlayId, closeFn;
        if (field === 'PermissionSlip') {
            openFn = function (id) { return openPermissionSlip(id); }; overlayId = 'psOverlay'; closeFn = closePermissionSlip;
        } else if (field === 'ParentInterview') {
            openFn = function (id) { return openInterview(id); }; overlayId = 'piOverlay'; closeFn = closeInterview;
        } else if (field === 'BegASQ' || field === 'EndASQ') {
            var period1 = field === 'BegASQ' ? 'Beginning' : 'End';
            openFn = function (id) { return openScreening(id, 'ASQ-3', period1); }; overlayId = 'scrOverlay'; closeFn = closeScreening;
        } else if (field === 'BegASE' || field === 'EndASE') {
            var period2 = field === 'BegASE' ? 'Beginning' : 'End';
            openFn = function (id) { return openScreening(id, 'ASQ:SE-2', period2); }; overlayId = 'scrOverlay'; closeFn = closeScreening;
        } else {
            alert('This column does not support Print All.');
            return;
        }

        var overlay = document.getElementById(overlayId);
        var modalEl = overlay.querySelector('.pi-modal');
        var pages = [];
        for (var i = 0; i < unchecked.length; i++) {
            await openFn(unchecked[i].Id);
            pages.push(serializeModalForPrint(modalEl));
        }
        closeFn();

        var container = document.getElementById('printAllContainer');
        container.innerHTML = pages.map(function (html) { return '<div class="print-page">' + html + '</div>'; }).join('');
        container.setAttribute('data-printing', '1');
        window.print();
        container.removeAttribute('data-printing');
        container.innerHTML = '';
    }

    // ── Markup + CSS injection ────────────────────────────────────────────────
    // Both host pages get identical modals and styles from here, so neither HTML
    // file carries its own copy. If a page already defines #piOverlay (isbe.html
    // still ships the markup inline for now), injection is skipped so we never
    // duplicate the ids.
    var MODAL_HTML = [
        '<div class="pi-overlay" id="piOverlay"><div class="pi-modal">',
        '<div class="pi-modal-header"><h3 id="piModalTitle">Parent Interview Form</h3>',
        '<button class="pi-close" onclick="CofpForms.closeInterview()" aria-label="Close">&times;</button></div>',
        '<div class="pi-modal-body">',
        '<div class="pi-section"><h4>Child Information</h4><div class="pi-grid three">',
        '<div class="pi-field"><label>Child Name</label><div class="pi-value" id="piChildName"></div></div>',
        '<div class="pi-field"><label>Date of Birth</label><div class="pi-value" id="piDOB"></div></div>',
        '<div class="pi-field"><label>Classroom</label><div class="pi-value" id="piRoom"></div></div></div></div>',
        '<div class="pi-section"><h4>Household Information</h4><div class="pi-grid">',
        '<div class="pi-field"><label>Household Income</label><div class="pi-value" id="piIncome"></div></div>',
        '<div class="pi-field"><label>Household Size</label><div class="pi-value" id="piHHSize"></div></div>',
        '<div class="pi-field"><label>Public Benefits</label><div class="pi-value" id="piBenefits"></div></div>',
        '<div class="pi-field"><label>F/R/P Status</label><div class="pi-value" id="piFRP"></div></div>',
        '<div class="pi-field"><label>IEP</label><div class="pi-value" id="piIEP"></div></div>',
        '<div class="pi-field"><label>Foster Care</label><div class="pi-value" id="piFoster"></div></div>',
        '<div class="pi-field"><label>Military</label><div class="pi-value" id="piMilitary"></div></div>',
        '<div class="pi-field"><label>Category</label><div class="pi-value" id="piCategory"></div></div></div></div>',
        '<div class="pi-section" id="piIntakeSection"><h4>From Pre-Enrollment Intake <span id="piIntakeMeta" style="font-weight:400;text-transform:none;letter-spacing:0;color:#9ca3af;font-size:0.7rem;"></span></h4><div id="piIntakeBody"></div></div>',
        '<div class="pi-section"><h4>Interview Details</h4><div class="pi-grid">',
        '<div class="pi-field"><label>Interview Date</label><input type="date" id="piDate"></div>',
        '<div class="pi-field"></div>',
        '<div class="pi-field pi-full"><label>Parent Goals for Child</label><textarea id="piGoals" placeholder="What goals do the parents have for their child this year?"></textarea></div>',
        '<div class="pi-field pi-full"><label>Parent Concerns</label><textarea id="piConcerns" placeholder="Are there any concerns the parents would like to discuss?"></textarea></div>',
        '<div class="pi-field pi-full"><label>Child Strengths</label><textarea id="piStrengths" placeholder="What strengths does the child demonstrate at home?"></textarea></div>',
        '<div class="pi-field pi-full"><label>Additional Notes</label><textarea id="piNotes" placeholder="Any additional notes from the interview..."></textarea></div></div></div>',
        '<div class="pi-section"><h4>Language &amp; Translation</h4>',
        '<div class="doc-note">PICC PI5.L requires the preferred language to be identified here, and PI5.M requires the translator arrangements to be recorded. Neither may be left blank &mdash; if no translator was needed, say so.</div>',
        '<div class="pi-grid"><div class="pi-field"><label>Preferred Language</label><input type="text" id="piPreferredLanguage" placeholder="e.g. English, Spanish"></div>',
        '<div class="pi-field"><label>Translator Needed for the Interview</label><select id="piTranslatorNeeded"><option value="">&mdash; select &mdash;</option><option value="No">No &ndash; interview conducted in the family\'s preferred language</option><option value="Yes">Yes</option></select></div>',
        '<div class="pi-field pi-full"><label>Translator Arrangements / Accommodations Provided</label><textarea id="piTranslatorArrangements" placeholder="Who translated and how it was arranged, or state that none was needed and why."></textarea></div></div></div>',
        '<div class="pi-section"><h4>Signatures</h4><div class="pi-grid">',
        '<div class="pi-field pi-full"><label>Parent/Guardian Signature</label><div id="piParentSigPad"></div><input type="text" id="piParentSig" placeholder="Printed name" style="margin-top:7px;"></div>',
        '<div class="pi-field pi-full"><label>Staff Signature</label><div id="piStaffSigPad"></div><input type="text" id="piStaffSig" placeholder="Printed name" style="margin-top:7px;"></div></div></div>',
        '</div>',
        '<div class="pi-modal-footer"><span class="pi-saved-badge" id="piSavedBadge" style="display:none;">&#10003; Saved</span>',
        '<button class="pi-btn pi-btn-secondary" onclick="CofpForms.printInterview()">&#x1F5A8;&#xFE0F; Print</button>',
        '<button class="pi-btn pi-btn-primary" id="piSaveBtn" onclick="CofpForms.saveInterview()">Save Interview</button></div>',
        '</div></div>',

        '<div class="pi-overlay" id="psOverlay"><div class="pi-modal">',
        '<div class="pi-modal-header"><h3 id="psModalTitle">Permission Slip</h3>',
        '<button class="pi-close" onclick="CofpForms.closePermissionSlip()" aria-label="Close">&times;</button></div>',
        '<div class="pi-modal-body">',
        '<div class="pi-section" style="text-align:center;padding:4px 0 10px;"><h4 style="font-size:1.1rem;font-weight:800;color:#1e3a8a;text-transform:none;letter-spacing:0;border:none;padding:0;margin:0 0 4px;">Children of Promise PFA</h4><div style="font-size:0.95rem;font-weight:700;color:#374151;">Permission to perform screenings</div></div>',
        '<div class="pi-section"><div class="pi-consent">',
        '<div style="font-size:0.92rem;color:#374151;">I, <input type="text" id="psParentName" class="pi-inline" placeholder="parent name"> consent to <input type="text" id="psTeacher" class="pi-inline pi-inline-italic" placeholder="teacher"> conducting screenings on my child for the <input type="text" id="psSchoolYear" class="pi-inline pi-inline-sm" placeholder="year"> school year using Ages and Stages ASQ and ASE screening instruments.</div>',
        '<p style="font-size:0.86rem;line-height:1.5;color:#4b5563;margin:12px 0 0;">Screenings will be performed at the beginning, middle, and end of the school year.</p>',
        '<p style="font-size:0.86rem;line-height:1.5;color:#4b5563;margin:8px 0 0;">Results of the screenings will be shared with the parents along with Teaching Strategies report cards at the middle and end of the school year.</p>',
        '</div></div>',
        '<div class="pi-section" style="margin-top:14px;"><h4>Form Details</h4><div class="pi-grid">',
        '<div class="pi-field"><label>Date Signed</label><input type="date" id="psDate"></div></div></div>',
        /* Side by side, not stacked full-width: the parent and teacher signatures are
           two independent people signing, with nothing that needs to line up between
           them. Stacked, the two 110px signature pads plus their printed-name rows
           push the modal well past a laptop screen's height, forcing an inner scroll
           the moment the modal opens. Side by side halves that section's height. */
        '<div class="pi-section" style="margin-top:20px;"><h4>Signatures</h4><div class="pi-grid">',
        '<div class="pi-field"><label>Parent/Guardian Signature</label><div id="psParentSigPad"></div><div style="display:flex;gap:10px;margin-top:7px;"><input type="text" id="psParentSig" placeholder="Printed name" style="flex:2;"><input type="date" id="psParentSigDate" style="flex:1;" title="Date signed"></div></div>',
        '<div class="pi-field"><label>Teacher Signature</label><div id="psTeacherSigPad"></div><div style="display:flex;gap:10px;margin-top:7px;"><input type="text" id="psTeacherSig" placeholder="Printed name" style="flex:2;"><input type="date" id="psTeacherSigDate" style="flex:1;" title="Date signed"></div></div></div></div>',
        '</div>',
        /* No Print button: this form is sign-and-save only, on screen — no paper
           copy is expected, so nothing to print. */
        '<div class="pi-modal-footer"><span class="pi-saved-badge" id="psSavedBadge" style="display:none;">&#10003; Saved</span>',
        '<button class="pi-btn pi-btn-primary" id="psSaveBtn" onclick="CofpForms.savePermissionSlip()">Save Permission Slip</button></div>',
        '</div></div>',

        // ── Screening Results Shared (PICC PI10.H) ──
        '<div class="pi-overlay" id="rsOverlay"><div class="pi-modal">',
        '<div class="pi-modal-header"><h3 id="rsModalTitle">Screening Results Shared with Parent</h3>',
        '<button class="pi-close" onclick="CofpForms.closeResultsShared()" aria-label="Close">&times;</button></div>',
        '<div class="pi-modal-body">',
        '<div class="pi-section"><h4>Child</h4><div class="pi-grid three">',
        '<div class="pi-field"><label>Child Name</label><div class="pi-value" id="rsChildName"></div></div>',
        '<div class="pi-field"><label>Date of Birth</label><div class="pi-value" id="rsDOB"></div></div>',
        '<div class="pi-field"><label>Classroom</label><div class="pi-value" id="rsRoom"></div></div></div></div>',
        '<div class="pi-section"><h4>Screening</h4><div class="pi-grid">',
        '<div class="pi-field"><label>Research-Based Tool Used</label><select id="rsToolUsed"><option value="">Select</option><option>ASQ-3</option><option>ASQ:SE-2</option><option>ASQ-3 + ASQ:SE-2</option><option value="Other">Other</option></select></div>',
        '<div class="pi-field"><label>If Other, name the tool</label><input type="text" id="rsToolOther"></div>',
        '<div class="pi-field"><label>Date Child Was Screened</label><input type="date" id="rsScreeningDate"></div>',
        '<div class="pi-field"><label>Name of Screener (staff)</label><input type="text" id="rsScreenerName"></div>',
        '<div class="pi-field pi-full"><label>Results Summary</label><textarea id="rsResultsSummary" placeholder="Domains screened and the outcome in each."></textarea></div></div></div>',
        '<div class="pi-section"><h4>Sharing with Parent</h4><div class="pi-grid">',
        '<div class="pi-field"><label>Date Results Were Shared</label><input type="date" id="rsSharedDate"></div>',
        '<div class="pi-field"><label>Shared With (parent/guardian name)</label><input type="text" id="rsSharedWith"></div>',
        '<div class="pi-field"><label>How Results Were Shared</label><select id="rsSharedMethod"><option value="">Select</option><option>In person with report card</option><option>Conference</option><option>Phone</option><option>Sent home</option><option>Email</option><option value="Other">Other</option></select></div>',
        '<div class="pi-field pi-full"><label>Evidence the Results Were Shared</label><textarea id="rsEvidence" placeholder="What was given to or discussed with the parent, and any copy retained in the file."></textarea></div>',
        '<div class="pi-field pi-full"><label>Parent Questions or Response</label><textarea id="rsParentResponse"></textarea></div></div></div>',
        '<div class="pi-section"><h4>Follow-Up</h4>',
        '<div class="doc-note">PI10.I requires a referral for further evaluation when a screening identifies a concern. Record the referral itself on the Referral form.</div>',
        '<div class="pi-grid">',
        '<div class="pi-field"><label>Screening Identified a Concern</label><select id="rsConcern"><option value="">Select</option><option>No</option><option>Yes</option></select></div>',
        '<div class="pi-field"><label>Referred for Further Evaluation</label><select id="rsReferral"><option value="">Select</option><option>N/A</option><option>No</option><option>Yes</option></select></div>',
        '<div class="pi-field pi-full"><label>Follow-Up Notes</label><textarea id="rsFollowUp"></textarea></div></div></div>',
        '<div class="pi-section"><h4>Signatures</h4>',
        '<div class="doc-note">Sign here when the results are shared. Signing files a PDF of this record into the child\u2019s folder; re-signing files a fresh copy and keeps the old one.</div>',
        '<div class="pi-grid">',
        '<div class="pi-field pi-full"><label>Parent/Guardian Signature</label><div id="rsParentSigPad"></div><div style="display:flex;gap:10px;margin-top:7px;"><input type="text" id="rsParentSig" placeholder="Printed name" style="flex:2;"><input type="date" id="rsParentSigDate" style="flex:1;" title="Date signed"></div></div>',
        '<div class="pi-field pi-full"><label>Staff Signature</label><div id="rsStaffSigPad"></div><div style="display:flex;gap:10px;margin-top:7px;"><input type="text" id="rsStaffSig" placeholder="Printed name" style="flex:2;"><input type="date" id="rsStaffSigDate" style="flex:1;" title="Date signed"></div></div></div></div>',
        '</div>',
        '<div class="pi-modal-footer"><span class="pi-saved-badge" id="rsSavedBadge" style="display:none;">&#10003; Saved</span>',
        '<button class="pi-btn pi-btn-secondary" onclick="CofpForms.printResultsShared()">&#x1F5A8;&#xFE0F; Print</button>',
        '<button class="pi-btn pi-btn-primary" id="rsSaveBtn" onclick="CofpForms.saveResultsShared()">Save Record</button></div>',
        '</div></div>',

        '<div class="pi-overlay" id="scrOverlay"><div class="pi-modal">',
        '<div class="pi-modal-header"><h3 id="scrModalTitle">Screening Score Entry</h3>',
        '<button class="pi-close" onclick="CofpForms.closeScreening()" aria-label="Close">&times;</button></div>',
        '<div class="pi-modal-body">',
        '<div class="pi-section"><h4>Student &amp; Screening Info</h4><div class="pi-grid three">',
        '<div class="pi-field"><label>Child Name</label><div class="pi-value" id="scrChildName"></div></div>',
        '<div class="pi-field"><label>Date of Birth</label><div class="pi-value" id="scrDOB"></div></div>',
        '<div class="pi-field"><label>Age at Screening</label><div class="pi-value" id="scrAge"></div></div></div>',
        '<div class="pi-grid" style="margin-top:10px;"><div class="pi-field"><label>Screening Type</label><div class="pi-value" id="scrType"></div></div>',
        '<div class="pi-field"><label>Period</label><div class="pi-value" id="scrPeriod"></div></div></div></div>',
        '<div class="pi-section" id="scrASQDomains"><h4>ASQ-3 Domain Scores</h4>',
        '<p style="font-size:0.72rem;color:#6b7280;margin-bottom:10px;">Enter the score for each domain (0-60). Mark cutoff status based on the scoring guide for the child\'s age interval.</p>',
        '<div class="pi-grid">',
        '<div class="pi-field"><label>Communication</label><input type="number" id="scrComm" min="0" max="60" placeholder="0-60"></div>',
        '<div class="pi-field"><label>Comm. Status</label><select id="scrCommStatus"><option value="Above">Above Cutoff</option><option value="Monitor">Monitoring Zone</option><option value="Below">Below Cutoff</option></select></div>',
        '<div class="pi-field"><label>Gross Motor</label><input type="number" id="scrGross" min="0" max="60" placeholder="0-60"></div>',
        '<div class="pi-field"><label>Gross Motor Status</label><select id="scrGrossStatus"><option value="Above">Above Cutoff</option><option value="Monitor">Monitoring Zone</option><option value="Below">Below Cutoff</option></select></div>',
        '<div class="pi-field"><label>Fine Motor</label><input type="number" id="scrFine" min="0" max="60" placeholder="0-60"></div>',
        '<div class="pi-field"><label>Fine Motor Status</label><select id="scrFineStatus"><option value="Above">Above Cutoff</option><option value="Monitor">Monitoring Zone</option><option value="Below">Below Cutoff</option></select></div>',
        '<div class="pi-field"><label>Problem Solving</label><input type="number" id="scrProblem" min="0" max="60" placeholder="0-60"></div>',
        '<div class="pi-field"><label>Problem Solving Status</label><select id="scrProblemStatus"><option value="Above">Above Cutoff</option><option value="Monitor">Monitoring Zone</option><option value="Below">Below Cutoff</option></select></div>',
        '<div class="pi-field"><label>Personal-Social</label><input type="number" id="scrPersonal" min="0" max="60" placeholder="0-60"></div>',
        '<div class="pi-field"><label>Personal-Social Status</label><select id="scrPersonalStatus"><option value="Above">Above Cutoff</option><option value="Monitor">Monitoring Zone</option><option value="Below">Below Cutoff</option></select></div></div></div>',
        '<div class="pi-section" id="scrASEDomains" style="display:none;"><h4>ASQ:SE-2 Score</h4>',
        '<p style="font-size:0.72rem;color:#6b7280;margin-bottom:10px;">Enter the total score and cutoff comparison for the child\'s age interval.</p>',
        '<div class="pi-grid"><div class="pi-field"><label>Total Score</label><input type="number" id="scrSETotal" min="0" max="999" placeholder="Total score"></div>',
        '<div class="pi-field"><label>Cutoff for Age Interval</label><input type="number" id="scrSECutoff" min="0" max="999" placeholder="Cutoff value"></div>',
        '<div class="pi-field"><label>Result</label><select id="scrSEResult"><option value="Below">Below Cutoff (typical)</option><option value="Monitor">Monitoring Zone</option><option value="Above">Above Cutoff (concern)</option></select></div></div></div>',
        '<div class="pi-section"><h4>Details</h4><div class="pi-grid">',
        '<div class="pi-field"><label>Date Administered</label><input type="date" id="scrDate"></div>',
        '<div class="pi-field"><label>Completed By</label><select id="scrCompletedBy"><option value="Parent">Parent</option><option value="Teacher">Teacher</option><option value="Both">Parent + Teacher</option></select></div>',
        '<div class="pi-field"><label>Questionnaire Interval</label><input type="text" id="scrInterval" placeholder="e.g. 36 month, 48 month"></div>',
        '<div class="pi-field"><label>Referral Made?</label><select id="scrReferral"><option value="No">No</option><option value="Yes">Yes</option></select></div>',
        '<div class="pi-field pi-full"><label>Notes / Follow-up</label><textarea id="scrNotes" placeholder="Any concerns, referral details, follow-up actions..."></textarea></div></div></div>',
        // The parent fills the paper questionnaire; the teacher scores it above. Both
        // are required evidence, so the completed questionnaire is scanned/photographed
        // and attached here. It files straight into the child\u2019s folder.
        '<div class="pi-section"><h4>Parent\u2019s Completed Questionnaire</h4>',
        '<div class="doc-note">The parent\u2019s filled-in Ages &amp; Stages questionnaire is required alongside the scores. Attach a scan or a clear photo (PDF or image). It is filed in the child\u2019s folder.</div>',
        '<div class="cls-upload-row"><input type="file" id="scrQuestFile" accept=".pdf,.jpg,.jpeg,.png">',
        '<button type="button" class="pi-btn pi-btn-secondary" id="scrQuestBtn" onclick="CofpForms.uploadScreeningQuestionnaire()">Upload questionnaire</button>',
        '<span id="scrQuestStatus" class="cls-upload-status"></span></div></div>',
        '<div class="pi-section"><h4>Signatures</h4>',
        '<div class="doc-note">Sign the scored summary here. Signing files a PDF of the scores into the child\u2019s folder; re-signing files a fresh copy and keeps the old one.</div>',
        '<div class="pi-grid">',
        '<div class="pi-field pi-full"><label>Parent/Guardian Signature</label><div id="scrParentSigPad"></div><input type="text" id="scrParentSig" placeholder="Printed name" style="margin-top:7px;"></div>',
        '<div class="pi-field pi-full"><label>Staff Signature</label><div id="scrStaffSigPad"></div><input type="text" id="scrStaffSig" placeholder="Printed name" style="margin-top:7px;"></div></div></div>',
        '</div>',
        '<div class="pi-modal-footer"><span class="pi-saved-badge" id="scrSavedBadge" style="display:none;">&#10003; Saved</span>',
        '<button class="pi-btn pi-btn-secondary" onclick="CofpForms.printScreening()">&#x1F5A8;&#xFE0F; Print</button>',
        '<button class="pi-btn pi-btn-primary" id="scrSaveBtn" onclick="CofpForms.saveScreening()">Save Screening</button></div>',
        '</div></div>',

        // Report cards are not filled in the app — they are produced elsewhere
        // (Teaching Strategies) and uploaded. A small modal keeps that consistent
        // with the other columns rather than a bare file dialog.
        '<div class="pi-overlay" id="rcOverlay"><div class="pi-modal">',
        '<div class="pi-modal-header"><h3 id="rcModalTitle">Report Card</h3>',
        '<button class="pi-close" onclick="CofpForms.closeReportUpload()" aria-label="Close">&times;</button></div>',
        '<div class="pi-modal-body">',
        '<div class="pi-section"><h4>Child</h4><div class="pi-value" id="rcChildName"></div></div>',
        '<div class="pi-section"><h4 id="rcWhich">Report Card</h4>',
        '<div class="doc-note">Upload the child\u2019s report card (PDF or a clear photo). It is filed in the child\u2019s folder and marks this column complete.</div>',
        '<div class="cls-upload-row"><input type="file" id="rcFile" accept=".pdf,.jpg,.jpeg,.png">',
        '<button type="button" class="pi-btn pi-btn-primary" id="rcBtn" onclick="CofpForms.uploadReportCard()">Upload report card</button>',
        '<span id="rcStatus" class="cls-upload-status"></span></div></div>',
        '</div>',
        '<div class="pi-modal-footer">',
        '<button class="pi-btn pi-btn-secondary" onclick="CofpForms.closeReportUpload()">Close</button></div>',
        '</div></div>',

        '<div id="printAllContainer"></div>'
    ].join('');

    var MODAL_CSS = [
        '.pi-overlay { display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:center;justify-content:center; }',
        '.pi-overlay.open { display:flex; }',
        /* max-height stays 90vh so the modal never touches the browser edges, but the
           permission slip (the most vertically dense of these forms — a consent
           paragraph plus two full signature pads) is the reason .pi-modal-body and
           .pi-section padding below were tightened: on a typical laptop screen
           (~800px tall) it now fits without the inner scroll it needed before. */
        '.pi-modal { background:white;border-radius:12px;width:95%;max-width:800px;max-height:90vh;overflow-y:auto;box-shadow:0 8px 40px rgba(0,0,0,0.3); }',
        '.pi-modal-header { display:flex;align-items:center;justify-content:space-between;padding:12px 24px;border-bottom:1px solid #e5e7eb;position:sticky;top:0;background:white;z-index:2;border-radius:12px 12px 0 0; }',
        '.pi-modal-header h3 { margin:0;font-size:1.1rem;font-weight:700;color:#1e3a8a; }',
        '.pi-modal-header .pi-close { background:none;border:none;font-size:1.5rem;cursor:pointer;color:#6b7280;padding:4px 8px;border-radius:4px; }',
        '.pi-modal-header .pi-close:hover { background:#f3f4f6;color:#111; }',
        '.pi-modal-body { padding:16px 24px; }',
        '.pi-section { margin-bottom:14px; }',
        '.pi-section h4 { font-size:0.8rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#6b7280;margin:0 0 10px 0;padding-bottom:6px;border-bottom:1px solid #f3f4f6; }',
        '.pi-grid { display:grid;grid-template-columns:1fr 1fr;gap:10px 16px; }',
        '.pi-grid.three { grid-template-columns:1fr 1fr 1fr; }',
        '.pi-field { display:flex;flex-direction:column;gap:3px; }',
        '.pi-field label { font-size:0.7rem;font-weight:600;color:#6b7280; }',
        '.pi-field .pi-value { font-size:0.82rem;font-weight:500;color:#111;padding:6px 10px;background:#f8fafc;border-radius:6px;min-height:28px;display:flex;align-items:center; }',
        '.pi-field textarea, .pi-field input[type=text], .pi-field input[type=date], .pi-field input[type=number] { font-size:0.82rem;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-family:inherit;resize:vertical; }',
        '.pi-field textarea { min-height:60px; }',
        '.pi-field textarea:focus, .pi-field input:focus { outline:none;border-color:#2563eb;box-shadow:0 0 0 2px rgba(37,99,235,0.1); }',
        '.pi-field select { font-size:0.82rem;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-family:inherit;background:white; }',
        '.pi-field select:focus { outline:none;border-color:#2563eb;box-shadow:0 0 0 2px rgba(37,99,235,0.1); }',
        /* The consent statement sits in its own soft panel so it reads as the formal
           declaration it is, with comfortable padding rather than hugging the edge. */
        '.pi-consent { background:#f8fafc;border:1px solid #eef2f7;border-radius:10px;'
            + 'padding:14px 20px;line-height:2.2; }',
        /* Inline fill-in-the-blank inputs that flow WITHIN the sentence. Underlined
           blanks that widen to fit their content (esp. two teacher names). */
        '.pi-inline { display:inline-block;width:170px;max-width:100%;font-size:0.9rem;font-family:inherit;color:#111;'
            + 'text-align:center;border:none;border-bottom:1.5px solid #9ca3af;background:transparent;'
            + 'padding:1px 6px;margin:0 3px;vertical-align:baseline; }',
        '.pi-inline::placeholder { color:#c4c9d2;font-style:normal; }',
        '.pi-inline:focus { outline:none;border-bottom-color:#2563eb;background:#eff6ff; }',
        '.pi-inline:hover { border-bottom-color:#2563eb; }',
        /* Teacher blank is widest — it can hold two full names. */
        '.pi-inline-italic { font-style:italic;width:250px; }',
        '.pi-inline-sm { width:100px; }',
        '.pi-full { grid-column:1/-1; }',
        '.pi-modal-footer { padding:12px 24px;border-top:1px solid #e5e7eb;display:flex;gap:10px;justify-content:flex-end;position:sticky;bottom:0;background:white;border-radius:0 0 12px 12px; }',
        '.pi-btn { padding:8px 18px;border-radius:6px;font-size:0.82rem;font-weight:600;cursor:pointer;border:1px solid transparent;transition:all 0.15s; }',
        '.pi-btn-primary { background:#2563eb;color:white; }',
        '.pi-btn-primary:hover { background:#1d4ed8; }',
        '.pi-btn-secondary { background:white;color:#374151;border-color:#d1d5db; }',
        '.pi-btn-secondary:hover { background:#f9fafb; }',
        '.pi-btn:disabled { opacity:0.5;cursor:not-allowed; }',
        '.pi-saved-badge { display:inline-flex;align-items:center;gap:4px;font-size:0.72rem;color:#059669;font-weight:600; }',
        '.pi-flags { display:flex;flex-wrap:wrap;gap:6px;padding:4px 0; }',
        '.pi-flag { padding:3px 9px;border-radius:12px;background:#fef2f2;color:#b91c1c;font-size:0.7rem;font-weight:700;white-space:nowrap; }',
        '.doc-note { font-size:0.72rem;color:#6b7280;margin:-4px 0 10px 0;line-height:1.5; }',
        '.cls-upload-row { display:flex;align-items:center;gap:10px;flex-wrap:wrap; }',
        '.cls-upload-row input[type=file] { font-size:0.8rem; }',
        '.cls-upload-status { font-size:0.75rem;font-weight:600; }',
        '@media print { .cls-upload-row { display:none !important; } }',
        '#printAllContainer { display:none; }',
        '.print-value { display:inline-block;min-height:1em; }',
        '@media print {',
        '  .pi-overlay:not([data-printing]) { display:none !important; }',
        '  .pi-overlay[data-printing] .pi-modal, .pi-overlay[data-printing] .pi-modal * { visibility:visible; }',
        '  .pi-overlay[data-printing] { display:block !important;position:static;background:none; }',
        '  .pi-overlay[data-printing] .pi-modal { position:static;width:100%;max-width:100%;max-height:none;overflow:visible;box-shadow:none;border-radius:0;margin:0; }',
        '  .pi-overlay[data-printing] .pi-modal-footer { display:none; }',
        '  .pi-overlay[data-printing] .pi-modal-header .pi-close { display:none; }',
        '  .pi-overlay[data-printing] input::placeholder, .pi-overlay[data-printing] textarea::placeholder { color:transparent !important;opacity:0 !important; }',
        '  #printAllContainer[data-printing] { display:block !important;position:static;visibility:visible; }',
        '  #printAllContainer[data-printing] * { visibility:visible; }',
        '  #printAllContainer[data-printing] .print-page { page-break-after:always;break-after:page; }',
        '  #printAllContainer[data-printing] .print-page:last-child { page-break-after:auto;break-after:auto; }',
        '  #printAllContainer[data-printing] .pi-modal { position:static;width:100%;max-width:100%;box-shadow:none;border-radius:0;margin:0; }',
        '  #printAllContainer[data-printing] .print-value { border-bottom:1px solid #9ca3af;min-width:120px;padding:2px 4px;font-weight:600; }',
        '}'
    ].join('\n');

    function injectAssets() {
        // If the page already has the modals (isbe.html ships them inline), don't
        // add a second set — the ids must stay unique.
        if (!document.getElementById('piOverlay')) {
            var wrap = document.createElement('div');
            wrap.innerHTML = MODAL_HTML;
            while (wrap.firstChild) document.body.appendChild(wrap.firstChild);
        }
        if (!document.getElementById('cofp-forms-css')) {
            var style = document.createElement('style');
            style.id = 'cofp-forms-css';
            style.textContent = MODAL_CSS;
            document.head.appendChild(style);
        }
    }

    // ── Public API ─────────────────────────────────────────────────────────────
    var api = {
        init: function (context) {
            ctx = context;
            // A page that already has the markup (isbe.html) can pass
            // injectAssets:false to keep using its own inline modals/CSS.
            if (context.injectAssets !== false) injectAssets();
            return api;
        },
        // form entry points
        openInterview: openInterview,
        saveInterview: saveInterview,
        closeInterview: closeInterview,
        printInterview: printInterview,
        openPermissionSlip: openPermissionSlip,
        savePermissionSlip: savePermissionSlip,
        closePermissionSlip: closePermissionSlip,
        openResultsShared: openResultsShared,
        saveResultsShared: saveResultsShared,
        closeResultsShared: closeResultsShared,
        printResultsShared: printResultsShared,
        openScreening: openScreening,
        saveScreening: saveScreening,
        closeScreening: closeScreening,
        printScreening: printScreening,
        uploadScreeningQuestionnaire: uploadScreeningQuestionnaire,
        openReportUpload: openReportUpload,
        closeReportUpload: closeReportUpload,
        uploadReportCard: uploadReportCard,
        printAllForColumn: printAllForColumn,
        loadSignatures: loadSignatures,
        // shared helpers the classroom view needs
        COLUMNS: COLUMNS,
        columnHasForm: columnHasForm,
        isLateEnrollee: isLateEnrollee,
        screeningDeadline: screeningDeadline,
        sortByName: sortByName,
        getRoom: getRoom,
        getTeacher: getTeacher
    };

    global.CofpForms = api;
})(window);
