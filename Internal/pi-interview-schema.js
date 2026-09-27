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
    { title: 'Parent / Guardian 2', fields: [
        { id: 'parent2Name', label: 'Name', type: 'text' },
        { id: 'parent2Dob', label: 'Date of birth', type: 'date' },
        { id: 'parent2Address', label: 'Address', type: 'text', full: true },
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

function piEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* Render one field to HTML. Values are set after render by loadInterviewForm/prefill,
   so this only builds empty controls. */
function piRenderField(f) {
    const cls = 'pi-field' + (f.full ? ' pi-full' : '');
    const lbl = '<label>' + piEsc(f.label) + '</label>';
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
        ctrl = '<div class="pi-radio-row">'
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
    host.innerHTML = PI_INTERVIEW_SCHEMA.map(sec =>
        '<div class="pi-section"><h4>' + piEsc(sec.title) + '</h4>'
        + '<div class="pi-grid">' + sec.fields.map(piRenderField).join('') + '</div></div>'
    ).join('');
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
    if (f.type === 'yesno' || f.type === 'radio') {
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

/* Read the whole form into a plain object keyed by schema id. */
function serializeInterviewForm() {
    const out = {};
    PI_INTERVIEW_SCHEMA.forEach(sec => sec.fields.forEach(f => {
        if (f.type === 'yesno' || f.type === 'radio') {
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
    return out;
}

/* Load a saved formData object into the rendered form. */
function loadInterviewForm(fd) {
    if (!fd) return;
    PI_INTERVIEW_SCHEMA.forEach(sec => sec.fields.forEach(f => {
        if (Object.prototype.hasOwnProperty.call(fd, f.id)) piSetFieldValue(f.id, fd[f.id]);
    }));
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
