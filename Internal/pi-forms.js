/* ──────────────────────────────────────────────────────────────────────────
   PICC per-child document forms  (Prevention Initiative only)

   Adds the four child/family file documents the FY27 Prevention Initiative
   Compliance Checklist requires but the roster had no way to produce:

     PI6.A  Family Centered Assessment   within 6 months of enrollment
     PI6.B  Individual Family Goal Plan  within 6 months, updated annually
     PI7.A  Written Transition Plan      as applicable
     PI7.B  Referral                     as applicable (also covers PI10.I)

   These are declared as data rather than written out as four more modals. The
   page already carries three hand-built forms (Parent Interview, Permission
   Slip, Screening) at roughly 90 lines of near-identical open/save/print code
   each; four more copies would have doubled the file we just finished
   splitting apart. One spec + one renderer keeps the markup in one place and
   makes a fifth form a data change.

   Loaded as a classic script before isbe.html's inline script. Everything is
   wrapped in an IIFE because that inline script declares its state with
   top-level `let` (students, trackingData, activeProgram, ...) which lands in
   the shared global lexical environment -- a top-level `const` here with a
   colliding name would be a hard redeclaration error. Those globals are read
   by bare name inside functions, which resolves at call time.
   ────────────────────────────────────────────────────────────────────────── */

(function () {
    'use strict';

    function todayISO() {
        return new Date().toISOString().split('T')[0];
    }

    function escHtml(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function fullName(s) {
        return s ? (s.First_Name + ' ' + s.Last_Name) : '';
    }

    // ── Shared option lists ──

    const GOAL_STATUS = ['', 'Not started', 'In progress', 'Met', 'No longer a priority'];
    const YES_NO = ['', 'Yes', 'No'];
    const YES_NO_NA = ['', 'Yes', 'No', 'N/A'];

    // Tools the PICC names as acceptable published, research-based family
    // assessments for PI6.A. "Other" stays available because the checklist
    // allows it with a description.
    const ASSESSMENT_TOOLS = [
        '',
        'Life Skills Progression (LSP)',
        'Baby TALK Family Centered Assessment',
        'Family Resource and Opportunities for Growth (FROG)',
        'Parent, Family, and Community Engagement (PFCE) Framework',
        'Other (describe below)'
    ];

    // Center-based transition situations. The PICC asks for an individualized
    // written plan so children and families experience a seamless transition
    // of services; these are the routes a center program actually sees.
    const TRANSITION_TYPES = [
        '',
        'Moving to a new classroom within the program',
        'Transition to Preschool for All (PFA)',
        'Referral to Early Intervention (Part C)',
        'Early Intervention to Early Childhood Special Education (Part C to Part B)',
        'Transition to Kindergarten',
        'Exiting the program',
        'Family moved / relocated',
        'Other (describe below)'
    ];

    const TRANSITION_RECORDS = [
        'Developmental screening results',
        'IFSP / IEP',
        'Health & immunization records',
        'Attendance records',
        'Individual Family Goal Plan',
        'Parent Interview Form',
        'Other'
    ];

    const REFERRAL_REASONS = [
        '',
        'Developmental concern indicated by screening',
        'Social-emotional / behavioral concern',
        'Speech and language',
        'Hearing or vision',
        'Medical / health',
        'Family support services',
        'Housing or food assistance',
        'Mental health',
        'Substance use',
        'Domestic violence',
        'Other (describe below)'
    ];

    // Where the concern came from. ASQ-3 and ASQ:SE-2 are listed separately
    // because the roster tracks them as separate screenings.
    const CONCERN_SOURCES = [
        '',
        'ASQ-3 screening',
        'ASQ:SE-2 screening',
        'Teacher observation',
        'Parent request or concern',
        'Ongoing developmental monitoring',
        'Family Centered Assessment',
        'Other (describe below)'
    ];

    const REFERRAL_OUTCOMES = [
        '',
        'Pending',
        'Evaluation scheduled',
        'Evaluation completed \u2013 eligible',
        'Evaluation completed \u2013 not eligible',
        'Services started',
        'Family declined',
        'Unable to contact family',
        'Closed'
    ];

    // The child header every one of these documents needs. PICC file reviews
    // check that each document identifies the child it belongs to.
    function childSection() {
        return {
            title: 'Child Information',
            grid: 'three',
            fields: [
                { label: 'Child Name', type: 'static', value: fullName },
                { label: 'Date of Birth', type: 'static', value: s => s.Birth_date },
                { label: 'Classroom', type: 'static', value: s => getRoom(s.RoomNumber) },
                { label: 'Enrollment Date', type: 'static', value: s => s.Start_Date }
            ]
        };
    }

    // One goal block. PI6.B wants goals with action steps and a review cycle;
    // three blocks covers what staff use in practice without forcing a
    // dynamic repeater into a form that has to print on paper.
    function goalSection(n) {
        return {
            title: n === 1 ? 'Family Goal 1' : 'Family Goal ' + n + ' (if applicable)',
            fields: [
                { key: 'goal' + n, label: 'Goal', type: 'textarea', full: true, placeholder: 'What does the family want to work toward?' },
                { key: 'goal' + n + 'Steps', label: 'Action Steps', type: 'textarea', full: true, placeholder: 'Steps the family and program will take.' },
                { key: 'goal' + n + 'Resources', label: 'Resources / Supports', type: 'textarea', full: true, placeholder: 'Services, referrals or supports that help reach this goal.' },
                { key: 'goal' + n + 'Responsible', label: 'Person Responsible', type: 'text' },
                { key: 'goal' + n + 'Target', label: 'Target Date', type: 'date' },
                { key: 'goal' + n + 'Status', label: 'Status', type: 'select', options: GOAL_STATUS }
            ]
        };
    }

    /* ── Form specifications ──
       api          slug matched by the generic /api/pi-doc endpoints
       field        ISBETracking column auto-checked on save
       picc         checklist item, shown in the modal so staff know the source
       primaryDate  key whose value the compliance window is measured against
       window       { days, label } deadline badge measured from Start_Date  */

    const DOC_FORM_SPECS = {
        familyAssessment: {
            api: 'family-assessment',
            field: 'FamilyCenteredAssessment',
            title: 'Family Centered Assessment',
            picc: 'PICC PI6.A',
            piccNote: 'Each child/family file needs evidence that a published, research-based '
                + 'Family Centered Assessment was conducted within 6 months of enrollment. '
                + 'The LSP child portion may be replaced by the ASQ (or another child developmental tool).',
            saveLabel: 'Save Assessment',
            primaryDate: 'assessmentDate',
            window: { days: 182, label: '6-month window from enrollment' },
            sections: [
                childSection(),
                {
                    title: 'Assessment',
                    fields: [
                        { key: 'assessmentDate', label: 'Assessment Date', type: 'date', default: todayISO },
                        { key: 'enrollmentDate', label: 'Enrollment Date', type: 'date', default: s => s.Start_Date || '' },
                        { key: 'assessmentTool', label: 'Assessment Tool Used', type: 'select', options: ASSESSMENT_TOOLS, full: true },
                        { key: 'toolOther', label: 'If Other, describe the tool', type: 'text', full: true },
                        { key: 'completedBy', label: 'Completed By (staff)', type: 'text' }
                    ]
                },
                {
                    title: 'Findings',
                    fields: [
                        { key: 'familyStrengths', label: 'Family Strengths', type: 'textarea', full: true, placeholder: 'Strengths and protective factors identified with the family.' },
                        { key: 'familyNeeds', label: 'Family Needs', type: 'textarea', full: true, placeholder: 'Needs the family identified during the assessment.' },
                        { key: 'areasOfConcern', label: 'Areas of Concern', type: 'textarea', full: true, placeholder: 'Any concerns raised. Note if a referral was made.' },
                        { key: 'nextSteps', label: 'Next Steps / Follow-Up', type: 'textarea', full: true, placeholder: 'What happens next, and by when.' }
                    ]
                },
                {
                    title: 'Signatures',
                    fields: [
                        { key: 'parentSignature', label: 'Parent/Guardian Signature', type: 'text', placeholder: 'Type full name as signature' },
                        { key: 'staffSignature', label: 'Staff Signature', type: 'text', placeholder: 'Type full name as signature' },
                        { key: 'signedDate', label: 'Date Signed', type: 'date', default: todayISO }
                    ]
                }
            ]
        },

        familyGoalPlan: {
            api: 'family-goal-plan',
            field: 'FamilyGoalPlan',
            title: 'Individual Family Goal Plan',
            picc: 'PICC PI6.B',
            piccNote: 'Each child/family file needs evidence that an Individual Family Goal Plan was '
                + 'developed within 6 months of enrollment and updated annually thereafter. '
                + 'Record annual updates as a new plan date with type "Annual update".',
            saveLabel: 'Save Goal Plan',
            primaryDate: 'planDate',
            window: { days: 182, label: '6-month window from enrollment' },
            sections: [
                childSection(),
                {
                    title: 'Plan',
                    fields: [
                        { key: 'planDate', label: 'Plan Date', type: 'date', default: todayISO },
                        { key: 'enrollmentDate', label: 'Enrollment Date', type: 'date', default: s => s.Start_Date || '' },
                        { key: 'planType', label: 'Plan Type', type: 'select', options: ['', 'Initial plan', 'Annual update'] },
                        { key: 'nextReviewDate', label: 'Next Review Date', type: 'date' },
                        { key: 'familyStrengths', label: 'Family Strengths the Plan Builds On', type: 'textarea', full: true }
                    ]
                },
                goalSection(1),
                goalSection(2),
                goalSection(3),
                {
                    title: 'Signatures',
                    fields: [
                        { key: 'parentSignature', label: 'Parent/Guardian Signature', type: 'text', placeholder: 'Type full name as signature' },
                        { key: 'staffSignature', label: 'Staff Signature', type: 'text', placeholder: 'Type full name as signature' },
                        { key: 'signedDate', label: 'Date Signed', type: 'date', default: todayISO }
                    ]
                }
            ]
        },

        transitionPlan: {
            api: 'transition-plan',
            field: 'TransitionPlan',
            title: 'Transition Plan',
            picc: 'PICC PI7.A',
            piccNote: 'Written individualized Transition Plans ensure children and families experience a '
                + 'seamless transition of services. For a family that exited suddenly, the checklist '
                + 'accepts comprehensive case notes with documented attempts to contact the family '
                + 'instead \u2014 record those in the Sudden Exit section.',
            saveLabel: 'Save Transition Plan',
            primaryDate: 'planDate',
            sections: [
                childSection(),
                {
                    title: 'Transition',
                    fields: [
                        { key: 'planDate', label: 'Plan Date', type: 'date', default: todayISO },
                        { key: 'transitionDate', label: 'Anticipated Transition Date', type: 'date' },
                        { key: 'transitionType', label: 'Type of Transition', type: 'select', options: TRANSITION_TYPES, full: true },
                        { key: 'receivingProgram', label: 'Receiving Program / Placement', type: 'text', full: true },
                        { key: 'receivingContact', label: 'Receiving Contact Person', type: 'text' },
                        { key: 'receivingPhone', label: 'Contact Phone', type: 'text' },
                        { key: 'staffResponsible', label: 'Staff Responsible', type: 'text' }
                    ]
                },
                {
                    title: 'Plan Details',
                    fields: [
                        { key: 'currentServices', label: 'Current Services Summary', type: 'textarea', full: true, placeholder: 'Services the child and family receive now.' },
                        { key: 'transitionSteps', label: 'Steps to Support the Transition', type: 'textarea', full: true, placeholder: 'Visits, meetings, introductions, and who arranges each.' },
                        { key: 'familyConcerns', label: 'Family Questions or Concerns', type: 'textarea', full: true }
                    ]
                },
                {
                    title: 'Records',
                    fields: [
                        { key: 'recordsTransferred', label: 'Records to Transfer', type: 'checkgroup', options: TRANSITION_RECORDS, full: true },
                        { key: 'parentNotifiedDate', label: 'Date Parent Notified', type: 'date' },
                        { key: 'recordsConsent', label: 'Parent Consent for Records Release', type: 'select', options: YES_NO_NA }
                    ]
                },
                {
                    title: 'Sudden Exit',
                    note: 'Complete only if the family exited without notice. The checklist accepts case '
                        + 'notes plus documented contact attempts as the transition evidence in that case.',
                    fields: [
                        { key: 'suddenExit', label: 'Family Exited Suddenly', type: 'select', options: YES_NO },
                        { key: 'contactAttempts', label: 'Case Notes & Documented Contact Attempts', type: 'textarea', full: true, placeholder: 'Date, method and outcome of each attempt to reach the family.' }
                    ]
                },
                {
                    title: 'Signatures',
                    fields: [
                        { key: 'parentSignature', label: 'Parent/Guardian Signature', type: 'text', placeholder: 'Type full name as signature' },
                        { key: 'staffSignature', label: 'Staff Signature', type: 'text', placeholder: 'Type full name as signature' },
                        { key: 'signedDate', label: 'Date Signed', type: 'date', default: todayISO }
                    ]
                }
            ]
        },

        referral: {
            api: 'referral',
            field: 'Referral',
            title: 'Referral Record',
            picc: 'PICC PI7.B / PI10.I',
            piccNote: 'Evidence the referral system is used when necessary, and that children identified '
                + 'with developmental concerns are referred for further evaluation. The checklist treats '
                + 'this as not applicable for families that did not require a referral \u2014 record that '
                + 'below so the file shows the determination was made.',
            saveLabel: 'Save Referral',
            primaryDate: 'referralDate',
            sections: [
                childSection(),
                {
                    title: 'Applicability',
                    fields: [
                        { key: 'notApplicable', label: 'No Referral Needed for This Family', type: 'select', options: YES_NO },
                        { key: 'notApplicableReason', label: 'Basis for That Determination', type: 'textarea', full: true, placeholder: 'Why no referral was required. Leave the rest of the form blank if this applies.' }
                    ]
                },
                {
                    title: 'Referral',
                    fields: [
                        { key: 'referralDate', label: 'Referral Date', type: 'date' },
                        { key: 'referredBy', label: 'Referral Made By (staff)', type: 'text' },
                        { key: 'referralReason', label: 'Reason for Referral', type: 'select', options: REFERRAL_REASONS, full: true },
                        { key: 'concernSource', label: 'Source of the Concern', type: 'select', options: CONCERN_SOURCES, full: true },
                        { key: 'concernDetail', label: 'Description of the Concern', type: 'textarea', full: true, placeholder: 'Include screening domain and result if the concern came from a screening.' }
                    ]
                },
                {
                    title: 'Receiving Agency',
                    fields: [
                        { key: 'referredTo', label: 'Referred To (agency / provider)', type: 'text', full: true },
                        { key: 'agencyContact', label: 'Agency Contact', type: 'text' },
                        { key: 'agencyPhone', label: 'Agency Phone', type: 'text' },
                        { key: 'parentNotifiedDate', label: 'Date Parent Notified', type: 'date' },
                        { key: 'parentConsent', label: 'Parent Consent Obtained', type: 'select', options: YES_NO_NA }
                    ]
                },
                {
                    title: 'Outcome',
                    fields: [
                        { key: 'outcome', label: 'Outcome', type: 'select', options: REFERRAL_OUTCOMES },
                        { key: 'outcomeDate', label: 'Outcome Date', type: 'date' },
                        { key: 'followUpNotes', label: 'Follow-Up Notes', type: 'textarea', full: true }
                    ]
                },
                {
                    title: 'Signature',
                    fields: [
                        { key: 'staffSignature', label: 'Staff Signature', type: 'text', placeholder: 'Type full name as signature' },
                        { key: 'signedDate', label: 'Date Signed', type: 'date', default: todayISO }
                    ]
                }
            ]
        }
    };

    // ── State ──

    let currentKey = null;
    let currentStudentId = null;

    // ── Rendering ──

    function fieldHtml(f, student) {
        const id = 'doc_' + f.key;
        const cls = 'pi-field' + (f.full ? ' pi-full' : '');
        const ph = f.placeholder ? ' placeholder="' + escHtml(f.placeholder) + '"' : '';

        if (f.type === 'static') {
            let v = '';
            try { v = f.value(student) || ''; } catch (e) { v = ''; }
            return '<div class="' + cls + '"><label>' + escHtml(f.label) + '</label>'
                + '<div class="pi-value">' + escHtml(v || '\u2014') + '</div></div>';
        }
        if (f.type === 'textarea') {
            return '<div class="' + cls + '"><label>' + escHtml(f.label) + '</label>'
                + '<textarea id="' + id + '"' + ph + '></textarea></div>';
        }
        if (f.type === 'select') {
            const opts = f.options.map(o =>
                '<option value="' + escHtml(o) + '">' + escHtml(o || '\u2014 select \u2014') + '</option>').join('');
            return '<div class="' + cls + '"><label>' + escHtml(f.label) + '</label>'
                + '<select id="' + id + '">' + opts + '</select></div>';
        }
        if (f.type === 'checkgroup') {
            // Stored as a comma-joined string so it round-trips through the
            // pipe-delimited sqlcmd transport as one ordinary text column.
            const boxes = f.options.map((o, i) =>
                '<label class="doc-check"><input type="checkbox" id="' + id + '_' + i
                + '" value="' + escHtml(o) + '"> ' + escHtml(o) + '</label>').join('');
            return '<div class="' + cls + '"><label>' + escHtml(f.label) + '</label>'
                + '<div class="doc-checkgroup" id="' + id + '">' + boxes + '</div></div>';
        }
        // date + text
        return '<div class="' + cls + '"><label>' + escHtml(f.label) + '</label>'
            + '<input type="' + (f.type === 'date' ? 'date' : 'text') + '" id="' + id + '"' + ph + '></div>';
    }

    function renderForm(spec, student) {
        const sections = spec.sections.map(sec => {
            const grid = 'pi-grid' + (sec.grid ? ' ' + sec.grid : '');
            const note = sec.note
                ? '<div class="doc-note">' + escHtml(sec.note) + '</div>'
                : '';
            return '<div class="pi-section"><h4>' + escHtml(sec.title) + '</h4>' + note
                + '<div class="' + grid + '">'
                + sec.fields.map(f => fieldHtml(f, student)).join('')
                + '</div></div>';
        }).join('');

        return '<div class="doc-picc"><strong>' + escHtml(spec.picc) + '</strong> \u2014 '
            + escHtml(spec.piccNote) + '</div>'
            + '<div id="docWindowBadge"></div>'
            + sections;
    }

    function allFields(spec) {
        const out = [];
        spec.sections.forEach(sec => sec.fields.forEach(f => { if (f.key) out.push(f); }));
        return out;
    }

    // ── Compliance window badge ──
    // Mirrors the 45-day screening badge, with the interval supplied by the spec
    // (PI6 documents are due within 6 months of enrollment rather than 45 days).
    function renderWindowBadge(spec, student) {
        const host = document.getElementById('docWindowBadge');
        if (!host) return;
        host.innerHTML = '';
        if (!spec.window || !student.Start_Date) return;

        const done = document.getElementById('doc_' + spec.primaryDate);
        const doneVal = done ? done.value : '';
        const days = spec.window.days;
        let state, text;

        if (doneVal) {
            const used = daysBetween(student.Start_Date, doneVal);
            if (used === null) return;
            state = used <= days ? 'ok' : 'late';
            text = state === 'ok'
                ? 'Completed on day ' + used + ' of ' + days
                : 'Completed on day ' + used + ' \u2014 past the ' + days + '-day window';
        } else {
            const elapsed = daysBetween(student.Start_Date, todayISO());
            if (elapsed === null) return;
            const left = days - elapsed;
            if (left < 0) { state = 'overdue'; text = Math.abs(left) + ' days overdue'; }
            else if (left <= 30) { state = 'due'; text = left + ' days left'; }
            else { state = 'ok'; text = left + ' days left'; }
        }

        host.innerHTML = '<div class="doc-window dl-' + state + '">'
            + escHtml(spec.window.label) + ': <strong>' + escHtml(text) + '</strong>'
            + ' <span class="doc-window-sub">(enrolled ' + escHtml(student.Start_Date) + ')</span></div>';
    }

    // ── Open / populate ──

    async function openDocForm(key, studentId) {
        const spec = DOC_FORM_SPECS[key];
        if (!spec) return;
        const student = students.find(s => String(s.Id) === String(studentId));
        if (!student) return;

        currentKey = key;
        currentStudentId = studentId;

        document.getElementById('docModalTitle').textContent =
            spec.title + ' \u2013 ' + fullName(student);
        document.getElementById('docSaveBtn').textContent = spec.saveLabel;
        document.getElementById('docModalBody').innerHTML = renderForm(spec, student);
        document.getElementById('docSavedBadge').style.display = 'none';

        const fields = allFields(spec);

        // Defaults first, then overwrite with anything already saved.
        fields.forEach(f => {
            const el = document.getElementById('doc_' + f.key);
            if (!el || f.type === 'checkgroup') return;
            let v = '';
            if (f.default) {
                try { v = (typeof f.default === 'function' ? f.default(student) : f.default) || ''; }
                catch (e) { v = ''; }
            }
            el.value = v;
        });

        try {
            const res = await apiFetch('/api/pi-doc/' + spec.api + '/' + studentId);
            const d = await res.json();
            if (d && d.found) {
                fields.forEach(f => {
                    // Server returns SQL column names (PascalCase) keyed off the
                    // json key used on write, so map key -> Column.
                    const col = f.key.charAt(0).toUpperCase() + f.key.slice(1);
                    const val = d[col];
                    if (val === undefined) return;
                    if (f.type === 'checkgroup') {
                        const chosen = String(val).split(',').map(x => x.trim()).filter(Boolean);
                        f.options.forEach((o, i) => {
                            const box = document.getElementById('doc_' + f.key + '_' + i);
                            if (box) box.checked = chosen.indexOf(o) !== -1;
                        });
                        return;
                    }
                    const el = document.getElementById('doc_' + f.key);
                    if (el) el.value = val;
                });
            }
        } catch (e) {
            console.error('Failed to load ' + spec.api, e);
        }

        renderWindowBadge(spec, student);
        const primary = document.getElementById('doc_' + spec.primaryDate);
        if (primary) primary.addEventListener('change', () => renderWindowBadge(spec, student));

        document.getElementById('docOverlay').classList.add('open');
    }

    function closeDocForm() {
        document.getElementById('docOverlay').classList.remove('open');
        currentKey = null;
        currentStudentId = null;
    }

    async function saveDocForm() {
        if (!currentKey || !currentStudentId) return;
        const spec = DOC_FORM_SPECS[currentKey];
        const btn = document.getElementById('docSaveBtn');
        btn.disabled = true;
        btn.textContent = 'Saving...';

        const body = {};
        allFields(spec).forEach(f => {
            if (f.type === 'checkgroup') {
                body[f.key] = f.options.filter((o, i) => {
                    const box = document.getElementById('doc_' + f.key + '_' + i);
                    return box && box.checked;
                }).join(', ');
                return;
            }
            const el = document.getElementById('doc_' + f.key);
            body[f.key] = el ? el.value : '';
        });

        try {
            const res = await apiFetch('/api/pi-doc/' + spec.api + '/' + currentStudentId, {
                method: 'POST',
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (data.success) {
                if (!trackingData[currentStudentId]) trackingData[currentStudentId] = {};
                trackingData[currentStudentId][spec.field] = 1;
                renderRoster();
                const badge = document.getElementById('docSavedBadge');
                badge.style.display = 'inline-flex';
                setTimeout(() => { badge.style.display = 'none'; }, 3000);
            } else {
                alert('Save failed: ' + (data.error || 'Unknown error'));
            }
        } catch (e) {
            alert('Save failed: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.textContent = spec.saveLabel;
        }
    }

    function printDocForm() {
        const overlay = document.getElementById('docOverlay');
        overlay.setAttribute('data-printing', '1');
        window.print();
        overlay.removeAttribute('data-printing');
    }

    window.DOC_FORM_SPECS = DOC_FORM_SPECS;
    window.openDocForm = openDocForm;
    window.closeDocForm = closeDocForm;
    window.saveDocForm = saveDocForm;
    window.printDocForm = printDocForm;
})();
