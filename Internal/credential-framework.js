/* The Gateways ECE Credential and Infant Toddler Credential level tables, and the
   arithmetic for working out what a given staff record still needs.

   Transcribed from the two framework documents in Internal/documents:
     - "ECE Credential Framework.pdf"            PD229, revised 12/19/2022
     - "Infant Toddler Credential Framework.pdf" PD229, revised 12/19/2022
   Both are the versions Clete added on 9/10/2026.

   Three things about this file are deliberate.

   1. It reports the education and experience gates, and does NOT report competencies
      as met or unmet. Each level also requires a named list of competencies (ITC HGD1,
      ITC HSW2 and so on) which are assessed by Gateways against transcripts and
      training records. Nothing in our staff records tracks them per person, so the
      competency list is shown as something to check rather than scored. Guessing a
      competency from a course title is how an application gets sent back.

   2. It separates what counts today from what would count if the transcript were with
      the Registry. College credit Gateways has not received does not raise a level
      however many hours were earned, and for several people here that gap is the whole
      story — Sue Engel has 53 semester hours at SWIC against a registry that shows a
      high school diploma.

   3. The supervised-experience route is surfaced as prominently as the documented-hours
      route. Every ITC level offers both, and for somebody already working in an
      infant/toddler room the supervised route is often weeks away while the documented
      route needs years of verified history from former employers. */
(function (root) {
'use strict';

/* ── ECE Credential ──────────────────────────────────────────────────────────
   Level 1 is a training course rather than an education level, so it carries no
   education or experience gate here. */
var ECE_LEVELS = [
    {
        level: 1,
        education: 'A 48 clock hour training through your local CCR&R, or 16 modules online. '
                 + 'A Professional Educator License endorsed in Early Childhood Education also '
                 + 'meets it.',
        rank: 0,
        experience: null
    },
    {
        level: 2,
        education: 'High school diploma or GED',
        rank: 2,
        experience: { supervised: 10, supervisedLabel: 'hours of ECE observation', documented: 200 },
        /* Note IRE stops at 2 here, where the ITC list runs to IRE3. The two credentials
           use the same competency family names for different requirements, so they cannot
           be read across. */
        adds: ['HGD1', 'HGD2', 'HGD3', 'HSW1', 'HSW2', 'IRE1', 'IRE2',
               'FCR1', 'FCR2', 'FCR3', 'PPD1', 'PPD2']
    },
    {
        level: 3,
        education: 'Nine semester hours \u2014 three each of Math, English and a General Education '
                 + 'elective such as Psychology, Sociology or Science. All nine must be credit '
                 + 'bearing, non-developmental, and 100 level or above.',
        rank: 3,
        experience: { supervised: 10, documented: 400 },
        adds: ['HSW3', 'HSW4', 'HSW5', 'OA1', 'OA2', 'OA3', 'CPD1', 'CPD2', 'CPD3',
               'IRE3', 'IRE4', 'FCR4', 'FCR5', 'FCR6', 'PPD3', 'PPD4']
    },
    {
        level: 4,
        education: 'An Associate\u2019s degree, or 60+ semester hours including the nine listed at '
                 + 'Level 3',
        rank: 4,
        experience: { supervised: 100, documented: 600 },
        adds: ['HGD4', 'HSW6', 'OA4', 'OA5', 'OA6', 'CPD4', 'CPD5', 'CPD6', 'CPD7', 'CPD8',
               'CPD9', 'IRE5', 'PPD5', 'PPD6']
    },
    {
        level: 5,
        education: 'A Bachelor\u2019s degree',
        rank: 5,
        experience: { supervised: 200, documented: 1200 },
        // The source prints "HDG6" here; it is HGD6.
        adds: ['HGD5', 'HGD6', 'HSW7', 'HSW8', 'OA7', 'OA8', 'CPD10', 'IRE6', 'IRE7',
               'FCR7', 'PPD7', 'PPD8', 'PPD9', 'PPD10']
    },
    {
        level: 6,
        education: 'A graduate degree, plus mastery in at least three of the seven Level 6 skill '
                 + 'areas, plus six professional contributions demonstrating competency in three '
                 + 'different areas within the last five years',
        rank: 6,
        experience: { documented: 6000 }
    }
];

/* ── Infant Toddler Credential ───────────────────────────────────────────────
   The ECE level in each row is the gate that catches most people: ITC Level 4
   cannot be awarded without ECE Credential Level 4, whatever the infant/toddler
   hours look like. */
/* Competencies are held as codes rather than prose because two things need doing with
   them: adding up across levels, and subtracting what a credential already covers.

   Each row lists only what that level ADDS. The framework wording is "Must meet all
   previous level competencies plus", so the real requirement for a level is its own list
   plus every list below it — see competenciesFor. */
var ITC_LEVELS = [
    {
        level: 2, ece: 2,
        experience: { supervised: 5, documented: 200 },
        adds: ['HGD1', 'HGD2', 'HGD3', 'HSW1', 'HSW2', 'IRE1', 'IRE2', 'IRE3',
               'FCR1', 'FCR2', 'FCR3', 'PPD1', 'PPD2']
    },
    {
        level: 3, ece: 3,
        experience: { supervised: 10, documented: 450 },
        adds: ['HGD4', 'HGD5', 'HSW3', 'HSW4', 'OA1', 'OA2', 'CPD1', 'CPD2', 'CPD3',
               'IRE4', 'IRE5', 'IRE6', 'FCR4', 'PPD3']
    },
    {
        level: 4, ece: 4,
        experience: { supervised: 50, documented: 900 },
        adds: ['HGD6', 'HSW5', 'OA3', 'CPD4', 'IRE7', 'FCR5', 'FCR6', 'PPD4']
    },
    {
        level: 5, ece: 5,
        experience: { supervised: 100, documented: 1800 },
        adds: ['HGD7', 'CPD5', 'FCR7', 'PPD5']
    },
    {
        level: 6, ece: 5, gradDegree: true,
        experience: { documented: 3600 },
        adds: ['HGD8', 'HSW6', 'HSW7', 'OA4', 'OA5', 'OA6', 'CPD6', 'CPD7', 'CPD8',
               'IRE8', 'FCR8', 'PPD6', 'PPD7', 'PPD8', 'PPD9']
    }
];

/* ── Competency areas ────────────────────────────────────────────────────────
   The seven content areas a competency code belongs to, keyed by the letter prefix
   of the code. `area` is the heading exactly as the Infant Toddler Credential
   Framework PDF prints it (PD229, 12/19/2022) — used verbatim rather than shortened,
   because it is the source. `gloss` is a plain-English sentence for a reader who does
   not know the framework; it summarises the area, and is ours, so it is worded as a
   summary and not passed off as the framework's own text.

   The framework groups competencies by area per level (it lists "ITC HGD1, HGD2,
   HGD3" under a heading) but does NOT print a distinct sentence for each numbered
   code — that per-benchmark wording lives in a separate Gateways Content Area
   Benchmarks document we do not hold. So a single code is described by its area, and
   two codes in the same area read the same. That is honest about what the source
   actually says; inventing a unique sentence per number is exactly the kind of guess
   the rest of this file refuses to make. */
/* `descriptor` is the content area's purpose statement, transcribed verbatim from the
   Infant Toddler Credential Level 2-4 Benchmarks (INCCRRA 2013), which is in the
   document library. The individual numbered indicators (A1, A5, B3...) are NOT held
   here: that document numbers them by area LETTER (A, B, C...) rather than by the
   HGD/HSW/IRE codes the framework and this checklist use, so there is no reliable
   code-to-code map and inventing one would put the wrong text on a line. The page
   therefore shows the descriptor plus a link to the full benchmark PDF, and leaves the
   per-indicator wording to the source. */
var COMPETENCY_AREAS = {
    HGD: {
        area: 'Human Growth and Development',
        gloss: 'Infant and toddler physical, cognitive, language and social-emotional development.',
        descriptor: 'Infant/toddler practitioners use current and emerging principles, theories and '
            + 'knowledge of developmental milestones as a foundation for all aspects of their work with '
            + 'young children, prenatal to age 3, and their families. They view child development '
            + 'knowledge as the core of their practitioner practice, and engage in ongoing learning and '
            + 'reflection about developmental knowledge and theory. They use their understanding as they '
            + 'plan and implement observations, assessments, and teaching/learning interactions, and as a '
            + 'context for collaborating with families and other practitioners on behalf of children.'
    },
    HSW: {
        area: 'Health, Safety & Well-Being',
        gloss: 'Safe environments, sanitation, safe-sleep practice, nutrition and health protocols for very young children.',
        descriptor: 'Infant/toddler practitioners understand that children\u2019s mental health, physical '
            + 'health, and safety are the foundations for development and learning in children, prenatal to '
            + 'age 3. They acknowledge the value of creating and fostering healthy social and physical '
            + 'environments that promote children\u2019s adaptive behavior and emotional, social, physical, '
            + 'cognitive, and language development. They collaborate with families and other practitioners '
            + 'to understand their perspectives on health, nutrition, and safety, and provide practices and '
            + 'routines that recognize individual children\u2019s needs and are congruent with individual '
            + 'families\u2019 cultures, values and preferences.'
    },
    IRE: {
        area: 'Interactions, Relationships, & Environments',
        gloss: 'Nurturing, responsive interactions and learning environments designed for infants and toddlers.',
        descriptor: 'Infant/toddler practitioners use their understanding of early development to support and '
            + 'provide healthy early relationships, both in their own work with children and as they '
            + 'collaborate with families on behalf of children. They provide and promote developmentally, '
            + 'culturally, and individually appropriate environments and seek to engage young children, ages '
            + 'birth to 3, in social, play and caregiving interactions that support their development and '
            + 'learning. Relationships recognize and promote the primacy of the parent-child relationship as '
            + 'well as foster emerging relationships with other adults and with peers.'
    },
    FCR: {
        area: 'Family & Community Relationships',
        gloss: 'Partnering with families, understanding cultural backgrounds and supporting family systems.',
        descriptor: 'Infant/toddler practitioners understand the roles that culture, community, and family '
            + 'play in the growth and development of infants and toddlers, knowing that parenting styles, '
            + 'ethnicity, cultural expectations, household make up, and community influence all domains of '
            + 'development. They understand and value the critical role of positive, collaborative '
            + 'partnerships with families, colleagues, and community service agencies, and use their '
            + 'knowledge of family and social systems to create reciprocal, productive relationships that '
            + 'enhance the contributions of family, program, and community to the development, learning, and '
            + 'well being of young children, prenatal to age 3, and their families.'
    },
    PPD: {
        area: 'Personal & Professional Development',
        gloss: 'Reflective practice, professional ethics and continuing to learn.',
        descriptor: 'Infant/toddler practitioners demonstrate respect for children, families, and colleagues. '
            + 'They identify themselves as practitioners and conduct themselves as members of a significant, '
            + 'expanding, changing profession. They honor diversity in cultures, beliefs, and practices, and '
            + 'are committed to ongoing practitioner development. They continually reflect on and take '
            + 'responsibility for their own values, choices and actions, and they advocate for young children, '
            + 'prenatal to age 3, and their families, exemplifying the ethical standards of their profession.'
    },
    OA: {
        area: 'Observation & Assessment',
        gloss: 'Documenting developmental milestones and using observation to guide care.',
        descriptor: 'Infant/toddler practitioners recognize that knowledge of each infant\u2019s or toddler\u2019s '
            + 'development and learning provides the framework for what they do with each child, birth to age 3, '
            + 'and family. They value the roles of informal and formal observation and assessment in '
            + 'understanding what and how each child is developing, and they view observation and assessment as '
            + 'ways to understand children and their interactions and relationships with their families, other '
            + 'caregivers, peers, and physical environments, within the context of culture and community.'
    },
    CPD: {
        area: 'Curriculum or Program Design',
        gloss: 'Curriculum, schedules and responsive routines built around infant and toddler needs.',
        descriptor: 'Infant/toddler practitioners take their cues for curriculum from the child and family. '
            + 'They use child development knowledge, knowledge of developmentally appropriate practices, and '
            + 'content knowledge to design, provide, promote, and evaluate opportunities and experiences that '
            + 'support optimal development and learning in children, birth to age 3. Practitioners encourage '
            + 'young children\u2019s social emotional competence, problem solving, critical thinking, and '
            + 'academic competence within a nurturing, supportive, challenging learning environment that '
            + 'emphasizes relationships, interactions, routines, and play.'
    }
};

// The area prefix of a code: 'HGD4' -> 'HGD', 'IRE7' -> 'IRE'.
function areaOf(code) {
    var m = /^([A-Z]+)/.exec(String(code || ''));
    return m ? m[1] : '';
}

/* The competencies a given ITC level requires, grouped by content area and each
   flagged covered/outstanding, for a checklist. `coveredCodes` is whatever a held
   credential provably covers (the Infant Toddler CDA list, in practice); everything
   else is 'to evidence', never guessed as met.

   Returns an ordered array of { key, area, gloss, items:[{code, covered}] } so the
   UI can render one panel per area with the boxes inside it. Areas appear in the
   framework's own order. */
function itcCompetencyChecklist(level, coveredCodes) {
    var covered = {};
    (coveredCodes || []).forEach(function (c) { covered[c] = true; });
    var required = competenciesFor(level);
    var order = ['HGD', 'HSW', 'IRE', 'FCR', 'PPD', 'OA', 'CPD'];
    var byArea = {};
    required.forEach(function (code) {
        var a = areaOf(code);
        (byArea[a] = byArea[a] || []).push(code);
    });
    // Numeric sort within an area so HGD2 precedes HGD10.
    var numOf = function (c) { var m = /(\d+)$/.exec(c); return m ? parseInt(m[1], 10) : 0; };
    return order.filter(function (a) { return byArea[a] && byArea[a].length; })
        .map(function (a) {
            return {
                key: a,
                area: COMPETENCY_AREAS[a] ? COMPETENCY_AREAS[a].area : a,
                gloss: COMPETENCY_AREAS[a] ? COMPETENCY_AREAS[a].gloss : '',
                descriptor: COMPETENCY_AREAS[a] ? (COMPETENCY_AREAS[a].descriptor || '') : '',
                items: byArea[a].sort(function (x, y) { return numOf(x) - numOf(y); })
                    .map(function (code) { return { code: code, covered: !!covered[code] }; })
            };
        });
}

// Everything a level needs, its own additions plus every level below it.
function competenciesFor(level) {
    var all = [];
    for (var i = 0; i < ITC_LEVELS.length; i++) {
        if (ITC_LEVELS[i].level <= level) all = all.concat(ITC_LEVELS[i].adds);
    }
    return all;
}

/* The Infant Toddler CDA is worth detecting rather than merely mentioning: it covers
   seven of the thirteen competencies Level 2 asks for. The Preschool CDA covers none of
   the ITC ones, so the two must not be conflated — "CDA" alone is not enough to act on. */
var IT_CDA_COMPETENCIES = ['HSW1', 'HSW2', 'IRE1', 'IRE2', 'IRE3', 'FCR3', 'PPD2'];

function hasInfantToddlerCda(s) {
    var src = [s.EceCredentials, s.Gateways, s.Notes].filter(Boolean).join(' ');
    // Must say infant/toddler near the CDA; a bare "CDA" is ambiguous by design.
    return /(infant[\s/-]*toddler|\bIT\b)[^.;]{0,40}\bCDA\b/i.test(src)
        || /\bCDA\b[^.;]{0,40}(infant[\s/-]*toddler)/i.test(src);
}

// Group consecutive numbers in a family so a long list reads as HGD1-3 rather than all three.
function formatCompetencies(codes) {
    var fams = {}, order = [];
    codes.forEach(function (c) {
        var m = c.match(/^([A-Z]+)(\d+)$/);
        if (!m) return;
        if (!fams[m[1]]) { fams[m[1]] = []; order.push(m[1]); }
        fams[m[1]].push(parseInt(m[2], 10));
    });
    return order.map(function (fam) {
        var ns = fams[fam].sort(function (a, b) { return a - b; });
        /* Runs of three or more collapse to a range; a pair stays as two codes, because
           "HSW1-2" saves nothing over "HSW1, HSW2" and reads as a range that isn't one. */
        var parts = [], start = ns[0], prev = ns[0];
        for (var i = 1; i <= ns.length; i++) {
            if (ns[i] === prev + 1) { prev = ns[i]; continue; }
            if (start === prev) parts.push(String(start));
            else if (prev === start + 1) parts.push(String(start), String(prev));
            else parts.push(start + '\u2013' + prev);
            start = prev = ns[i];
        }
        // Gateways writes these without a space: HGD1, HSW6-7. Match that exactly so a
        // staff member can find the code on their PD Record by eye.
        return fam + parts.join(', ' + fam);
    }).join(', ');
}

/* How many competencies may come from credential-approved training rather than
   college coursework. Worth stating because it is the route for people with long
   service and little college credit. */
var TRAINING_ALLOWANCE = {
    ece: { low: 6, high: 11 },
    itc: { low: 13, high: 20 }
};

/* What each CDA is worth on the ECE Credential. The difference is large and runs the
   opposite way to the ITC: the Preschool CDA covers six of the twelve ECE Level 2
   competencies, the Infant Toddler CDA only two. Somebody holding the infant/toddler one
   has more of the ITC done and less of the ECE. */
var PRESCHOOL_CDA_ECE = ['HSW1', 'HSW2', 'IRE1', 'IRE2', 'FCR1', 'PPD1'];
var IT_CDA_ECE = ['FCR1', 'PPD1'];

// Everything an ECE level needs: its own additions plus every level below it.
function eceCompetenciesFor(level) {
    var all = [];
    for (var i = 0; i < ECE_LEVELS.length; i++) {
        if (ECE_LEVELS[i].level <= level && ECE_LEVELS[i].adds) {
            all = all.concat(ECE_LEVELS[i].adds);
        }
    }
    return all;
}

function hasPreschoolCda(s) {
    var src = [s.EceCredentials, s.Gateways, s.Notes].filter(Boolean).join(' ');
    if (/(pre.?school|pre.?k)[^.;]{0,40}\bCDA\b/i.test(src)) return true;
    return /\bCDA\b[^.;]{0,40}(pre.?school|pre.?k)/i.test(src);
}

function num(v) {
    var n = parseFloat(String(v === null || v === undefined ? '' : v).replace(/[^0-9.]/g, ''));
    return isFinite(n) ? n : null;
}

/* Highest ECE level a degree alone supports. "Some College" returns 0 because it names
   no qualification, so the semester hours have to carry it — but see isVague below:
   0 here means "not established", which is not the same as "does not qualify". */
function degreeRank(education) {
    var e = String(education || '').toLowerCase();
    if (/doctor|phd|ed\.?d/.test(e)) return 6;
    if (/master|graduate/.test(e)) return 6;
    if (/bachelor/.test(e)) return 5;
    if (/associate/.test(e)) return 4;
    /* "Some College" is ranked with a diploma rather than at nothing. College enrolment
       presupposes secondary completion, and the notes bear it out for everyone here who
       carries this value. It says nothing about reaching Level 3 or above, which is what
       isVague and the semester hours are for. */
    if (/high school|ged|diploma|some college|coursework/.test(e)) return 2;
    return 0;
}

/* "Some College" and a blank are the two values that describe no qualification. With
   no semester hours recorded either, the education requirement cannot be judged from
   the record at all, and saying "you do not reach this" would be an accusation the
   record does not support. */
function isVague(education) {
    var e = String(education || '').trim().toLowerCase();
    return e === '' || /some college|coursework/.test(e);
}

// Semester hours can lift somebody above their degree: 60+ reaches Level 4.
function semesterRank(total) {
    var n = num(total);
    if (n === null) return 0;
    if (n >= 60) return 4;
    if (n >= 9) return 3;
    return 0;
}

/* Three states, not two. A blank field means nobody has established whether Gateways
   holds the transcript, and treating that as "on file" is an optimistic default that
   produces confident wrong advice: it credits someone with an education level the
   Registry may not be able to see, and sends them off to chase competencies when the
   actual blocker is an unsent transcript.

   Unknown is therefore costed like "not submitted" when working out what counts today,
   because the asymmetry is stark. If we assume it is missing and it is not, somebody
   re-orders a transcript for nothing. If we assume it is there and it is not, we plan
   coursework nobody needed while the application sits. */
function transcriptState(s) {
    var v = String(s.TranscriptOnFile || '').trim();
    if (!v) return 'unknown';
    return /not submitted/i.test(v) ? 'not' : 'onfile';
}

/* The education ceiling, twice over: what the Registry can act on now, and what it
   could act on if the transcript reached them. Where those two differ, sending the
   transcript is the whole next step. */
function educationCeiling(s, heldEce) {
    var deg = degreeRank(s.Education);
    var sem = semesterRank(s.SemesterHoursTotal);
    var tState = transcriptState(s);
    var onFile = tState === 'onfile';

    /* A level Gateways has already awarded is proof its education gate was met, whatever
       the Education field says. Janell holds ECE Level 2 against an Education of "Some
       College"; the credential is the better evidence. */
    var floor = 0;
    for (var i = 0; i < ECE_LEVELS.length; i++) {
        if (heldEce && ECE_LEVELS[i].level === heldEce) floor = ECE_LEVELS[i].rank;
    }

    var hours = num(s.SemesterHoursTotal);
    return {
        today: Math.max(deg, floor, onFile ? sem : 0),
        potential: Math.max(deg, floor, sem),
        semesterRank: sem,
        transcriptOnFile: onFile,
        transcriptState: tState,
        hours: hours,
        eceHours: num(s.SemesterHoursEce),
        // Nothing in the record establishes an education level beyond what is already held.
        assessable: !(isVague(s.Education) && hours === null)
    };
}

var IT_ROOM = /infant|toddler|\b2\s*year|\btwos?\b/i;

function worksWithInfantsToddlers(s) {
    return IT_ROOM.test(String(s.Classroom || '') + ' ' + String(s.SecondaryClassroom || ''));
}

// A written "30hrs/wk" beats an FTE, because somebody recorded it on purpose.
function hoursPerWeek(s) {
    var m = String(s.Notes || '').match(/(\d{1,2})\s*hrs?\s*\/\s*wk/i);
    if (m) return parseFloat(m[1]);
    var fte = num(s.Fte);
    return fte ? Math.round(fte * 40) : null;
}

function weeksToReach(hours, perWeek) {
    if (!perWeek || !hours) return null;
    return Math.ceil(hours / perWeek);
}

function levelWord(n) { return 'Level ' + n; }

/* The competency sentence for an ECE level, including the part that decides whether the
   level is reachable without going back to college.

   The training allowance is a cap on the TOTAL, not a per-level allowance, so where the
   outstanding count exceeds it the difference has to come from coursework. For Level 2
   that is the whole question: twelve competencies against a cap of six means at least six
   must be college credit, and no amount of in-service training substitutes. */
function eceCompetencyText(s, row) {
    if (!row.adds) {
        return 'Level 6 is assessed on mastery in three of the seven Level 6 skill areas and six '
             + 'professional contributions rather than on a competency list.';
    }
    var required = eceCompetenciesFor(row.level);
    var psCda = hasPreschoolCda(s);
    var itCda = hasInfantToddlerCda(s);
    var coveredSet = psCda ? PRESCHOOL_CDA_ECE : (itCda ? IT_CDA_ECE : []);
    var covered = required.filter(function (c) { return coveredSet.indexOf(c) !== -1; });
    var outstanding = required.filter(function (c) { return covered.indexOf(c) === -1; });
    var cap = row.level <= 4 ? TRAINING_ALLOWANCE.ece.low : TRAINING_ALLOWANCE.ece.high;
    var mustBeCollege = outstanding.length - cap;

    return levelWord(row.level) + ' needs ' + required.length + ' competencies'
        + (row.level > 2 ? ', counting every level below it' : '') + ': '
        + formatCompetencies(required) + '. '
        + (covered.length
           ? 'Your ' + (psCda ? 'Preschool' : 'Infant Toddler') + ' CDA covers '
             + formatCompetencies(covered) + ', leaving ' + outstanding.length + '. '
           : '')
        + 'Up to ' + cap + ' may come from credential-approved training rather than college. '
        + (mustBeCollege > 0
           ? '<b>That means at least ' + mustBeCollege + ' of them have to be college coursework '
             + '\u2014 training alone will not reach this level.</b>'
           : 'The outstanding ' + outstanding.length + ' fall within that allowance, so this level '
             + 'is reachable through training without further college credit.')
        + ' We do not track competencies per person, so check them against your Professional '
        + 'Development Record.';
}

/* ── ECE next steps ─────────────────────────────────────────────────────── */
function eceSteps(s, held) {
    var steps = [];
    var edu = educationCeiling(s, held);

    if (held) {
        steps.push({ done: true, t: 'ECE Credential ' + levelWord(held) + ' held',
            d: 'Recorded on your staff record from the Gateways report.' });
    } else {
        steps.push({ done: false, t: 'Start with ECE Credential Level 1',
            d: ECE_LEVELS[0].education + ' No fee and no transcript needed, and it is awarded '
             + 'automatically once the modules are complete. You need to be a Gateways Registry '
             + 'member first.' });
    }

    // Transcript gap first: it is usually the largest single move available.
    if (!edu.transcriptOnFile && edu.hours) {
        var unknown = edu.transcriptState === 'unknown';
        steps.push({
            done: false,
            t: (unknown
                ? 'Check whether Gateways has your transcript \u2014 it is worth up to '
                : 'Send your transcript to the Registry \u2014 worth up to ')
                + levelWord(edu.potential) + (unknown ? '' : ' on its own'),
            d: 'Your record shows ' + edu.hours + ' semester hours'
             + (edu.eceHours ? ', ' + edu.eceHours + ' of them in early childhood' : '')
             + (unknown
                ? ', but nothing on your record establishes whether the Registry has ever '
                  + 'received the transcript. That question is worth settling before anything '
                  + 'else, because the answer changes what you should do next: if they have it, '
                  + 'the gap is which competencies your courses map to; if they do not, none of '
                  + 'the credit counts yet and sending it is the only thing that matters. '
                  + 'Your Gateways Professional Development Record shows what they hold.'
                : ', but the transcript has not reached Gateways. Credit the Registry has not '
                  + 'received cannot raise a level.')
             + ' Counted conservatively you are at '
             + (edu.today ? levelWord(edu.today) : 'no education level')
             + '; with the transcript on file the education requirement supports '
             + levelWord(edu.potential) + '. It must go to the Registry direct from the college, '
             + 'not to the centre \u2014 a copy issued to you, or a black and white print of one, '
             + 'is not an official transcript however complete it looks.'
             /* The distance to the next threshold is the actionable part. 53 hours is not
                "nearly Level 4", it is seven credits short of it, and that is a semester. */
             + (edu.hours < 60 && edu.hours >= 9
                ? ' A further ' + Math.ceil(60 - edu.hours) + ' semester hours would reach the 60 '
                  + 'that Level 4 asks for.'
                : '')
        });
    }

    var next = held ? held + 1 : 2;
    var row = null;
    for (var i = 0; i < ECE_LEVELS.length; i++) if (ECE_LEVELS[i].level === next) row = ECE_LEVELS[i];

    if (!row) {
        steps.push({ done: true, t: 'Level 6 is the top of the ECE Credential',
            d: 'There is no level above this one.' });
        return steps;
    }

    var eduMet = edu.potential >= row.rank;
    // row.education already ends in a full stop in some rows; do not add a second.
    var eduSentence = row.education.replace(/\.\s*$/, '') + '. ';
    steps.push({
        done: false,
        t: 'Next: ECE Credential ' + levelWord(row.level),
        d: '<b>Education:</b> ' + eduSentence
         /* The transcript caveat belongs only on levels the semester hours are carrying.
            Level 2 needs a diploma, which no transcript affects, and saying otherwise
            invents a blocker. edu.today excludes credit the Registry has not received, so
            today >= rank means the level stands without it. */
         + (eduMet
            ? 'Your record already supports this'
              + (edu.today >= row.rank ? '.' : ', once the transcript is with Gateways.')
            : (edu.assessable
               ? 'Your record does not reach this yet'
                 + (edu.hours ? ' \u2014 ' + edu.hours + ' semester hours recorded.' : '.')
               : 'Your record does not say either way \u2014 it shows \u201c'
                 + String(s.Education || 'nothing').trim() + '\u201d and no semester hours, which '
                 + 'is not enough to judge this against. Worth getting your transcript on file so '
                 + 'the question can be answered.'))
         + (row.experience
            ? '<br><b>Experience:</b> '
              + (row.experience.supervised
                 ? row.experience.supervised + ' '
                   + (row.experience.supervisedLabel || 'hours of supervised ECE experience')
                   + ', or ' + row.experience.documented.toLocaleString('en-US')
                   + ' hours of documented ECE work experience.'
                 : row.experience.documented.toLocaleString('en-US')
                   + ' hours of documented ECE work experience.')
            : '')
         + '<br><b>Competencies:</b> ' + eceCompetencyText(s, row)
    });

    return steps;
}

/* The ITC level to aim at, given what is held. Extracted so the competency checklist
   on the page can show the SAME level itcSteps talks about, rather than recomputing
   the ceiling logic in the page and risking the two drifting apart.

   The ECE credential caps the ITC; Level 6 additionally needs a graduate degree. You
   apply for the level you qualify for rather than climbing rung by rung, so this is
   the ceiling the held ECE allows, never below the next rung up from what is held. */
function itcTargetLevel(s, heldItc, heldEce) {
    var ceiling = 2;
    if (heldEce >= 5) ceiling = (degreeRank(s.Education) >= 6) ? 6 : 5;
    else if (heldEce >= 2) ceiling = heldEce;
    var next = Math.max((heldItc || 0) + 1, Math.min(ceiling, 6));
    if (next < 2) next = 2;
    if (next > 6) next = 6;
    return next;
}

/* ── ITC next steps ─────────────────────────────────────────────────────── */
function itcSteps(s, heldItc, heldEce) {
    var steps = [];
    var edu = educationCeiling(s, heldEce);
    var inItRoom = worksWithInfantsToddlers(s);
    var perWeek = hoursPerWeek(s);

    if (heldItc) {
        steps.push({ done: true, t: 'Infant Toddler Credential ' + levelWord(heldItc) + ' held',
            d: 'This is what the ExceleRate infant and toddler room requirement counts.' });
    }

    /* Said before the gates rather than after them. Somebody working school-age can meet
       every education requirement for a high ITC level and still have no route to it,
       because the experience has to be with children under three. Leading with the level
       would send them after the wrong credential. */
    if (!inItRoom && !heldItc) {
        steps.push({
            done: false,
            t: 'The ITC may not be the credential to chase from your current room',
            d: 'Every level needs experience with children from birth to age three, and your '
             + 'recorded room is ' + (String(s.Classroom || s.SecondaryClassroom || '').trim()
                 || 'not set') + '. The education requirements below may well be met, but without '
             + 'infant/toddler hours there is no route to an award. The ECE Credential is usually '
             + 'the better target unless a move to an infant or toddler room is on the cards.'
        });
    }

    /* The ITC is not a ladder that has to be climbed a rung at a time. You apply for the
       level you qualify for, and the ECE credential is what caps it. Lindsey holds ECE
       Level 4 and no ITC, so her target is ITC Level 4 — pointing her at Level 2 would
       send her after a credential well below what she is entitled to, and Level 4 is the
       application she already has pending.

       Level 6 additionally needs a graduate degree, so it is only offered to someone who
       has one. */
    var next = itcTargetLevel(s, heldItc, heldEce);

    var row = null;
    for (var i = 0; i < ITC_LEVELS.length; i++) if (ITC_LEVELS[i].level === next) row = ITC_LEVELS[i];

    /* Say so when the target genuinely skips levels, otherwise it looks like a mistake.
       Only when the ECE gate for that level is actually met — offering to skip ahead on
       the strength of a credential the person does not hold would be worse than silence —
       and never for Level 2, which is the bottom rung and cannot be skipped to. */
    if (row && next > 2 && next > heldItc + 1 && heldEce >= row.ece && inItRoom) {
        steps.push({
            done: false,
            t: 'You can apply straight at ' + levelWord(next),
            d: 'Your ECE Credential ' + levelWord(heldEce) + ' entitles you to Infant Toddler '
             + levelWord(next) + ', so there is no need to work up through the levels below it. '
             + 'Apply for the level you qualify for.'
        });
    }

    if (!row) {
        steps.push({ done: true, t: 'Level 6 is the top of the Infant Toddler Credential',
            d: 'There is no level above this one.' });
        return steps;
    }

    /* The ECE gate, stated before anything else. Somebody chasing infant/toddler hours
       while their ECE level is the real blocker is spending effort in the wrong place. */
    var eceGateMet = heldEce >= row.ece;
    steps.push({
        done: eceGateMet,
        t: (eceGateMet ? 'ECE Credential ' + levelWord(row.ece) + ' requirement met'
                       : 'First you need ECE Credential ' + levelWord(row.ece)),
        d: 'Infant Toddler ' + levelWord(row.level) + ' requires ECE Credential '
         + levelWord(row.ece) + (row.level < 5 ? ' or higher' : '') + '. '
         + (eceGateMet
            ? 'You hold ECE ' + levelWord(heldEce) + ', so this is not what is holding you up.'
            : (heldEce ? 'You hold ECE ' + levelWord(heldEce) + ', so the ECE side is the binding '
                         + 'constraint here, not your infant and toddler hours.'
                       : 'You do not hold an ECE Credential yet, so there is no route to the ITC '
                         + 'that skips it.'))
         + (row.gradDegree ? ' Level 6 also requires a graduate degree.' : '')
    });

    // The experience gate, with the supervised route costed in weeks where possible.
    var sup = row.experience.supervised;
    var doc = row.experience.documented;
    var weeks = sup && inItRoom ? weeksToReach(sup, perWeek) : null;
    steps.push({
        done: false,
        t: 'Experience with infants, toddlers and their families',
        d: (sup
            ? '<b>' + sup + ' hours supervised</b>, or <b>' + doc.toLocaleString('en-US')
              + ' hours documented</b>. '
            : '<b>' + doc.toLocaleString('en-US') + ' hours documented.</b> ')
         + (inItRoom
            ? (weeks
               ? 'You work in an infant/toddler room at about ' + perWeek + ' hours a week, so the '
                 + 'supervised route is roughly ' + weeks + ' week' + (weeks === 1 ? '' : 's')
                 + ' of documented supervision \u2014 usually far quicker than assembling '
                 + doc.toLocaleString('en-US') + ' verified hours from former employers.'
               : 'You work in an infant/toddler room, so the supervised route is likely the '
                 + 'quicker one. Hours per week are not on your record, so it cannot be costed.')
            : 'Your recorded room is not an infant/toddler room, so neither route accrues from '
              + 'your current assignment. Documented hours from earlier infant/toddler work need a '
              + 'PD75a signed by that employer.')
         + ' Documented hours only count once a work history form from the employer is on file.'
    });

    /* Competencies. The only ones ever treated as met are those a held credential
       covers outright, because that is a documented fact rather than an inference from a
       course title. Everything else is listed to be checked, never scored. */
    var required = competenciesFor(row.level);
    var cda = hasInfantToddlerCda(s);
    var covered = cda ? required.filter(function (c) {
        return IT_CDA_COMPETENCIES.indexOf(c) !== -1;
    }) : [];
    var outstanding = required.filter(function (c) { return covered.indexOf(c) === -1; });
    var allowance = row.level <= 4 ? TRAINING_ALLOWANCE.itc.low : TRAINING_ALLOWANCE.itc.high;

    steps.push({
        done: false,
        t: 'Competencies for ' + levelWord(row.level) + ' \u2014 ' + outstanding.length
            + ' to evidence' + (covered.length ? ', ' + covered.length + ' already covered' : ''),
        d: (row.level > 2
            ? levelWord(row.level) + ' requires every competency from the levels below it as well, '
              + 'so the full list is ' + required.length + ' of them: '
            : 'Gateways assesses ')
         + 'ITC ' + formatCompetencies(required) + '. '
         + (cda
            ? '<br>Your Infant Toddler CDA covers ITC ' + formatCompetencies(covered)
              + ' outright, which leaves <b>ITC ' + formatCompetencies(outstanding) + '</b>.'
            : '')
         + '<br>These come from college coursework, and up to ' + allowance + ' in total may come '
         + 'from credential-approved training instead'
         + (outstanding.length <= allowance
            ? ' \u2014 so the ' + outstanding.length + ' outstanding could all be met by training, '
              + 'without further college credit.'
            : '.')
         + ' We do not track competencies per person, so this needs checking against your '
         + 'Professional Development Record rather than assumed.'
    });

    if (!edu.transcriptOnFile && edu.hours) {
        steps.push({
            done: false,
            t: edu.transcriptState === 'unknown'
                ? 'The same transcript question caps the ECE side'
                : 'Your transcript is holding up the ECE side too',
            d: edu.transcriptState === 'unknown'
                ? 'Until it is known whether Gateways holds your transcript, your ECE level '
                  + 'cannot be relied on, and the ECE level caps the ITC. One phone call settles '
                  + 'both.'
                : 'The same missing transcript caps your ECE level, which in turn caps the ITC. '
                  + 'One errand clears both.'
        });
    }

    return steps;
}

root.CredentialFramework = {
    ECE_LEVELS: ECE_LEVELS,
    ITC_LEVELS: ITC_LEVELS,
    IT_CDA_COMPETENCIES: IT_CDA_COMPETENCIES,
    PRESCHOOL_CDA_ECE: PRESCHOOL_CDA_ECE,
    IT_CDA_ECE: IT_CDA_ECE,
    competenciesFor: competenciesFor,
    eceCompetenciesFor: eceCompetenciesFor,
    COMPETENCY_AREAS: COMPETENCY_AREAS,
    areaOf: areaOf,
    itcCompetencyChecklist: itcCompetencyChecklist,
    itcTargetLevel: itcTargetLevel,
    hasInfantToddlerCda: hasInfantToddlerCda,
    hasPreschoolCda: hasPreschoolCda,
    formatCompetencies: formatCompetencies,
    degreeRank: degreeRank,
    semesterRank: semesterRank,
    isVague: isVague,
    educationCeiling: educationCeiling,
    worksWithInfantsToddlers: worksWithInfantsToddlers,
    hoursPerWeek: hoursPerWeek,
    eceSteps: eceSteps,
    itcSteps: itcSteps
};

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

if (typeof module !== 'undefined' && module.exports) {
    module.exports = (typeof window !== 'undefined' ? window : globalThis).CredentialFramework;
}
