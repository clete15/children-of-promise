/* Next-step suggestions for a staff member's professional development plan.

   PICC PI9 requires each plan to carry "an assessment of the needs of each direct
   service staff member" and "a description of the professional learning the
   program will provide". Both are derivable from records already held — Gateways
   credential levels, semester hours, transcript status and room assignment — so
   this computes them instead of asking the director to write eleven of them from
   memory.

   Deliberately conservative. Every suggestion states the fact it rests on, and
   nothing is asserted that the data does not support. Where a credential decision
   belongs to Gateways, the suggestion says to ask Gateways rather than predicting
   the outcome.

   Loaded by both individual-pd-plan.html and the staff development page, so the
   printed plan and the screen can never disagree.                              */

(function (root) {
    'use strict';

    var IT_ROOMS = ['Infant', 'Infants / Toddlers', '2 Year Olds / Toddlers'];
    var PD_HOURS_REQUIRED = 20;
    // Community college certificates built for this credential run about 21 hours.
    var ITC_L2_APPROX_HOURS = 21;

    function roomKey(v) {
        return String(v || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
            .map(function (w) {
                return w.length > 2 && w.slice(-1) === 's' && w.slice(-2) !== 'ss' ? w.slice(0, -1) : w;
            }).join('/');
    }

    function servesInfantToddler(s) {
        return IT_ROOMS.some(function (r) {
            return roomKey(s.Classroom) === roomKey(r) || roomKey(s.SecondaryClassroom) === roomKey(r);
        });
    }

    // Reads a Gateways level out of the stored credential text. Pending items are
    // stripped first: something awaiting coursework is not held.
    function credLevel(s, kind) {
        var src = [s.EceCredentials, s.Gateways].filter(Boolean).join(', ');
        var earned = src.replace(/\b(pending|awaiting|in ?progress|missing|expired)\b[^,;]*/gi, '');
        var re = kind === 'ece' ? /ECE(?:\s*Credential)?\s*-?\s*Level\s*(\d)/i
            : kind === 'it' ? /(?:IT|ITC|Infant\s*\/?\s*Toddler)(?:\s*Credential)?\s*-?\s*Level\s*(\d)/i
            : /Director(?:\s*Credential)?\s*-?\s*Level\s*(III|II|I|\d)/i;
        var m = earned.match(re);
        if (!m) return 0;
        if (kind === 'dir') {
            return /^\d$/.test(m[1]) ? +m[1] : ({ I: 1, II: 2, III: 3 })[m[1].toUpperCase()] || 0;
        }
        return +m[1];
    }

    var num = function (v) { var n = parseFloat(v); return isFinite(n) ? n : null; };

    /* Returns { needs: [...], provide: [...], goals: [...] }
         needs   — the assessment PI9 asks for, as plain statements of fact
         provide — what the programme will do about it
         goals   — prefilled rows for the plan's goal table
       Each goal: { goal, actionSteps, timeline, resources, evidence, why } */
    function suggest(s, opts) {
        opts = opts || {};
        var needs = [], provide = [], goals = [];
        var ece = credLevel(s, 'ece');
        var it = credLevel(s, 'it');
        var dir = credLevel(s, 'dir');
        var shTotal = num(s.SemesterHoursTotal);
        var shEce = num(s.SemesterHoursEce);
        var pd = num(s.PdHoursYtd);
        var transcript = (s.TranscriptOnFile || '').trim();
        var inIt = servesInfantToddler(s);
        var isAssistant = /assistant|para/i.test(s.Role || '');
        var isDirector = /director|administrator/i.test(s.Role || '');
        var pendingText = [s.EceCredentials, s.Gateways, s.Notes].filter(Boolean).join(' ');

        // ── 1. Unsubmitted transcript. Cheapest possible win, so it leads. ──
        if (transcript === 'Not submitted' && (shTotal || shEce)) {
            needs.push('Holds ' + (shTotal || shEce) + ' earned college credit hours'
                + (shEce ? ', ' + shEce + ' of them early childhood' : '')
                + ', none of which are on file with the Gateways Registry. Credential levels '
                + 'cannot reflect coursework the Registry has not received.');
            provide.push('Program will request an official transcript from the college and send it to '
                + 'the Gateways credential office, then confirm the record has been updated.');
            goals.push({
                goal: 'Get official transcript on file with Gateways',
                actionSteps: 'Ask the college to send an official transcript directly to '
                    + 'transcripts@inccra.org, quoting Registry ID '
                    + (s.RegistryId || '(obtain Registry ID)') + '. A copy sent by the employee is not accepted.',
                timeline: 'Within 30 days',
                resources: 'Transcript request fee if charged; Registry ID',
                evidence: 'Updated Gateways Staff Education and Credentials report showing the hours',
                why: 'Hours already earned are not counting toward any credential.'
            });
        } else if (!transcript && !shTotal && !isDirector) {
            needs.push('No college coursework or transcript status recorded, so it is not known '
                + 'whether prior coursework exists that could support a credential.');
            provide.push('Program will ask the employee whether any college coursework has been '
                + 'completed and, if so, obtain an official transcript.');
        }

        // ── 2. A pending Gateways application that is stuck. ──
        var stuck = pendingText.match(/Awaiting Official Transcripts/i);
        if (stuck) {
            needs.push('A Gateways application is held for "Awaiting Official Transcripts", '
                + 'so an assessment is already open and waiting on a document.');
            provide.push('Program will supply the outstanding transcript so the pending application '
                + 'can be assessed.');
        }
        if (/Awaiting Additional Coursework/i.test(pendingText)) {
            needs.push('A Gateways application is held for "Awaiting Additional Coursework", '
                + 'which paperwork alone will not resolve — further study is required.');
        }

        // ── 3. Infant/toddler credential where the room calls for it. ──
        if (inIt && it < 2) {
            var ecePart = shEce != null ? shEce : null;
            needs.push('Works with infants and toddlers but holds no Infant/Toddler Credential at '
                + 'Level 2. ExceleRate Standard 4B expects 30% of infant and toddler staff to hold it.'
                + (ecePart != null ? ' Currently ' + ecePart + ' early childhood semester hours on record.' : ''));
            provide.push('Program will identify an infant and toddler specific course, confirm with '
                + 'Gateways that it counts toward the Infant/Toddler Credential, and support enrolment.');
            goals.push({
                goal: 'Earn Gateways Infant/Toddler Credential Level 2',
                actionSteps: 'Confirm current requirements with credentials@ilgateways.com. Enrol in an '
                    + 'infant and toddler specific course — not a general early childhood course. '
                    + 'Community college certificates built for this credential run about '
                    + ITC_L2_APPROX_HOURS + ' credit hours, so confirm how much existing coursework counts first.',
                timeline: 'Confirm requirements within 30 days; enrol next available term',
                resources: 'Gateways scholarship; SWIC or an online provider; release time if needed',
                evidence: 'Gateways report showing Infant/Toddler Credential Level 2',
                why: 'Assigned to an infant or toddler room without the matching credential.'
            });
        }

        // ── 4. ECE credential progression. ──
        if (!isDirector && ece > 0 && ece < 3) {
            needs.push('Holds ECE Credential Level ' + ece + '. ExceleRate Standard 4B counts staff at '
                + 'Level 3 and above, so this level does not contribute to that threshold.');
            provide.push('Program will map the coursework needed to reach ECE Level 3 and support enrolment.');
            goals.push({
                goal: 'Advance from ECE Credential Level ' + ece + ' to Level 3',
                actionSteps: 'Ask Gateways which specific coursework is outstanding for Level 3, then '
                    + 'enrol in the next required course.',
                timeline: 'Requirements confirmed within 60 days',
                resources: 'Gateways scholarship; academic advising at SWIC',
                evidence: 'Gateways report showing ECE Credential Level 3',
                why: 'Level 3 is the point at which a credential counts toward Standard 4B.'
            });
        } else if (!isDirector && ece === 0) {
            needs.push('No Gateways ECE Credential on record.');
            provide.push('Program will support an initial ECE Credential application, which begins the '
                + 'credential record even at Level 1.');
            goals.push({
                goal: 'Obtain an initial Gateways ECE Credential',
                actionSteps: 'Create or renew Gateways Registry membership, then apply for an ECE Credential.',
                timeline: 'Within 90 days',
                resources: 'Registry membership; Gateways application support',
                evidence: 'Gateways report showing an ECE Credential',
                why: 'No credential on record at all.'
            });
        }

        // ── 5. Director credential, for whoever administers the programme. ──
        if (isDirector && dir < 1) {
            needs.push('Serves in a director or administrator role without an Illinois Director '
                + 'Credential at Level I or above, which ExceleRate Standard 4A requires.');
            provide.push('Program will support an Illinois Director Credential application.');
            goals.push({
                goal: 'Earn Illinois Director Credential Level I',
                actionSteps: 'Apply through Gateways and supply the work experience documentation requested.',
                timeline: 'Application submitted within 90 days',
                resources: 'Gateways application; work experience verification from the program',
                evidence: 'Gateways report showing Illinois Director Credential Level I',
                why: 'Standard 4A rests on the administrator holding this credential.'
            });
        }

        // ── 6. Annual professional development hours. ──
        if (pd == null) {
            needs.push('Professional development hours for the current year are not recorded, so it '
                + 'is unknown whether the ' + PD_HOURS_REQUIRED + ' hour expectation is met.');
            provide.push('Program will record training and credit hours as they are completed.');
        } else if (pd < PD_HOURS_REQUIRED) {
            needs.push('Has ' + pd + ' of ' + PD_HOURS_REQUIRED + ' professional development hours '
                + 'for the year, ' + (PD_HOURS_REQUIRED - pd) + ' short.');
            provide.push('Program will provide in-service sessions and identify outside training or '
                + 'credit hours to close the remaining ' + (PD_HOURS_REQUIRED - pd) + ' hours.');
            goals.push({
                goal: 'Complete ' + PD_HOURS_REQUIRED + ' professional development hours this year',
                actionSteps: 'Attend program in-service sessions and select outside training or college '
                    + 'credit to make up the remaining ' + (PD_HOURS_REQUIRED - pd) + ' hours. '
                    + 'Credit hours count toward this total.',
                timeline: 'By the end of the program year',
                resources: 'In-service schedule; Gateways training calendar; conference registration',
                evidence: 'Training certificates and the running hour total on the staff record',
                why: 'Twenty hours a year is expected of classroom teaching staff.'
            });
        }

        // ── 7. Registry membership housekeeping. ──
        if (/REGISTRY MEMBERSHIP EXPIRED|registry.{0,20}expired/i.test(pendingText)) {
            needs.push('Gateways Registry membership has expired. No credential can be issued or '
                + 'renewed while membership is lapsed.');
            provide.push('Program will support Registry membership renewal.');
            goals.push({
                goal: 'Renew Gateways Registry membership',
                actionSteps: 'Renew membership through the Gateways Registry.',
                timeline: 'Within 30 days',
                resources: 'Registry renewal fee',
                evidence: 'Registry showing an active membership expiry date',
                why: 'A lapsed membership blocks every other credential step.'
            });
        }
        if (!s.RegistryId) {
            needs.push('No Gateways Registry ID on record, so this person does not appear on the '
                + 'program\u2019s Gateways staff report.');
            provide.push('Program will register the employee with the Gateways Registry.');
            goals.push({
                goal: 'Register with the Gateways Registry',
                actionSteps: 'Create a Gateways Registry membership and record the Registry ID on the staff card.',
                timeline: 'Within 30 days of hire',
                resources: 'Gateways Registry membership',
                evidence: 'Registry ID recorded and appearing on the program staff report',
                why: 'Qualifications cannot be evidenced for someone not on the Registry.'
            });
        }

        // ── 8. Assistants working toward a teaching role. ──
        if (isAssistant && ece >= 1 && (shEce == null || shEce < 6)) {
            provide.push('Program will discuss a route from assistant toward a teaching role and the '
                + 'coursework it would need.');
        }

        if (!needs.length) {
            needs.push('Credentials, coursework and professional development hours are all current '
                + 'against the requirements tracked here. Focus this cycle on maintaining hours and '
                + 'renewing certifications before they lapse.');
        }
        if (!provide.length) {
            provide.push('Program will provide ongoing in-service sessions and continue to fund '
                + 'training that maintains current credentials.');
        }
        return { needs: needs, provide: provide, goals: goals };
    }

    /* ── Review cycles ──
       The centre reviews plans twice: mid-year and end-of-year. That cadence is
       its own policy — PI9 requires a written dated plan but sets no frequency —
       so it is defined here rather than presented as a regulation.

       The school year starts 08 September, which is what decides which year a
       plan belongs to. Both cycles are records for the same school year and
       neither replaces the other. */
    var SCHOOL_YEAR_START = { month: 9, day: 8 };
    var CYCLES = [
        { key: 'Mid-Year', label: 'Mid-Year Review', dueMonth: 1, dueDay: 15 },
        { key: 'End-of-Year', label: 'End-of-Year Review', dueMonth: 6, dueDay: 30 }
    ];

    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function iso(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }

    /* Reads a date as calendar year/month/day without a timezone shift.

       "2026-09-08" passed to new Date() is parsed as UTC midnight, and reading it
       back with getDate() in Central time returns the 7th. That would file a plan
       created on the first day of the school year into the previous year, so
       date-only strings are split by hand instead. */
    function ymd(value) {
        var s = String(value == null ? '' : value).trim();
        var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) return { y: +m[1], m: +m[2], d: +m[3] };
        var dt = s ? new Date(s) : new Date();
        if (isNaN(dt.getTime())) dt = new Date();
        return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
    }

    // "2026-2027" for any date inside that school year.
    function schoolYearOf(date) {
        var p = ymd(date);
        var afterStart = p.m > SCHOOL_YEAR_START.month
            || (p.m === SCHOOL_YEAR_START.month && p.d >= SCHOOL_YEAR_START.day);
        return afterStart ? p.y + '-' + (p.y + 1) : (p.y - 1) + '-' + p.y;
    }

    // Compares two date-only strings without constructing Date objects.
    function onOrBefore(a, b) {
        var x = ymd(a), y = ymd(b);
        return (x.y * 10000 + x.m * 100 + x.d) <= (y.y * 10000 + y.m * 100 + y.d);
    }

    // Both cycles fall in the calendar year AFTER the school year begins.
    function cycleDueDate(cycleKey, schoolYear) {
        var startYear = parseInt(String(schoolYear || schoolYearOf()).split('-')[0], 10);
        var c = CYCLES.filter(function (x) { return x.key === cycleKey; })[0];
        if (!c || !startYear) return '';
        return iso(startYear + 1, c.dueMonth, c.dueDay);
    }

    /* Which cycles exist for a person this school year, and what is outstanding.
       A missing cycle whose due date has not arrived is "upcoming", not "overdue" —
       reporting it as late would train the director to ignore the list. */
    function cycleStatus(staffId, plans, schoolYear, today) {
        var sy = schoolYear || schoolYearOf();
        var mine = (plans || []).filter(function (p) {
            return String(p.StaffId) === String(staffId)
                && (p.SchoolYear || schoolYearOf(p.PlanDate)) === sy;
        });
        return CYCLES.map(function (c) {
            var found = mine.filter(function (p) { return (p.PlanType || '') === c.key; })
                .sort(function (a, b) { return (+b.Id) - (+a.Id); })[0] || null;
            var due = cycleDueDate(c.key, sy);
            // Overdue only once the due date has actually passed.
            var overdue = !found && !!due && !onOrBefore(today || new Date(), due);
            return {
                key: c.key, label: c.label, due: due, plan: found,
                state: found ? 'done' : (overdue ? 'overdue' : 'upcoming')
            };
        });
    }

    // The cycle a new plan should default to: the earliest one not yet on file.
    function suggestedCycle(staffId, plans, schoolYear, today) {
        var st = cycleStatus(staffId, plans, schoolYear, today);
        var open = st.filter(function (c) { return c.state !== 'done'; });
        return (open[0] || st[st.length - 1]).key;
    }

    root.PDSuggest = {
        suggest: suggest,
        credLevel: credLevel,
        servesInfantToddler: servesInfantToddler,
        roomKey: roomKey,
        PD_HOURS_REQUIRED: PD_HOURS_REQUIRED,
        IT_ROOMS: IT_ROOMS,
        CYCLES: CYCLES,
        SCHOOL_YEAR_START: SCHOOL_YEAR_START,
        schoolYearOf: schoolYearOf,
        cycleDueDate: cycleDueDate,
        cycleStatus: cycleStatus,
        suggestedCycle: suggestedCycle
    };
})(typeof window !== 'undefined' ? window : globalThis);
