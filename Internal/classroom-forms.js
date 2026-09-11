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
        { field: 'EndYearReport', teacher: true, label: 'End Year<br>Report Card' }
    ];
    var SCREENING_FIELDS = ['BegASQ', 'BegASE', 'EndASQ', 'EndASE'];
    // A column has a form behind it when opening it produces a modal. Mid/End year
    // report cards are tick-only, so they are deliberately excluded.
    function columnHasForm(field) {
        return field === 'PermissionSlip' || field === 'ParentInterview'
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
        if (existing && existing.RelPath) {
            pad.showExisting('/api/doc-file?path=' + encodeURIComponent(existing.RelPath));
            pad.setStatus('Signed' + (existing.SignedAt ? ' ' + existing.SignedAt.slice(0, 10) : '')
                + ' \u2014 press Clear to sign again', '#166534');
        } else {
            pad.setStatus('Not signed yet. Hand the screen to the parent, or print and scan the '
                + 'signed sheet into the child\u2019s file.', '#64748b');
        }
        setTimeout(function () { pad.refresh(); }, 30);
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
            payload.signatures.forEach(function (s) {
                sigs[sigKey(studentId, field, s.role)] = {
                    StudentId: String(studentId), FormField: field, Role: s.role,
                    SignedName: s.name, RelPath: d.relPath,
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

        document.getElementById('piDate').value = new Date().toISOString().split('T')[0];
        document.getElementById('piGoals').value = '';
        document.getElementById('piConcerns').value = '';
        document.getElementById('piStrengths').value = '';
        document.getElementById('piNotes').value = '';
        document.getElementById('piParentSig').value = '';
        document.getElementById('piStaffSig').value = '';
        document.getElementById('piPreferredLanguage').value = '';
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
                document.getElementById('piPreferredLanguage').value = data.PreferredLanguage || '';
                document.getElementById('piTranslatorNeeded').value = data.TranslatorNeeded || '';
                document.getElementById('piTranslatorArrangements').value = data.TranslatorArrangements || '';
            }
        } catch (e) { console.error('Failed to load interview', e); }

        loadIntakeRecord(studentId);
        document.getElementById('piOverlay').classList.add('open');
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

        document.getElementById('psModalTitle').textContent = 'Permission Slip \u2013 ' + student.First_Name + ' ' + student.Last_Name;
        document.getElementById('psParentNameDisplay').innerHTML = '&nbsp;';
        document.getElementById('psTeacherDisplay').textContent = teacher || '\u00a0';
        document.getElementById('psSchoolYearDisplay').textContent = schoolYear;

        document.getElementById('psParentName').value = '';
        document.getElementById('psSchoolYear').value = schoolYear;
        document.getElementById('psDate').value = new Date().toISOString().split('T')[0];
        document.getElementById('psTeacher').value = teacher;
        document.getElementById('psParentSig').value = '';
        document.getElementById('psParentSigDate').value = '';
        document.getElementById('psTeacherSig').value = '';
        document.getElementById('psTeacherSigDate').value = '';
        document.getElementById('psSavedBadge').style.display = 'none';

        sigPads = {};
        mountSigPad('psParentSigPad', studentId, 'PermissionSlip', 'parent',
            { label: 'Parent/Guardian signature', printedName: 'psParentSig', dateField: 'psParentSigDate' });
        mountSigPad('psTeacherSigPad', studentId, 'PermissionSlip', 'staff',
            { label: 'Teacher signature', printedName: 'psTeacherSig', dateField: 'psTeacherSigDate' });

        try {
            var res = await apiFetch(yearQS('/api/permission-slip/' + studentId));
            var data = await res.json();
            if (data && data.Id) {
                document.getElementById('psParentName').value = data.ParentName || '';
                document.getElementById('psParentNameDisplay').textContent = data.ParentName || '\u00a0';
                document.getElementById('psSchoolYear').value = data.SchoolYear || schoolYear;
                document.getElementById('psSchoolYearDisplay').textContent = data.SchoolYear || schoolYear;
                document.getElementById('psDate').value = data.SignedDate || '';
                document.getElementById('psTeacher').value = data.Teacher || teacher;
                document.getElementById('psTeacherDisplay').textContent = data.Teacher || teacher || '\u00a0';
                document.getElementById('psParentSig').value = data.ParentSignature || '';
                document.getElementById('psParentSigDate').value = data.ParentSigDate || '';
                document.getElementById('psTeacherSig').value = data.TeacherSignature || '';
                document.getElementById('psTeacherSigDate').value = data.TeacherSigDate || '';
            }
        } catch (e) { console.error('Failed to load permission slip', e); }

        document.getElementById('psOverlay').classList.add('open');
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

    function printPermissionSlip() {
        document.getElementById('psOverlay').setAttribute('data-printing', '1');
        window.print();
        document.getElementById('psOverlay').removeAttribute('data-printing');
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

    function printScreening() {
        document.getElementById('scrOverlay').setAttribute('data-printing', '1');
        window.print();
        document.getElementById('scrOverlay').removeAttribute('data-printing');
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
        '<div class="pi-section" style="text-align:center;padding:10px 0 20px;"><h4 style="font-size:1.1rem;font-weight:800;color:#1e3a8a;text-transform:none;letter-spacing:0;border:none;padding:0;margin:0 0 4px;">Children of Promise PFA</h4><div style="font-size:0.95rem;font-weight:700;color:#374151;">Permission to perform screenings</div></div>',
        '<div class="pi-section"><div style="font-size:0.88rem;line-height:1.8;color:#374151;">I, <span style="display:inline-block;min-width:180px;border-bottom:1px solid #9ca3af;font-weight:600;text-align:center;" id="psParentNameDisplay">&nbsp;</span> consent to <span style="display:inline-block;min-width:180px;border-bottom:1px solid #9ca3af;font-style:italic;text-align:center;" id="psTeacherDisplay">&nbsp;</span> conducting screenings on my child for the <span style="display:inline-block;min-width:100px;border-bottom:1px solid #9ca3af;text-align:center;" id="psSchoolYearDisplay">&nbsp;</span> school year using Ages and Stages ASQ and ASE screening instruments.</div>',
        '<p style="font-size:0.88rem;line-height:1.8;color:#374151;margin-top:16px;">Screenings will be performed at the beginning, middle, and end of the school year.</p>',
        '<p style="font-size:0.88rem;line-height:1.8;color:#374151;margin-top:16px;">Results of the screenings will be shared with the parents along with Teaching Strategies report cards at the middle and end of the school year.</p></div>',
        '<div class="pi-section" style="margin-top:24px;"><h4>Form Details</h4><div class="pi-grid">',
        '<div class="pi-field"><label>Parent/Guardian Name</label><input type="text" id="psParentName" placeholder="Parent full name" oninput="document.getElementById(\'psParentNameDisplay\').textContent=this.value||\'\\u00a0\'"></div>',
        '<div class="pi-field"><label>School Year</label><input type="text" id="psSchoolYear" placeholder="e.g. 2025-2026" oninput="document.getElementById(\'psSchoolYearDisplay\').textContent=this.value||\'\\u00a0\'"></div>',
        '<div class="pi-field"><label>Date Signed</label><input type="date" id="psDate"></div>',
        '<div class="pi-field"><label>Teacher</label><input type="text" id="psTeacher" placeholder="Teacher name" oninput="document.getElementById(\'psTeacherDisplay\').textContent=this.value||\'\\u00a0\'"></div></div></div>',
        '<div class="pi-section" style="margin-top:20px;"><h4>Signatures</h4><div class="pi-grid">',
        '<div class="pi-field pi-full"><label>Parent/Guardian Signature</label><div id="psParentSigPad"></div><div style="display:flex;gap:10px;margin-top:7px;"><input type="text" id="psParentSig" placeholder="Printed name" style="flex:2;"><input type="date" id="psParentSigDate" style="flex:1;" title="Date signed"></div></div>',
        '<div class="pi-field pi-full"><label>Teacher Signature</label><div id="psTeacherSigPad"></div><div style="display:flex;gap:10px;margin-top:7px;"><input type="text" id="psTeacherSig" placeholder="Printed name" style="flex:2;"><input type="date" id="psTeacherSigDate" style="flex:1;" title="Date signed"></div></div></div></div>',
        '</div>',
        '<div class="pi-modal-footer"><span class="pi-saved-badge" id="psSavedBadge" style="display:none;">&#10003; Saved</span>',
        '<button class="pi-btn pi-btn-secondary" onclick="CofpForms.printPermissionSlip()">&#x1F5A8;&#xFE0F; Print</button>',
        '<button class="pi-btn pi-btn-primary" id="psSaveBtn" onclick="CofpForms.savePermissionSlip()">Save Permission Slip</button></div>',
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
        '</div>',
        '<div class="pi-modal-footer"><span class="pi-saved-badge" id="scrSavedBadge" style="display:none;">&#10003; Saved</span>',
        '<button class="pi-btn pi-btn-secondary" onclick="CofpForms.printScreening()">&#x1F5A8;&#xFE0F; Print</button>',
        '<button class="pi-btn pi-btn-primary" id="scrSaveBtn" onclick="CofpForms.saveScreening()">Save Screening</button></div>',
        '</div></div>',

        '<div id="printAllContainer"></div>'
    ].join('');

    var MODAL_CSS = [
        '.pi-overlay { display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:center;justify-content:center; }',
        '.pi-overlay.open { display:flex; }',
        '.pi-modal { background:white;border-radius:12px;width:95%;max-width:800px;max-height:90vh;overflow-y:auto;box-shadow:0 8px 40px rgba(0,0,0,0.3); }',
        '.pi-modal-header { display:flex;align-items:center;justify-content:space-between;padding:16px 24px;border-bottom:1px solid #e5e7eb;position:sticky;top:0;background:white;z-index:2;border-radius:12px 12px 0 0; }',
        '.pi-modal-header h3 { margin:0;font-size:1.1rem;font-weight:700;color:#1e3a8a; }',
        '.pi-modal-header .pi-close { background:none;border:none;font-size:1.5rem;cursor:pointer;color:#6b7280;padding:4px 8px;border-radius:4px; }',
        '.pi-modal-header .pi-close:hover { background:#f3f4f6;color:#111; }',
        '.pi-modal-body { padding:24px; }',
        '.pi-section { margin-bottom:20px; }',
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
        '.pi-full { grid-column:1/-1; }',
        '.pi-modal-footer { padding:16px 24px;border-top:1px solid #e5e7eb;display:flex;gap:10px;justify-content:flex-end;position:sticky;bottom:0;background:white;border-radius:0 0 12px 12px; }',
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
        printPermissionSlip: printPermissionSlip,
        openScreening: openScreening,
        saveScreening: saveScreening,
        closeScreening: closeScreening,
        printScreening: printScreening,
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
