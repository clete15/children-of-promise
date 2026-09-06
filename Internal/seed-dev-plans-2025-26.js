/* Seeds the 2025-26 staff development plans from the centre's existing document.

   Run once after deploying the StaffDevelopmentPlan / StaffDevelopmentGoal tables:
       node Internal/seed-dev-plans-2025-26.js

   Idempotent — it skips anyone who already has a 2025-2026 plan, so re-running is
   safe. Self-assessment text is the employee's own words and is copied verbatim
   rather than rewritten.

   Mid-year and year-end notes are left EMPTY on purpose. The document shows those
   sections blank, and filling them in would fabricate a review that did not
   happen. That gap is real and the page will show it.                          */
const https = require('https');
const auth = 'Basic ' + Buffer.from(':cofpadmin').toString('base64');
const HOST = 'childrenofpromisedaycare.com';
const SCHOOL_YEAR = '2025-2026';
const PLAN_DATE = '2025-09-08';   // start of the 2025-26 program year
const YEAR_END_DUE = '2026-06-30';
const MID_YEAR_DUE = '2026-01-15';

function call(method, path, body) {
    return new Promise(resolve => {
        const data = body ? JSON.stringify(body) : null;
        const headers = { Authorization: auth };
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        const req = https.request({ host: HOST, port: 443, path, method, headers }, res => {
            let b = ''; res.on('data', c => b += c);
            res.on('end', () => resolve({ status: res.statusCode, body: b }));
        });
        req.on('error', e => resolve({ status: 0, body: String(e.code || e.message) }));
        req.setTimeout(25000, () => { req.destroy(); resolve({ status: 0, body: 'TIMEOUT' }); });
        if (data) req.write(data);
        req.end();
    });
}
const getJSON = async p => { const r = await call('GET', p); try { return JSON.parse(r.body); } catch (e) { return null; } };

/* Keyed by the name on the 2025-26 document. Where a person has since been
   renamed on the staff record, `staffName` gives the current name so the plan
   attaches to the right record. */
const PLANS = [
    {
        docName: 'Keyona Hentz', staffName: 'Keyona Hentz',
        location: 'Millstadt', supervisor: 'Megan Nooney',
        strengths: 'Expert knowledge in PFA monitoring and curriculum oversight.',
        growth: 'Improving paperwork organization and digital filing systems.',
        favorite: 'Mentoring staff on child development.',
        frustrations: 'Technical/hardware malfunctions (printers/electronics).',
        goals: [{
            goal: 'Complete Illinois core modules (IELG/IELDS, ERS, WEEC).',
            pdSupport: 'Enroll in and complete i-learning modules.',
            measurement: 'Updated PDR and successful ISBE monitoring report.'
        }]
    },
    {
        docName: 'Megan Nooney', staffName: 'Megan Nooney',
        location: 'Children of Promise', supervisor: 'Board / Owners',
        strengths: 'Task-oriented and an active listener.',
        growth: 'Time management regarding administrative filing.',
        favorite: 'Supporting family growth and development.',
        frustrations: 'High volume of staff and child documentation.',
        goals: [{
            goal: 'Achieve Silver Level Admin status and oversee team ECE Level 1 compliance.',
            pdSupport: 'Complete PAS Self-Assessment, CQI training, Intro to Developmental Screening, and Fundamentals of Child Assessment.',
            measurement: 'Gateways Silver Level Admin designation.'
        }]
    },
    {
        docName: 'Lindsey Runyon', staffName: 'Lindsey Runyon',
        location: 'Children of Promise', supervisor: 'Megan Nooney',
        strengths: 'Dedicated classroom instruction.',
        growth: 'Completing advanced credentialing.',
        goals: [{
            goal: 'Finalize Infant Toddler Credential and complete all ISBE core modules.',
            pdSupport: 'Mail/upload Work Experience documentation to Gateways counselor; complete IELG, ERS, and WEEC.',
            measurement: 'Awarded Infant Toddler Credential.'
        }]
    },
    {
        docName: 'Janelle Poenetske', staffName: 'Janell Poenitske',
        location: 'Children of Promise', supervisor: 'Megan Nooney',
        strengths: 'Highly reliable; positive attitude.',
        growth: 'Training for children with special needs.',
        frustrations: 'Volume of special needs without specific industry training.',
        goals: [{
            goal: 'Resolve Infant Toddler Credential status and complete core modules.',
            pdSupport: 'Reach out to Gateways to complete "Awaiting Additional Coursework"; prioritize WEEC training for inclusive care.',
            measurement: 'Updated PDR showing course completions and credential status.'
        }]
    },
    {
        docName: 'Sue Engel', staffName: 'Sue Engel',
        location: 'Millstadt', supervisor: 'Megan Nooney',
        strengths: 'Diligent, punctual, and strong time management.',
        growth: 'Learning Teaching Strategies (TS).',
        favorite: 'Watching the kids grow and learn.',
        frustrations: 'When staff call off.',
        goals: [{
            goal: 'Resolve transcript issues to obtain ECE Level 1 and complete core modules.',
            pdSupport: 'Verify transcript receipt with Gateways; complete IELG, ERS, and WEEC modules.',
            measurement: 'ECE Level 1 status in Gateways; completion certificates.'
        }]
    },
    {
        docName: 'Tara Goldsmith', staffName: 'Tara Goldsmith',
        location: 'Children of Promise', supervisor: 'Megan Nooney',
        strengths: 'Punctual multi-tasker.',
        growth: 'Classroom organization.',
        goals: [{
            goal: 'Resolve "Missing Documents" in Gateways portal and complete core modules.',
            pdSupport: 'Email Gateways Counselor to identify specific missing items; finish all core ISBE modules.',
            measurement: 'Resolution of portal status; training certificates.'
        }]
    },
    {
        // Recorded as Renee on the document; the registry name is Donna Nier.
        docName: 'Renee Nier', staffName: 'Donna Nier',
        location: 'Children of Promise', supervisor: 'Megan Nooney',
        strengths: 'Fresh perspective and eagerness to learn.',
        growth: 'Fundamental ECE standards knowledge.',
        goals: [{
            goal: 'Complete 16 ECE Level 1 Modules and core ISBE compliance training.',
            pdSupport: 'Complete 2 modules per week to finish by June 1st; finish IELG, ERS, and WEEC.',
            measurement: 'Verified ECE Level 1 Credential.'
        }]
    },
    {
        docName: 'Paige Holliday', staffName: 'Paige Holliday',
        location: 'Children of Promise', supervisor: 'Megan Nooney',
        strengths: 'Diligent and punctual.',
        growth: 'Learning Teaching Strategies (TS) Assessments, and Ages and Stages.',
        goals: [{
            goal: 'Move from "Awaiting Counselor" status to Credentialed and complete core modules.',
            pdSupport: 'Frequent portal check-ins; complete IELG, ERS, and WEEC training.',
            measurement: 'Awarded ECE / Infant Toddler Credentials.'
        }]
    },
    {
        docName: 'Madeline Muir', staffName: 'Madeline Muir',
        location: 'Children of Promise', supervisor: 'Keyona Hentz',
        strengths: 'Positive attitude, and growing with changes needed within the classroom.',
        growth: 'Learning Teaching Strategies (TS) Curriculum and Assessments.',
        goals: [{
            goal: 'Maintain ECE Level 1 and complete core ISBE compliance (IELG, ERS, WEEC).',
            pdSupport: 'Complete 1 monthly Gateways workshop; apply IELG to classroom transitions and communication.',
            measurement: 'Updated PDR records.'
        }]
    },
    {
        /* On the 2025-26 document but no longer employed, and with no staff record.
           Kept here so the seed reports the difference rather than silently
           dropping a plan that exists on paper. */
        docName: 'Raquel Smith', staffName: 'Raquel Smith', departed: true,
        location: 'Children of Promise', supervisor: 'Keyona Hentz',
        strengths: 'Positive attitude and communication with staff and parents.',
        growth: 'Trainings done; learning TS and time management.',
        goals: [{
            goal: 'Maintain ECE Level 1 and complete core ISBE compliance (IELG, ERS, WEEC).',
            pdSupport: 'Complete 1 monthly Gateways workshop; apply IELG to classroom transitions and communication.',
            measurement: 'Updated PDR records.'
        }]
    }
];

(async () => {
    const log = [];
    const staff = await getJSON('/api/staff');
    if (!staff) { console.log('Could not read /api/staff'); return; }
    const dev = await getJSON('/api/dev-plans');
    if (!dev) { console.log('Could not read /api/dev-plans — is the table deployed?'); return; }
    if (!Object.prototype.hasOwnProperty.call((dev.plans || [{}])[0] || {}, 'Strengths') && (dev.plans || []).length) {
        console.log('The Strengths column is not live. Deploy and restart first.');
        return;
    }

    for (const p of PLANS) {
        const rec = staff.find(s => s.Name === p.staffName);
        if (!rec) {
            log.push(`SKIPPED ${p.docName}: no staff record`
                + (p.departed ? ' (no longer employed — plan exists on paper only)' : ' — name may not match'));
            continue;
        }
        const fresh = await getJSON('/api/dev-plans') || { plans: [], goals: [] };
        const existing = (fresh.plans || []).find(x => String(x.StaffId) === String(rec.Id)
            && (x.SchoolYear || '') === SCHOOL_YEAR);
        let planId = existing ? existing.Id : null;

        if (existing) {
            // A plan already here with no goals means an earlier run created the
            // plan but could not attach them. Backfill rather than skip.
            const has = (fresh.goals || []).filter(g => String(g.PlanId) === String(existing.Id)).length;
            if (has) { log.push(`SKIPPED ${p.staffName}: already has a ${SCHOOL_YEAR} plan with ${has} goal(s)`); continue; }
            log.push(`BACKFILL ${p.staffName}: plan ${planId} exists with no goals`);
        } else {
            const r = await call('POST', '/api/dev-plans', {
                staffId: rec.Id, schoolYear: SCHOOL_YEAR, planDate: PLAN_DATE,
                planType: 'Annual', location: p.location, supervisorName: p.supervisor,
                strengths: p.strengths || '', growthAreas: p.growth || '',
                favoriteAspect: p.favorite || '', frustrations: p.frustrations || '',
                initialDate: PLAN_DATE, reviewDate: YEAR_END_DUE,
                midYearDate: '', midYearNotes: '', yearEndDate: '', yearEndNotes: ''
            });
            if (r.status !== 200) { log.push(`FAILED ${p.staffName}: HTTP ${r.status} ${r.body.slice(0, 120)}`); continue; }
            /* Do not trust the id echoed back: an older server build returned 0.
               Re-read and match on staff plus year, which is unique by design. */
            const after = await getJSON('/api/dev-plans') || { plans: [] };
            const mine = (after.plans || []).filter(x => String(x.StaffId) === String(rec.Id)
                && (x.SchoolYear || '') === SCHOOL_YEAR)
                .sort((a, b) => (+b.Id) - (+a.Id));
            planId = mine.length ? mine[0].Id : null;
            if (!planId) { log.push(`FAILED ${p.staffName}: plan created but its id could not be resolved`); continue; }
        }

        let n = 0;
        for (let i = 0; i < p.goals.length; i++) {
            const g = p.goals[i];
            const gr = await call('POST', '/api/dev-goals', {
                planId: planId, goal: g.goal, pdSupport: g.pdSupport, measurement: g.measurement,
                midYearReviewDate: MID_YEAR_DUE, midYearComments: '', yearEndComments: '',
                status: 'Open', sortOrder: i
            });
            if (gr.status === 200) n++;
        }
        log.push(`  -> ${p.staffName}: plan ${planId}, ${n} of ${p.goals.length} goal(s) attached, supervisor ${p.supervisor}`);
    }

    // What the document says versus who is actually on staff.
    const named = PLANS.map(p => p.staffName);
    const noPlan = staff.filter(s => !named.includes(s.Name)).map(s => s.Name);
    log.push('');
    log.push('Staff with no 2025-26 plan on the document: ' + (noPlan.join(', ') || 'none'));
    console.log(log.join('\n'));
})();
