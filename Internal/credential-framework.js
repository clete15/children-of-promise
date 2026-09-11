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

/* A plain-language note explaining what a CDA does and does NOT do on each ladder,
   because Gateways does not make this obvious and it is the thing most misread: a
   CDA is not an ECE level, and the Infant/Toddler one helps the two ladders very
   unevenly. Returns '' when the person holds no CDA, so it only appears where it is
   actually relevant. The specific counts come from the same tables the cards use
   (IT_CDA_ECE / PRESCHOOL_CDA_ECE and IT_CDA_COMPETENCIES), so they cannot drift. */
function cdaLadderNote(s) {
    var it = hasInfantToddlerCda(s);
    var ps = hasPreschoolCda(s);
    if (!it && !ps) return '';

    var which = it ? 'Infant/Toddler' : 'Preschool';
    var body = '<b>Your ' + which + ' CDA is a national credential, not a Gateways ECE level</b> '
        + '\u2014 holding it does not by itself grant ECE Level 2. What it does:'
        + '<ul style="margin:6px 0 0 18px;padding:0;">';

    if (it) {
        body += '<li>On the <b>Infant Toddler</b> ladder it is worth a lot: it covers '
            + IT_CDA_COMPETENCIES.length + ' of the 13 competencies Infant Toddler Level 2 asks for.</li>'
            + '<li>On the <b>ECE (preschool)</b> ladder it is worth little: only '
            + IT_CDA_ECE.length + ' of the 12 ECE Level 2 competencies, because it is an '
            + 'infant/toddler credential being applied to the preschool ladder.</li>';
    } else {
        body += '<li>On the <b>ECE (preschool)</b> ladder it covers '
            + PRESCHOOL_CDA_ECE.length + ' of the 12 ECE Level 2 competencies.</li>'
            + '<li>It does <b>not</b> count toward the Infant Toddler ladder.</li>';
    }

    body += '<li>ECE Level 2 itself only needs a <b>high-school diploma or GED</b> for its '
        + 'education floor \u2014 no college. College credit first becomes required at ECE '
        + 'Level 3 (9 semester hours) and Level 4 (an Associate\u2019s or 60+ hours).</li>'
        + '<li>Any <b>college credit the CDA carried</b> only counts once Gateways has the '
        + 'transcript on file \u2014 earned-but-not-submitted counts for nothing.</li>'
        + '</ul>';
    return body;
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

/* ── ECE next steps ───────────────────────────────────────────────────────
   Deliberately brief: what the NEXT level needs, in the three terms the director
   asked for — college, training, and classroom/work hours — and nothing else. The
   competency lists and transcript essays that used to live here were removed on
   request; detail can come back later if wanted. */
function eceSteps(s, held) {
    var steps = [];

    // The held level is shown in the "Where you stand" tile at the top of the page,
    // so it is not repeated here as a green step — this column is only next steps.

    var next = held ? held + 1 : 1;
    var row = null;
    for (var i = 0; i < ECE_LEVELS.length; i++) if (ECE_LEVELS[i].level === next) row = ECE_LEVELS[i];

    if (!row) {
        steps.push({ done: true, t: 'Level 6 is the top of the ECE Credential',
            d: 'There is no level above this one.' });
        return steps;
    }

    steps.push(levelRequirementStep('ECE Credential', row, 'ECE'));
    return steps;
}

/* One "what the next level needs" card, three plain lines: college, training,
   classroom/work. Shared by both ladders so they read identically.

   `kind` is 'ECE' or 'ITC' and only changes the wording of the work-experience line
   (ECE work vs infant/toddler work). No competency text, by design. */
function levelRequirementStep(credName, row, kind) {
    var college = row.education
        ? row.education.replace(/\.\s*$/, '')
        : null;

    // Level 1 is a training course, not an education gate — that is its "college" line.
    var isLevel1 = row.level === 1;

    var lines = '';
    if (isLevel1) {
        lines += '<div class="req"><span class="k">Training</span><span class="v">'
              + college + '.</span></div>';
    } else {
        /* ITC levels carry no education line of their own — the ECE Credential is their
           education gate, and that is shown on the ECE side. So only print College when
           the level actually has an education requirement (the ECE ladder does). */
        if (college) {
            lines += '<div class="req"><span class="k">College</span><span class="v">'
                  + college + '.</span></div>';
        } else if (kind === 'ITC') {
            lines += '<div class="req"><span class="k">College</span><span class="v">'
                  + 'Set by the ECE Credential level shown above \u2014 no separate college '
                  + 'requirement.</span></div>';
        }
        /* Training line. This is the part people misread: it is a FALLBACK, not a
           requirement. Each level has a set of required skill areas ("competencies").
           You prove each one either through college coursework OR, only where your
           coursework did not cover it, through an approved Gateways workshop. So
           training is needed only to fill a specific gap; someone whose coursework
           (or a credential they already hold) already covers the competencies needs
           no training at all. The number is a CEILING on how many may be covered this
           way, not a count of trainings to complete. Worded so it cannot read as a
           mandatory step. */
        var cap = kind === 'ECE'
            ? (row.level <= 4 ? TRAINING_ALLOWANCE.ece.low : TRAINING_ALLOWANCE.ece.high)
            : (row.level <= 4 ? TRAINING_ALLOWANCE.itc.low : TRAINING_ALLOWANCE.itc.high);
        lines += '<div class="req"><span class="k">Training <span class="opt">optional</span></span>'
              + '<span class="v">Only if a required skill area is not already covered by your '
              + 'coursework. Up to ' + cap + ' of them may be met with an approved Gateways '
              + 'workshop instead of a college course \u2014 it is a substitute for a gap, not a '
              + 'requirement on top. If your coursework (or a credential you already hold) covers '
              + 'them, no training is needed.</span></div>';

        // Classroom / work-experience line.
        var workWord = kind === 'ITC'
            ? 'with infants, toddlers and their families'
            : 'of ECE work';
        if (row.experience && (row.experience.supervised || row.experience.documented)) {
            var v = '';
            if (row.experience.supervised) {
                v += '<b>' + row.experience.supervised + ' hours</b> supervised, or ';
            }
            v += '<b>' + row.experience.documented.toLocaleString('en-US') + ' hours</b> '
               + 'documented ' + workWord + '.';
            lines += '<div class="req"><span class="k">Classroom</span><span class="v">'
                  + v + '</span></div>';
        }
    }

    return {
        done: false,
        t: 'Next: ' + credName + ' ' + levelWord(row.level),
        d: '<div class="req-list">' + lines + '</div>'
    };
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

/* ── ITC next steps ───────────────────────────────────────────────────────
   Brief, on request. What the next Infant Toddler level needs in three terms, plus
   one line if a higher ECE Credential is the gate — and in that case it says only
   "obtain ECE X", not the ECE coursework, because the ECE column already covers that.

   The ECE credential caps the ITC: you cannot hold ITC Level 4 without ECE Level 4.
   So the "next" ITC level offered is capped at the ECE level held — chasing a higher
   ITC level than the ECE allows is effort in the wrong place. */
function itcSteps(s, heldItc, heldEce) {
    var steps = [];

    // The held level is shown in the "Where you stand" tile at the top of the page,
    // so it is not repeated here as a green step — this column is only next steps.

    // The ITC level the CURRENT ECE allows. Never past what ECE supports, so the card
    // shows a level that is actually reachable rather than one gated behind ECE work.
    var nextByEce = itcTargetLevel(s, heldItc, heldEce);
    // The plain next rung up, regardless of ECE — used to explain an ECE gate.
    var nextRung = (heldItc || 1) + 1;
    if (nextRung > 6) nextRung = 6;

    /* If a higher ECE Credential is the gate for the next rung, show ONLY that — the
       instruction was to say "obtain ECE X" and stop, not to list the requirements for
       a level the person cannot reach yet. The ECE column shows how to get the ECE
       level; repeating ITC hours for an unreachable level would be noise. */
    var rungRow = null;
    for (var r = 0; r < ITC_LEVELS.length; r++) if (ITC_LEVELS[r].level === nextRung) rungRow = ITC_LEVELS[r];
    if (rungRow && heldEce < rungRow.ece) {
        steps.push({
            done: false,
            t: 'Next: reach ECE Credential ' + levelWord(rungRow.ece) + ' first',
            d: 'Infant Toddler ' + levelWord(nextRung) + ' requires ECE Credential '
             + levelWord(rungRow.ece) + (nextRung < 5 ? ' or higher' : '')
             + (heldEce ? ', and you hold ECE ' + levelWord(heldEce) + '.' : '.')
             + ' See the Preschool (ECE) column for what that takes.'
             + (rungRow.gradDegree ? ' Level 6 also requires a graduate degree.' : '')
        });
        return steps;
    }

    var row = null;
    for (var i = 0; i < ITC_LEVELS.length; i++) if (ITC_LEVELS[i].level === nextByEce) row = ITC_LEVELS[i];

    if (!row) {
        steps.push({ done: true, t: 'Level 6 is the top of the Infant Toddler Credential',
            d: 'There is no level above this one.' });
        return steps;
    }

    // The requirement for the level the ECE currently allows. On the ITC side the ECE
    // credential IS the education gate, so the college line is suppressed (see kind).
    steps.push(levelRequirementStep('Infant Toddler Credential', row, 'ITC'));
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
    cdaLadderNote: cdaLadderNote,
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
