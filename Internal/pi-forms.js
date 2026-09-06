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
    /* ASQ first and selected by default: it is the tool this program uses for the
       Family Centered Assessment. PI6.A guidance allows the LSP child portion to
       be replaced by the ASQ or another child developmental tool. The published
       alternatives stay on the list so a different choice can still be recorded. */
    const ASSESSMENT_TOOLS = [
        'Ages & Stages Questionnaire (ASQ)',
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

    /* ── Weighted eligibility criteria (PI5.A) ──
       These mirror the scoring the public pre-enrollment form already applies to
       rank the waiting list (External/preenrollment.html calcScore), so a child
       who came through that form has this whole table filled in automatically.

       points     must stay in step with calcScore or the printed form will
                  disagree with the waiting-list order it claims to explain
       picc       priority population the criterion satisfies, where PI5.B-G
                  names one; the checklist requires those to appear on the form
       intakeKey  Yes/No column on the pre-enrollment record
       derive     for criteria the intake stores as something other than Yes/No

       PI5.C, PI5.F and PI5.G are required priority populations that the
       pre-enrollment form does not currently ask about, so they have no
       intakeKey and start blank for staff to answer. */
    const WEIGHTED_CRITERIA = [
        { key: 'homeless', label: 'Experiencing homelessness', points: 50, picc: 'PI5.D', intakeKey: 'Homeless' },
        { key: 'youthInCare', label: 'Youth in Care (foster) or adopted', points: 50, picc: 'PI5.E', intakeKey: 'FosterAdopted' },
        { key: 'earlyIntervention', label: 'Enrolled in Early Intervention with an identified delay', points: 5, picc: 'PI5.B', intakeKey: 'EarlyIntervention' },
        { key: 'hasIep', label: 'Has an IEP', points: 5, picc: 'PI5.B', intakeKey: 'IEP' },
        { key: 'screeningDelayNoEi', label: 'Screening indicated a delay but no current Early Intervention referral', points: 5, picc: 'PI5.C', intakeKey: 'ScreeningDelayNoEi' },
        // The intake form offers "Not sure" on this one. Leave it unanswered rather
        // than defaulting to No, so staff settle it from the income verification.
        {
            key: 'incomeBelow50Fpl', label: 'Family income at or below 50% of the federal poverty level', points: 5, picc: 'PI5.F',
            derive: d => {
                const v = String(d.IncomeBelow50Fpl || '').trim().toLowerCase();
                return v === 'yes' ? 'Yes' : v === 'no' ? 'No' : '';
            }
        },
        { key: 'parentEll', label: 'Parent or caregiver is an English language learner', points: 5, picc: 'PI5.G', intakeKey: 'ParentEll' },
        { key: 'nonEnglishHome', label: 'Primary language in the home is not English', points: 5, intakeKey: 'NonEnglishHome' },
        { key: 'publicBenefits', label: 'Receiving public benefits (WIC, Medicaid, SNAP, TANF)', points: 5, derive: d => (d.PublicBenefits ? 'Yes' : 'No') },
        { key: 'abuseHistory', label: 'Abuse or domestic violence history', points: 5, intakeKey: 'AbuseHistory' },
        { key: 'mentalIllness', label: 'Mental illness in the home', points: 5, intakeKey: 'MentalIllness' },
        { key: 'dcfsInvolvement', label: 'DCFS involvement', points: 5, intakeKey: 'DcfsInvolvement' },
        { key: 'substanceAbuse', label: 'Substance abuse in the home', points: 5, intakeKey: 'SubstanceAbuse' },
        { key: 'caregiverOther', label: 'Child cared for by someone other than a parent', points: 5, intakeKey: 'CaregiverOther' },
        { key: 'familyDeath', label: 'Death in the immediate family', points: 5, intakeKey: 'FamilyDeath' },
        { key: 'lowBirthWeight', label: 'Low birth weight or failure to thrive', points: 5, intakeKey: 'LowBirthWeight' },
        { key: 'parentIncarcerated', label: 'Parent incarcerated', points: 5, intakeKey: 'ParentIncarcerated' },
        { key: 'teenParent', label: 'Teen parent', points: 5, intakeKey: 'TeenParent' },
        { key: 'noHsDiploma', label: 'Parent without a high school diploma', points: 5, intakeKey: 'NoHSDiploma' },
        { key: 'bornOutsideUs', label: 'Child or parent born outside the United States', points: 5, intakeKey: 'BornOutsideUS' },
        { key: 'activeMilitary', label: 'Active military family', points: 5, intakeKey: 'ActiveMilitary' },
        { key: 'singleParent', label: 'Single-parent household', points: 3, derive: d => (d.LivingSituation === 'Single Parent' ? 'Yes' : 'No') }
    ];

    // PI5.H: the three determinations the checklist recognises.
    const ELIGIBILITY_RESULTS = [
        '',
        'Family is enrolled in the PI program',
        'Family did not qualify for the PI program',
        'Family is on the PI waiting list'
    ];

    const INCOME_VERIFICATION_TYPES = [
        '',
        'Pay stubs',
        'Prior year tax return',
        'Benefit award letter',
        'Employer statement',
        'Self-declaration of income',
        'Other (describe in notes)'
    ];

    const SCREENING_TOOLS = [
        '',
        'ASQ-3',
        'ASQ:SE-2',
        'ASQ-3 and ASQ:SE-2',
        'Other (describe below)'
    ];

    const SHARING_METHODS = [
        '',
        'In person',
        'Parent-teacher conference',
        'Sent home in writing',
        'Phone call',
        'Email',
        'Other (describe below)'
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
                        { key: 'assessmentTool', label: 'Assessment Tool Used', type: 'select', options: ASSESSMENT_TOOLS, full: true, default: 'Ages & Stages Questionnaire (ASQ)' },
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

        weightedEligibility: {
            api: 'weighted-eligibility',
            field: 'WeightedEligibility',
            title: 'Weighted Eligibility Determination',
            picc: 'PICC PI5.A / PI5.B-G / PI5.H / PI5.J',
            piccNote: 'Every child enrolled in PI needs a completed weighted eligibility form on file, '
                + 'with income verification, and it must be dated on or before the enrollment date. '
                + 'Criteria are pre-filled from the family\u2019s pre-enrollment submission where one exists; '
                + 'check them against the file and correct anything that has changed.',
            saveLabel: 'Save Determination',
            primaryDate: 'completedDate',
            beforeEnrollment: true,
            needsIntake: true,
            sections: [
                childSection(),
                {
                    title: 'Completion',
                    fields: [
                        { key: 'completedDate', label: 'Date Completed', type: 'date' },
                        { key: 'enrollmentDate', label: 'Enrollment Date', type: 'date', default: s => s.Start_Date || '' },
                        { key: 'completedBy', label: 'Completed By (staff)', type: 'text' },
                        {
                            label: 'Pre-Enrollment Record', type: 'static',
                            value: (s, intake) => !intake ? 'None on file'
                                : 'Submitted ' + (intake.SubmittedAt || '').split(' ')[0]
                                + (intake.MatchType === 'name+dob' ? ' (matched by name + DOB)' : '')
                        }
                    ]
                },
                {
                    title: 'Weighted Criteria',
                    note: 'PICC PI5.B through PI5.G require the priority populations to appear on this form. '
                        + 'Answers come from the pre-enrollment submission where one exists. Families who applied '
                        + 'before those questions were added, and anyone who answered "Not sure" to the income '
                        + 'question, will have blank rows that need answering here.',
                    fields: [
                        { key: 'criteriaTable', type: 'criteria', label: 'Weighted Eligibility Criteria', items: WEIGHTED_CRITERIA },
                        { key: 'totalPoints', label: 'Total Weighted Points', type: 'text' }
                    ]
                },
                {
                    title: 'Income Verification',
                    note: 'PI5.J requires proof of income in the file, re-verified each time this form is completed. '
                        + 'If the family uses a benefit card as proof, the card must be in the parent\u2019s name, not the child\u2019s.',
                    fields: [
                        { key: 'householdIncome', label: 'Household Income', type: 'text', default: (s, intake) => (intake && intake.HouseholdIncome) || '' },
                        { key: 'householdSize', label: 'Household Size', type: 'text', default: (s, intake) => (intake && intake.HouseholdSize) || '' },
                        { key: 'incomeVerificationType', label: 'Proof of Income Provided', type: 'select', options: INCOME_VERIFICATION_TYPES },
                        { key: 'incomeVerificationDate', label: 'Date Income Verified', type: 'date' },
                        { key: 'benefitCardInParentName', label: 'If a Benefit Card Was Used, Is It in the Parent\u2019s Name?', type: 'select', options: YES_NO_NA, full: true }
                    ]
                },
                {
                    title: 'Determination',
                    note: 'PI5.H records the outcome of the eligibility screening in the child/family file.',
                    fields: [
                        { key: 'eligibilityResult', label: 'Eligibility Screening Result', type: 'select', options: ELIGIBILITY_RESULTS, full: true },
                        { key: 'notes', label: 'Notes', type: 'textarea', full: true }
                    ]
                },
                {
                    title: 'Signatures',
                    fields: [
                        { key: 'parentSignature', label: 'Parent/Guardian Signature', type: 'text', placeholder: 'Type full name as signature' },
                        { key: 'staffSignature', label: 'Staff Signature', type: 'text', placeholder: 'Type full name as signature' },
                        { key: 'signedDate', label: 'Date Signed', type: 'date' }
                    ]
                }
            ]
        },

        screeningResultsShared: {
            api: 'screening-results-shared',
            field: 'ScreeningResultsShared',
            title: 'Screening Results Shared with Parent',
            picc: 'PICC PI10.H',
            piccNote: 'Every child who was screened needs documentation that the results were shared with the '
                + 'parent or guardian. The checklist names seven components: child name, the tool used, evidence '
                + 'the results were shared, who they were shared with, the date screened, the date shared, and '
                + 'the name of the screener.',
            saveLabel: 'Save Record',
            primaryDate: 'sharedDate',
            sections: [
                childSection(),
                {
                    title: 'Screening',
                    fields: [
                        { key: 'toolUsed', label: 'Research-Based Tool Used', type: 'select', options: SCREENING_TOOLS },
                        { key: 'toolOther', label: 'If Other, name the tool', type: 'text' },
                        { key: 'screeningDate', label: 'Date Child Was Screened', type: 'date' },
                        { key: 'screenerName', label: 'Name of Screener (staff)', type: 'text' },
                        { key: 'resultsSummary', label: 'Results Summary', type: 'textarea', full: true, placeholder: 'Domains screened and the outcome in each.' }
                    ]
                },
                {
                    title: 'Sharing with Parent',
                    fields: [
                        { key: 'sharedDate', label: 'Date Results Were Shared', type: 'date' },
                        { key: 'sharedWith', label: 'Shared With (parent/guardian name)', type: 'text' },
                        { key: 'sharedMethod', label: 'How Results Were Shared', type: 'select', options: SHARING_METHODS },
                        { key: 'evidenceOfSharing', label: 'Evidence the Results Were Shared', type: 'textarea', full: true, placeholder: 'What was given to or discussed with the parent, and any copy retained in the file.' },
                        { key: 'parentResponse', label: 'Parent Questions or Response', type: 'textarea', full: true }
                    ]
                },
                {
                    title: 'Follow-Up',
                    note: 'PI10.I requires a referral for further evaluation when a screening identifies a concern. '
                        + 'Record the referral itself on the Referral form.',
                    fields: [
                        { key: 'concernIdentified', label: 'Screening Identified a Concern', type: 'select', options: YES_NO },
                        { key: 'referralMade', label: 'Referred for Further Evaluation', type: 'select', options: YES_NO_NA },
                        { key: 'followUpNotes', label: 'Follow-Up Notes', type: 'textarea', full: true }
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
    let currentIntake = null;   // pre-enrollment record, when the spec asks for it

    // ── Rendering ──

    // A criteria block is stored one column per criterion, so it expands into
    // ordinary select fields for save/load and only differs in how it renders.
    function criteriaFields(f) {
        return f.items.map(it => ({ key: it.key, type: 'select', options: YES_NO, criterion: it }));
    }

    function criteriaHtml(f) {
        const rows = f.items.map(it =>
            '<tr>'
            + '<td>' + escHtml(it.label) + '</td>'
            + '<td class="doc-criteria-picc">' + (it.picc ? escHtml(it.picc) : '') + '</td>'
            + '<td class="doc-criteria-pts">' + it.points + '</td>'
            + '<td><select id="doc_' + it.key + '" onchange="recalcWeightedTotal()">'
            + YES_NO.map(o => '<option value="' + escHtml(o) + '">'
                + escHtml(o || '\u2014') + '</option>').join('')
            + '</select></td>'
            + '</tr>').join('');

        return '<div class="pi-field pi-full"><label>' + escHtml(f.label) + '</label>'
            + '<table class="doc-criteria">'
            + '<thead><tr><th>Criterion</th><th>PICC</th><th>Pts</th><th>Applies</th></tr></thead>'
            + '<tbody>' + rows + '</tbody>'
            + '<tfoot><tr><td colspan="2">Total weighted points</td>'
            + '<td class="doc-criteria-pts" id="docCriteriaTotal">0</td><td></td></tr></tfoot>'
            + '</table>'
            + '<div id="docScoreCompare" class="doc-note"></div></div>';
    }

    function fieldHtml(f, student) {
        const id = 'doc_' + f.key;
        const cls = 'pi-field' + (f.full ? ' pi-full' : '');
        const ph = f.placeholder ? ' placeholder="' + escHtml(f.placeholder) + '"' : '';

        if (f.type === 'criteria') return criteriaHtml(f);

        if (f.type === 'static') {
            let v = '';
            try { v = f.value(student, currentIntake) || ''; } catch (e) { v = ''; }
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
        spec.sections.forEach(sec => sec.fields.forEach(f => {
            if (f.type === 'criteria') { criteriaFields(f).forEach(c => out.push(c)); return; }
            if (f.key) out.push(f);
        }));
        return out;
    }

    // Sums the points of every criterion answered Yes and, when the child came
    // through the online pre-enrollment, notes where the live total diverges from
    // the score the waiting list was ranked by.
    function recalcWeightedTotal() {
        const spec = DOC_FORM_SPECS[currentKey];
        if (!spec) return;
        let block = null;
        spec.sections.forEach(sec => sec.fields.forEach(f => { if (f.type === 'criteria') block = f; }));
        if (!block) return;

        let total = 0;
        block.items.forEach(it => {
            const el = document.getElementById('doc_' + it.key);
            if (el && el.value === 'Yes') total += it.points;
        });

        const totalEl = document.getElementById('docCriteriaTotal');
        if (totalEl) totalEl.textContent = total;
        const stored = document.getElementById('doc_totalPoints');
        if (stored) stored.value = total;

        const cmp = document.getElementById('docScoreCompare');
        if (!cmp) return;
        const intakeScore = currentIntake && currentIntake.found ? parseInt(currentIntake.Score, 10) : NaN;
        if (isNaN(intakeScore)) {
            cmp.textContent = 'No pre-enrollment score on file, so this total was entered by hand.';
            return;
        }
        if (intakeScore === total) {
            cmp.textContent = 'Matches the waiting-list score of ' + intakeScore + ' from the pre-enrollment record.';
        } else {
            // Expected whenever PI5.C/F/G are answered here, since the public form
            // does not ask those three questions yet.
            cmp.innerHTML = 'Waiting-list score at intake was <strong>' + intakeScore
                + '</strong>; this form totals <strong>' + total + '</strong>. '
                + 'A difference is expected when criteria the pre-enrollment form does not ask about are answered here.';
        }
    }

    // ── Compliance window badge ──
    // Mirrors the 45-day screening badge, with the interval supplied by the spec
    // (PI6 documents are due within 6 months of enrollment rather than 45 days).
    function renderWindowBadge(spec, student) {
        const host = document.getElementById('docWindowBadge');
        if (!host) return;
        host.innerHTML = '';
        if (!student.Start_Date) return;

        const done = document.getElementById('doc_' + spec.primaryDate);
        const doneVal = done ? done.value : '';

        // PI5 eligibility documents are the other way round from PI6: rather than a
        // window that opens at enrollment, they must be dated on or before it.
        if (spec.beforeEnrollment) {
            if (!doneVal) {
                host.innerHTML = '<div class="doc-window dl-due">Eligibility documents must be dated on or '
                    + 'before the enrollment date <span class="doc-window-sub">(enrolled '
                    + escHtml(student.Start_Date) + ')</span></div>';
                return;
            }
            const diff = daysBetween(doneVal, student.Start_Date);
            if (diff === null) return;
            const okBefore = diff >= 0;
            host.innerHTML = '<div class="doc-window dl-' + (okBefore ? 'ok' : 'late') + '">'
                + (okBefore
                    ? 'Dated on or before enrollment'
                    : 'Dated ' + Math.abs(diff) + ' day(s) AFTER enrollment \u2014 the checklist requires on or before')
                + ' <span class="doc-window-sub">(enrolled ' + escHtml(student.Start_Date) + ')</span></div>';
            return;
        }

        if (!spec.window) return;
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
        currentIntake = null;

        // Fetch the linked pre-enrollment record before rendering, so static fields
        // and criteria defaults can read it. openDocForm is awaited by Print All,
        // which is why this stays inline rather than filling in afterwards.
        if (spec.needsIntake) {
            try {
                // Intake is the original pre-enrollment submission, not a per-year
                // record, so this one is deliberately not year-scoped.
                const ir = await apiFetch('/api/student-intake/' + studentId);
                currentIntake = await ir.json();
            } catch (e) {
                console.error('Failed to load intake record', e);
            }
        }

        document.getElementById('docModalTitle').textContent =
            spec.title + ' \u2013 ' + fullName(student);
        document.getElementById('docSaveBtn').textContent = spec.saveLabel;
        document.getElementById('docModalBody').innerHTML = renderForm(spec, student);
        document.getElementById('docSavedBadge').style.display = 'none';

        const fields = allFields(spec);

        // Defaults first, then overwrite with anything already saved.
        const intake = currentIntake && currentIntake.found ? currentIntake : null;
        const isYes = v => String(v).trim().toLowerCase() === 'yes';

        fields.forEach(f => {
            const el = document.getElementById('doc_' + f.key);
            if (!el || f.type === 'checkgroup') return;
            let v = '';
            // A weighted criterion answers itself from the pre-enrollment record.
            if (f.criterion && intake) {
                const c = f.criterion;
                if (c.derive) { try { v = c.derive(intake) || ''; } catch (e) { v = ''; } }
                else if (c.intakeKey) v = isYes(intake[c.intakeKey]) ? 'Yes' : 'No';
            } else if (f.default) {
                try { v = (typeof f.default === 'function' ? f.default(student, intake) : f.default) || ''; }
                catch (e) { v = ''; }
            }
            el.value = v;
        });

        try {
            // activeSchoolYear is owned by isbe.html; these records are per year so
            // a returning child starts fresh rather than showing last year's form.
            const res = await apiFetch('/api/pi-doc/' + spec.api + '/' + studentId
                + '?year=' + encodeURIComponent(activeSchoolYear));
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
        recalcWeightedTotal();
        const primary = document.getElementById('doc_' + spec.primaryDate);
        if (primary) primary.addEventListener('change', () => renderWindowBadge(spec, student));

        document.getElementById('docOverlay').classList.add('open');
    }

    function closeDocForm() {
        document.getElementById('docOverlay').classList.remove('open');
        currentKey = null;
        currentStudentId = null;
        currentIntake = null;
    }

    async function saveDocForm() {
        if (!currentKey || !currentStudentId) return;
        const spec = DOC_FORM_SPECS[currentKey];
        const btn = document.getElementById('docSaveBtn');
        btn.disabled = true;
        btn.textContent = 'Saving...';

        const body = { year: activeSchoolYear };
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
                refreshActiveView();
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
    window.recalcWeightedTotal = recalcWeightedTotal;   // referenced by inline onchange
    window.openDocForm = openDocForm;
    window.closeDocForm = closeDocForm;
    window.saveDocForm = saveDocForm;
    window.printDocForm = printDocForm;
})();
