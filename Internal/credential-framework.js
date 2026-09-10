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
        experience: { supervised: 10, supervisedLabel: 'hours of ECE observation', documented: 200 }
    },
    {
        level: 3,
        education: 'Nine semester hours \u2014 three each of Math, English and a General Education '
                 + 'elective such as Psychology, Sociology or Science. All nine must be credit '
                 + 'bearing, non-developmental, and 100 level or above.',
        rank: 3,
        experience: { supervised: 10, documented: 400 }
    },
    {
        level: 4,
        education: 'An Associate\u2019s degree, or 60+ semester hours including the nine listed at '
                 + 'Level 3',
        rank: 4,
        experience: { supervised: 100, documented: 600 }
    },
    {
        level: 5,
        education: 'A Bachelor\u2019s degree',
        rank: 5,
        experience: { supervised: 200, documented: 1200 }
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
var ITC_LEVELS = [
    {
        level: 2, ece: 2,
        experience: { supervised: 5, documented: 200 },
        competencies: 'ITC HGD1\u20133, HSW1\u20132, IRE1\u20133, FCR1\u20133, PPD1\u20132'
    },
    {
        level: 3, ece: 3,
        experience: { supervised: 10, documented: 450 },
        competencies: 'ITC HGD4\u20135, HSW3\u20134, OA1\u20132, CPD1\u20133, IRE4\u20136, FCR4, PPD3'
    },
    {
        level: 4, ece: 4,
        experience: { supervised: 50, documented: 900 },
        competencies: 'ITC HGD6, HSW5, OA3, CPD4, IRE7, FCR5\u20136, PPD4'
    },
    {
        level: 5, ece: 5,
        experience: { supervised: 100, documented: 1800 },
        competencies: 'ITC HGD7, CPD5, FCR7, PPD5'
    },
    {
        level: 6, ece: 5, gradDegree: true,
        experience: { documented: 3600 },
        competencies: 'ITC HGD8, HSW6\u20137, OA4\u20136, CPD6\u20138, IRE8, FCR8, PPD6\u20139'
    }
];

/* How many competencies may come from credential-approved training rather than
   college coursework. Worth stating because it is the route for people with long
   service and little college credit. */
var TRAINING_ALLOWANCE = {
    ece: { low: 6, high: 11 },
    itc: { low: 13, high: 20 }
};

// The Infant Toddler CDA is worth naming: it covers seven ITC competencies outright.
var IT_CDA_COVERS = 'ITC HSW1, HSW2, IRE1, IRE2, IRE3, FCR3, PPD2, plus ECE FCR1 and ECE PPD1';

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

function transcriptWithGateways(s) {
    return !/not submitted/i.test(String(s.TranscriptOnFile || ''));
}

/* The education ceiling, twice over: what the Registry can act on now, and what it
   could act on if the transcript reached them. Where those two differ, sending the
   transcript is the whole next step. */
function educationCeiling(s, heldEce) {
    var deg = degreeRank(s.Education);
    var sem = semesterRank(s.SemesterHoursTotal);
    var onFile = transcriptWithGateways(s);

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
        steps.push({
            done: false,
            t: 'Send your transcript to the Registry \u2014 worth up to '
                + levelWord(edu.potential) + ' on its own',
            d: 'Your record shows ' + edu.hours + ' semester hours'
             + (edu.eceHours ? ', ' + edu.eceHours + ' of them in early childhood' : '')
             + ', but the transcript has not reached Gateways. Credit the Registry has not '
             + 'received cannot raise a level. On paper you are at '
             + (edu.today ? levelWord(edu.today) : 'no education level')
             + '; with the transcript on file the education requirement supports '
             + levelWord(edu.potential) + '. It must go to the Registry direct from the college, '
             + 'not to the centre.'
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
         + '<br><b>Competencies:</b> each level adds a named list, assessed by Gateways from your '
         + 'transcript and training. Up to ' + TRAINING_ALLOWANCE.ece.low + ' competencies may come '
         + 'from credential-approved training at Levels 2 to 4, and up to '
         + TRAINING_ALLOWANCE.ece.high + ' at Levels 5 and 6. We do not track these per person, so '
         + 'check them against your Professional Development Record.'
    });

    return steps;
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
    var ceiling = 2;
    if (heldEce >= 5) ceiling = (degreeRank(s.Education) >= 6) ? 6 : 5;
    else if (heldEce >= 2) ceiling = heldEce;
    var next = Math.max(heldItc + 1, Math.min(ceiling, 6));
    if (next < 2) next = 2;

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

    // Competencies, named but never scored.
    steps.push({
        done: false,
        t: 'Competencies for ' + levelWord(row.level),
        d: 'Gateways assesses ' + row.competencies + '. These come from college coursework, and up '
         + 'to ' + (row.level <= 4 ? TRAINING_ALLOWANCE.itc.low : TRAINING_ALLOWANCE.itc.high)
         + ' in total may come from credential-approved training instead. We do not track '
         + 'competencies per person, so this list needs checking against your Professional '
         + 'Development Record rather than assumed. The Infant Toddler CDA covers '
         + IT_CDA_COVERS + '.'
    });

    if (!edu.transcriptOnFile && edu.hours) {
        steps.push({
            done: false, t: 'Your transcript is holding up the ECE side too',
            d: 'The same missing transcript caps your ECE level, which in turn caps the ITC. One '
             + 'errand clears both.'
        });
    }

    return steps;
}

root.CredentialFramework = {
    ECE_LEVELS: ECE_LEVELS,
    ITC_LEVELS: ITC_LEVELS,
    IT_CDA_COVERS: IT_CDA_COVERS,
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
