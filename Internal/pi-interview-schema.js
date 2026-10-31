/* ══════════════════════════════════════════════════════════════════════════
   The Parent Interview form, in ONE place.

   The whole-state Prevention Initiative Parent Interview is a ~100-field form. It
   is rendered on the ISBE admin roster (isbe.html) AND on the parent portal
   (parent.html), and both must show the identical questions in the identical order
   — the detail here is what a child is entered into SIS from. So the schema and the
   engine that renders / serializes / loads / prefills it live here, loaded by both
   pages, rather than being copied into each.

   Everything is defined as a plain top-level function/const, i.e. a global when this
   file is loaded via <script src>. That is deliberate: the admin page has always
   called these as bare globals (serializeInterviewForm(), piSetFieldValue(), ...),
   so moving them here changes nothing at the call sites.

   Field types:
     text | date | number | textarea            simple inputs
     select                                       opts = ['A','B'] dropdown
     yesno                                         Yes / No radios (value 'Yes'|'No')
     radio                                         opts = [['val','Label'], ...]
     checks                                        opts = ['A','B',...] multi-select -> array
     repeat                                        opts = ['Col1','Col2'] -> array of {Col1,Col2}
   `full:true` spans both columns. Ids are the formData keys.
   ══════════════════════════════════════════════════════════════════════════ */
const PI_INTERVIEW_SCHEMA = [
    { title: 'Interview', fields: [
        { id: 'personInterviewed', label: 'Person interviewed', type: 'text' },
        { id: 'relationship', label: 'Relationship to child', type: 'text' },
        { id: 'childFullName', label: 'Child full name', type: 'text' },
        { id: 'childDob', label: 'Child date of birth', type: 'date' },
        { id: 'nameToBeCalled', label: 'Name the child likes to be called', type: 'text' },
        { id: 'howHeard', label: 'How did you hear about this program?', type: 'text' },
    ] },
    { title: 'Parent / Guardian 1', fields: [
        { id: 'parent1Name', label: 'Name', type: 'text' },
        { id: 'parent1Dob', label: 'Date of birth', type: 'date' },
        { id: 'parent1Address', label: 'Address', type: 'text', full: true },
        { id: 'parent1City', label: 'City', type: 'text' },
        { id: 'parent1State', label: 'State', type: 'text' },
        { id: 'parent1Zip', label: 'ZIP', type: 'text' },
        { id: 'parent1Phone', label: 'Phone', type: 'text' },
        { id: 'parent1Email', label: 'Email', type: 'text' },
        { id: 'parent1Marital', label: 'Marital status', type: 'text' },
        { id: 'parent1Language', label: 'Language spoken in home', type: 'text' },
        { id: 'parent1Translator', label: 'Translator needed?', type: 'yesno' },
        { id: 'parent1Grade', label: 'Highest grade completed', type: 'text' },
        { id: 'parent1Employer', label: 'Place of employment', type: 'text' },
        { id: 'parent1WorkPhone', label: 'Work phone', type: 'text' },
    ] },
    /* collapseField: a boolean field whose checkbox lives in the section header; when
       checked it hides and clears the rest of the section (a one-parent household has
       no second guardian to record). */
    { title: 'Parent / Guardian 2', collapseField: 'parent2NA', fields: [
        { id: 'parent2NA', label: 'No second parent / guardian (not applicable)', type: 'sectionToggle' },
        { id: 'parent2Name', label: 'Name', type: 'text' },
        { id: 'parent2Dob', label: 'Date of birth', type: 'date' },
        // sameAddrFrom: shows a "same as Parent/Guardian 1" checkbox above this field
        // that copies + mirrors PG1's address block into PG2 and locks these fields.
        { id: 'parent2Address', label: 'Address', type: 'text', full: true,
          sameAddr: { toggleId: 'parent2SameAddr', toggleLabel: 'Same address as Parent / Guardian 1',
                      pairs: [['parent1Address', 'parent2Address'], ['parent1City', 'parent2City'],
                              ['parent1State', 'parent2State'], ['parent1Zip', 'parent2Zip']] } },
        { id: 'parent2City', label: 'City', type: 'text' },
        { id: 'parent2State', label: 'State', type: 'text' },
        { id: 'parent2Zip', label: 'ZIP', type: 'text' },
        { id: 'parent2Phone', label: 'Phone', type: 'text' },
        { id: 'parent2Email', label: 'Email', type: 'text' },
        { id: 'parent2Marital', label: 'Marital status', type: 'text' },
        { id: 'parent2Language', label: 'Language spoken in home', type: 'text' },
        { id: 'parent2Translator', label: 'Translator needed?', type: 'yesno' },
        { id: 'parent2Grade', label: 'Highest grade completed', type: 'text' },
        { id: 'parent2Employer', label: 'Place of employment', type: 'text' },
        { id: 'parent2WorkPhone', label: 'Work phone', type: 'text' },
    ] },
    { title: 'Household & Siblings', fields: [
        { id: 'childLivesWith', label: 'Child lives with', type: 'radio', full: true,
          opts: [['parents', 'Parent(s)'], ['foster', 'Foster parent(s) / legal guardian(s)'], ['other', 'Other']] },
        { id: 'childLivesWithOther', label: 'If other, specify', type: 'text', full: true },
        { id: 'siblings', label: 'Siblings', type: 'repeat', full: true, opts: ['Name', 'Date of birth'] },
        { id: 'siblingAcademicTrouble', label: 'Are any siblings having academic difficulty or trouble in school? Explain.', type: 'textarea', full: true },
    ] },
    { title: 'Child\u2019s Medical History', fields: [
        { id: 'pregnancyIssue', label: 'Anything unusual about the pregnancy/delivery or serious health problems at birth?', type: 'yesno' },
        { id: 'pregnancyIssueExplain', label: 'If yes, explain', type: 'text' },
        { id: 'pregnancyLength', label: 'Length of pregnancy', type: 'text' },
        { id: 'birthWeight', label: 'Weight at birth', type: 'text' },
        { id: 'currentWeight', label: 'Current weight', type: 'text' },
        { id: 'currentHeight', label: 'Current height', type: 'text' },
        { id: 'feedingDifficulty', label: 'Feeding difficulties as an infant?', type: 'yesno' },
        { id: 'feedingExplain', label: 'If yes, explain', type: 'text' },
        { id: 'respirator', label: 'Was this child on a respirator?', type: 'yesno' },
        { id: 'respiratorHowLong', label: 'If so, how long?', type: 'text' },
        { id: 'healthIssues', label: 'Is your child experiencing health issues? (note if chronic/terminal)', type: 'textarea', full: true },
        { id: 'disabilityYN', label: 'Does your child have a diagnosed disability?', type: 'yesno' },
        { id: 'disabilityExplain', label: 'If yes, explain', type: 'text' },
        { id: 'cfcReferral', label: 'Needs a referral to Child and Family Connections?', type: 'yesno' },
        { id: 'medications', label: 'Is this child taking any medication(s)?', type: 'yesno' },
        { id: 'medicationsWhat', label: 'What medication(s) / why (condition)', type: 'text' },
        { id: 'surgeries', label: 'Surgeries', type: 'repeat', full: true, opts: ['Surgery', 'Date', 'Hospital'] },
        { id: 'doctors', label: 'Doctor(s)', type: 'repeat', full: true, opts: ['Doctor', 'Clinic / Office', 'Phone'] },
    ] },
    { title: 'Symptoms, Illness & Screening', fields: [
        { id: 'symptoms', label: 'Do you notice, or has a doctor reported, any of the following? (check all)', type: 'checks', full: true,
          opts: ['Thumb sucking', 'Nail biting', 'Epilepsy', 'Heart trouble', 'Overtired', 'Lack of appetite',
                 'Overweight', 'Underweight', 'Frequent headache', 'Nightmares', 'Asthma', 'Allergies',
                 'Frequent indigestion', 'Frequent constipation', 'Frequent diarrhea', 'Vomiting',
                 'Frequent fevers', 'Sinus trouble', 'Nose bleeding', 'Rashes', 'Frequent ear infections',
                 'Night terrors', 'Communicable diseases'] },
        { id: 'symptomsExplain', label: 'Allergies / communicable diseases \u2014 explain', type: 'text', full: true },
        { id: 'illnesses', label: 'Illness history', type: 'repeat', full: true, opts: ['Illness', 'Yes/No', 'Age', 'Hospitalization / where'] },
        { id: 'hearingProblem', label: 'Hearing problem?', type: 'yesno' },
        { id: 'hearingDescribe', label: 'If yes, describe / adaptive equipment', type: 'text' },
        { id: 'visionProblem', label: 'Vision problems?', type: 'yesno' },
        { id: 'visionDescribe', label: 'If yes, describe / adaptive equipment', type: 'text' },
        { id: 'developmentalConcern', label: 'Diagnosed with a developmental concern?', type: 'yesno' },
        { id: 'developmentalDescribe', label: 'If yes, describe', type: 'text' },
        { id: 'therapies', label: 'Therapy services received', type: 'repeat', full: true, opts: ['Service', 'Therapist', 'Agency / Clinic', 'Phone'] },
    ] },
    { title: 'Social History', fields: [
        { id: 'childcare', label: 'Attends a child care program or in-home care?', type: 'yesno' },
        { id: 'childcareWhere', label: 'Where?', type: 'text' },
        { id: 'playsWithOthers', label: 'Opportunities to play with other children?', type: 'yesno' },
        { id: 'playsWithOthersWhere', label: 'Where?', type: 'text' },
        { id: 'drugAlcohol', label: 'Family experienced alcohol or drug abuse?', type: 'yesno' },
        { id: 'drugAlcoholExplain', label: 'If yes, explain', type: 'text' },
        { id: 'trauma', label: 'You or your child exposed to stress, trauma, or violence?', type: 'yesno' },
        { id: 'traumaExplain', label: 'If yes, explain', type: 'text' },
        { id: 'dcfs', label: 'Family currently receiving DCFS services for abuse/neglect?', type: 'yesno' },
        { id: 'caregiverIllness', label: 'Any primary caregiver with chronic/terminal illness, mental illness, or disability?', type: 'yesno' },
        { id: 'caregiverIllnessExplain', label: 'If yes, explain', type: 'text' },
        { id: 'motherAgeFirstChild', label: 'Age of mother at birth of first child', type: 'text' },
        { id: 'fatherAgeFirstChild', label: 'Age of father at birth of first child', type: 'text' },
        { id: 'immigrated', label: 'Family recently immigrated?', type: 'yesno' },
        { id: 'activeMilitary', label: 'Any primary caregiver on active duty in the military?', type: 'yesno' },
        { id: 'incarcerated', label: 'Any primary caregiver incarcerated?', type: 'yesno' },
        { id: 'familyDeath', label: 'Death in the immediate family (parent, child, sibling)?', type: 'yesno' },
        { id: 'familyDeathExplain', label: 'If yes, explain', type: 'text' },
        { id: 'socialize', label: 'Opportunities to socialize with family and friends? Explain.', type: 'textarea', full: true },
        { id: 'favoriteActivities', label: 'Child\u2019s most enjoyable activities', type: 'textarea', full: true },
        { id: 'familyActivities', label: 'What do you enjoy doing as a family?', type: 'textarea', full: true },
        { id: 'fears', label: 'What frightens your child?', type: 'textarea', full: true },
        { id: 'comfort', label: 'What do you do to comfort your child?', type: 'textarea', full: true },
        { id: 'transitions', label: 'How does your child respond to transitions?', type: 'textarea', full: true },
        { id: 'typicalDay', label: 'What is a typical day like for your family?', type: 'textarea', full: true },
        { id: 'developmentVsPeers', label: 'Is your child\u2019s development similar to peers? Explain.', type: 'textarea', full: true },
        { id: 'regression', label: 'Noticed any regression in development?', type: 'yesno' },
        { id: 'regressionExplain', label: 'If yes, explain', type: 'text' },
    ] },
    { title: 'Nutrition, Sleep & Pregnancy', fields: [
        { id: 'significantPeople', label: 'Significant people in your child\u2019s life (person / relationship)', type: 'textarea', full: true },
        { id: 'enoughToEat', label: 'Does everyone in your family get enough to eat?', type: 'yesno' },
        { id: 'freshFoodAccess', label: 'A place in your community to get fresh food?', type: 'yesno' },
        { id: 'eatingSchedule', label: 'Child\u2019s drinking/eating and eating schedule', type: 'textarea', full: true },
        { id: 'sleepSchedule', label: 'Child\u2019s sleeping / napping schedule', type: 'textarea', full: true },
        { id: 'behaviorConcerns', label: 'Behaviors that concern you?', type: 'yesno' },
        { id: 'behaviorConcernsExplain', label: 'If yes, explain', type: 'text' },
        { id: 'specialInstructions', label: 'Special information / instructions for program staff', type: 'textarea', full: true },
        { id: 'currentPregnancy', label: 'Current pregnancy?', type: 'yesno' },
        { id: 'pregnancyEDD', label: 'Estimated date of delivery', type: 'text' },
        { id: 'pregnancyConcerns', label: 'Any difficulties or concerns with this pregnancy? Explain.', type: 'textarea', full: true },
    ] },
    { title: 'Household, Financial & Insurance', fields: [
        { id: 'transportation', label: 'Family has transportation available?', type: 'yesno' },
        { id: 'moves', label: 'Number of times family has moved in the past year', type: 'text' },
        { id: 'livingSituation', label: 'Current living situation', type: 'radio', full: true,
          opts: [['stable', 'Fixed, regular, adequate nighttime residence'],
                 ['shares', 'Shares housing due to loss of housing / hardship'],
                 ['motel', 'Motel / hotel / camping grounds'],
                 ['emergency', 'Emergency or transitional housing'],
                 ['notDesigned', 'Place not designed for regular sleeping'],
                 ['car', 'Car, park, public space, substandard housing'],
                 ['awaitingFoster', 'Child awaiting foster care placement'],
                 ['unaccompanied', 'Unaccompanied youth']] },
        { id: 'livingSituationNote', label: 'Living situation note (from intake)', type: 'text', full: true },
        { id: 'readingEase', label: 'As a parent, is reading and comprehension easy or difficult for you?', type: 'radio',
          opts: [['easy', 'Easy'], ['difficult', 'Difficult']] },
        { id: 'householdStructure', label: 'Household structure', type: 'radio', full: true,
          opts: [['bothParents', 'Both parents at home'], ['singleParent', 'Single parent at home'],
                 ['otherAdult', 'Adult other than parent also in home'], ['sharedCustody', 'Shared custody'],
                 ['teenParent', 'Teen parent lives with parents'], ['other', 'Other']] },
        { id: 'employmentP1', label: 'Employment status \u2014 Parent 1', type: 'select',
          opts: ['', 'Unemployed, not seeking', 'Unemployed, seeking', 'Employed < 20 hrs/wk', 'Employed 20+ hrs/wk'] },
        { id: 'employmentP2', label: 'Employment status \u2014 Parent 2', type: 'select',
          opts: ['', 'Unemployed, not seeking', 'Unemployed, seeking', 'Employed < 20 hrs/wk', 'Employed 20+ hrs/wk'] },
        { id: 'currentStudent', label: 'Current student?', type: 'yesno' },
        { id: 'income', label: 'Household annual income', type: 'text' },
        { id: 'householdSize', label: 'Number of people in the household', type: 'text' },
        { id: 'publicPrograms', label: 'Public programs', type: 'checks', full: true,
          opts: ['WIC', 'Medicaid', 'SNAP', 'TANF', 'CCAP'] },
        { id: 'proofOfIncome', label: 'Proof of income (if no public benefits)', type: 'checks', full: true,
          opts: ['Paystubs', 'SSI', 'Other'] },
        { id: 'insurance', label: 'Insurance', type: 'checks', full: true,
          opts: ['Private (parent\u2019s work)', 'All Kids', 'Medicaid', 'No insurance', 'Other', 'Covered for another pregnancy'] },
    ] },
    /* The old "From the Pre-Enrollment Application" section was removed: it duplicated
       data that already lives on the waiting list and the Weighted Eligibility form,
       which is the only place those priority-population answers are needed. The Parent
       Interview no longer re-displays them. */
    { title: 'Interview Summary', fields: [
        { id: 'parentGoals', label: 'Parent goals for their child', type: 'textarea', full: true, ph: 'What goals do the parents have for their child this year?' },
        { id: 'parentConcerns', label: 'Parent concerns', type: 'textarea', full: true, ph: 'Any concerns the parents would like to discuss?' },
        { id: 'childStrengths', label: 'Child strengths', type: 'textarea', full: true, ph: 'What strengths does the child show at home?' },
        { id: 'dreamsGoals', label: 'Dreams / goals for your child\u2019s future', type: 'textarea', full: true },
        { id: 'otherInfo', label: 'Anything else that will help us serve you better', type: 'textarea', full: true },
        { id: 'pickup', label: 'Authorized pick-up list', type: 'repeat', full: true, opts: ['Name', 'Phone', 'Relationship'] },
        { id: 'additionalNotes', label: 'Additional notes (staff)', type: 'textarea', full: true },
    ] },
];

// Flat id -> field lookup, built once.
const PI_FIELD_BY_ID = (function () {
    const m = {};
    PI_INTERVIEW_SCHEMA.forEach(sec => sec.fields.forEach(f => { m[f.id] = f; }));
    return m;
})();

// toggleId -> { pairs } for every field carrying a sameAddr spec, so the sync/toggle
// handlers can find the copy map by the checkbox id alone.
const PI_SAMEADDR_BY_TOGGLE = (function () {
    const m = {};
    PI_INTERVIEW_SCHEMA.forEach(sec => sec.fields.forEach(f => {
        if (f.sameAddr) m[f.sameAddr.toggleId] = f.sameAddr;
    }));
    return m;
})();

function piEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* Render one field to HTML. Values are set after render by loadInterviewForm/prefill,
   so this only builds empty controls. */
function piRenderField(f) {
    // A sectionToggle renders in the section header (see renderInterviewForm), not in
    // the field grid, so skip it here.
    if (f.type === 'sectionToggle') return '';
    const cls = 'pi-field' + (f.full ? ' pi-full' : '');
    // A field with a sameAddr spec gets a "same as ..." checkbox above its label.
    const sameAddrToggle = f.sameAddr
        ? '<label class="pi-sameaddr"><input type="checkbox" id="pf_' + f.sameAddr.toggleId + '"'
          + ' onchange="piToggleSameAddr(\'' + f.sameAddr.toggleId + '\')">'
          + piEsc(f.sameAddr.toggleLabel) + '</label>'
        : '';
    const lbl = sameAddrToggle + '<label>' + piEsc(f.label) + '</label>';
    let ctrl = '';
    if (f.type === 'textarea') {
        ctrl = '<textarea id="pf_' + f.id + '" placeholder="' + piEsc(f.ph || '') + '"></textarea>';
    } else if (f.type === 'date') {
        ctrl = '<input type="date" id="pf_' + f.id + '">';
    } else if (f.type === 'select') {
        ctrl = '<select id="pf_' + f.id + '">'
            + f.opts.map(o => '<option value="' + piEsc(o) + '">' + (o ? piEsc(o) : '\u2014 select \u2014') + '</option>').join('')
            + '</select>';
    } else if (f.type === 'yesno') {
        ctrl = '<div class="pi-yesno">'
            + ['Yes', 'No'].map(v => '<label class="pi-opt"><input type="radio" name="pf_' + f.id + '" value="' + v + '">' + v + '</label>').join('')
            + '</div>';
    } else if (f.type === 'radio') {
        /* A short list (2-3 options, e.g. Easy/Difficult) gets .pi-short so the CSS
           packs it to content width rather than stretching each choice across a wide
           column. Long lists (living situation, household structure) keep the full
           even-column grid. */
        ctrl = '<div class="pi-radio-row' + (f.opts.length <= 3 ? ' pi-short' : '') + '">'
            + f.opts.map(o => '<label class="pi-opt"><input type="radio" name="pf_' + f.id + '" value="' + piEsc(o[0]) + '">' + piEsc(o[1]) + '</label>').join('')
            + '</div>';
    } else if (f.type === 'checks') {
        ctrl = '<div class="pi-check-grid" id="pf_' + f.id + '">'
            + f.opts.map(o => '<label class="pi-opt"><input type="checkbox" value="' + piEsc(o) + '">' + piEsc(o) + '</label>').join('')
            + '</div>';
    } else if (f.type === 'repeat') {
        ctrl = '<div class="pi-repeat" id="pf_' + f.id + '" data-cols="' + piEsc(f.opts.join('|')) + '">'
            + '<table><thead><tr>' + f.opts.map(c => '<th>' + piEsc(c) + '</th>').join('') + '<th></th></tr></thead>'
            + '<tbody></tbody></table>'
            + '<button type="button" class="pi-repeat-add" onclick="piAddRepeatRow(\'' + f.id + '\')">+ Add row</button>'
            + '</div>';
    } else { // text / number
        ctrl = '<input type="text" id="pf_' + f.id + '" placeholder="' + piEsc(f.ph || '') + '">';
    }
    return '<div class="' + cls + '">' + lbl + ctrl + '</div>';
}

function renderInterviewForm() {
    const host = document.getElementById('piFormSections');
    if (!host) return;
    host.innerHTML = PI_INTERVIEW_SCHEMA.map(sec => {
        // A collapsible section (Parent/Guardian 2) puts its N/A toggle in the header
        // and wraps the fields in a body that the toggle can hide. The sectionToggle
        // field itself is rendered IN the header, not in the grid.
        if (sec.collapseField) {
            const header = '<h4 class="pi-section-head">' + piEsc(sec.title)
                + '<label class="pi-section-na"><input type="checkbox" id="pf_' + sec.collapseField + '"'
                + ' onchange="piToggleSection(\'' + sec.collapseField + '\')">'
                + piEsc(sectionToggleLabel(sec)) + '</label></h4>';
            const bodyFields = sec.fields.filter(f => f.type !== 'sectionToggle');
            return '<div class="pi-section" data-collapse="' + piEsc(sec.collapseField) + '">' + header
                + '<div class="pi-grid pi-section-body" data-collapse-body="' + piEsc(sec.collapseField) + '">'
                + bodyFields.map(piRenderField).join('') + '</div></div>';
        }
        return '<div class="pi-section"><h4>' + piEsc(sec.title) + '</h4>'
            + '<div class="pi-grid">' + sec.fields.map(piRenderField).join('') + '</div></div>';
    }).join('');

    // Live-sync: while a "same address" box is ticked, editing a Parent/Guardian 1
    // address field mirrors into Parent/Guardian 2. Attached once per source field.
    Object.keys(PI_SAMEADDR_BY_TOGGLE).forEach(toggleId => {
        PI_SAMEADDR_BY_TOGGLE[toggleId].pairs.forEach(([src]) => {
            const el = document.getElementById('pf_' + src);
            if (el) el.addEventListener('input', () => piSyncSameAddr(toggleId));
        });
    });
}

// The label for a section's collapse toggle comes from its sectionToggle field.
function sectionToggleLabel(sec) {
    const t = sec.fields.find(f => f.type === 'sectionToggle');
    return t ? t.label : 'Not applicable';
}

/* Collapse/expand a section from its header N/A checkbox. Collapsing hides the body
   and clears every field in it, so a "not applicable" section never saves stale data
   left over from before the box was ticked. */
function piToggleSection(fieldId) {
    const cb = document.getElementById('pf_' + fieldId);
    const body = document.querySelector('[data-collapse-body="' + fieldId + '"]');
    if (!cb || !body) return;
    const off = cb.checked;
    body.style.display = off ? 'none' : '';
    if (off) {
        const sec = PI_INTERVIEW_SCHEMA.find(s => s.collapseField === fieldId);
        if (sec) sec.fields.forEach(f => { if (f.type !== 'sectionToggle') piSetFieldValue(f.id, f.type === 'checks' || f.type === 'repeat' ? [] : ''); });
    }
}

/* Mirror the Parent/Guardian 1 address into Parent/Guardian 2 when the "same address"
   box is ticked: copy the values, keep them in sync as PG1 is edited, and disable the
   PG2 address fields so it reads as mirrored. Unticking re-enables them, leaving the
   copied values in place to edit. */
function piToggleSameAddr(fieldId) {
    const spec = PI_SAMEADDR_BY_TOGGLE[fieldId];
    if (!spec) return;
    const cb = document.getElementById('pf_' + fieldId);
    const on = !!(cb && cb.checked);
    spec.pairs.forEach(([src, dst]) => {
        if (on) piSetFieldValue(dst, (document.getElementById('pf_' + src) || {}).value || '');
        const dstEl = document.getElementById('pf_' + dst);
        if (dstEl) { dstEl.disabled = on; dstEl.classList.toggle('pi-mirrored', on); }
    });
}

// Keep PG2 address live-synced to PG1 while "same address" is on. Attached to the PG1
// address inputs after render.
function piSyncSameAddr(fieldId) {
    const spec = PI_SAMEADDR_BY_TOGGLE[fieldId];
    const cb = document.getElementById('pf_' + fieldId);
    if (!spec || !cb || !cb.checked) return;
    spec.pairs.forEach(([src, dst]) => piSetFieldValue(dst, (document.getElementById('pf_' + src) || {}).value || ''));
}

/* Append one blank row to a repeat table, or a row pre-filled from `values` (object
   keyed by column name). */
function piAddRepeatRow(fieldId, values) {
    const wrap = document.getElementById('pf_' + fieldId);
    if (!wrap) return;
    const cols = (wrap.getAttribute('data-cols') || '').split('|');
    const tbody = wrap.querySelector('tbody');
    const tr = document.createElement('tr');
    tr.innerHTML = cols.map(c =>
        '<td><input type="text" data-col="' + piEsc(c) + '" value="' + piEsc(values ? (values[c] || '') : '') + '"></td>'
    ).join('') + '<td><button type="button" class="pi-rowdel" title="Remove row" onclick="this.closest(\'tr\').remove()">\u00d7</button></td>';
    tbody.appendChild(tr);
}

/* Set one field's value by id (the schema id, not the pf_ prefix). Handles every type. */
function piSetFieldValue(id, value) {
    const f = PI_FIELD_BY_ID[id];
    if (!f) return;
    if (f.type === 'sectionToggle') {
        const cb = document.getElementById('pf_' + id);
        if (cb) cb.checked = value === true || value === 'true' || value === 1 || value === '1';
    } else if (f.type === 'yesno' || f.type === 'radio') {
        const els = document.getElementsByName('pf_' + id);
        els.forEach(el => { el.checked = (el.value === String(value)); });
    } else if (f.type === 'checks') {
        const arr = Array.isArray(value) ? value.map(String) : [];
        const wrap = document.getElementById('pf_' + id);
        if (wrap) wrap.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = arr.indexOf(cb.value) !== -1; });
    } else if (f.type === 'repeat') {
        const wrap = document.getElementById('pf_' + id);
        if (wrap) { wrap.querySelector('tbody').innerHTML = ''; (Array.isArray(value) ? value : []).forEach(row => piAddRepeatRow(id, row)); }
    } else {
        const el = document.getElementById('pf_' + id);
        if (el) el.value = value == null ? '' : value;
    }
}

/* Prefill = set the value AND tint the field so it is visible that it came from the
   record. Never overwrites with a blank. */
function piPrefill(id, value) {
    if (value == null || value === '') return;
    piSetFieldValue(id, value);
    const el = document.getElementById('pf_' + id);
    const wrap = el ? el.closest('.pi-field') : null;
    // radios/yesno have no single #pf_ element; find their field via a named input.
    if (wrap) wrap.classList.add('pi-prefilled');
    else {
        const named = document.getElementsByName('pf_' + id)[0];
        const w2 = named ? named.closest('.pi-field') : null;
        if (w2) w2.classList.add('pi-prefilled');
    }
}
function piPrefillGroup(id, values) {
    if (!values || !values.length) return;
    piSetFieldValue(id, values);
    const wrap = document.getElementById('pf_' + id);
    const field = wrap ? wrap.closest('.pi-field') : null;
    if (field) field.classList.add('pi-prefilled');
}

/* ══════════════════════════════════════════════════════════════════════════
   Pre-enrollment → Parent Interview crosswalk

   ONE place that says what fills what. This mapping used to be an imperative
   `if (x) piPrefill(...)` run copied into isbe.html (admin roster) and
   parent.html (parent portal), which is how the two drifted: the portal fell
   back to City_Town and the roster did not, and seventeen answers the intake
   endpoint already returned were mapped in neither.

   Two sources:
     enr   the enrollment row (rptMasterEnrollment) — the maintained copy
     pe    the pre-enrollment intake record from GET /api/student-intake/:id

   Precedence is per-field and deliberate, noted at each rule. Nothing ever
   overwrites with a blank (piPrefill no-ops on '' / null), and a saved
   interview is loaded AFTER this, so a saved answer always beats a prefill.
   ══════════════════════════════════════════════════════════════════════════ */

function piIsYes(v) {
    return ['yes', 'y', 'true', '1'].indexOf(String(v == null ? '' : v).trim().toLowerCase()) !== -1;
}
function piIsNo(v) {
    return ['no', 'n', 'false', '0'].indexOf(String(v == null ? '' : v).trim().toLowerCase()) !== -1;
}
/* The family's answer verbatim: Yes, No, or blank when they were never asked
   (older intake records predate some questions and come back empty). */
function piYesNo(v) {
    if (piIsYes(v)) return 'Yes';
    if (piIsNo(v)) return 'No';
    return '';
}
/* The 50%-FPL question is the only three-way one — "Not sure" is a real answer
   the public form offers, and it scores nothing, so it must not read as a No. */
function piYesNoUnsure(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (s === 'unsure' || s === 'not sure') return 'Unsure';
    return piYesNo(v);
}
/* One comma-joined benefits string -> the publicPrograms checkbox values. */
function piBenefitList(s) {
    const b = String(s == null ? '' : s).toLowerCase();
    if (!b) return [];
    return ['WIC', 'Medicaid', 'SNAP', 'TANF', 'CCAP'].filter(p => b.indexOf(p.toLowerCase()) !== -1);
}
// The public form's program codes, spelled out for a printed form.
const PI_PROGRAM_LABELS = {
    '0-2': 'Infant & Toddler (birth \u2013 2 years)',
    '2-3': '2-Year-Old Program (2 \u2013 3 years)',
    '3-5': 'Pre-School (3 \u2013 5 years)',
    'ba': 'Before & Afterschool (school age)'
};

const PI_INTERVIEW_PREFILL = [
    // ── Who we are talking to. The intake is the only place a parent/guardian
    //    name, phone, email or address is captured; enrollment drops all of it.
    ['personInterviewed', c => c.parentName],
    ['parent1Name', c => c.parentName],
    ['parent1Phone', c => c.pe.Phone],
    ['parent1Email', c => c.pe.Email],
    ['parent1Address', c => c.pe.Address],
    // City is on both records; the application is more specific than the
    // enrollment town field, so it wins and City_Town is the fallback.
    ['parent1City', c => c.pe.City || c.enr.City_Town],
    ['parent1Zip', c => c.pe.Zip],
    ['parent1Language', c => c.language],

    // ── Household and money. Staff maintain these on the enrollment record
    //    (F/R/P depends on them), so enrollment wins and the application is the
    //    fallback for a child enrolled before the values were copied across.
    ['income', c => c.enr.HouseholdIncome || c.pe.HouseholdIncome],
    ['householdSize', c => c.enr.HouseholdSize || c.pe.HouseholdSize],
    ['publicPrograms', c => piBenefitList(c.enr.PublicBenefits || c.pe.PublicBenefits)],
    ['livingSituationNote', c => c.pe.LivingSituation],

    /* ── Questions the state form already asks in its own words.
         Only a reported YES is carried over. A blank leaves the question open
         for the interview instead of putting a sensitive "No" in the family's
         mouth — and the appendix section records every answer verbatim anyway,
         so nothing is lost by leaving these open. */
    ['disabilityYN', c => (piIsYes(c.enr.IEP) || piIsYes(c.pe.IEP)) ? 'Yes' : ''],
    ['childLivesWith', c => (c.isFoster || piIsYes(c.pe.FosterAdopted)) ? 'foster' : ''],
    ['activeMilitary', c => (piIsYes(c.enr.Military) || piIsYes(c.pe.ActiveMilitary)) ? 'Yes' : ''],
    ['drugAlcohol', c => piIsYes(c.pe.SubstanceAbuse) ? 'Yes' : ''],
    ['trauma', c => piIsYes(c.pe.AbuseHistory) ? 'Yes' : ''],
    ['dcfs', c => piIsYes(c.pe.DcfsInvolvement) ? 'Yes' : ''],
    ['caregiverIllness', c => piIsYes(c.pe.MentalIllness) ? 'Yes' : ''],
    ['familyDeath', c => piIsYes(c.pe.FamilyDeath) ? 'Yes' : ''],
    ['incarcerated', c => piIsYes(c.pe.ParentIncarcerated) ? 'Yes' : ''],
    ['immigrated', c => piIsYes(c.pe.BornOutsideUS) ? 'Yes' : ''],
    ['livingSituation', c => piIsYes(c.pe.Homeless) ? 'shares' : ''],
    /* Household structure. The application asks two things that both land here:
       whether the family is single- or two-parent (LivingSituation), and whether a
       teen parent lives with their own parents (TeenParent). A teen-parent household
       is the more specific fact, so it wins; otherwise the both/single answer maps
       straight across. Left blank when the application said neither, so the
       interviewer still chooses among the options the intake cannot express
       (other adult in home, shared custody). */
    ['householdStructure', c => {
        if (piIsYes(c.pe.TeenParent)) return 'teenParent';
        const ls = String(c.pe.LivingSituation || '').trim().toLowerCase();
        if (ls === 'single parent' || ls === 'single') return 'singleParent';
        if (ls === 'both parents' || ls === 'both') return 'bothParents';
        return '';
    }],
    /* Non-English home → the Parent/Guardian 1 "translator needed?" question. The
       family told us at intake they primarily speak another language, so flag that a
       translator is worth arranging rather than leaving the interviewer to rediscover
       it. Only a Yes is carried; a No or blank leaves it open. */
    ['parent1Translator', c => piIsYes(c.pe.NonEnglishHome) ? 'Yes' : ''],
    ['additionalNotes', c => c.pe.Notes],

    // The "From the Pre-Enrollment Application" appendix was removed from the form, so
    // its prefill rules are gone too — that data stays on the Weighted Eligibility form.
];

/* Intake keys deliberately NOT mapped, so the next reader does not have to
   wonder whether they were forgotten:
     Id, MatchType       plumbing for the lookup itself
     ChildName,
     ChildBirthDate      already set from the enrollment record, which is the
                         maintained spelling and the one on the roster
     Score, WaitlistStatus
                         waiting-list prioritisation. PI5.H wants the eligibility
                         result in the file, and the weighted eligibility form is
                         where it lives; a priority score on a form the parent
                         signs would invite a conversation we do not want to have.
     HomeLanguage        used, but via c.language (it feeds two fields). */

/* Apply the whole crosswalk to the rendered form. Returns how many fields were
   filled, so a caller can show or hide its "pre-filled from the record" note
   without repeating the logic. */
function applyInterviewPrefill(student, intake) {
    const enr = student || {};
    /* Accept any intake-shaped object, and reject only an explicit found:false.
       The two callers hand us DIFFERENT shapes: the admin roster passes the
       /api/student-intake response, which carries found:true|false, while the
       parent portal passes data.preEnroll from its login response, which has no
       found key at all. Testing truthiness of `found` would therefore have
       silently dropped every prefill on the parent portal. A failed fetch, a
       null, or no record leaves the enrollment half of the mapping to apply. */
    const pe = (intake && typeof intake === 'object' && intake.found !== false) ? intake : {};
    const ctx = {
        enr: enr,
        pe: pe,
        parentName: [pe.ParentFirst, pe.ParentLast].filter(Boolean).join(' '),
        // The application is the family's own words and the more recent of the
        // two, so it wins for language.
        language: pe.HomeLanguage || enr.HomeLanguage || '',
        isFoster: String(enr.Category || '').trim().toLowerCase() === 'foster'
    };

    let filled = 0;
    PI_INTERVIEW_PREFILL.forEach(rule => {
        const id = rule[0];
        let v;
        // One bad value must not abandon the rest of the prefill.
        try { v = rule[1](ctx); } catch (e) { v = ''; }
        if (v == null || v === '') return;
        if (Array.isArray(v)) {
            if (!v.length) return;
            piPrefillGroup(id, v);
        } else {
            piPrefill(id, v);
        }
        filled++;
    });

    /* PI5.L's preferred language sits outside the schema, in the admin modal's
       own Language & Translation block. Fill it from the same source rather
       than making the caller re-derive it. Only when empty, so re-opening a
       saved interview never clobbers what was recorded. */
    const langEl = document.getElementById('piPreferredLanguage');
    if (langEl && !langEl.value && ctx.language) { langEl.value = ctx.language; filled++; }

    return filled;
}

/* Read the whole form into a plain object keyed by schema id. */
function serializeInterviewForm() {
    const out = {};
    PI_INTERVIEW_SCHEMA.forEach(sec => sec.fields.forEach(f => {
        if (f.type === 'sectionToggle') {
            const cb = document.getElementById('pf_' + f.id);
            out[f.id] = !!(cb && cb.checked);
        } else if (f.type === 'yesno' || f.type === 'radio') {
            const checked = Array.prototype.filter.call(document.getElementsByName('pf_' + f.id), el => el.checked)[0];
            out[f.id] = checked ? checked.value : '';
        } else if (f.type === 'checks') {
            const wrap = document.getElementById('pf_' + f.id);
            out[f.id] = wrap ? Array.prototype.filter.call(wrap.querySelectorAll('input[type=checkbox]'), cb => cb.checked).map(cb => cb.value) : [];
        } else if (f.type === 'repeat') {
            const wrap = document.getElementById('pf_' + f.id);
            const rows = [];
            if (wrap) wrap.querySelectorAll('tbody tr').forEach(tr => {
                const row = {}; let any = false;
                tr.querySelectorAll('input[data-col]').forEach(inp => { row[inp.getAttribute('data-col')] = inp.value; if (inp.value.trim()) any = true; });
                if (any) rows.push(row);
            });
            out[f.id] = rows;
        } else {
            const el = document.getElementById('pf_' + f.id);
            out[f.id] = el ? el.value : '';
        }
    }));
    // The "same address" toggles are inline on a field, not schema fields of their own.
    Object.keys(PI_SAMEADDR_BY_TOGGLE).forEach(toggleId => {
        const cb = document.getElementById('pf_' + toggleId);
        out[toggleId] = !!(cb && cb.checked);
    });
    return out;
}

/* Load a saved formData object into the rendered form. */
function loadInterviewForm(fd) {
    if (!fd) return;
    PI_INTERVIEW_SCHEMA.forEach(sec => sec.fields.forEach(f => {
        if (Object.prototype.hasOwnProperty.call(fd, f.id)) piSetFieldValue(f.id, fd[f.id]);
    }));
    // Restore the inline "same address" toggles (not schema fields), then re-apply the
    // collapse/mirror side-effects so a reopened form looks exactly as it was saved.
    Object.keys(PI_SAMEADDR_BY_TOGGLE).forEach(toggleId => {
        const cb = document.getElementById('pf_' + toggleId);
        if (cb) cb.checked = fd[toggleId] === true || fd[toggleId] === 'true' || fd[toggleId] === 1 || fd[toggleId] === '1';
        piToggleSameAddr(toggleId);
    });
    PI_INTERVIEW_SCHEMA.forEach(sec => { if (sec.collapseField) piToggleSection(sec.collapseField); });
}

/* Turn the serialized form into printable blocks (one per section, answered fields
   only) for the filed PDF. */
function interviewFormBlocks(fd) {
    const blocks = [];
    PI_INTERVIEW_SCHEMA.forEach(sec => {
        const lines = [];
        sec.fields.forEach(f => {
            const v = fd[f.id];
            if (v == null || v === '') return;
            if (Array.isArray(v)) {
                if (!v.length) return;
                if (f.type === 'checks') lines.push(f.label + ': ' + v.join(', '));
                else lines.push(f.label + ':\n' + v.map(row => '  \u2022 ' + Object.keys(row).map(k => row[k]).filter(Boolean).join(' / ')).join('\n'));
            } else {
                lines.push(f.label + ': ' + v);
            }
        });
        if (lines.length) blocks.push({ heading: sec.title, text: lines.join('\n') });
    });
    return blocks;
}

/* ══════════════════════════════════════════════════════════════════════════
   DOM-free prefill  (server side)

   applyInterviewPrefill() above writes straight into rendered inputs, so it only
   runs in a browser. The server needs the SAME crosswalk to produce the pre-filled
   Parent Interview PDF it files at enrollment — and it must be the same crosswalk,
   not a second copy, or the two drift exactly the way isbe.html and parent.html once
   did. So the context-building and rule-application are factored out here and shared:
   the browser path tints DOM fields, this path fills a plain object, both walk the one
   PI_INTERVIEW_PREFILL table.

   Takes the enrollment row and the intake record in the SAME shapes the browser gets:
     student  the rptMasterEnrollment row (c.enr in the rules)
     intake   the /api/student-intake record (c.pe); found:false or null = none
   Returns { formData, preferredLanguage, filled } where formData is keyed by schema id
   and is exactly what loadInterviewForm()/interviewFormBlocks()/serializeInterviewForm()
   expect. Nothing is written for a blank value, so an unanswered question stays absent
   from formData rather than becoming an empty string — the same "never a blank" rule
   piPrefill enforces in the browser. */
function buildInterviewPrefillContext(student, intake) {
    const enr = student || {};
    // Mirror applyInterviewPrefill: accept any intake-shaped object, reject only an
    // explicit found:false (the two historical callers pass different shapes).
    const pe = (intake && typeof intake === 'object' && intake.found !== false) ? intake : {};
    return {
        enr: enr,
        pe: pe,
        parentName: [pe.ParentFirst, pe.ParentLast].filter(Boolean).join(' '),
        language: pe.HomeLanguage || enr.HomeLanguage || '',
        isFoster: String(enr.Category || '').trim().toLowerCase() === 'foster'
    };
}

function interviewFormDataFromRecords(student, intake) {
    const ctx = buildInterviewPrefillContext(student, intake);
    const formData = {};
    let filled = 0;
    PI_INTERVIEW_PREFILL.forEach(rule => {
        const id = rule[0];
        let v;
        // One bad value must not abandon the rest of the prefill (same as the DOM path).
        try { v = rule[1](ctx); } catch (e) { v = ''; }
        if (v == null || v === '') return;
        if (Array.isArray(v)) {
            if (!v.length) return;
            formData[id] = v;
        } else {
            formData[id] = v;
        }
        filled++;
    });
    // PI5.L preferred language lives outside the schema (in the admin modal's own
    // Language & Translation block), so it is returned separately for the caller to
    // store on the ParentInterviews row rather than in the form blob.
    return { formData: formData, preferredLanguage: ctx.language, filled: filled };
}

/* ══════════════════════════════════════════════════════════════════════════
   Node export guard

   In the browser this file is loaded via <script src> and every name above is a
   global, which is what the admin roster and parent portal call. Under Node (the
   server's document seeder, and the pre-enrollment → interview cross-check script)
   the same definitions are reached through require(). `module` is undefined in the
   browser, so the guard keeps the one file serving both without a bundler.

   Only the DOM-free pieces are exported: the schema, the crosswalk table, the pure
   helpers, the printable-blocks builder, and the server-side transform. The
   DOM-bound functions (renderInterviewForm, serializeInterviewForm, piPrefill, …)
   are intentionally left out — they do nothing useful without a document. */
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        PI_INTERVIEW_SCHEMA: PI_INTERVIEW_SCHEMA,
        PI_FIELD_BY_ID: PI_FIELD_BY_ID,
        PI_INTERVIEW_PREFILL: PI_INTERVIEW_PREFILL,
        PI_PROGRAM_LABELS: PI_PROGRAM_LABELS,
        piIsYes: piIsYes,
        piIsNo: piIsNo,
        piYesNo: piYesNo,
        piYesNoUnsure: piYesNoUnsure,
        piBenefitList: piBenefitList,
        interviewFormBlocks: interviewFormBlocks,
        buildInterviewPrefillContext: buildInterviewPrefillContext,
        interviewFormDataFromRecords: interviewFormDataFromRecords
    };
}
