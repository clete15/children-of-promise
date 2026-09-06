const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Prevent crashes from unhandled errors
process.on('uncaughtException', (err) => {
    console.error('[CRASH PREVENTED]', err.message);
});
process.on('unhandledRejection', (err) => {
    console.error('[UNHANDLED REJECTION]', err);
});

const PORT = process.env.PORT || 80;
const HTTPS_PORT = 443;
const DB_SERVER = 'localhost\\SQLEXPRESS';
const DB_NAME = 'CofPMillstadt';
const EXTERNAL_DIR = path.join(__dirname, '..', 'External');

// SSL Certificate paths (from win-acme / Let's Encrypt)
const CERT_DIR = 'C:\\certs';
let sslOptions = null;
try {
    const certFiles = fs.readdirSync(CERT_DIR);
    const keyFile = certFiles.find(f => f.endsWith('-key.pem'));
    const chainFile = certFiles.find(f => f.endsWith('-chain.pem'));
    if (keyFile && chainFile) {
        sslOptions = {
            key: fs.readFileSync(path.join(CERT_DIR, keyFile)),
            cert: fs.readFileSync(path.join(CERT_DIR, chainFile)),
        };
        console.log('[SSL] Certificates loaded from', CERT_DIR);
    }
} catch (e) {
    console.log('[SSL] No certificates found, HTTPS disabled');
}

const MIME = {
    '.html': 'text/html', '.css': 'text/css',
    '.js': 'application/javascript', '.json': 'application/json',
    '.png': 'image/png', '.ico': 'image/x-icon',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.pdf': 'application/pdf',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword'
};

const COLS = ['Last_Name','First_Name','Birth_date','Start_Date','City_Town','Days_Old',
              'RoomNumber','Monday','Tuesday','Wednesday','Thursday','Friday',
              'Active','Category','PFA_PI_na','F_R_P_Food','IEP','Military'];

const ROOM_COLS = ['RoomNumber','Building','Room','TeacherDescription','Type','RequiredSlots','AgeRange','DCFSCapacity'];

const INTERNAL_PASSWORD = 'cofpadmin';

function checkAuth(req, res) {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Basic ')) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Children Of Promise Staff"' });
        res.end('Unauthorized');
        return false;
    }
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const password = decoded.split(':')[1];
    if (password !== INTERNAL_PASSWORD) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Children Of Promise Staff"' });
        res.end('Unauthorized');
        return false;
    }
    return true;
}

function esc(v) {
    if (v === null || v === undefined || v === '') return 'NULL';
    return `'${String(v).replace(/'/g, "''")}'`;
}

function bit(v) {
    if (v === true || v === 'Yes' || v === '1' || v === 1) return 1;
    if (v === false || v === 'No' || v === '0' || v === 0) return 0;
    return 'NULL';
}

// ── sqlcmd transport encoding ──
// runSQL() shells out to sqlcmd with `-s "|" -W -h -1`, so results come back as
// one line per row with columns separated by '|'. That means any stored value
// containing a literal '|' shifts every later column, and any value containing a
// line break splits one row into several unparseable lines.
//
// Free-text form fields (textareas) hit both cases routinely. Rather than
// mangling what we store, we keep the real text in the database and encode only
// the transport: wrap text columns in txCol() on the way out and run the value
// through txDecode() after splitting. Sentinels are plain ASCII so they survive
// whatever code page sqlcmd writes -- a non-ASCII sentinel such as CHAR(166)
// would come back as a replacement char once execSync decoded the output utf8.
const TX_PIPE = '{PIPE}';
const TX_NL = '{NL}';

function txCol(col, alias) {
    return `REPLACE(REPLACE(REPLACE(ISNULL(${col},''),'|','${TX_PIPE}'),CHAR(13),''),CHAR(10),'${TX_NL}') AS ${alias || col}`;
}

function txDecode(v) {
    return String(v == null ? '' : v).split(TX_NL).join('\n').split(TX_PIPE).join('|');
}

// ── School year ──
// Every per-child record is scoped to a school year. Without this, a returning
// child carried last year's ticked checkboxes into the new year and saving a new
// permission slip or screening overwrote the previous year's record, which the
// PICC needs kept (permission is valid July 1 to June 30, and the Individual
// Family Goal Plan must show annual updates).
//
// The year rolls over on July 1, matching getSchoolYear() in the browser and the
// USDA threshold boundary already used for F/R/P.
function currentSchoolYear() {
    const now = new Date();
    const start = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
    return start + '-' + (start + 1);
}

// Rows created before the SchoolYear columns existed are stamped with this on
// migration. All of that data was entered during the 2025-2026 year.
const LEGACY_SCHOOL_YEAR = '2025-2026';

// Accepts a year from the client but never trusts it into SQL unescaped, and
// falls back to the current year so an older client that omits it still works.
function resolveSchoolYear(v) {
    const s = String(v || '').trim();
    return /^\d{4}-\d{4}$/.test(s) ? s : currentSchoolYear();
}

// Adds SchoolYear to a table that predates it, backfills existing rows, and
// returns the DDL. Safe to re-run.
function schoolYearColumnSQL(table) {
    // Guarded on the table existing as well as the column, because callers run
    // this before a SELECT that may be the first thing to touch the table.
    return `IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='${table}')
   AND NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='${table}' AND COLUMN_NAME='SchoolYear')
BEGIN
    EXEC('ALTER TABLE ${table} ADD SchoolYear NVARCHAR(20)');
    EXEC('UPDATE ${table} SET SchoolYear=''${LEGACY_SCHOOL_YEAR}'' WHERE SchoolYear IS NULL');
END;
`;
}

// ── ISBETracking schema ──
// Single source of truth for the checklist columns. Every read and write runs the
// ensure block first, so a fresh database (or one predating a column we added
// later) heals itself instead of failing. EnterSIS and RemoveFromSIS were
// accepted by the PUT whitelist but never existed as columns, so those two
// checkboxes silently failed to save until this list took over.
const ISBE_TRACKING_COLUMNS = [
    'PermissionSlip', 'ParentInterview', 'ProofOfIncome', 'EnterSIS',
    'BegASQ', 'BegASE', 'MidYearReport', 'EndASQ', 'EndASE', 'EndYearReport',
    // PICC per-child document forms (Prevention Initiative only).
    'WeightedEligibility', 'ScreeningResultsShared',
    'FamilyCenteredAssessment', 'FamilyGoalPlan', 'TransitionPlan', 'Referral',
    'RemoveFromSIS', 'GrantPerfReport'
];

function isbeTrackingEnsureSQL() {
    let sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ISBETracking')
    CREATE TABLE ISBETracking (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        StudentId INT NOT NULL,
        SchoolYear NVARCHAR(20)
    );
`;
    for (const c of ISBE_TRACKING_COLUMNS) {
        sql += `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='ISBETracking' AND COLUMN_NAME='${c}') ALTER TABLE ISBETracking ADD ${c} BIT DEFAULT 0;\n`;
    }
    sql += schoolYearColumnSQL('ISBETracking');
    return sql;
}

// Ticks one checklist column for a student in a given year. Used by every form
// save so the roster reflects a completed form immediately. Kept in one place
// because there are six form handlers that all need identical upsert semantics.
function trackingTickSQL(studentId, year, field) {
    return `IF EXISTS (SELECT 1 FROM ISBETracking WHERE StudentId=${studentId} AND SchoolYear=${esc(year)})
    UPDATE ISBETracking SET ${field}=1 WHERE StudentId=${studentId} AND SchoolYear=${esc(year)}
ELSE
    INSERT INTO ISBETracking (StudentId,SchoolYear,${field}) VALUES (${studentId},${esc(year)},1);
`;
}

// ── PICC per-child document forms ──
// PI6.A Family Centered Assessment, PI6.B Individual Family Goal Plan,
// PI7.A Transition Plan and PI7.B Referral all need the same treatment: one row
// per student, a printable form, and an auto-checked box on the roster. Rather
// than four near-identical endpoint pairs, each form is declared here as
// [columnName, sqlType, jsonKey] and served by one generic GET/POST.
// Column order drives both the INSERT and the SELECT, so it must stay stable;
// append new fields at the end and the migration below adds them in place.
const PI_DOC_FORMS = {
    'family-assessment': {
        table: 'PIFamilyAssessments',
        trackingColumn: 'FamilyCenteredAssessment',
        columns: [
            ['AssessmentDate', 'NVARCHAR(20)', 'assessmentDate'],
            ['EnrollmentDate', 'NVARCHAR(20)', 'enrollmentDate'],
            ['AssessmentTool', 'NVARCHAR(200)', 'assessmentTool'],
            ['ToolOther', 'NVARCHAR(300)', 'toolOther'],
            ['CompletedBy', 'NVARCHAR(200)', 'completedBy'],
            ['FamilyStrengths', 'NVARCHAR(MAX)', 'familyStrengths'],
            ['FamilyNeeds', 'NVARCHAR(MAX)', 'familyNeeds'],
            ['AreasOfConcern', 'NVARCHAR(MAX)', 'areasOfConcern'],
            ['NextSteps', 'NVARCHAR(MAX)', 'nextSteps'],
            ['ParentSignature', 'NVARCHAR(200)', 'parentSignature'],
            ['StaffSignature', 'NVARCHAR(200)', 'staffSignature'],
            ['SignedDate', 'NVARCHAR(20)', 'signedDate']
        ]
    },
    'family-goal-plan': {
        table: 'PIFamilyGoalPlans',
        trackingColumn: 'FamilyGoalPlan',
        columns: [
            ['PlanDate', 'NVARCHAR(20)', 'planDate'],
            ['EnrollmentDate', 'NVARCHAR(20)', 'enrollmentDate'],
            ['PlanType', 'NVARCHAR(60)', 'planType'],
            ['FamilyStrengths', 'NVARCHAR(MAX)', 'familyStrengths'],
            ['Goal1', 'NVARCHAR(MAX)', 'goal1'],
            ['Goal1Steps', 'NVARCHAR(MAX)', 'goal1Steps'],
            ['Goal1Resources', 'NVARCHAR(MAX)', 'goal1Resources'],
            ['Goal1Responsible', 'NVARCHAR(200)', 'goal1Responsible'],
            ['Goal1Target', 'NVARCHAR(20)', 'goal1Target'],
            ['Goal1Status', 'NVARCHAR(40)', 'goal1Status'],
            ['Goal2', 'NVARCHAR(MAX)', 'goal2'],
            ['Goal2Steps', 'NVARCHAR(MAX)', 'goal2Steps'],
            ['Goal2Resources', 'NVARCHAR(MAX)', 'goal2Resources'],
            ['Goal2Responsible', 'NVARCHAR(200)', 'goal2Responsible'],
            ['Goal2Target', 'NVARCHAR(20)', 'goal2Target'],
            ['Goal2Status', 'NVARCHAR(40)', 'goal2Status'],
            ['Goal3', 'NVARCHAR(MAX)', 'goal3'],
            ['Goal3Steps', 'NVARCHAR(MAX)', 'goal3Steps'],
            ['Goal3Resources', 'NVARCHAR(MAX)', 'goal3Resources'],
            ['Goal3Responsible', 'NVARCHAR(200)', 'goal3Responsible'],
            ['Goal3Target', 'NVARCHAR(20)', 'goal3Target'],
            ['Goal3Status', 'NVARCHAR(40)', 'goal3Status'],
            ['NextReviewDate', 'NVARCHAR(20)', 'nextReviewDate'],
            ['ParentSignature', 'NVARCHAR(200)', 'parentSignature'],
            ['StaffSignature', 'NVARCHAR(200)', 'staffSignature'],
            ['SignedDate', 'NVARCHAR(20)', 'signedDate']
        ]
    },
    'transition-plan': {
        table: 'PITransitionPlans',
        trackingColumn: 'TransitionPlan',
        columns: [
            ['PlanDate', 'NVARCHAR(20)', 'planDate'],
            ['TransitionType', 'NVARCHAR(120)', 'transitionType'],
            ['TransitionDate', 'NVARCHAR(20)', 'transitionDate'],
            ['ReceivingProgram', 'NVARCHAR(300)', 'receivingProgram'],
            ['ReceivingContact', 'NVARCHAR(200)', 'receivingContact'],
            ['ReceivingPhone', 'NVARCHAR(60)', 'receivingPhone'],
            ['CurrentServices', 'NVARCHAR(MAX)', 'currentServices'],
            ['TransitionSteps', 'NVARCHAR(MAX)', 'transitionSteps'],
            ['RecordsTransferred', 'NVARCHAR(MAX)', 'recordsTransferred'],
            ['ParentNotifiedDate', 'NVARCHAR(20)', 'parentNotifiedDate'],
            ['RecordsConsent', 'NVARCHAR(20)', 'recordsConsent'],
            ['FamilyConcerns', 'NVARCHAR(MAX)', 'familyConcerns'],
            ['StaffResponsible', 'NVARCHAR(200)', 'staffResponsible'],
            ['SuddenExit', 'NVARCHAR(20)', 'suddenExit'],
            ['ContactAttempts', 'NVARCHAR(MAX)', 'contactAttempts'],
            ['ParentSignature', 'NVARCHAR(200)', 'parentSignature'],
            ['StaffSignature', 'NVARCHAR(200)', 'staffSignature'],
            ['SignedDate', 'NVARCHAR(20)', 'signedDate']
        ]
    },
    // PI5.A weighted eligibility form, with PI5.B-G priority populations,
    // PI5.H determination and PI5.J income verification on the same document.
    // One column per criterion so eligibility can be reported on later.
    'weighted-eligibility': {
        table: 'PIWeightedEligibility',
        trackingColumn: 'WeightedEligibility',
        columns: [
            ['CompletedDate', 'NVARCHAR(20)', 'completedDate'],
            ['EnrollmentDate', 'NVARCHAR(20)', 'enrollmentDate'],
            ['CompletedBy', 'NVARCHAR(200)', 'completedBy'],
            ['Homeless', 'NVARCHAR(10)', 'homeless'],
            ['YouthInCare', 'NVARCHAR(10)', 'youthInCare'],
            ['EarlyIntervention', 'NVARCHAR(10)', 'earlyIntervention'],
            ['HasIep', 'NVARCHAR(10)', 'hasIep'],
            ['ScreeningDelayNoEi', 'NVARCHAR(10)', 'screeningDelayNoEi'],
            ['IncomeBelow50Fpl', 'NVARCHAR(10)', 'incomeBelow50Fpl'],
            ['ParentEll', 'NVARCHAR(10)', 'parentEll'],
            ['NonEnglishHome', 'NVARCHAR(10)', 'nonEnglishHome'],
            ['PublicBenefits', 'NVARCHAR(10)', 'publicBenefits'],
            ['AbuseHistory', 'NVARCHAR(10)', 'abuseHistory'],
            ['MentalIllness', 'NVARCHAR(10)', 'mentalIllness'],
            ['DcfsInvolvement', 'NVARCHAR(10)', 'dcfsInvolvement'],
            ['SubstanceAbuse', 'NVARCHAR(10)', 'substanceAbuse'],
            ['CaregiverOther', 'NVARCHAR(10)', 'caregiverOther'],
            ['FamilyDeath', 'NVARCHAR(10)', 'familyDeath'],
            ['LowBirthWeight', 'NVARCHAR(10)', 'lowBirthWeight'],
            ['ParentIncarcerated', 'NVARCHAR(10)', 'parentIncarcerated'],
            ['TeenParent', 'NVARCHAR(10)', 'teenParent'],
            ['NoHsDiploma', 'NVARCHAR(10)', 'noHsDiploma'],
            ['BornOutsideUs', 'NVARCHAR(10)', 'bornOutsideUs'],
            ['ActiveMilitary', 'NVARCHAR(10)', 'activeMilitary'],
            ['SingleParent', 'NVARCHAR(10)', 'singleParent'],
            ['TotalPoints', 'NVARCHAR(10)', 'totalPoints'],
            ['HouseholdIncome', 'NVARCHAR(40)', 'householdIncome'],
            ['HouseholdSize', 'NVARCHAR(10)', 'householdSize'],
            ['IncomeVerificationType', 'NVARCHAR(120)', 'incomeVerificationType'],
            ['IncomeVerificationDate', 'NVARCHAR(20)', 'incomeVerificationDate'],
            ['BenefitCardInParentName', 'NVARCHAR(20)', 'benefitCardInParentName'],
            ['EligibilityResult', 'NVARCHAR(120)', 'eligibilityResult'],
            ['Notes', 'NVARCHAR(MAX)', 'notes'],
            ['ParentSignature', 'NVARCHAR(200)', 'parentSignature'],
            ['StaffSignature', 'NVARCHAR(200)', 'staffSignature'],
            ['SignedDate', 'NVARCHAR(20)', 'signedDate']
        ]
    },
    'screening-results-shared': {
        table: 'PIScreeningResultsShared',
        trackingColumn: 'ScreeningResultsShared',
        columns: [
            ['ToolUsed', 'NVARCHAR(120)', 'toolUsed'],
            ['ToolOther', 'NVARCHAR(200)', 'toolOther'],
            ['ScreeningDate', 'NVARCHAR(20)', 'screeningDate'],
            ['ScreenerName', 'NVARCHAR(200)', 'screenerName'],
            ['ResultsSummary', 'NVARCHAR(MAX)', 'resultsSummary'],
            ['SharedDate', 'NVARCHAR(20)', 'sharedDate'],
            ['SharedWith', 'NVARCHAR(200)', 'sharedWith'],
            ['SharedMethod', 'NVARCHAR(120)', 'sharedMethod'],
            ['EvidenceOfSharing', 'NVARCHAR(MAX)', 'evidenceOfSharing'],
            ['ParentResponse', 'NVARCHAR(MAX)', 'parentResponse'],
            ['ConcernIdentified', 'NVARCHAR(10)', 'concernIdentified'],
            ['ReferralMade', 'NVARCHAR(20)', 'referralMade'],
            ['FollowUpNotes', 'NVARCHAR(MAX)', 'followUpNotes'],
            ['ParentSignature', 'NVARCHAR(200)', 'parentSignature'],
            ['StaffSignature', 'NVARCHAR(200)', 'staffSignature'],
            ['SignedDate', 'NVARCHAR(20)', 'signedDate']
        ]
    },
    'referral': {
        table: 'PIReferrals',
        trackingColumn: 'Referral',
        columns: [
            ['NotApplicable', 'NVARCHAR(20)', 'notApplicable'],
            ['NotApplicableReason', 'NVARCHAR(MAX)', 'notApplicableReason'],
            ['ReferralDate', 'NVARCHAR(20)', 'referralDate'],
            ['ReferralReason', 'NVARCHAR(200)', 'referralReason'],
            ['ConcernSource', 'NVARCHAR(200)', 'concernSource'],
            ['ConcernDetail', 'NVARCHAR(MAX)', 'concernDetail'],
            ['ReferredTo', 'NVARCHAR(300)', 'referredTo'],
            ['AgencyContact', 'NVARCHAR(200)', 'agencyContact'],
            ['AgencyPhone', 'NVARCHAR(60)', 'agencyPhone'],
            ['ReferredBy', 'NVARCHAR(200)', 'referredBy'],
            ['ParentNotifiedDate', 'NVARCHAR(20)', 'parentNotifiedDate'],
            ['ParentConsent', 'NVARCHAR(20)', 'parentConsent'],
            ['Outcome', 'NVARCHAR(120)', 'outcome'],
            ['OutcomeDate', 'NVARCHAR(20)', 'outcomeDate'],
            ['FollowUpNotes', 'NVARCHAR(MAX)', 'followUpNotes'],
            ['StaffSignature', 'NVARCHAR(200)', 'staffSignature'],
            ['SignedDate', 'NVARCHAR(20)', 'signedDate']
        ]
    }
};

// ── ParentInterviews schema ──
// PICC PI5.L requires the preferred language to be identified on the Parent
// Interview Form, and PI5.M requires a section recording translator
// arrangements. The checklist states neither section may be left blank. The
// table predates these columns in production, hence the migrations.
const PARENT_INTERVIEW_ADDED_COLUMNS = [
    ['PreferredLanguage', 'NVARCHAR(120)'],
    ['TranslatorNeeded', 'NVARCHAR(20)'],
    ['TranslatorArrangements', 'NVARCHAR(MAX)']
];

function parentInterviewEnsureSQL() {
    let sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ParentInterviews')
    CREATE TABLE ParentInterviews (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        StudentId INT NOT NULL,
        InterviewDate NVARCHAR(20),
        ParentGoals NVARCHAR(MAX),
        ParentConcerns NVARCHAR(MAX),
        ChildStrengths NVARCHAR(MAX),
        ParentSignature NVARCHAR(200),
        StaffSignature NVARCHAR(200),
        Notes NVARCHAR(MAX),
        CreatedAt DATETIME DEFAULT GETDATE(),
        UpdatedAt DATETIME DEFAULT GETDATE()
    );
`;
    for (const [name, type] of PARENT_INTERVIEW_ADDED_COLUMNS) {
        sql += `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='ParentInterviews' AND COLUMN_NAME='${name}') ALTER TABLE ParentInterviews ADD ${name} ${type};\n`;
    }
    sql += schoolYearColumnSQL('ParentInterviews');
    return sql;
}

// ── ProgramCompliance schema ──
// Key/value store, one row per (school year, field). The PICC panel writes a
// status, a date and a free-text note per checklist item, and a 200-char note
// would truncate, so FieldValue widens to MAX. FieldName stays NVARCHAR(50)
// because it sits inside UQ_Compliance and widening it would mean dropping and
// rebuilding that constraint; item keys are validated against 50 instead.
const COMPLIANCE_FIELD_NAME_MAX = 50;

// ── Staff schema ──
// Staff records were previously held in browser localStorage on staff-cards.html,
// which meant credential data existed only in one browser and a version bump in
// that page silently reset it to hardcoded defaults. They live here now because
// four other things depend on them: the PAS qualification worksheets, PICC CB6
// (classroom staff qualifications) and PI9 (professional development plans), the
// ExceleRate training thresholds, and CB4 staff-to-classroom ratios.
//
// ReviewedBy/ReviewedDate exist because the seed data was machine-extracted from
// Gateways PDFs and needs a human to confirm it before it backs a compliance
// claim. Unreviewed is the honest default.
function staffEnsureSQL() {
    return `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='Staff')
    CREATE TABLE Staff (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Name NVARCHAR(200) NOT NULL,
        Role NVARCHAR(200),
        Program NVARCHAR(40),
        Classroom NVARCHAR(100),
        Fte NVARCHAR(10),
        Education NVARCHAR(100),
        EceCredentials NVARCHAR(300),
        Gateways NVARCHAR(200),
        ExperienceYears NVARCHAR(20),
        RegistryId NVARCHAR(40),
        Notes NVARCHAR(MAX),
        Active BIT DEFAULT 1,
        ReviewedBy NVARCHAR(200),
        ReviewedDate NVARCHAR(20),
        StaffGroup NVARCHAR(40),
        SecondaryClassroom NVARCHAR(100),
        SemesterHoursTotal NVARCHAR(20),
        SemesterHoursEce NVARCHAR(20),
        TranscriptOnFile NVARCHAR(20),
        PdHoursYtd NVARCHAR(20),
        CreatedAt DATETIME DEFAULT GETDATE(),
        UpdatedAt DATETIME DEFAULT GETDATE()
    );
GO
/* Added after the table shipped, so existing databases need the column too.
   Separates the ownership group from classroom staff. It matters beyond display:
   the ExceleRate credential thresholds are proportions of TEACHING staff, and
   counting owners and administrators in that denominator would understate them. */
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Staff' AND COLUMN_NAME='StaffGroup')
    ALTER TABLE Staff ADD StaffGroup NVARCHAR(40);
GO
/* A second room the person is SCHEDULED to teach in part time, distinct from the
   irregular fill-in cover that is deliberately not tracked. It has to be a real
   place on the schedule, because that is what lets a credential be counted: the
   ExceleRate infant/toddler requirement is about staff working with infants and
   toddlers, and unscheduled cover would not support the claim.

   Staff appear on the PAS teaching worksheet for both rooms. */
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Staff' AND COLUMN_NAME='SecondaryClassroom')
    ALTER TABLE Staff ADD SecondaryClassroom NVARCHAR(100);
GO
/* Semester hours off the official transcript, and whether the Registry has it.

   The PAS Teaching Staff Qualifications worksheet asks for general and ECE
   semester hours per person, and until now nothing held them, so every worksheet
   printed with those columns blank. They also explain a gap that cost real
   credential levels here: Sue Engel has 53 earned hours including an infant and
   toddler course, none of which reached Gateways, so her registry record shows a
   high school diploma only. Tracking whether the transcript is on file makes that
   kind of omission visible instead of invisible. */
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Staff' AND COLUMN_NAME='SemesterHoursTotal')
    ALTER TABLE Staff ADD SemesterHoursTotal NVARCHAR(20);
GO
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Staff' AND COLUMN_NAME='SemesterHoursEce')
    ALTER TABLE Staff ADD SemesterHoursEce NVARCHAR(20);
GO
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Staff' AND COLUMN_NAME='TranscriptOnFile')
    ALTER TABLE Staff ADD TranscriptOnFile NVARCHAR(20);
GO
/* Professional development clock hours in the current school year.

   ExceleRate asks for 20 hours a year per classroom teaching staff member. The
   StaffTraining table records WHICH trainings were completed but carries no hour
   count, so the total cannot be derived from it. Held as a running total the
   director maintains, rather than computed, because PD comes from many sources
   (Gateways, in-house, conferences) that will never all be itemised here. */
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Staff' AND COLUMN_NAME='PdHoursYtd')
    ALTER TABLE Staff ADD PdHoursYtd NVARCHAR(20);
`;
}

// Columns the staff endpoints read and write, in one place so the SELECT, the
// INSERT and the UPDATE cannot drift apart.
const STAFF_COLUMNS = [
    ['Name', 'name'], ['Role', 'role'], ['Program', 'program'], ['Classroom', 'classroom'],
    ['Fte', 'fte'], ['Education', 'education'], ['EceCredentials', 'eceCredentials'],
    ['Gateways', 'gateways'], ['ExperienceYears', 'experienceYears'], ['RegistryId', 'registryId'],
    ['Notes', 'notes'], ['ReviewedBy', 'reviewedBy'], ['ReviewedDate', 'reviewedDate'],
    ['StaffGroup', 'staffGroup'], ['SecondaryClassroom', 'secondaryClassroom'],
    ['SemesterHoursTotal', 'semesterHoursTotal'], ['SemesterHoursEce', 'semesterHoursEce'],
    ['TranscriptOnFile', 'transcriptOnFile'], ['PdHoursYtd', 'pdHoursYtd']
];

/* One-time migration payload: the staff list that used to be hardcoded in
   staff-cards.html as DEFAULT_STAFF. Inserted only when the table is empty, so
   it runs once and never overwrites the director's later edits. Registry IDs
   have been lifted out of the free-text notes into their own column; the notes
   are kept verbatim because they carry the verification trail.

   Safe to delete this constant once the table is populated in production. */
const STAFF_SEED = [
    { name: 'Keyona Hentz', role: 'Teacher', program: 'PFA', classroom: 'Pre-School', fte: '1.0', education: "Bachelor's", eceCredentials: 'ECE Level 5, IT Level 4, Director Level I', gateways: 'ECE Credential - Level 5', experienceYears: '9.5', registryId: 'N285894', notes: "Holds a Director Level I credential and serves as PFA Director for the grant, but her role here is Teacher. Bachelor's ECE (Univ of Arizona Global, 2020). Associate's ECE (SWIC, 2016). Prior: Toddle Town Inc IT (5/2015-5/2018, 6,240 hrs) + Preschool (3/2020-5/2022, 4,160 hrs), Belleville PS Dist 118 IT (08/22-08/24, 2,340 hrs). Current: CofP since 2/2024 - PFA Teacher + Director (teaching 520 hrs + admin 2,050 hrs thru 03/2025, continuing). Total ~9.5 yrs as of 08/2026." },
    { name: 'Madeline Muir', role: 'Assistant Teacher', program: 'PFA', classroom: 'Pre-School', fte: '1.0', education: 'High School/GED', eceCredentials: 'ECE Level 1', gateways: 'ECE Credential - Level 1', experienceYears: '3.5', registryId: 'N559187', notes: 'HS Diploma (Waterloo HS, 2012). ECE Level 1 (2/20/2025). Prior: Together We Grow - Asst Teacher Infant room (01/2023-05/2023, 4,160 hrs). Current: CofP since 01/2024.' },
    { name: 'Lindsey Runyon', role: 'Teacher', program: 'INCCRA', classroom: 'Toddlers', fte: '1.0', education: "Associate's", eceCredentials: 'ECE Level 1', gateways: 'ECE Credential - Level 1', experienceYears: '14', registryId: 'N171961', notes: "Associate's ECC (SWIC, 2011). At CofP since 4/2/2012. Moved from Pre-School 2 to the Toddler room for 2026-2027. 40hrs/wk. Pending: ECE & IT (Missing Documents)." },
    { name: 'Tara Goldsmith', role: 'Teacher', program: 'PI', classroom: 'Infant', fte: '1.0', education: 'High School/GED', eceCredentials: 'ECE Level 1, CDA', gateways: 'ECE Credential - Level 1', experienceYears: '14', registryId: 'N230823', notes: 'HS Diploma (Belleville West, 2004). At CofP since 10/15/2012. 40hrs/wk x 12+ yrs = 24,900+ hrs. Now the Infant Room Teacher (no longer floating). Holds a CDA. Pending: Director, ECE, IT.' },
    { name: 'Paige Turner', role: 'Teacher', program: 'PI', classroom: 'Infant/Toddler', fte: '.75', education: 'High School/GED', eceCredentials: '', gateways: '', experienceYears: '10', registryId: 'N452129', notes: 'HS Diploma (Litchfield Senior HS, 2013). At CofP since 1/2016 as Infant/Toddler Teacher. 32hrs/wk x 8+ yrs = 13,312+ hrs. Verified by Megan Nooney 12/16/2024. No Gateways credential yet.' },
    { name: 'Janell Poenitske', role: 'Teacher', program: 'PI', classroom: 'Pre-School 2', fte: '1.0', education: 'Some College', eceCredentials: 'ECE Level 1', gateways: 'ECE Credential - Level 1', experienceYears: '12', registryId: 'N147146', notes: "Pursuing a Director credential, but her role here is Teacher. HS Diploma (Providence HS, 1994). Coursework: Bachelor's Music (SIUE). Prior: Together We Grow (9/2023, 1,040 hrs), Magic Building Blocks (9/09-12/2010, 4,640 hrs), First Baptist/Early Years (10/2015-2/2023, 15,184 hrs). Current: CofP since 6/3/2024. Pending: Director, IT, ECE." },
    { name: 'Sue Engel', role: 'Teacher', program: 'PI', classroom: 'Infant/Toddler', fte: '.75', education: 'High School/GED', eceCredentials: 'ECE Level 1', gateways: 'ECE Credential - Level 1', experienceYears: '37', registryId: 'N278509', notes: 'HS Diploma (Belleville West, 1982). At CofP since 5/1988. 30hrs/wk x 36+ yrs = 56,160+ total hrs. Preschool/Toddler - care, feed, daily activities. Pending: ECE & IT.' },
    { name: 'Renee Nier', role: 'Assistant Teacher', program: 'PI', classroom: '2 Year Olds / Toddlers', fte: '1.0', education: '', eceCredentials: '', gateways: '', experienceYears: '', registryId: '', notes: 'Sole staff member in the 2 Year Olds / Toddlers room as of 2026-2027. Not in Gateways report as of 2/24/2025 — qualifications still need gathering.' },
    /* Classroom is deliberately blank: Megan is Director only as of 2026-2027,
       with no assigned room. That keeps her off the teaching staff worksheets —
       her qualifications belong on the Administrator Qualifications worksheet. */
    { name: 'Megan Nooney', role: 'Director', program: 'PI', classroom: '', fte: '1.0', education: "Associate's", eceCredentials: 'ECE Level 1, Gold IT2, Autism 101', gateways: 'ECE Credential - Level 1', experienceYears: '17.5', registryId: 'N179660', notes: "Director only as of 2026-2027, no assigned classroom. Associate's ECE (SWIC, 2012). At CofP since 01/2009. Prior teaching: 40hrs/wk x 15+ yrs = 31,200+ hrs - lead teacher preschool, curriculum, schedules. Admin: Director since 01/2009 - staff, files, admin, filling classrooms. Pending: IT, ECE, Director (Awaiting Work Exp). Gold IT2 (1/2024)." },
    { name: 'Molly Ellis', role: 'Teacher', program: 'PI', classroom: '2 Year Olds', fte: '', education: '', eceCredentials: '', gateways: '', experienceYears: '', registryId: '', notes: 'New teacher for 2026-2027, took over the 2 Year Olds room from Janell Poenitske. Qualifications not yet gathered — needs education, Gateways ECE level, credentials and prior experience before the PAS worksheets can be completed.' },
    /* Ownership group. Taken from the Gateways Staff Education and Credentials
       report of 9/6/2026, which is the source of truth for names, degrees and
       credential levels. Grouped separately from classroom staff because the
       ExceleRate credential thresholds are proportions of teaching staff. */
    { name: 'Pamela Holliday', role: 'Director', program: 'n/a', classroom: 'Before and Afterschool', fte: '', education: "Master's", eceCredentials: 'ECE Level 5', gateways: 'ECE Credential - Level 5', experienceYears: '21', registryId: 'N52689', staffGroup: 'Ownership', notes: 'Ownership group. Gateways 9/6/2026: Director/Early Childhood Teacher, position code 16 Director/Administrator (multi site), serves School-Age, at CofP since 1/3/2005. HS (Collinsville 1967), Bachelor\u2019s Special Education (SIU Carbondale 1971), Master\u2019s Special Education (SIUE 1976). ECE Level 1 (9/13/2017), ECE Level 5 (3/25/2025). Pending: Illinois Director Credential (Awaiting Work Experience).' },
    { name: 'Clete Holliday', role: 'Director', program: 'n/a', classroom: '', fte: '', education: "Bachelor's", eceCredentials: '', gateways: '', experienceYears: '', registryId: 'N297190', staffGroup: 'Ownership', notes: 'Ownership group, no classroom assignment. Gateways 9/6/2026: Manager LLC, position code 1 Director/Administrator (one site), age served Not Applicable, since 1/1/2025. Associate\u2019s and Bachelor\u2019s Electrical Engineering. No Gateways credentials. REGISTRY MEMBERSHIP EXPIRED \u2014 needs renewal.' },
    { name: 'Jeremy Holliday', role: 'Assistant Teacher', program: 'n/a', classroom: 'Before and Afterschool', fte: '', education: 'High School/GED', eceCredentials: 'ECE Level 1', gateways: 'ECE Credential - Level 1', experienceYears: '11', registryId: 'N279427', staffGroup: 'Ownership', notes: 'Ownership group. Gateways 9/6/2026: Assistant Child Care Worker, position code 5 Assistant Teacher, serves Preschool, at CofP since 1/5/2015. HS (Belleville West 2001). ECE Level 1 (10/13/2017).' },
    { name: 'Sara Holliday', role: 'Teacher', program: 'n/a', classroom: 'Before and Afterschool', fte: '', education: 'Some College', eceCredentials: 'ECE Level 1', gateways: 'ECE Credential - Level 1', experienceYears: '26', registryId: 'N236163', staffGroup: 'Ownership', notes: 'Ownership group. Gateways 9/6/2026: Early Childhood Teacher, position code 4 Teacher, serves Infants and Preschool, at CofP since 5/1/2000 (position since 5/1/2008). HS (Belleville West 2000), coursework toward Associate\u2019s and Bachelor\u2019s (no degree awarded). ECE Level 1 (12/4/2017). Pending: ECE Credential and Infant Toddler Credential (both Awaiting Additional Coursework).' },
    { name: 'New Teacher', role: 'TBD', program: 'n/a', classroom: 'TBD', fte: '', education: '', eceCredentials: '', gateways: '', experienceYears: '', registryId: '', notes: 'Placeholder for new hire' }
];

function staffSeedSQL() {
    const cols = STAFF_COLUMNS.map(([c]) => c).join(',');
    const rows = STAFF_SEED.map(s =>
        '(' + STAFF_COLUMNS.map(([, key]) => esc(s[key])).join(',') + ')').join(',\n        ');
    // Guarded on the table being empty, so this is a migration and not a reset.
    return `IF NOT EXISTS (SELECT 1 FROM Staff)
    INSERT INTO Staff (${cols}) VALUES
        ${rows};
`;
}

// ── StaffTraining schema ──
// One row per staff member per training. Backs two different requirements from
// the same data: the ExceleRate Silver thresholds (How ERS Works needs the
// director plus 50% of teaching staff, ideally one per classroom) and PICC PI9,
// which wants a professional development record for every staff member.
//
// Keyed on (StaffId, TrainingKey). A completion is cleared by deleting the row
// rather than blanking the date, so "no row" unambiguously means not done.
function staffTrainingEnsureSQL() {
    return `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='StaffTraining')
    CREATE TABLE StaffTraining (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        StaffId INT NOT NULL,
        TrainingKey NVARCHAR(60) NOT NULL,
        CompletedDate NVARCHAR(20),
        EvidenceLink NVARCHAR(500),
        Notes NVARCHAR(MAX),
        CreatedAt DATETIME DEFAULT GETDATE(),
        UpdatedAt DATETIME DEFAULT GETDATE()
    );
`;
}

/* ── StaffDevelopmentPlan / StaffDevelopmentGoal schemas ──
   PICC PI9 requires a written, dated Professional Development Plan for every PI
   staff member, carrying the person's name, the plan date and timelines, an
   assessment of their needs, and a description of the learning the program will
   provide. Those four things are the columns below.

   Superseded plans are kept rather than overwritten. PI9 asks for timelines, and
   a single mutable row cannot evidence progression or show a monitor that the
   mid-year review happened. The current plan is the newest row for that person
   with Status='Active'; issuing a new one marks the previous 'Superseded'.

   Note the frequency: PI9 itself states no review cadence. The annual and
   mid-year rhythm comes from the employee handbook 10.3 and the staff timeline,
   which are the centre's own policy and stricter than the regulation. */
function staffDevPlanEnsureSQL() {
    return `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='StaffDevelopmentPlan')
    CREATE TABLE StaffDevelopmentPlan (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        StaffId INT NOT NULL,
        PlanDate NVARCHAR(20),
        ReviewDate NVARCHAR(20),
        PlanType NVARCHAR(30),
        NeedsAssessment NVARCHAR(MAX),
        ProgramWillProvide NVARCHAR(MAX),
        LongTermGoals NVARCHAR(MAX),
        StaffSignedDate NVARCHAR(20),
        SupervisorSignedDate NVARCHAR(20),
        SupervisorName NVARCHAR(200),
        Status NVARCHAR(20) DEFAULT 'Active',
        CreatedAt DATETIME DEFAULT GETDATE(),
        UpdatedAt DATETIME DEFAULT GETDATE()
    );
GO
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='StaffDevelopmentGoal')
    CREATE TABLE StaffDevelopmentGoal (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        PlanId INT NOT NULL,
        Goal NVARCHAR(500),
        ActionSteps NVARCHAR(MAX),
        Timeline NVARCHAR(200),
        Resources NVARCHAR(500),
        Evidence NVARCHAR(500),
        Status NVARCHAR(30),
        CompletedDate NVARCHAR(20),
        SortOrder INT DEFAULT 0,
        CreatedAt DATETIME DEFAULT GETDATE(),
        UpdatedAt DATETIME DEFAULT GETDATE()
    );
`;
}

const DEVPLAN_COLUMNS = [
    ['StaffId', 'staffId'], ['PlanDate', 'planDate'], ['ReviewDate', 'reviewDate'],
    ['PlanType', 'planType'], ['NeedsAssessment', 'needsAssessment'],
    ['ProgramWillProvide', 'programWillProvide'], ['LongTermGoals', 'longTermGoals'],
    ['StaffSignedDate', 'staffSignedDate'], ['SupervisorSignedDate', 'supervisorSignedDate'],
    ['SupervisorName', 'supervisorName'], ['Status', 'status']
];
const DEVGOAL_COLUMNS = [
    ['PlanId', 'planId'], ['Goal', 'goal'], ['ActionSteps', 'actionSteps'],
    ['Timeline', 'timeline'], ['Resources', 'resources'], ['Evidence', 'evidence'],
    ['Status', 'status'], ['CompletedDate', 'completedDate'], ['SortOrder', 'sortOrder']
];

// ── SilverSelfAssessments schema ──
// ExceleRate Silver wants one environment-rating self-assessment per classroom,
// with the instrument set by the ages served: ITERS-3 for infants, toddlers and
// twos, ECERS-3 for 3-5s, SACERS-U for school age. Tracked per room rather than
// per program because that is how the scoresheets are completed and submitted.
//
// Keyed on (RoomNumber, Instrument) so a 2-3 room that switches from ITERS-3 to
// ECERS-3 under the 75% rule keeps both records rather than overwriting one.
function silverAssessmentEnsureSQL() {
    return `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='SilverSelfAssessments')
    CREATE TABLE SilverSelfAssessments (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        RoomNumber NVARCHAR(20) NOT NULL,
        Instrument NVARCHAR(40) NOT NULL,
        CompletedDate NVARCHAR(20),
        UploadedDate NVARCHAR(20),
        EvidenceLink NVARCHAR(500),
        Notes NVARCHAR(MAX),
        CreatedAt DATETIME DEFAULT GETDATE(),
        UpdatedAt DATETIME DEFAULT GETDATE()
    );
`;
}

// ── PasWorksheets schema ──
// The PAS self-assessment and its supporting worksheets are filled in across
// seven pages that each kept their answers in browser localStorage, under keys
// like pas_teaching_staff_quals_<classroom>. That meant the artifact being
// prepared for submission existed only in whichever browser typed it, could not
// be reviewed by anyone else, and vanished with a cleared cache.
//
// One row per (worksheet, scope). Scope is the classroom key for the per-room
// worksheets and empty for program-level ones. The answers are stored as the
// same JSON object the pages already build from their [data-field] inputs, so
// each page keeps its own shape and no schema change is needed to add a field.
function pasWorksheetEnsureSQL() {
    return `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='PasWorksheets')
    CREATE TABLE PasWorksheets (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        WorksheetKey NVARCHAR(60) NOT NULL,
        ScopeKey NVARCHAR(60) NOT NULL,
        Payload NVARCHAR(MAX),
        UpdatedBy NVARCHAR(200),
        CreatedAt DATETIME DEFAULT GETDATE(),
        UpdatedAt DATETIME DEFAULT GETDATE()
    );
`;
}

// ── SiteSettings schema ──
// Key/value store for facts that are true of the site regardless of school year:
// the DCFS license, ExceleRate level, and similar. Deliberately has no
// SchoolYear column, which is what distinguishes it from ProgramCompliance.
function siteSettingsEnsureSQL() {
    return `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='SiteSettings')
    CREATE TABLE SiteSettings (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        SettingKey NVARCHAR(60) NOT NULL UNIQUE,
        SettingValue NVARCHAR(MAX),
        UpdatedAt DATETIME DEFAULT GETDATE()
    );
`;
}

function complianceEnsureSQL() {
    return `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ProgramCompliance')
    CREATE TABLE ProgramCompliance (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        SchoolYear NVARCHAR(20) NOT NULL,
        FieldName NVARCHAR(${COMPLIANCE_FIELD_NAME_MAX}) NOT NULL,
        FieldValue NVARCHAR(MAX),
        UpdatedAt DATETIME DEFAULT GETDATE(),
        CONSTRAINT UQ_Compliance UNIQUE(SchoolYear, FieldName)
    );
IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='ProgramCompliance' AND COLUMN_NAME='FieldValue' AND CHARACTER_MAXIMUM_LENGTH <> -1)
    ALTER TABLE ProgramCompliance ALTER COLUMN FieldValue NVARCHAR(MAX);
`;
}

function docFormEnsureSQL(cfg) {
    const cols = cfg.columns.map(([name, type]) => `        ${name} ${type}`).join(',\n');
    let sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='${cfg.table}')
    CREATE TABLE ${cfg.table} (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        StudentId INT NOT NULL,
${cols},
        CreatedAt DATETIME DEFAULT GETDATE(),
        UpdatedAt DATETIME DEFAULT GETDATE()
    );
`;
    // Forward migration so fields added to the config later appear without manual DDL.
    for (const [name, type] of cfg.columns) {
        sql += `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='${cfg.table}' AND COLUMN_NAME='${name}') ALTER TABLE ${cfg.table} ADD ${name} ${type};\n`;
    }
    sql += schoolYearColumnSQL(cfg.table);
    return sql;
}

function runSQL(sql) {
    const tmp = path.join(__dirname, '_q.sql');
    fs.writeFileSync(tmp, sql, 'utf8');
    try {
        const out = execSync(`"C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\170\\Tools\\Binn\\sqlcmd.exe" -S ${DB_SERVER} -d ${DB_NAME} -E -s "|" -W -h -1 -i "${tmp}"`,
            { encoding: 'utf8', shell: 'cmd.exe' });
        console.log('[SQL]', out.trim());
        return { ok: true, data: out };
    } catch (e) {
        console.error('[SQL ERR]', e.stderr || e.message);
        return { ok: false, error: e.stderr || e.message };
    } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
    }
}

function parseRows(raw) {
    return raw.trim().split('\n')
        .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
        .map(l => {
            const vals = l.split('|').map(v => v.trim());
            const obj = {};
            COLS.forEach((c, i) => obj[c] = vals[i] ?? '');
            return obj;
        });
}

function sendJSON(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
}

function readBody(req, cb) {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { cb(null, JSON.parse(b)); } catch (e) { cb(e); } });
}

const server = http.createServer((req, res) => {
    // If HTTPS is available, redirect HTTP to HTTPS (except for ACME challenges)
    if (sslOptions && !req.url.startsWith('/.well-known/acme-challenge')) {
        const host = (req.headers.host || '').split(':')[0];
        res.writeHead(301, { 'Location': `https://${host}${req.url}` });
        return res.end();
    }
    handleRequest(req, res);
});

// HTTPS server
let httpsServer = null;
if (sslOptions) {
    httpsServer = https.createServer(sslOptions, (req, res) => {
        handleRequest(req, res);
    });
}

function handleRequest(req, res) {
    const url = req.url.split('?')[0];

    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT', 'Access-Control-Allow-Headers': 'Content-Type' });
        return res.end();
    }

    // GET health check (public)
    if (req.method === 'GET' && url === '/api/health') {
        return sendJSON(res, 200, { ok: true });
    }

    // POST upload proof of income (internal - protected)
    if (req.method === 'POST' && url.startsWith('/api/upload/income/')) {
        if (!checkAuth(req, res)) return;
        const studentId = decodeURIComponent(url.split('/')[4] || '');
        const uploadDir = path.join(__dirname, '..', 'uploads', 'income');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

        let body = [];
        req.on('data', chunk => body.push(chunk));
        req.on('end', () => {
            const buf = Buffer.concat(body);
            const contentType = req.headers['content-type'] || '';
            const boundary = contentType.split('boundary=')[1];
            if (!boundary) return sendJSON(res, 400, { error: 'No boundary' });

            // Parse multipart
            const parts = buf.toString('binary').split('--' + boundary);
            for (const part of parts) {
                if (!part.includes('filename=')) continue;
                const nameMatch = part.match(/filename="([^"]+)"/);
                if (!nameMatch) continue;
                const origName = nameMatch[1];
                const ext = path.extname(origName);
                const safeName = `${studentId.replace(/[^a-zA-Z0-9]/g,'_')}_${Date.now()}${ext}`;
                const filePath = path.join(uploadDir, safeName);
                const headerEnd = part.indexOf('\r\n\r\n');
                if (headerEnd < 0) continue;
                const fileData = Buffer.from(part.slice(headerEnd + 4, part.lastIndexOf('\r\n')), 'binary');
                fs.writeFileSync(filePath, fileData);

                // Update DB
                const r = runSQL(`UPDATE rptMasterEnrollment SET ProofOfIncomeFile=${esc(safeName)},ProofOfIncomeUploaded=1 WHERE First_Name=${esc(studentId.split('|')[0])} AND Last_Name=${esc(studentId.split('|')[1])}`);
                if (!r.ok) return sendJSON(res, 500, { error: r.error });
                return sendJSON(res, 200, { success: true, file: safeName });
            }
            sendJSON(res, 400, { error: 'No file found in upload' });
        });
        return;
    }

    // GET download proof of income (internal - protected)
    if (req.method === 'GET' && url.startsWith('/api/download/income/')) {
        if (!checkAuth(req, res)) return;
        const fileName = decodeURIComponent(url.split('/')[4] || '');
        const filePath = path.join(__dirname, '..', 'uploads', 'income', fileName);
        if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('Not found'); }
        const ext = path.extname(fileName).toLowerCase();
        const mime = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Content-Disposition': `inline; filename="${fileName}"` });
        fs.createReadStream(filePath).pipe(res);
        return;
    }
    // GET students (internal - protected)
    if (req.method === 'GET' && url === '/api/students') {
        if (!checkAuth(req, res)) return;
        // Ensure CCAPStartDate column exists (separate batch so metadata refreshes)
        runSQL(`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='rptMasterEnrollment' AND COLUMN_NAME='CCAPStartDate') ALTER TABLE rptMasterEnrollment ADD CCAPStartDate NVARCHAR(20)`);
        const r = runSQL(`SELECT e.Id,e.Last_Name,e.First_Name,e.Birth_date,e.Start_Date,e.City_Town,e.Days_Old,e.RoomNumber,r.Room,r.TeacherDescription,r.Type,r.DCFSCapacity,e.Monday,e.Tuesday,e.Wednesday,e.Thursday,e.Friday,e.Active,e.Category,e.PFA_PI_na,e.F_R_P_Food,e.IEP,e.Military,ISNULL(e.HouseholdIncome,'') AS HouseholdIncome,ISNULL(e.ProofOfIncomeFile,'') AS ProofOfIncomeFile,ISNULL(CAST(e.ProofOfIncomeUploaded AS NVARCHAR),'0') AS ProofOfIncomeUploaded,ISNULL(e.PublicBenefits,'') AS PublicBenefits,ISNULL(CAST(e.HouseholdSize AS NVARCHAR),'') AS HouseholdSize,ISNULL(e.CCAPStartDate,'') AS CCAPStartDate FROM rptMasterEnrollment e LEFT JOIN dimClassrooms r ON e.RoomNumber=r.RoomNumber ORDER BY e.RoomNumber,e.Last_Name`);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()) && !l.includes('Changed database') && !l.includes('Commands completed') && l.includes('|'))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return {
                    Id: v[0], Last_Name: v[1], First_Name: v[2], Birth_date: v[3], Start_Date: v[4],
                    City_Town: v[5], Days_Old: v[6], RoomNumber: v[7], Room: v[8],
                    TeacherDescription: v[9], Type: v[10], Room_Capacity: v[11],
                    Monday: v[12], Tuesday: v[13], Wednesday: v[14], Thursday: v[15], Friday: v[16],
                    Active: v[17], Category: v[18], PFA_PI_na: v[19], F_R_P_Food: v[20],
                    IEP: v[21], Military: v[22], HouseholdIncome: v[23],
                    ProofOfIncomeFile: v[24], ProofOfIncomeUploaded: v[25], PublicBenefits: v[26], HouseholdSize: v[27], CCAPStartDate: v[28]
                };
            });
        return sendJSON(res, 200, rows);
    }

    // GET classrooms (internal - protected)
    if (req.method === 'GET' && url === '/api/classrooms') {
        if (!checkAuth(req, res)) return;
        const r = runSQL(`SELECT ${ROOM_COLS.join(',')} FROM dimClassrooms ORDER BY RoomNumber`);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return { RoomNumber: v[0], Building: v[1], Room: v[2], TeacherDescription: v[3], Type: v[4], RequiredSlots: v[5], AgeRange: v[6], DCFSCapacity: v[7] };
            });
        return sendJSON(res, 200, rows);
    }

    // POST new classroom (internal - protected)
    if (req.method === 'POST' && url === '/api/classrooms') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const sql = `INSERT INTO dimClassrooms (RoomNumber,Room,TeacherDescription,DCFSCapacity,AgeRange) VALUES (${parseInt(d.roomNumber)},${esc(d.room)},${esc(d.teacher)},${parseInt(d.capacity)||10},${esc(d.ageRange)})`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // PUT update classroom (internal - protected)
    if (req.method === 'PUT' && url.startsWith('/api/classrooms/')) {
        if (!checkAuth(req, res)) return;
        const roomNumber = decodeURIComponent(url.split('/')[3] || '');
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const fields = [];
            if (d.room !== undefined)     fields.push(`Room=${esc(d.room)}`);
            if (d.teacher !== undefined)  fields.push(`TeacherDescription=${esc(d.teacher)}`);
            if (d.capacity !== undefined) fields.push(`DCFSCapacity=${parseInt(d.capacity) || 0}`);
            if (d.ageRange !== undefined) fields.push(`AgeRange=${esc(d.ageRange)}`);
            if (!fields.length) return sendJSON(res, 400, { error: 'Nothing to update' });
            const rn = parseInt(roomNumber);
            const whereClause = isNaN(rn) ? `RoomNumber=${esc(roomNumber)}` : `RoomNumber=${rn}`;
            const sql = `UPDATE dimClassrooms SET ${fields.join(',')} WHERE ${whereClause}`;
            console.log('[PUT CLASSROOM]', sql);
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // POST new student (internal - protected)
    if (req.method === 'POST' && url === '/api/students') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            console.log('[POST] Saving:', d.firstName, d.lastName);
            // Auto-calculate F/R/P based on USDA income guidelines (2026-2027)
            const freeThresholds  = [20748,28132,35516,42900,50284,57668,65052,72436];
            const reducedThresholds = [29526,40034,50542,61050,71558,82066,92574,103082];
            const hhSize = Math.max(1, Math.min(parseInt(d.householdSize)||1, 8)) - 1;
            const income = parseInt(d.householdIncome) || 100000;
            const benefits = d.publicBenefits || '';
            const isFoster = d.category === 'Foster';
            const isMilitary = d.military === true || d.military === 'Yes';
            const isPFA = d.pfaPiNa === 'PFA';
            let frpFood = 'Paid';
            if (benefits || isFoster || isMilitary || isPFA || income <= freeThresholds[hhSize]) frpFood = 'Free';
            else if (income <= reducedThresholds[hhSize]) frpFood = 'Reduced';
            // Keep the link back to the pre-enrollment intake record so the rich
            // family/risk-factor data stays reachable after the child is enrolled.
            const preId = parseInt(d.preEnrollmentId);
            const preIdVal = isNaN(preId) ? 'NULL' : preId;
            const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='rptMasterEnrollment' AND COLUMN_NAME='PreEnrollmentId') ALTER TABLE rptMasterEnrollment ADD PreEnrollmentId INT NULL;
                INSERT INTO rptMasterEnrollment (Last_Name,First_Name,Birth_date,Start_Date,City_Town,Days_Old,RoomNumber,Monday,Tuesday,Wednesday,Thursday,Friday,Active,Category,PFA_PI_na,F_R_P_Food,IEP,Military,HouseholdIncome,HouseholdSize,PublicBenefits,ProofOfIncomeUploaded,PreEnrollmentId) VALUES (${esc(d.lastName)},${esc(d.firstName)},${esc(d.birthDate)},${esc(d.startDate)},${esc(d.cityTown)},${esc(d.daysOld)},${esc(d.roomNumber)},${d.monday?1:0},${d.tuesday?1:0},${d.wednesday?1:0},${d.thursday?1:0},${d.friday?1:0},${esc(d.active)},${esc(d.category)},${esc(d.pfaPiNa)},${esc(frpFood)},${esc(d.iep)},${esc(d.military)},${esc(d.householdIncome)},${parseInt(d.householdSize)||0},${esc(d.publicBenefits)},0,${preIdVal})`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            if (!r.data.includes('rows affected')) return sendJSON(res, 500, { error: 'No rows written: ' + r.data });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // GET screening summary for every student (internal - protected).
    // One row per student/type/period so the roster can show dates, concerns and
    // referral status without a request per child.
    if (req.method === 'GET' && url === '/api/screening-summary') {
        if (!checkAuth(req, res)) return;
        const summaryYear = resolveSchoolYear(new URLSearchParams(req.url.split('?')[1] || '').get('year'));
        const summaryEnsure = schoolYearColumnSQL('ScreeningScores');
        // Concern logic differs by instrument:
        //  ASQ-3      higher score is better, so 'Below' cutoff is the concern.
        //  ASQ:SE-2   higher score means more concern, so 'Above' cutoff is the concern.
        const sql = summaryEnsure + `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ScreeningScores') SELECT 0 AS StudentId WHERE 1=0
            ELSE
            SELECT StudentId,
                ISNULL(ScreeningType,'') AS ScreeningType,
                ISNULL(Period,'') AS Period,
                ISNULL(ScreeningDate,'') AS ScreeningDate,
                ISNULL(ReferralMade,'') AS ReferralMade,
                CASE WHEN ScreeningType='ASQ-3' AND (CommStatus='Below' OR GrossStatus='Below' OR FineStatus='Below' OR ProblemStatus='Below' OR PersonalStatus='Below') THEN 'concern'
                     WHEN ScreeningType='ASQ-3' AND (CommStatus='Monitor' OR GrossStatus='Monitor' OR FineStatus='Monitor' OR ProblemStatus='Monitor' OR PersonalStatus='Monitor') THEN 'monitor'
                     WHEN ScreeningType<>'ASQ-3' AND SEResult='Above' THEN 'concern'
                     WHEN ScreeningType<>'ASQ-3' AND SEResult='Monitor' THEN 'monitor'
                     ELSE 'ok' END AS Flag
            FROM ScreeningScores WHERE SchoolYear=${esc(summaryYear)}`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => /^\s*\d+\s*\|/.test(l))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return { StudentId: v[0], ScreeningType: v[1], Period: v[2], ScreeningDate: v[3], ReferralMade: v[4], Flag: v[5] };
            });
        return sendJSON(res, 200, rows);
    }

    // GET the pre-enrollment intake record linked to a student (internal - protected).
    // Prefers the stored PreEnrollmentId; falls back to an exact child name + DOB match
    // for students enrolled before the link existed.
    if (req.method === 'GET' && url.startsWith('/api/student-intake/')) {
        if (!checkAuth(req, res)) return;
        const studentId = parseInt(url.split('/')[3]);
        if (!studentId) return sendJSON(res, 400, { error: 'Student ID required' });
        // Free-text columns are flattened: rows are returned as pipe-delimited lines
        // split on newlines, so an embedded newline would corrupt the record.
        const flat = col => `REPLACE(REPLACE(ISNULL(${col},''),CHAR(13),' '),CHAR(10),' ')`;
        const cols = `p.Id,ISNULL(p.SubmittedAt,'') AS SubmittedAt,ISNULL(p.FirstName,'') AS ParentFirst,ISNULL(p.LastName,'') AS ParentLast,`
            + `ISNULL(p.Phone,'') AS Phone,ISNULL(p.Email,'') AS Email,ISNULL(p.Address,'') AS Address,ISNULL(p.City,'') AS City,ISNULL(p.Zip,'') AS Zip,`
            + `ISNULL(p.ChildName,'') AS ChildName,ISNULL(p.ChildBirthDate,'') AS ChildBirthDate,ISNULL(p.AgeGroup,'') AS AgeGroup,ISNULL(p.DaysRequested,'') AS DaysRequested,`
            + `ISNULL(CAST(p.Score AS NVARCHAR),'') AS Score,ISNULL(p.WaitlistStatus,'') AS WaitlistStatus,`
            + `ISNULL(p.Homeless,'') AS Homeless,ISNULL(p.FosterAdopted,'') AS FosterAdopted,ISNULL(p.IEP,'') AS IEP,ISNULL(p.EarlyIntervention,'') AS EarlyIntervention,`
            + `ISNULL(p.AbuseHistory,'') AS AbuseHistory,ISNULL(p.MentalIllness,'') AS MentalIllness,ISNULL(p.DcfsInvolvement,'') AS DcfsInvolvement,`
            + `ISNULL(p.SubstanceAbuse,'') AS SubstanceAbuse,ISNULL(p.CaregiverOther,'') AS CaregiverOther,ISNULL(p.FamilyDeath,'') AS FamilyDeath,`
            + `ISNULL(p.LowBirthWeight,'') AS LowBirthWeight,ISNULL(p.ParentIncarcerated,'') AS ParentIncarcerated,ISNULL(p.TeenParent,'') AS TeenParent,`
            + `ISNULL(p.NoHSDiploma,'') AS NoHSDiploma,ISNULL(p.BornOutsideUS,'') AS BornOutsideUS,ISNULL(p.NonEnglishHome,'') AS NonEnglishHome,`
            + `ISNULL(p.ActiveMilitary,'') AS ActiveMilitary,ISNULL(p.PriorEarlyLearning,'') AS PriorEarlyLearning,ISNULL(p.BrightpointSubsidy,'') AS BrightpointSubsidy,`
            + `${flat('p.LivingSituation')} AS LivingSituation,ISNULL(p.HouseholdIncome,'') AS HouseholdIncome,ISNULL(CAST(p.HouseholdSize AS NVARCHAR),'') AS HouseholdSize,`
            + `ISNULL(p.PublicBenefits,'') AS PublicBenefits,`
            // PICC PI5.C / PI5.G / PI5.F priority populations. Added to the intake
            // form later than the rest, so older records return blank here.
            + `ISNULL(p.ScreeningDelayNoEi,'') AS ScreeningDelayNoEi,ISNULL(p.ParentEll,'') AS ParentEll,ISNULL(p.IncomeBelow50Fpl,'') AS IncomeBelow50Fpl,`
            + `${flat('p.Notes')} AS Notes`;
        const sql = `SELECT TOP 1 ${cols},'linked' AS MatchType FROM rptMasterEnrollment e INNER JOIN PreEnrollment p ON p.Id = e.PreEnrollmentId WHERE e.Id=${studentId}
            UNION ALL
            SELECT TOP 1 ${cols},'name+dob' AS MatchType FROM rptMasterEnrollment e INNER JOIN PreEnrollment p ON LTRIM(RTRIM(p.ChildName))=LTRIM(RTRIM(e.First_Name+' '+e.Last_Name)) AND CONVERT(date,p.ChildBirthDate)=CONVERT(date,e.Birth_date) WHERE e.Id=${studentId} AND e.PreEnrollmentId IS NULL`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const keys = ['Id','SubmittedAt','ParentFirst','ParentLast','Phone','Email','Address','City','Zip','ChildName','ChildBirthDate','AgeGroup','DaysRequested','Score','WaitlistStatus','Homeless','FosterAdopted','IEP','EarlyIntervention','AbuseHistory','MentalIllness','DcfsInvolvement','SubstanceAbuse','CaregiverOther','FamilyDeath','LowBirthWeight','ParentIncarcerated','TeenParent','NoHSDiploma','BornOutsideUS','NonEnglishHome','ActiveMilitary','PriorEarlyLearning','BrightpointSubsidy','LivingSituation','HouseholdIncome','HouseholdSize','PublicBenefits','ScreeningDelayNoEi','ParentEll','IncomeBelow50Fpl','Notes','MatchType'];
        const line = r.data.trim().split('\n').find(l => /^\s*\d+\s*\|/.test(l));
        if (!line) return sendJSON(res, 200, { found: false });
        const v = line.split('|').map(x => x.trim());
        const rec = { found: true };
        keys.forEach((k, i) => rec[k] = v[i] || '');
        return sendJSON(res, 200, rec);
    }

    // PUT update student (internal - protected)
    if (req.method === 'PUT' && url.startsWith('/api/students/')) {
        if (!checkAuth(req, res)) return;
        const parts = url.split('/');
        const origFirst = decodeURIComponent(parts[3] || '');
        const origLast  = decodeURIComponent(parts[4] || '');
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });

            // Auto-calculate F_R_P_Food from income/size/benefits (USDA 2026-2027)
            const freeThresholds  = [20748,28132,35516,42900,50284,57668,65052,72436];
            const reducedThresholds = [29526,40034,50542,61050,71558,82066,92574,103082];
            const hasIncome = d.householdIncome !== undefined && d.householdIncome !== '';
            const hasSize   = d.householdSize !== undefined && d.householdSize !== '';
            if (hasIncome && hasSize) {
                const hhSize = Math.max(1, Math.min(parseInt(d.householdSize)||1, 8)) - 1;
                const income = parseInt(d.householdIncome) || 100000;
                const benefits = d.publicBenefits || '';
                const isFoster = d.category === 'Foster';
                const isMilitary = d.military === true || d.military === 'Yes';
                const isPFA = d.pfaPiNa === 'PFA';
                let frpFood = 'Paid';
                if (benefits || isFoster || isMilitary || isPFA || income <= freeThresholds[hhSize]) frpFood = 'Free';
                else if (income <= reducedThresholds[hhSize]) frpFood = 'Reduced';
                d.frpFood = frpFood;
            }

            const fields = [];
            if (d.lastName !== undefined)        fields.push(`Last_Name=${esc(d.lastName)}`);
            if (d.firstName !== undefined)       fields.push(`First_Name=${esc(d.firstName)}`);
            if (d.birthDate !== undefined)       fields.push(`Birth_date=${esc(d.birthDate)}`);
            if (d.startDate !== undefined)       fields.push(`Start_Date=${esc(d.startDate)}`);
            if (d.cityTown !== undefined)        fields.push(`City_Town=${esc(d.cityTown)}`);
            if (d.daysOld !== undefined)         fields.push(`Days_Old=${esc(d.daysOld)}`);
            if (d.roomNumber !== undefined)      fields.push(`RoomNumber=${esc(d.roomNumber)}`);
            if (d.monday !== undefined)          fields.push(`Monday=${d.monday?1:0}`);
            if (d.tuesday !== undefined)         fields.push(`Tuesday=${d.tuesday?1:0}`);
            if (d.wednesday !== undefined)       fields.push(`Wednesday=${d.wednesday?1:0}`);
            if (d.thursday !== undefined)        fields.push(`Thursday=${d.thursday?1:0}`);
            if (d.friday !== undefined)          fields.push(`Friday=${d.friday?1:0}`);
            if (d.active !== undefined)          fields.push(`Active=${esc(d.active)}`);
            if (d.category !== undefined)        fields.push(`Category=${esc(d.category)}`);
            if (d.pfaPiNa !== undefined)         fields.push(`PFA_PI_na=${esc(d.pfaPiNa)}`);
            if (d.frpFood !== undefined)         fields.push(`F_R_P_Food=${esc(d.frpFood)}`);
            if (d.iep !== undefined)             fields.push(`IEP=${esc(d.iep)}`);
            if (d.military !== undefined)        fields.push(`Military=${esc(d.military)}`);
            if (d.householdIncome !== undefined)  fields.push(`HouseholdIncome=${esc(d.householdIncome)}`);
            if (d.householdSize !== undefined)    fields.push(`HouseholdSize=${d.householdSize?parseInt(d.householdSize):'NULL'}`);
            if (d.publicBenefits !== undefined)   fields.push(`PublicBenefits=${esc(d.publicBenefits)}`);
            if (d.proofOfIncome !== undefined)    fields.push(`ProofOfIncomeUploaded=${d.proofOfIncome?1:0}`);
            if (d.ccapStartDate !== undefined)    fields.push(`CCAPStartDate=${esc(d.ccapStartDate)}`);
            if (!fields.length) return sendJSON(res, 400, { error: 'Nothing to update' });
            const sql = `UPDATE rptMasterEnrollment SET ${fields.join(',')} WHERE First_Name=${esc(origFirst)} AND Last_Name=${esc(origLast)}`;
            console.log('[PUT SQL]', sql);
            const r = runSQL(sql);
            console.log('[PUT RESULT]', JSON.stringify(r));
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            if (!r.data.includes('rows affected')) return sendJSON(res, 500, { error: 'No rows updated: ' + r.data });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // POST run SQL (internal - protected)
    if (req.method === 'POST' && url === '/api/sql') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            if (!d.query) return sendJSON(res, 400, { error: 'No query provided' });
            const r = runSQL(d.query);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true, output: r.data });
        });
        return;
    }

    // POST deploy (internal - protected) — pulls code only, no restart
    if (req.method === 'POST' && url === '/api/deploy') {
        if (!checkAuth(req, res)) return;
        try {
            const out = execSync('"C:\\Program Files\\Git\\mingw64\\bin\\git.exe" fetch origin && "C:\\Program Files\\Git\\mingw64\\bin\\git.exe" reset --hard origin/master', { encoding: 'utf8', shell: 'cmd.exe', cwd: 'C:\\app' });
            console.log('[DEPLOY]', out);
            return sendJSON(res, 200, { success: true, output: out, message: 'Code updated. Static files active immediately. Restart server if server.js changed.' });
        } catch (e) {
            return sendJSON(res, 500, { error: e.message });
        }
    }

    // POST restart server (internal - protected)
    if (req.method === 'POST' && url === '/api/restart') {
        if (!checkAuth(req, res)) return;
        sendJSON(res, 200, { success: true, message: 'Server restarting...' });
        setTimeout(() => {
            try {
                // Spawn a detached process that waits 2 seconds then starts the server
                const child = require('child_process').spawn('cmd.exe', ['/c', 'timeout /t 2 /nobreak >nul & cd /d C:\\app & Launch.bat'], {
                    detached: true,
                    stdio: 'ignore',
                    shell: false
                });
                child.unref();
            } catch(e) { console.error('[RESTART ERR]', e.message); }
            process.exit(0);
        }, 1000);
        return;
    }

    // POST summer program sign-up (public)
    if (req.method === 'POST' && url === '/api/summer') {
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const sql = `
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'SummerProgram')
                CREATE TABLE SummerProgram (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    SubmittedAt DATETIME DEFAULT GETDATE(),
                    ParentFirstName NVARCHAR(100),
                    ParentLastName NVARCHAR(100),
                    ParentPhone NVARCHAR(30),
                    ChildFirstName NVARCHAR(100),
                    ChildLastName NVARCHAR(100),
                    ChildAge INT,
                    Days NVARCHAR(200)
                );
                INSERT INTO SummerProgram (ParentFirstName,ParentLastName,ParentPhone,ChildFirstName,ChildLastName,ChildAge,Days)
                VALUES (${esc(d.parentFirstName)},${esc(d.parentLastName)},${esc(d.parentPhone)},${esc(d.childFirstName)},${esc(d.childLastName)},${parseInt(d.childAge)||0},${esc(d.days)});`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // POST pre-enrollment form (public)
    if (req.method === 'POST' && url === '/api/preenrollment') {
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const sql = `
                IF NOT EXISTS (
                    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
                    WHERE TABLE_NAME = 'PreEnrollment'
                )
                CREATE TABLE PreEnrollment (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    SubmittedAt DATETIME DEFAULT GETDATE(),
                    FirstName NVARCHAR(100),
                    LastName NVARCHAR(100),
                    Email NVARCHAR(200),
                    Address NVARCHAR(500),
                    City NVARCHAR(100),
                    Zip NVARCHAR(20),
                    Country NVARCHAR(100),
                    Phone NVARCHAR(30),
                    ChildrenInfo NVARCHAR(1000),
                    HouseholdIncome NVARCHAR(200),
                    PublicBenefits NVARCHAR(500),
                    Homeless NVARCHAR(10),
                    IEP NVARCHAR(10),
                    NoHSDiploma NVARCHAR(10),
                    TeenParent NVARCHAR(10),
                    BornOutsideUS NVARCHAR(10),
                    FosterAdopted NVARCHAR(10),
                    NonEnglishHome NVARCHAR(10),
                    ActiveMilitary NVARCHAR(10),
                    PriorEarlyLearning NVARCHAR(10),
                    BrightpointSubsidy NVARCHAR(10),
                    LivingSituation NVARCHAR(20),
                    EarlyIntervention NVARCHAR(10),
                    AbuseHistory NVARCHAR(10),
                    MentalIllness NVARCHAR(10)
                );
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='ChildName') ALTER TABLE PreEnrollment ADD ChildName NVARCHAR(200);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='ChildBirthDate') ALTER TABLE PreEnrollment ADD ChildBirthDate NVARCHAR(20);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='ChildStartDate') ALTER TABLE PreEnrollment ADD ChildStartDate NVARCHAR(20);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='HouseholdSize') ALTER TABLE PreEnrollment ADD HouseholdSize INT;
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='DcfsInvolvement') ALTER TABLE PreEnrollment ADD DcfsInvolvement NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='SubstanceAbuse') ALTER TABLE PreEnrollment ADD SubstanceAbuse NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='CaregiverOther') ALTER TABLE PreEnrollment ADD CaregiverOther NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='FamilyDeath') ALTER TABLE PreEnrollment ADD FamilyDeath NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='LowBirthWeight') ALTER TABLE PreEnrollment ADD LowBirthWeight NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='ParentIncarcerated') ALTER TABLE PreEnrollment ADD ParentIncarcerated NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='Score') ALTER TABLE PreEnrollment ADD Score INT DEFAULT 0;
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='WaitlistStatus') ALTER TABLE PreEnrollment ADD WaitlistStatus NVARCHAR(20) DEFAULT 'Pending';
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='AgeGroup') ALTER TABLE PreEnrollment ADD AgeGroup NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='DaysRequested') ALTER TABLE PreEnrollment ADD DaysRequested NVARCHAR(50);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='ScreeningDelayNoEi') ALTER TABLE PreEnrollment ADD ScreeningDelayNoEi NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='ParentEll') ALTER TABLE PreEnrollment ADD ParentEll NVARCHAR(10);
                IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='IncomeBelow50Fpl') ALTER TABLE PreEnrollment ADD IncomeBelow50Fpl NVARCHAR(10);
                INSERT INTO PreEnrollment (
                    FirstName,LastName,Email,Address,City,Zip,Country,Phone,
                    ChildrenInfo,ChildName,ChildBirthDate,ChildStartDate,AgeGroup,DaysRequested,HouseholdIncome,HouseholdSize,PublicBenefits,Homeless,IEP,
                    NoHSDiploma,TeenParent,BornOutsideUS,FosterAdopted,
                    NonEnglishHome,ActiveMilitary,PriorEarlyLearning,
                    BrightpointSubsidy,LivingSituation,EarlyIntervention,
                    AbuseHistory,MentalIllness,DcfsInvolvement,SubstanceAbuse,
                    CaregiverOther,FamilyDeath,LowBirthWeight,ParentIncarcerated,
                    ScreeningDelayNoEi,ParentEll,IncomeBelow50Fpl,Score
                ) VALUES (
                    ${esc(d.firstName)},${esc(d.lastName)},${esc(d.email)},
                    ${esc(d.address)},${esc(d.city)},${esc(d.zip)},${esc(d.country)},
                    ${esc(d.phone)},${esc(d.childrenInfo)},${esc(d.childName)},${esc(d.childBirthDate)},${esc(d.childStartDate)},${esc(d.ageGroup)},${esc(d.daysRequested||'')},
                    ${esc(d.householdIncome)},${parseInt(d.householdSize)||0},${esc(d.publicBenefits)},${esc(d.homeless)},${esc(d.iep)},
                    ${esc(d.noHSDiploma)},${esc(d.teenParent)},${esc(d.bornOutsideUS)},
                    ${esc(d.fosterAdopted)},${esc(d.nonEnglishHome)},${esc(d.activeMilitary)},
                    ${esc(d.priorEarlyLearning)},${esc(d.brightpointSubsidy)},
                    ${esc(d.livingSituation)},${esc(d.earlyIntervention)},
                    ${esc(d.abuseHistory)},${esc(d.mentalIllness)},
                    ${esc(d.dcfsInvolvement)},${esc(d.substanceAbuse)},
                    ${esc(d.caregiverOther)},${esc(d.familyDeath)},
                    ${esc(d.lowBirthWeight)},${esc(d.parentIncarcerated)},
                    ${esc(d.screeningDelayNoEi)},${esc(d.parentEll)},${esc(d.incomeBelow50Fpl)},
                    ${parseInt(d.score)||0}
                );`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // GET ISBE tracking data (internal - protected)
    if (req.method === 'GET' && url === '/api/isbe-tracking') {
        if (!checkAuth(req, res)) return;
        // Column list comes from ISBE_TRACKING_COLUMNS so the SELECT can never drift
        // out of step with the schema the way EnterSIS/RemoveFromSIS previously did.
        const select = ISBE_TRACKING_COLUMNS.map(c => `ISNULL(${c},0) AS ${c}`).join(',');
        const year = resolveSchoolYear(new URLSearchParams(req.url.split('?')[1] || '').get('year'));
        const sql = isbeTrackingEnsureSQL()
            + `SELECT StudentId,${select} FROM ISBETracking WHERE SchoolYear=${esc(year)}`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                const row = { StudentId: v[0] };
                ISBE_TRACKING_COLUMNS.forEach((c, i) => { row[c] = v[i + 1] === '1'; });
                return row;
            });
        return sendJSON(res, 200, rows);
    }

    // GET parent interview for a student (internal - protected)
    if (req.method === 'GET' && url.startsWith('/api/parent-interview/')) {
        if (!checkAuth(req, res)) return;
        const studentId = parseInt(url.split('/')[3]);
        const year = resolveSchoolYear(new URLSearchParams(req.url.split('?')[1] || '').get('year'));
        const sql = parentInterviewEnsureSQL()
            + `SELECT Id,StudentId,InterviewDate,${txCol('ParentGoals')},${txCol('ParentConcerns')},${txCol('ChildStrengths')},${txCol('ParentSignature')},${txCol('StaffSignature')},${txCol('Notes')},${txCol('PreferredLanguage')},${txCol('TranslatorNeeded')},${txCol('TranslatorArrangements')} FROM ParentInterviews WHERE StudentId=${studentId} AND SchoolYear=${esc(year)}`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return { Id:v[0], StudentId:v[1], InterviewDate:v[2], ParentGoals:txDecode(v[3]), ParentConcerns:txDecode(v[4]), ChildStrengths:txDecode(v[5]), ParentSignature:txDecode(v[6]), StaffSignature:txDecode(v[7]), Notes:txDecode(v[8]), PreferredLanguage:txDecode(v[9]), TranslatorNeeded:txDecode(v[10]), TranslatorArrangements:txDecode(v[11]) };
            });
        return sendJSON(res, 200, rows.length ? rows[0] : null);
    }

    // POST save parent interview (internal - protected)
    if (req.method === 'POST' && url.startsWith('/api/parent-interview/')) {
        if (!checkAuth(req, res)) return;
        const studentId = parseInt(url.split('/')[3]);
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const year = resolveSchoolYear(d.year);
            const sql = parentInterviewEnsureSQL()
                + isbeTrackingEnsureSQL()
                + `IF EXISTS (SELECT 1 FROM ParentInterviews WHERE StudentId=${studentId} AND SchoolYear=${esc(year)})
                    UPDATE ParentInterviews SET InterviewDate=${esc(d.interviewDate)},ParentGoals=${esc(d.parentGoals)},ParentConcerns=${esc(d.parentConcerns)},ChildStrengths=${esc(d.childStrengths)},ParentSignature=${esc(d.parentSignature)},StaffSignature=${esc(d.staffSignature)},Notes=${esc(d.notes)},PreferredLanguage=${esc(d.preferredLanguage)},TranslatorNeeded=${esc(d.translatorNeeded)},TranslatorArrangements=${esc(d.translatorArrangements)},UpdatedAt=GETDATE() WHERE StudentId=${studentId} AND SchoolYear=${esc(year)}
                ELSE
                    INSERT INTO ParentInterviews (StudentId,SchoolYear,InterviewDate,ParentGoals,ParentConcerns,ChildStrengths,ParentSignature,StaffSignature,Notes,PreferredLanguage,TranslatorNeeded,TranslatorArrangements) VALUES (${studentId},${esc(year)},${esc(d.interviewDate)},${esc(d.parentGoals)},${esc(d.parentConcerns)},${esc(d.childStrengths)},${esc(d.parentSignature)},${esc(d.staffSignature)},${esc(d.notes)},${esc(d.preferredLanguage)},${esc(d.translatorNeeded)},${esc(d.translatorArrangements)});
`
                + trackingTickSQL(studentId, year, 'ParentInterview');
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // GET permission slip for a student (internal - protected)
    if (req.method === 'GET' && url.startsWith('/api/permission-slip/')) {
        if (!checkAuth(req, res)) return;
        const studentId = parseInt(url.split('/')[3]);
        const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='PermissionSlips')
            CREATE TABLE PermissionSlips (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                StudentId INT NOT NULL,
                ParentName NVARCHAR(200),
                SchoolYear NVARCHAR(20),
                SignedDate NVARCHAR(20),
                Teacher NVARCHAR(200),
                ParentSignature NVARCHAR(200),
                ParentSigDate NVARCHAR(20),
                TeacherSignature NVARCHAR(200),
                TeacherSigDate NVARCHAR(20),
                CreatedAt DATETIME DEFAULT GETDATE(),
                UpdatedAt DATETIME DEFAULT GETDATE()
            );
            ${schoolYearColumnSQL('PermissionSlips')}
            SELECT Id,StudentId,ISNULL(ParentName,'') AS ParentName,ISNULL(SchoolYear,'') AS SchoolYear,ISNULL(SignedDate,'') AS SignedDate,ISNULL(Teacher,'') AS Teacher,ISNULL(ParentSignature,'') AS ParentSignature,ISNULL(ParentSigDate,'') AS ParentSigDate,ISNULL(TeacherSignature,'') AS TeacherSignature,ISNULL(TeacherSigDate,'') AS TeacherSigDate,CreatedAt,UpdatedAt FROM PermissionSlips WHERE StudentId=${studentId} AND SchoolYear=${esc(resolveSchoolYear(new URLSearchParams(req.url.split('?')[1] || '').get('year')))}`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return { Id:v[0], StudentId:v[1], ParentName:v[2], SchoolYear:v[3], SignedDate:v[4], Teacher:v[5], ParentSignature:v[6], ParentSigDate:v[7], TeacherSignature:v[8], TeacherSigDate:v[9], CreatedAt:v[10], UpdatedAt:v[11] };
            });
        return sendJSON(res, 200, rows.length ? rows[0] : null);
    }

    // POST save permission slip (internal - protected)
    if (req.method === 'POST' && url.startsWith('/api/permission-slip/')) {
        if (!checkAuth(req, res)) return;
        const studentId = parseInt(url.split('/')[3]);
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            // The slip form already carries the school year it was filled in for;
            // that is the year the record belongs to.
            const slipYear = resolveSchoolYear(d.schoolYear || d.year);
            const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='PermissionSlips')
                CREATE TABLE PermissionSlips (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    StudentId INT NOT NULL,
                    ParentName NVARCHAR(200),
                    SchoolYear NVARCHAR(20),
                    SignedDate NVARCHAR(20),
                    Teacher NVARCHAR(200),
                    ParentSignature NVARCHAR(200),
                    ParentSigDate NVARCHAR(20),
                    TeacherSignature NVARCHAR(200),
                    TeacherSigDate NVARCHAR(20),
                    CreatedAt DATETIME DEFAULT GETDATE(),
                    UpdatedAt DATETIME DEFAULT GETDATE()
                );
                ${schoolYearColumnSQL('PermissionSlips')}
                IF EXISTS (SELECT 1 FROM PermissionSlips WHERE StudentId=${studentId} AND SchoolYear=${esc(slipYear)})
                    UPDATE PermissionSlips SET ParentName=${esc(d.parentName)},SignedDate=${esc(d.signedDate)},Teacher=${esc(d.teacher)},ParentSignature=${esc(d.parentSignature)},ParentSigDate=${esc(d.parentSigDate)},TeacherSignature=${esc(d.teacherSignature)},TeacherSigDate=${esc(d.teacherSigDate)},UpdatedAt=GETDATE() WHERE StudentId=${studentId} AND SchoolYear=${esc(slipYear)}
                ELSE
                    INSERT INTO PermissionSlips (StudentId,SchoolYear,ParentName,SignedDate,Teacher,ParentSignature,ParentSigDate,TeacherSignature,TeacherSigDate) VALUES (${studentId},${esc(slipYear)},${esc(d.parentName)},${esc(d.signedDate)},${esc(d.teacher)},${esc(d.parentSignature)},${esc(d.parentSigDate)},${esc(d.teacherSignature)},${esc(d.teacherSigDate)});
`
                + trackingTickSQL(studentId, slipYear, 'PermissionSlip');
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // GET a PICC document form for a student (internal - protected)
    // /api/pi-doc/<form-type>/<studentId>
    if (req.method === 'GET' && url.startsWith('/api/pi-doc/')) {
        if (!checkAuth(req, res)) return;
        const parts = url.split('/');
        const cfg = PI_DOC_FORMS[parts[3]];
        if (!cfg) return sendJSON(res, 404, { error: 'Unknown form type' });
        const studentId = parseInt(parts[4]);
        if (!studentId) return sendJSON(res, 400, { error: 'Invalid student id' });

        // `url` has the query string stripped, so read params off req.url.
        const year = resolveSchoolYear(new URLSearchParams(req.url.split('?')[1] || '').get('year'));
        const select = cfg.columns.map(([name]) => txCol(name)).join(',');
        const sql = docFormEnsureSQL(cfg)
            + `SELECT Id,StudentId,${select} FROM ${cfg.table} WHERE StudentId=${studentId} AND SchoolYear=${esc(year)}`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()));
        if (!rows.length) return sendJSON(res, 200, { found: false });
        const v = rows[0].split('|').map(x => x.trim());
        const out = { found: true, Id: v[0], StudentId: v[1] };
        cfg.columns.forEach(([name], i) => { out[name] = txDecode(v[i + 2]); });
        return sendJSON(res, 200, out);
    }

    // POST save a PICC document form (internal - protected)
    // Upserts the form row and auto-checks the matching roster column.
    if (req.method === 'POST' && url.startsWith('/api/pi-doc/')) {
        if (!checkAuth(req, res)) return;
        const parts = url.split('/');
        const cfg = PI_DOC_FORMS[parts[3]];
        if (!cfg) return sendJSON(res, 404, { error: 'Unknown form type' });
        const studentId = parseInt(parts[4]);
        if (!studentId) return sendJSON(res, 400, { error: 'Invalid student id' });

        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const year = resolveSchoolYear(d.year);
            const names = cfg.columns.map(([name]) => name).join(',');
            const vals = cfg.columns.map(([, , key]) => esc(d[key])).join(',');
            const sets = cfg.columns.map(([name, , key]) => `${name}=${esc(d[key])}`).join(',');
            const sql = docFormEnsureSQL(cfg)
                + isbeTrackingEnsureSQL()
                + `IF EXISTS (SELECT 1 FROM ${cfg.table} WHERE StudentId=${studentId} AND SchoolYear=${esc(year)})
    UPDATE ${cfg.table} SET ${sets},UpdatedAt=GETDATE() WHERE StudentId=${studentId} AND SchoolYear=${esc(year)}
ELSE
    INSERT INTO ${cfg.table} (StudentId,SchoolYear,${names}) VALUES (${studentId},${esc(year)},${vals});
`
                + trackingTickSQL(studentId, year, cfg.trackingColumn);
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // GET screening score for a student (internal - protected)
    if (req.method === 'GET' && url.startsWith('/api/screening/')) {
        if (!checkAuth(req, res)) return;
        const studentId = parseInt(url.split('/')[3]);
        const query = req.url.split('?')[1] || '';
        const params = new URLSearchParams(query);
        const type = params.get('type') || '';
        const period = params.get('period') || '';
        const scrYear = resolveSchoolYear(params.get('year'));
        const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ScreeningScores')
            CREATE TABLE ScreeningScores (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                StudentId INT NOT NULL,
                ScreeningType NVARCHAR(20),
                Period NVARCHAR(20),
                ScreeningDate NVARCHAR(20),
                CompletedBy NVARCHAR(20),
                Interval NVARCHAR(30),
                ReferralMade NVARCHAR(10),
                CommScore NVARCHAR(10),CommStatus NVARCHAR(20),
                GrossScore NVARCHAR(10),GrossStatus NVARCHAR(20),
                FineScore NVARCHAR(10),FineStatus NVARCHAR(20),
                ProblemScore NVARCHAR(10),ProblemStatus NVARCHAR(20),
                PersonalScore NVARCHAR(10),PersonalStatus NVARCHAR(20),
                SETotal NVARCHAR(10),SECutoff NVARCHAR(10),SEResult NVARCHAR(20),
                Notes NVARCHAR(MAX),
                CreatedAt DATETIME DEFAULT GETDATE(),
                UpdatedAt DATETIME DEFAULT GETDATE()
            );
            ${schoolYearColumnSQL('ScreeningScores')}
            SELECT Id,StudentId,ScreeningType,Period,ISNULL(ScreeningDate,'') AS ScreeningDate,ISNULL(CompletedBy,'') AS CompletedBy,ISNULL([Interval],'') AS [Interval],ISNULL(ReferralMade,'') AS ReferralMade,ISNULL(CommScore,'') AS CommScore,ISNULL(CommStatus,'') AS CommStatus,ISNULL(GrossScore,'') AS GrossScore,ISNULL(GrossStatus,'') AS GrossStatus,ISNULL(FineScore,'') AS FineScore,ISNULL(FineStatus,'') AS FineStatus,ISNULL(ProblemScore,'') AS ProblemScore,ISNULL(ProblemStatus,'') AS ProblemStatus,ISNULL(PersonalScore,'') AS PersonalScore,ISNULL(PersonalStatus,'') AS PersonalStatus,ISNULL(SETotal,'') AS SETotal,ISNULL(SECutoff,'') AS SECutoff,ISNULL(SEResult,'') AS SEResult,ISNULL(Notes,'') AS Notes FROM ScreeningScores WHERE StudentId=${studentId} AND ScreeningType=${esc(type)} AND Period=${esc(period)} AND SchoolYear=${esc(scrYear)}`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return { Id:v[0],StudentId:v[1],ScreeningType:v[2],Period:v[3],ScreeningDate:v[4],CompletedBy:v[5],Interval:v[6],ReferralMade:v[7],CommScore:v[8],CommStatus:v[9],GrossScore:v[10],GrossStatus:v[11],FineScore:v[12],FineStatus:v[13],ProblemScore:v[14],ProblemStatus:v[15],PersonalScore:v[16],PersonalStatus:v[17],SETotal:v[18],SECutoff:v[19],SEResult:v[20],Notes:v[21] };
            });
        return sendJSON(res, 200, rows.length ? rows[0] : null);
    }

    // POST save screening score (internal - protected)
    if (req.method === 'POST' && url.startsWith('/api/screening/')) {
        if (!checkAuth(req, res)) return;
        const studentId = parseInt(url.split('/')[3]);
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            // Map period to ISBE tracking field
            let isbeField = '';
            if (d.type === 'ASQ-3' && d.period === 'Beginning') isbeField = 'BegASQ';
            else if (d.type === 'ASQ-3' && d.period === 'End') isbeField = 'EndASQ';
            else if (d.type === 'ASQ:SE-2' && d.period === 'Beginning') isbeField = 'BegASE';
            else if (d.type === 'ASQ:SE-2' && d.period === 'End') isbeField = 'EndASE';
            const scrYear = resolveSchoolYear(d.year);

            const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ScreeningScores')
                CREATE TABLE ScreeningScores (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    StudentId INT NOT NULL,
                    ScreeningType NVARCHAR(20),
                    Period NVARCHAR(20),
                    ScreeningDate NVARCHAR(20),
                    CompletedBy NVARCHAR(20),
                    [Interval] NVARCHAR(30),
                    ReferralMade NVARCHAR(10),
                    CommScore NVARCHAR(10),CommStatus NVARCHAR(20),
                    GrossScore NVARCHAR(10),GrossStatus NVARCHAR(20),
                    FineScore NVARCHAR(10),FineStatus NVARCHAR(20),
                    ProblemScore NVARCHAR(10),ProblemStatus NVARCHAR(20),
                    PersonalScore NVARCHAR(10),PersonalStatus NVARCHAR(20),
                    SETotal NVARCHAR(10),SECutoff NVARCHAR(10),SEResult NVARCHAR(20),
                    Notes NVARCHAR(MAX),
                    CreatedAt DATETIME DEFAULT GETDATE(),
                    UpdatedAt DATETIME DEFAULT GETDATE()
                );
                ${schoolYearColumnSQL('ScreeningScores')}
                IF EXISTS (SELECT 1 FROM ScreeningScores WHERE StudentId=${studentId} AND ScreeningType=${esc(d.type)} AND Period=${esc(d.period)} AND SchoolYear=${esc(scrYear)})
                    UPDATE ScreeningScores SET ScreeningDate=${esc(d.screeningDate)},CompletedBy=${esc(d.completedBy)},[Interval]=${esc(d.interval)},ReferralMade=${esc(d.referralMade)},CommScore=${esc(d.commScore||'')},CommStatus=${esc(d.commStatus||'')},GrossScore=${esc(d.grossScore||'')},GrossStatus=${esc(d.grossStatus||'')},FineScore=${esc(d.fineScore||'')},FineStatus=${esc(d.fineStatus||'')},ProblemScore=${esc(d.problemScore||'')},ProblemStatus=${esc(d.problemStatus||'')},PersonalScore=${esc(d.personalScore||'')},PersonalStatus=${esc(d.personalStatus||'')},SETotal=${esc(d.seTotal||'')},SECutoff=${esc(d.seCutoff||'')},SEResult=${esc(d.seResult||'')},Notes=${esc(d.notes)},UpdatedAt=GETDATE() WHERE StudentId=${studentId} AND ScreeningType=${esc(d.type)} AND Period=${esc(d.period)} AND SchoolYear=${esc(scrYear)}
                ELSE
                    INSERT INTO ScreeningScores (StudentId,SchoolYear,ScreeningType,Period,ScreeningDate,CompletedBy,[Interval],ReferralMade,CommScore,CommStatus,GrossScore,GrossStatus,FineScore,FineStatus,ProblemScore,ProblemStatus,PersonalScore,PersonalStatus,SETotal,SECutoff,SEResult,Notes) VALUES (${studentId},${esc(scrYear)},${esc(d.type)},${esc(d.period)},${esc(d.screeningDate)},${esc(d.completedBy)},${esc(d.interval)},${esc(d.referralMade)},${esc(d.commScore||'')},${esc(d.commStatus||'')},${esc(d.grossScore||'')},${esc(d.grossStatus||'')},${esc(d.fineScore||'')},${esc(d.fineStatus||'')},${esc(d.problemScore||'')},${esc(d.problemStatus||'')},${esc(d.personalScore||'')},${esc(d.personalStatus||'')},${esc(d.seTotal||'')},${esc(d.seCutoff||'')},${esc(d.seResult||'')},${esc(d.notes)});
`
                + (isbeField ? trackingTickSQL(studentId, scrYear, isbeField) : '');
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // ══════════════════════════════════════════
    // PARENT PORTAL (public - code-authenticated)
    // ══════════════════════════════════════════

    // POST parent portal login (public)
    if (req.method === 'POST' && url === '/api/parent-portal/login') {
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const code = (d.code || '').trim().toUpperCase();
            if (!code) return sendJSON(res, 400, { error: 'Code required' });

            // Ensure table exists and look up code
            const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ParentCodes')
                CREATE TABLE ParentCodes (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    StudentId INT NOT NULL,
                    Code NVARCHAR(10) NOT NULL UNIQUE,
                    CreatedAt DATETIME DEFAULT GETDATE()
                );
                SELECT pc.StudentId,e.First_Name,e.Last_Name,e.Birth_date,e.RoomNumber,r.Room,r.TeacherDescription,
                    ISNULL(e.HouseholdIncome,'') AS HouseholdIncome,ISNULL(CAST(e.HouseholdSize AS NVARCHAR),'') AS HouseholdSize,
                    ISNULL(e.PublicBenefits,'') AS PublicBenefits,ISNULL(e.IEP,'') AS IEP,ISNULL(e.Military,'') AS Military,
                    ISNULL(e.Category,'') AS Category,ISNULL(e.City_Town,'') AS City_Town,ISNULL(e.PFA_PI_na,'') AS PFA_PI_na
                FROM ParentCodes pc
                JOIN rptMasterEnrollment e ON pc.StudentId=e.Id
                LEFT JOIN dimClassrooms r ON e.RoomNumber=r.RoomNumber
                WHERE pc.Code=${esc(code)}`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            const lines = r.data.trim().split('\n')
                .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()));
            if (!lines.length) return sendJSON(res, 200, { success: false, error: 'Invalid code' });
            const v = lines[0].split('|').map(x => x.trim());
            const student = { Id:v[0], First_Name:v[1], Last_Name:v[2], Birth_date:v[3], RoomNumber:v[4], Room:v[5], TeacherDescription:v[6], HouseholdIncome:v[7], HouseholdSize:v[8], PublicBenefits:v[9], IEP:v[10], Military:v[11], Category:v[12], City_Town:v[13], PFA_PI_na:v[14] };

            // Get tracking status for the year in progress. A parent following a
            // code should see whether THIS year's slip and interview are done, not
            // whether last year's were.
            const tSql = isbeTrackingEnsureSQL()
                + `SELECT PermissionSlip,ParentInterview FROM ISBETracking WHERE StudentId=${parseInt(student.Id)} AND SchoolYear=${esc(currentSchoolYear())}`;
            const tRes = runSQL(tSql);
            let tracking = {};
            if (tRes.ok) {
                const tLines = tRes.data.trim().split('\n')
                    .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()));
                if (tLines.length) {
                    const tv = tLines[0].split('|').map(x => x.trim());
                    tracking = { PermissionSlip: tv[0]==='1', ParentInterview: tv[1]==='1' };
                }
            }

            // Get pre-enrollment data if available
            let preEnroll = {};
            const peSql = `SELECT TOP 1 FirstName,LastName,Phone,Email,Address,City,Zip,
                ISNULL(Homeless,'') AS Homeless,ISNULL(FosterAdopted,'') AS FosterAdopted,
                ISNULL(NonEnglishHome,'') AS NonEnglishHome,ISNULL(ActiveMilitary,'') AS ActiveMilitary,
                ISNULL(TeenParent,'') AS TeenParent,ISNULL(LivingSituation,'') AS LivingSituation,
                ISNULL(IEP,'') AS IEP,ISNULL(EarlyIntervention,'') AS EarlyIntervention,
                ISNULL(ChildName,'') AS ChildName,ISNULL(ChildBirthDate,'') AS ChildBirthDate
                FROM PreEnrollment WHERE
                (ChildName LIKE '%'+${esc(student.First_Name)}+'%' OR FirstName=${esc(student.First_Name)})
                ORDER BY Id DESC`;
            const peRes = runSQL(peSql);
            if (peRes.ok) {
                const peLines = peRes.data.trim().split('\n')
                    .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()));
                if (peLines.length) {
                    const pv = peLines[0].split('|').map(x => x.trim());
                    preEnroll = { FirstName:pv[0],LastName:pv[1],Phone:pv[2],Email:pv[3],Address:pv[4],City:pv[5],Zip:pv[6],Homeless:pv[7],FosterAdopted:pv[8],NonEnglishHome:pv[9],ActiveMilitary:pv[10],TeenParent:pv[11],LivingSituation:pv[12],IEP:pv[13],EarlyIntervention:pv[14],ChildName:pv[15],ChildBirthDate:pv[16] };
                }
            }

            sendJSON(res, 200, { success: true, student, tracking, preEnroll });
        });
        return;
    }

    // POST parent portal sign form (public)
    if (req.method === 'POST' && url === '/api/parent-portal/sign') {
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const code = (d.code || '').trim().toUpperCase();
            const formType = d.formType;
            const data = d.data || {};
            // A parent signing today is signing for the year in progress. The
            // form may also carry the year it was rendered with.
            const formYear = resolveSchoolYear(data.schoolYear || d.year);

            // Verify code and get student ID
            const lookupSql = `SELECT StudentId FROM ParentCodes WHERE Code=${esc(code)}`;
            const lr = runSQL(lookupSql);
            if (!lr.ok) return sendJSON(res, 500, { error: lr.error });
            const lookupLines = lr.data.trim().split('\n')
                .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()));
            if (!lookupLines.length) return sendJSON(res, 403, { error: 'Invalid code' });
            const studentId = parseInt(lookupLines[0].trim());

            if (formType === 'PermissionSlip') {
                const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='PermissionSlips')
                    CREATE TABLE PermissionSlips (
                        Id INT IDENTITY(1,1) PRIMARY KEY,StudentId INT NOT NULL,
                        ParentName NVARCHAR(200),SchoolYear NVARCHAR(20),SignedDate NVARCHAR(20),
                        Teacher NVARCHAR(200),ParentSignature NVARCHAR(200),ParentSigDate NVARCHAR(20),
                        TeacherSignature NVARCHAR(200),TeacherSigDate NVARCHAR(20),
                        CreatedAt DATETIME DEFAULT GETDATE(),UpdatedAt DATETIME DEFAULT GETDATE()
                    );
                    ${schoolYearColumnSQL('PermissionSlips')}
                    IF EXISTS (SELECT 1 FROM PermissionSlips WHERE StudentId=${studentId} AND SchoolYear=${esc(formYear)})
                        UPDATE PermissionSlips SET ParentName=${esc(data.parentName)},SignedDate=${esc(data.signedDate)},Teacher=${esc(data.teacher)},ParentSignature=${esc(data.parentSignature)},ParentSigDate=${esc(data.parentSigDate)},UpdatedAt=GETDATE() WHERE StudentId=${studentId} AND SchoolYear=${esc(formYear)}
                    ELSE
                        INSERT INTO PermissionSlips (StudentId,SchoolYear,ParentName,SignedDate,Teacher,ParentSignature,ParentSigDate) VALUES (${studentId},${esc(formYear)},${esc(data.parentName)},${esc(data.signedDate)},${esc(data.teacher)},${esc(data.parentSignature)},${esc(data.parentSigDate)});
`
                    + trackingTickSQL(studentId, formYear, 'PermissionSlip');
                const r = runSQL(sql);
                if (!r.ok) return sendJSON(res, 500, { error: r.error });
                return sendJSON(res, 200, { success: true });
            }

            if (formType === 'ParentInterview') {
                // Full interview payload kept as JSON alongside the mapped columns.
                // esc() handles the quote escaping, so this must stay raw or the
                // stored JSON ends up double-escaped and unparseable.
                const jsonData = JSON.stringify(data);
                const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ParentInterviews')
                    CREATE TABLE ParentInterviews (
                        Id INT IDENTITY(1,1) PRIMARY KEY,StudentId INT NOT NULL,
                        InterviewDate NVARCHAR(20),ParentGoals NVARCHAR(MAX),ParentConcerns NVARCHAR(MAX),
                        ChildStrengths NVARCHAR(MAX),ParentSignature NVARCHAR(200),StaffSignature NVARCHAR(200),
                        Notes NVARCHAR(MAX),CreatedAt DATETIME DEFAULT GETDATE(),UpdatedAt DATETIME DEFAULT GETDATE()
                    );
                    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='ParentInterviews' AND COLUMN_NAME='FormData') ALTER TABLE ParentInterviews ADD FormData NVARCHAR(MAX);
                    ${schoolYearColumnSQL('ParentInterviews')}
                    IF EXISTS (SELECT 1 FROM ParentInterviews WHERE StudentId=${studentId} AND SchoolYear=${esc(formYear)})
                        UPDATE ParentInterviews SET InterviewDate=${esc(data.signDate||'')},ParentGoals=${esc(data.goals||'')},ParentConcerns=${esc(data.behaviors||'')},ChildStrengths=${esc(data.describeChild||'')},ParentSignature=${esc(data.parentSignature||'')},FormData=${esc(jsonData)},UpdatedAt=GETDATE() WHERE StudentId=${studentId} AND SchoolYear=${esc(formYear)}
                    ELSE
                        INSERT INTO ParentInterviews (StudentId,SchoolYear,InterviewDate,ParentGoals,ParentConcerns,ChildStrengths,ParentSignature,FormData) VALUES (${studentId},${esc(formYear)},${esc(data.signDate||'')},${esc(data.goals||'')},${esc(data.behaviors||'')},${esc(data.describeChild||'')},${esc(data.parentSignature||'')},${esc(jsonData)});
`
                    + trackingTickSQL(studentId, formYear, 'ParentInterview');
                const r = runSQL(sql);
                if (!r.ok) return sendJSON(res, 500, { error: r.error });
                return sendJSON(res, 200, { success: true });
            }

            sendJSON(res, 400, { error: 'Unknown form type' });
        });
        return;
    }

    // GET parent codes for staff (internal - protected)
    if (req.method === 'GET' && url === '/api/parent-codes') {
        if (!checkAuth(req, res)) return;
        const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ParentCodes')
            CREATE TABLE ParentCodes (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                StudentId INT NOT NULL,
                Code NVARCHAR(10) NOT NULL UNIQUE,
                CreatedAt DATETIME DEFAULT GETDATE()
            );
            SELECT pc.StudentId,pc.Code,e.First_Name,e.Last_Name FROM ParentCodes pc JOIN rptMasterEnrollment e ON pc.StudentId=e.Id ORDER BY e.Last_Name`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => { const v = l.split('|').map(x => x.trim()); return { StudentId:v[0], Code:v[1], First_Name:v[2], Last_Name:v[3] }; });
        return sendJSON(res, 200, rows);
    }

    // POST generate parent code (internal - protected)
    if (req.method === 'POST' && url === '/api/parent-codes') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const studentId = parseInt(d.studentId);
            if (!studentId) return sendJSON(res, 400, { error: 'Student ID required' });
            // Generate random 6-char code
            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            let code = '';
            for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];

            const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ParentCodes')
                CREATE TABLE ParentCodes (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    StudentId INT NOT NULL,
                    Code NVARCHAR(10) NOT NULL UNIQUE,
                    CreatedAt DATETIME DEFAULT GETDATE()
                );
                IF EXISTS (SELECT 1 FROM ParentCodes WHERE StudentId=${studentId})
                    UPDATE ParentCodes SET Code=${esc(code)} WHERE StudentId=${studentId}
                ELSE
                    INSERT INTO ParentCodes (StudentId,Code) VALUES (${studentId},${esc(code)})`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true, code: code });
        });
        return;
    }

    // POST start conference (internal - protected)
    if (req.method === 'POST' && url === '/api/conference') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const studentId = parseInt(d.studentId);
            const meetUrl = d.meetUrl || '';
            const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='Conferences')
                CREATE TABLE Conferences (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    StudentId INT NOT NULL,
                    MeetUrl NVARCHAR(500),
                    StartedAt DATETIME DEFAULT GETDATE(),
                    Active BIT DEFAULT 1
                );
                UPDATE Conferences SET Active=0 WHERE StudentId=${studentId};
                INSERT INTO Conferences (StudentId,MeetUrl,Active) VALUES (${studentId},${esc(meetUrl)},1)`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // GET weekly menus (internal - protected)
    if (req.method === 'GET' && url.startsWith('/api/menus')) {
        if (!checkAuth(req, res)) return;
        const query = req.url.split('?')[1] || '';
        const params = new URLSearchParams(query);
        const week = params.get('week') || '';
        // Read PFA and Other data separately to avoid sqlcmd line truncation
        const r1 = runSQL(`SELECT PfaData FROM WeeklyMenus WHERE WeekKey=${esc(week)}`);
        const r2 = runSQL(`SELECT OtherData FROM WeeklyMenus WHERE WeekKey=${esc(week)}`);
        if (!r1.ok && !r2.ok) return sendJSON(res, 200, {});
        const pfaRaw = (r1.data || '').split('\n').filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim())).join('').trim();
        const otherRaw = (r2.data || '').split('\n').filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim())).join('').trim();
        try {
            const pfa = pfaRaw ? JSON.parse(pfaRaw.trim()) : {};
            const other = otherRaw ? JSON.parse(otherRaw.trim()) : {};
            return sendJSON(res, 200, { pfa, other });
        } catch(e) { return sendJSON(res, 200, {}); }
    }

    // POST save weekly menus (internal - protected)
    if (req.method === 'POST' && url === '/api/menus') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const week = d.week || '';
            // Raw JSON; esc() does the quoting and escaping at the point of use.
            const pfaJson = JSON.stringify(d.pfa || {});
            const otherJson = JSON.stringify(d.other || {});
            const sql = `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='WeeklyMenus')
                CREATE TABLE WeeklyMenus (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    WeekKey NVARCHAR(20) NOT NULL UNIQUE,
                    PfaData NVARCHAR(MAX),
                    OtherData NVARCHAR(MAX),
                    UpdatedAt DATETIME DEFAULT GETDATE()
                );
                IF EXISTS (SELECT 1 FROM WeeklyMenus WHERE WeekKey=${esc(week)})
                    UPDATE WeeklyMenus SET PfaData=${esc(pfaJson)},OtherData=${esc(otherJson)},UpdatedAt=GETDATE() WHERE WeekKey=${esc(week)}
                ELSE
                    INSERT INTO WeeklyMenus (WeekKey,PfaData,OtherData) VALUES (${esc(week)},${esc(pfaJson)},${esc(otherJson)})`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // GET active conference for parent portal (public - code-authenticated via query)
    if (req.method === 'GET' && url === '/api/parent-portal/conference') {
        const query = req.url.split('?')[1] || '';
        const params = new URLSearchParams(query);
        const code = (params.get('code') || '').trim().toUpperCase();
        if (!code) return sendJSON(res, 400, { error: 'Code required' });
        const sql = `SELECT c.MeetUrl FROM Conferences c
            JOIN ParentCodes pc ON c.StudentId=pc.StudentId
            WHERE pc.Code=${esc(code)} AND c.Active=1
            ORDER BY c.StartedAt DESC`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const lines = r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()));
        if (!lines.length) return sendJSON(res, 200, { active: false });
        return sendJSON(res, 200, { active: true, meetUrl: lines[0].trim() });
    }

    // GET program compliance data (internal - protected)
    if (req.method === 'GET' && url === '/api/compliance') {
        if (!checkAuth(req, res)) return;
        const query = req.url.split('?')[1] || '';
        const params = new URLSearchParams(query);
        const year = params.get('year') || '';
        const sql = complianceEnsureSQL()
            + `SELECT FieldName,${txCol('FieldValue')} FROM ProgramCompliance WHERE SchoolYear=${esc(year)}`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const data = {};
        r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .forEach(l => {
                // Only split off the first delimiter: the value is free text that may
                // legitimately contain an encoded pipe.
                const i = l.indexOf('|');
                if (i === -1) return;
                const name = l.slice(0, i).trim();
                const raw = txDecode(l.slice(i + 1).trim());
                if (name) data[name] = raw === '1' ? true : raw === '0' ? false : raw;
            });
        return sendJSON(res, 200, data);
    }

    // GET staff (internal - protected)
    // Ensure, seed-if-empty and select are separated by GO because the seed and
    // the select reference a table the first batch may have only just created;
    // SQL Server compiles a whole batch up front, so they cannot share one.
    if (req.method === 'GET' && url === '/api/staff') {
        if (!checkAuth(req, res)) return;
        const select = ['Id'].concat(STAFF_COLUMNS.map(([c]) => c));
        const projection = select.map(c =>
            (c === 'Id' ? 'Id' : txCol(c))).join(',');
        const sql = staffEnsureSQL() + 'GO\n' + staffSeedSQL() + 'GO\n'
            + `SELECT ${projection},ISNULL(CAST(Active AS INT),1) AS Active FROM Staff WHERE ISNULL(Active,1)=1 ORDER BY Name`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const keys = select.concat(['Active']);
        const rows = r.data.trim().split('\n')
            .filter(l => /^\s*\d+\s*\|/.test(l))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                const o = {};
                keys.forEach((k, i) => { o[k] = k === 'Id' || k === 'Active' ? v[i] : txDecode(v[i]); });
                return o;
            });
        return sendJSON(res, 200, rows);
    }

    // POST new staff member (internal - protected)
    if (req.method === 'POST' && url === '/api/staff') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            if (!String(d.name || '').trim()) return sendJSON(res, 400, { error: 'Name is required' });
            const cols = STAFF_COLUMNS.map(([c]) => c).join(',');
            const vals = STAFF_COLUMNS.map(([, key]) => esc(d[key])).join(',');
            const sql = staffEnsureSQL() + 'GO\n'
                + `INSERT INTO Staff (${cols}) VALUES (${vals});SELECT SCOPE_IDENTITY() AS Id`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // PUT update staff member (internal - protected)
    if (req.method === 'PUT' && url.startsWith('/api/staff/')) {
        if (!checkAuth(req, res)) return;
        const id = parseInt(url.split('/')[3]);
        if (!id) return sendJSON(res, 400, { error: 'Staff id required' });
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            // Only update the fields actually supplied, so a partial save (for
            // example marking a record reviewed) cannot blank the rest.
            const sets = STAFF_COLUMNS
                .filter(([, key]) => d[key] !== undefined)
                .map(([c, key]) => `${c}=${esc(d[key])}`);
            if (!sets.length) return sendJSON(res, 400, { error: 'Nothing to update' });
            const sql = staffEnsureSQL() + 'GO\n'
                + `UPDATE Staff SET ${sets.join(',')},UpdatedAt=GETDATE() WHERE Id=${id}`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // DELETE staff member (internal - protected)
    // Soft delete: qualification history is compliance evidence, so the row stays
    // and is simply excluded from the active list.
    if (req.method === 'DELETE' && url.startsWith('/api/staff/')) {
        if (!checkAuth(req, res)) return;
        const id = parseInt(url.split('/')[3]);
        if (!id) return sendJSON(res, 400, { error: 'Staff id required' });
        const sql = staffEnsureSQL() + 'GO\n' + `UPDATE Staff SET Active=0,UpdatedAt=GETDATE() WHERE Id=${id}`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        return sendJSON(res, 200, { success: true });
    }

    /* ── Staff development plans (PICC PI9) ──
       Returns every plan and goal, current and superseded, so the page can show
       history. The caller picks the current one; the server does not hide the
       older versions, because they are the evidence of timelines PI9 asks for. */
    if (req.method === 'GET' && url === '/api/dev-plans') {
        if (!checkAuth(req, res)) return;
        const pCols = ['Id'].concat(DEVPLAN_COLUMNS.map(([c]) => c));
        const gCols = ['Id'].concat(DEVGOAL_COLUMNS.map(([c]) => c));
        const r = runSQL(staffDevPlanEnsureSQL() + 'GO\n'
            + `SELECT ${pCols.map(c => /^(Id|StaffId)$/.test(c) ? c : txCol(c)).join(',')} FROM StaffDevelopmentPlan ORDER BY StaffId, PlanDate DESC, Id DESC`);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const plans = r.data.trim().split('\n').filter(l => /^\s*\d+\s*\|/.test(l)).map(l => {
            const v = l.split('|').map(x => x.trim());
            const o = {};
            pCols.forEach((c, i) => { o[c] = /^(Id|StaffId)$/.test(c) ? v[i] : txDecode(v[i]); });
            return o;
        });
        const g = runSQL(staffDevPlanEnsureSQL() + 'GO\n'
            + `SELECT ${gCols.map(c => /^(Id|PlanId|SortOrder)$/.test(c) ? c : txCol(c)).join(',')} FROM StaffDevelopmentGoal ORDER BY PlanId, SortOrder, Id`);
        const goals = (!g.ok ? [] : g.data.trim().split('\n').filter(l => /^\s*\d+\s*\|/.test(l)).map(l => {
            const v = l.split('|').map(x => x.trim());
            const o = {};
            gCols.forEach((c, i) => { o[c] = /^(Id|PlanId|SortOrder)$/.test(c) ? v[i] : txDecode(v[i]); });
            return o;
        }));
        return sendJSON(res, 200, { plans, goals });
    }

    // POST a new plan. Any existing active plan for that person is superseded
    // rather than deleted, so the dated history survives.
    if (req.method === 'POST' && url === '/api/dev-plans') {
        if (!checkAuth(req, res)) return;
        return readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const staffId = parseInt(d.staffId);
            if (!staffId) return sendJSON(res, 400, { error: 'staffId required' });
            const cols = DEVPLAN_COLUMNS.map(([c]) => c).join(',');
            const vals = DEVPLAN_COLUMNS.map(([c, key]) =>
                c === 'StaffId' ? staffId
                : c === 'Status' ? esc(d.status || 'Active')
                : esc(d[key])).join(',');
            const sql = staffDevPlanEnsureSQL() + 'GO\n'
                + `UPDATE StaffDevelopmentPlan SET Status='Superseded',UpdatedAt=GETDATE() WHERE StaffId=${staffId} AND ISNULL(Status,'Active')='Active';\n`
                + `INSERT INTO StaffDevelopmentPlan (${cols}) VALUES (${vals});SELECT SCOPE_IDENTITY() AS Id`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            const m = (r.data || '').match(/(\d+)/);
            return sendJSON(res, 200, { success: true, id: m ? m[1] : null });
        });
    }

    // PUT edits a plan in place, for correcting the current one without
    // generating a spurious new version.
    if (req.method === 'PUT' && url.startsWith('/api/dev-plans/')) {
        if (!checkAuth(req, res)) return;
        const id = parseInt(url.split('/')[3]);
        if (!id) return sendJSON(res, 400, { error: 'Plan id required' });
        return readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const sets = DEVPLAN_COLUMNS.filter(([, key]) => d[key] !== undefined)
                .map(([c, key]) => `${c}=${esc(d[key])}`);
            if (!sets.length) return sendJSON(res, 400, { error: 'Nothing to update' });
            const r = runSQL(staffDevPlanEnsureSQL() + 'GO\n'
                + `UPDATE StaffDevelopmentPlan SET ${sets.join(',')},UpdatedAt=GETDATE() WHERE Id=${id}`);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            return sendJSON(res, 200, { success: true });
        });
    }

    // Goals: upsert by id, or insert when no id is supplied.
    if (req.method === 'POST' && url === '/api/dev-goals') {
        if (!checkAuth(req, res)) return;
        return readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const id = parseInt(d.id);
            let sql;
            if (id) {
                const sets = DEVGOAL_COLUMNS.filter(([, key]) => d[key] !== undefined)
                    .map(([c, key]) => c === 'SortOrder' || c === 'PlanId'
                        ? `${c}=${parseInt(d[key]) || 0}` : `${c}=${esc(d[key])}`);
                if (!sets.length) return sendJSON(res, 400, { error: 'Nothing to update' });
                sql = `UPDATE StaffDevelopmentGoal SET ${sets.join(',')},UpdatedAt=GETDATE() WHERE Id=${id}`;
            } else {
                const planId = parseInt(d.planId);
                if (!planId) return sendJSON(res, 400, { error: 'planId required' });
                const cols = DEVGOAL_COLUMNS.map(([c]) => c).join(',');
                const vals = DEVGOAL_COLUMNS.map(([c, key]) =>
                    c === 'PlanId' ? planId
                    : c === 'SortOrder' ? (parseInt(d.sortOrder) || 0)
                    : esc(d[key])).join(',');
                sql = `INSERT INTO StaffDevelopmentGoal (${cols}) VALUES (${vals});SELECT SCOPE_IDENTITY() AS Id`;
            }
            const r = runSQL(staffDevPlanEnsureSQL() + 'GO\n' + sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            const m = (r.data || '').match(/(\d+)/);
            return sendJSON(res, 200, { success: true, id: id || (m ? m[1] : null) });
        });
    }

    if (req.method === 'DELETE' && url.startsWith('/api/dev-goals/')) {
        if (!checkAuth(req, res)) return;
        const id = parseInt(url.split('/')[3]);
        if (!id) return sendJSON(res, 400, { error: 'Goal id required' });
        const r = runSQL(staffDevPlanEnsureSQL() + 'GO\n'
            + `DELETE FROM StaffDevelopmentGoal WHERE Id=${id}`);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        return sendJSON(res, 200, { success: true });
    }

    // GET all staff training records (internal - protected)
    if (req.method === 'GET' && url === '/api/staff-training') {
        if (!checkAuth(req, res)) return;
        const sql = staffTrainingEnsureSQL() + 'GO\n'
            + `SELECT Id,StaffId,${txCol('TrainingKey')},${txCol('CompletedDate')},${txCol('EvidenceLink')},${txCol('Notes')} FROM StaffTraining`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => /^\s*\d+\s*\|/.test(l))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return {
                    Id: v[0], StaffId: v[1], TrainingKey: txDecode(v[2]),
                    CompletedDate: txDecode(v[3]), EvidenceLink: txDecode(v[4]), Notes: txDecode(v[5])
                };
            });
        return sendJSON(res, 200, rows);
    }

    // POST record or clear a staff training (internal - protected)
    // Upserts on (StaffId, TrainingKey). Sending an empty completion with no
    // evidence or notes removes the row, which is how a checkbox un-tick arrives.
    if (req.method === 'POST' && url === '/api/staff-training') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const staffId = parseInt(d.staffId);
            const key = String(d.trainingKey || '').trim();
            if (!staffId || !key) return sendJSON(res, 400, { error: 'staffId and trainingKey are required' });

            const date = String(d.completedDate || '').trim();
            const link = String(d.evidenceLink || '').trim();
            const notes = String(d.notes || '').trim();
            const isEmpty = !date && !link && !notes;

            const where = `StaffId=${staffId} AND TrainingKey=${esc(key)}`;
            const sql = staffTrainingEnsureSQL() + 'GO\n' + (isEmpty
                ? `DELETE FROM StaffTraining WHERE ${where}`
                : `IF EXISTS (SELECT 1 FROM StaffTraining WHERE ${where})
    UPDATE StaffTraining SET CompletedDate=${esc(date)},EvidenceLink=${esc(link)},Notes=${esc(notes)},UpdatedAt=GETDATE() WHERE ${where}
ELSE
    INSERT INTO StaffTraining (StaffId,TrainingKey,CompletedDate,EvidenceLink,Notes) VALUES (${staffId},${esc(key)},${esc(date)},${esc(link)},${esc(notes)})`);
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true, cleared: isEmpty });
        });
        return;
    }

    // GET Silver self-assessment records (internal - protected)
    if (req.method === 'GET' && url === '/api/silver-assessments') {
        if (!checkAuth(req, res)) return;
        const sql = silverAssessmentEnsureSQL() + 'GO\n'
            + `SELECT Id,${txCol('RoomNumber')},${txCol('Instrument')},${txCol('CompletedDate')},${txCol('UploadedDate')},${txCol('EvidenceLink')},${txCol('Notes')} FROM SilverSelfAssessments`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => /^\s*\d+\s*\|/.test(l))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return {
                    Id: v[0], RoomNumber: txDecode(v[1]), Instrument: txDecode(v[2]),
                    CompletedDate: txDecode(v[3]), UploadedDate: txDecode(v[4]),
                    EvidenceLink: txDecode(v[5]), Notes: txDecode(v[6])
                };
            });
        return sendJSON(res, 200, rows);
    }

    // POST record or clear a Silver self-assessment (internal - protected)
    if (req.method === 'POST' && url === '/api/silver-assessments') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const room = String(d.roomNumber || '').trim();
            const instrument = String(d.instrument || '').trim();
            if (!room || !instrument) return sendJSON(res, 400, { error: 'roomNumber and instrument are required' });

            const completed = String(d.completedDate || '').trim();
            const uploaded = String(d.uploadedDate || '').trim();
            const link = String(d.evidenceLink || '').trim();
            const notes = String(d.notes || '').trim();
            const isEmpty = !completed && !uploaded && !link && !notes;

            const where = `RoomNumber=${esc(room)} AND Instrument=${esc(instrument)}`;
            const sql = silverAssessmentEnsureSQL() + 'GO\n' + (isEmpty
                ? `DELETE FROM SilverSelfAssessments WHERE ${where}`
                : `IF EXISTS (SELECT 1 FROM SilverSelfAssessments WHERE ${where})
    UPDATE SilverSelfAssessments SET CompletedDate=${esc(completed)},UploadedDate=${esc(uploaded)},EvidenceLink=${esc(link)},Notes=${esc(notes)},UpdatedAt=GETDATE() WHERE ${where}
ELSE
    INSERT INTO SilverSelfAssessments (RoomNumber,Instrument,CompletedDate,UploadedDate,EvidenceLink,Notes) VALUES (${esc(room)},${esc(instrument)},${esc(completed)},${esc(uploaded)},${esc(link)},${esc(notes)})`);
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true, cleared: isEmpty });
        });
        return;
    }

    // GET PAS worksheet answers (internal - protected)
    // Returns every saved worksheet. The pages need the full set anyway to show
    // which classrooms have been completed, and the row count is small.
    if (req.method === 'GET' && url === '/api/pas-worksheets') {
        if (!checkAuth(req, res)) return;
        const sql = pasWorksheetEnsureSQL() + 'GO\n'
            + `SELECT Id,${txCol('WorksheetKey')},${txCol('ScopeKey')},${txCol('Payload')},${txCol('UpdatedBy')},CONVERT(NVARCHAR(20),UpdatedAt,120) AS UpdatedAt FROM PasWorksheets`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            .filter(l => /^\s*\d+\s*\|/.test(l))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                let payload = {};
                try { payload = JSON.parse(txDecode(v[3]) || '{}'); } catch (e) { payload = {}; }
                return {
                    Id: v[0], WorksheetKey: txDecode(v[1]), ScopeKey: txDecode(v[2]),
                    Payload: payload, UpdatedBy: txDecode(v[4]), UpdatedAt: v[5]
                };
            });
        return sendJSON(res, 200, rows);
    }

    // POST save or clear one PAS worksheet (internal - protected)
    // An empty payload deletes the row, which is what the pages' "clear" action
    // means; that keeps "no row" as the single meaning of not started.
    if (req.method === 'POST' && url === '/api/pas-worksheets') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const worksheet = String(d.worksheet || '').trim();
            if (!worksheet || worksheet.length > 60) return sendJSON(res, 400, { error: 'worksheet key required, max 60 chars' });
            const scope = String(d.scope || '').trim().slice(0, 60);

            const payloadObj = d.payload && typeof d.payload === 'object' ? d.payload : null;
            const hasAnswers = payloadObj && Object.keys(payloadObj).some(k => {
                const v = payloadObj[k];
                return v !== '' && v !== false && v !== null && v !== undefined;
            });
            const where = `WorksheetKey=${esc(worksheet)} AND ScopeKey=${esc(scope)}`;

            if (!hasAnswers) {
                const r0 = runSQL(pasWorksheetEnsureSQL() + 'GO\n' + `DELETE FROM PasWorksheets WHERE ${where}`);
                if (!r0.ok) return sendJSON(res, 500, { error: r0.error });
                return sendJSON(res, 200, { success: true, cleared: true });
            }

            const payload = JSON.stringify(payloadObj);
            const by = String(d.updatedBy || '').trim();
            const sql = pasWorksheetEnsureSQL() + 'GO\n'
                + `IF EXISTS (SELECT 1 FROM PasWorksheets WHERE ${where})
    UPDATE PasWorksheets SET Payload=${esc(payload)},UpdatedBy=${esc(by)},UpdatedAt=GETDATE() WHERE ${where}
ELSE
    INSERT INTO PasWorksheets (WorksheetKey,ScopeKey,Payload,UpdatedBy) VALUES (${esc(worksheet)},${esc(scope)},${esc(payload)},${esc(by)})`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // GET site-level settings (internal - protected)
    // Facts that span school years live here rather than in ProgramCompliance,
    // which is keyed per year. First use is the DCFS license.
    if (req.method === 'GET' && url === '/api/site-settings') {
        if (!checkAuth(req, res)) return;
        const sql = siteSettingsEnsureSQL()
            + `SELECT SettingKey,${txCol('SettingValue')} FROM SiteSettings`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const data = {};
        r.data.trim().split('\n')
            .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .forEach(l => {
                const i = l.indexOf('|');
                if (i === -1) return;
                const k = l.slice(0, i).trim();
                if (k) data[k] = txDecode(l.slice(i + 1).trim());
            });
        return sendJSON(res, 200, data);
    }

    // POST save one site-level setting (internal - protected)
    if (req.method === 'POST' && url === '/api/site-settings') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const key = String(d.key || '').trim();
            if (!key || key.length > 60) return sendJSON(res, 400, { error: 'Key required, max 60 chars' });
            const sql = siteSettingsEnsureSQL()
                + `IF EXISTS (SELECT 1 FROM SiteSettings WHERE SettingKey=${esc(key)})
    UPDATE SiteSettings SET SettingValue=${esc(String(d.value == null ? '' : d.value))},UpdatedAt=GETDATE() WHERE SettingKey=${esc(key)}
ELSE
    INSERT INTO SiteSettings (SettingKey,SettingValue) VALUES (${esc(key)},${esc(String(d.value == null ? '' : d.value))})`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // POST save program compliance field (internal - protected)
    if (req.method === 'POST' && url === '/api/compliance') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const { year, field, value } = d;
            if (!year || !field) return sendJSON(res, 400, { error: 'Year and field required' });
            // A key longer than the column would be silently truncated and could then
            // collide with another item's key under the unique constraint.
            if (String(field).length > COMPLIANCE_FIELD_NAME_MAX) {
                return sendJSON(res, 400, { error: 'Field name exceeds ' + COMPLIANCE_FIELD_NAME_MAX + ' characters' });
            }
            const sql = complianceEnsureSQL()
                + `IF EXISTS (SELECT 1 FROM ProgramCompliance WHERE SchoolYear=${esc(year)} AND FieldName=${esc(field)})
                    UPDATE ProgramCompliance SET FieldValue=${esc(String(value))},UpdatedAt=GETDATE() WHERE SchoolYear=${esc(year)} AND FieldName=${esc(field)}
                ELSE
                    INSERT INTO ProgramCompliance (SchoolYear,FieldName,FieldValue) VALUES (${esc(year)},${esc(field)},${esc(String(value))})`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // PUT ISBE tracking field (internal - protected)
    if (req.method === 'PUT' && url === '/api/isbe-tracking') {
        if (!checkAuth(req, res)) return;
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const { studentId, field, value } = d;
            // Whitelist is the schema list itself, so a new checklist column is
            // writable as soon as it is declared (and never writable if it isn't).
            if (!ISBE_TRACKING_COLUMNS.includes(field)) return sendJSON(res, 400, { error: 'Invalid field' });
            const year = resolveSchoolYear(d.year);
            const sql = isbeTrackingEnsureSQL()
                + `IF EXISTS (SELECT 1 FROM ISBETracking WHERE StudentId=${parseInt(studentId)} AND SchoolYear=${esc(year)})
                UPDATE ISBETracking SET ${field}=${value?1:0} WHERE StudentId=${parseInt(studentId)} AND SchoolYear=${esc(year)}
            ELSE
                INSERT INTO ISBETracking (StudentId,SchoolYear,${field}) VALUES (${parseInt(studentId)},${esc(year)},${value?1:0})`;
            const r = runSQL(sql);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // POST recalculate all F/R/P values (internal - protected)
    if (req.method === 'POST' && url === '/api/recalculate-frp') {
        if (!checkAuth(req, res)) return;
        // Auto-select thresholds based on current date (effective July 1 each year)
        const now = new Date();
        const usdaYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
        const guidelines = {
            2025: { free: [20163,27339,34515,41691,48867,56043,63219,70395], reduced: [28694,38907,49120,59333,69546,79759,89972,100185] },
            2026: { free: [20748,28132,35516,42900,50284,57668,65052,72436], reduced: [29526,40034,50542,61050,71558,82066,92574,103082] },
        };
        const g = guidelines[usdaYear] || guidelines[2026];
        const f = g.free;
        const r2 = g.reduced;
        console.log(`[FRP] Using ${usdaYear}-${usdaYear+1} thresholds`);
        const sql = `UPDATE rptMasterEnrollment SET F_R_P_Food = 
            CASE 
                WHEN ISNULL(PublicBenefits,'') <> '' THEN 'Free'
                WHEN Category = 'Foster' THEN 'Free'
                WHEN Military = 'Yes' OR Military = 'YES' THEN 'Free'
                WHEN PFA_PI_na = 'PFA' THEN 'Free'
                WHEN ISNULL(HouseholdIncome,100000) <= CASE ISNULL(HouseholdSize,1) WHEN 1 THEN ${f[0]} WHEN 2 THEN ${f[1]} WHEN 3 THEN ${f[2]} WHEN 4 THEN ${f[3]} WHEN 5 THEN ${f[4]} WHEN 6 THEN ${f[5]} WHEN 7 THEN ${f[6]} ELSE ${f[7]} END THEN 'Free'
                WHEN ISNULL(HouseholdIncome,100000) <= CASE ISNULL(HouseholdSize,1) WHEN 1 THEN ${r2[0]} WHEN 2 THEN ${r2[1]} WHEN 3 THEN ${r2[2]} WHEN 4 THEN ${r2[3]} WHEN 5 THEN ${r2[4]} WHEN 6 THEN ${r2[5]} WHEN 7 THEN ${r2[6]} ELSE ${r2[7]} END THEN 'Reduced'
                ELSE 'Paid'
            END
            WHERE Active = 'Yes' OR Active = 'YES'`;
        const r = runSQL(sql);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        sendJSON(res, 200, { success: true, message: `All F/R/P values recalculated using ${usdaYear}-${usdaYear+1} thresholds` });
        return;
    }

    // GET management reports (internal - protected)
    if (req.method === 'GET' && url === '/api/reports') {
        if (!checkAuth(req, res)) return;
        const queries = {
            byRoom:        `SELECT r.Room, COUNT(*) AS Total, SUM(CASE WHEN e.Active='Yes' OR e.Active='YES' THEN 1 ELSE 0 END) AS Active FROM rptMasterEnrollment e LEFT JOIN dimClassrooms r ON e.RoomNumber=r.RoomNumber GROUP BY r.Room ORDER BY r.Room`,
            byRoomDaily:   `SELECT r.Room, r.DCFSCapacity, SUM(CASE WHEN e.Monday=1 AND (e.Active='Yes' OR e.Active='YES') THEN 1 ELSE 0 END) AS Mon, SUM(CASE WHEN e.Tuesday=1 AND (e.Active='Yes' OR e.Active='YES') THEN 1 ELSE 0 END) AS Tue, SUM(CASE WHEN e.Wednesday=1 AND (e.Active='Yes' OR e.Active='YES') THEN 1 ELSE 0 END) AS Wed, SUM(CASE WHEN e.Thursday=1 AND (e.Active='Yes' OR e.Active='YES') THEN 1 ELSE 0 END) AS Thu, SUM(CASE WHEN e.Friday=1 AND (e.Active='Yes' OR e.Active='YES') THEN 1 ELSE 0 END) AS Fri FROM rptMasterEnrollment e LEFT JOIN dimClassrooms r ON e.RoomNumber=r.RoomNumber WHERE e.Active='Yes' OR e.Active='YES' GROUP BY r.Room, r.DCFSCapacity, r.RoomNumber ORDER BY r.RoomNumber`,
            byProgram:     `SELECT ISNULL(PFA_PI_na,'Unknown') AS ProgramType, COUNT(*) AS Total FROM rptMasterEnrollment WHERE Active='Yes' OR Active='YES' GROUP BY PFA_PI_na`,
            byFood:        `SELECT ISNULL(F_R_P_Food,'Unknown') AS FoodProgram, COUNT(*) AS Total FROM rptMasterEnrollment WHERE Active='Yes' OR Active='YES' GROUP BY F_R_P_Food`,
            byPayType:     `SELECT ISNULL(Category,'Unknown') AS PayType, COUNT(*) AS Total FROM rptMasterEnrollment WHERE Active='Yes' OR Active='YES' GROUP BY Category`,
            benefits:      `SELECT SUM(CASE WHEN PublicBenefits LIKE '%WIC%' THEN 1 ELSE 0 END) AS WIC, SUM(CASE WHEN PublicBenefits LIKE '%Medicaid%' THEN 1 ELSE 0 END) AS Medicaid, SUM(CASE WHEN PublicBenefits LIKE '%SNAP%' THEN 1 ELSE 0 END) AS SNAP, SUM(CASE WHEN PublicBenefits LIKE '%TANF%' THEN 1 ELSE 0 END) AS TANF, SUM(CASE WHEN PublicBenefits LIKE '%CCAP%' THEN 1 ELSE 0 END) AS CCAP FROM rptMasterEnrollment WHERE Active='Yes' OR Active='YES'`,
            incomeProof:   `SELECT SUM(CASE WHEN ISNULL(ProofOfIncomeUploaded,0)=1 THEN 1 ELSE 0 END) AS Uploaded, SUM(CASE WHEN ISNULL(ProofOfIncomeUploaded,0)=0 THEN 1 ELSE 0 END) AS Missing FROM rptMasterEnrollment WHERE (Active='Yes' OR Active='YES') AND (PFA_PI_na='PFA' OR PFA_PI_na='PI')`,
            flags:         `SELECT SUM(CASE WHEN IEP='Yes' OR IEP='YES' THEN 1 ELSE 0 END) AS IEP, SUM(CASE WHEN Military='Yes' OR Military='YES' THEN 1 ELSE 0 END) AS Military FROM rptMasterEnrollment WHERE Active='Yes' OR Active='YES'`,
            waitlistSummary: `SELECT AgeGroup, COUNT(*) AS Total, AVG(CAST(Score AS FLOAT)) AS AvgScore FROM PreEnrollment WHERE WaitlistStatus NOT IN ('Enrolled','Declined') GROUP BY AgeGroup`,
            ccapEligible:  `SELECT e.First_Name,e.Last_Name,r.Room,ISNULL(e.HouseholdIncome,'') AS HouseholdIncome,ISNULL(CAST(e.HouseholdSize AS NVARCHAR),'') AS HouseholdSize,ISNULL(p.FirstName+' '+p.LastName,'') AS ParentName,ISNULL(p.Phone,'') AS ParentPhone FROM rptMasterEnrollment e LEFT JOIN dimClassrooms r ON e.RoomNumber=r.RoomNumber LEFT JOIN (SELECT ChildName,FirstName,LastName,Phone,ROW_NUMBER() OVER (PARTITION BY ChildName ORDER BY Id DESC) AS rn FROM PreEnrollment) p ON p.ChildName LIKE '%'+e.First_Name+'%' AND p.rn=1 WHERE (e.Active='Yes' OR e.Active='YES') AND e.Category<>'CCAP' AND e.Category<>'Foster' AND ISNULL(e.HouseholdIncome,0)>0 AND ISNULL(e.HouseholdSize,0)>0 AND ((e.HouseholdSize=1 AND e.HouseholdIncome<=35213) OR (e.HouseholdSize=2 AND e.HouseholdIncome<=47588) OR (e.HouseholdSize=3 AND e.HouseholdIncome<=59963) OR (e.HouseholdSize=4 AND e.HouseholdIncome<=72338) OR (e.HouseholdSize=5 AND e.HouseholdIncome<=84713) OR (e.HouseholdSize=6 AND e.HouseholdIncome<=97088) OR (e.HouseholdSize=7 AND e.HouseholdIncome<=109463) OR (e.HouseholdSize>=8 AND e.HouseholdIncome<=121838)) ORDER BY e.Last_Name`,
            foodDetail:    `SELECT r.Room,e.Last_Name,e.First_Name,ISNULL(e.HouseholdIncome,'') AS HouseholdIncome,ISNULL(CAST(e.HouseholdSize AS NVARCHAR),'') AS HouseholdSize,ISNULL(e.F_R_P_Food,'') AS FRP,ISNULL(e.PublicBenefits,'') AS Benefits FROM rptMasterEnrollment e LEFT JOIN dimClassrooms r ON e.RoomNumber=r.RoomNumber WHERE e.Active='Yes' OR e.Active='YES' ORDER BY r.Room,e.Last_Name`,
            summerProgram: `IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='SummerProgram') SELECT s.ChildLastName,s.ChildFirstName,s.ChildAge,ISNULL(e.F_R_P_Food,'Unknown') AS FRP,s.Days,s.ParentLastName,s.ParentFirstName,s.ParentPhone FROM SummerProgram s LEFT JOIN rptMasterEnrollment e ON s.ChildFirstName=e.First_Name AND s.ChildLastName=e.Last_Name ORDER BY s.ChildLastName`,
        };
        const results = {};
        for (const [key, sql] of Object.entries(queries)) {
            const r = runSQL(sql);
            if (!r.ok) { results[key] = { error: r.error }; continue; }
            results[key] = r.data.trim().split('\n')
                .filter(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
                .map(l => l.split('|').map(x => x.trim()));
        }
        return sendJSON(res, 200, results);
    }

    // GET waiting list count (lightweight - for badge)
    if (req.method === 'GET' && url === '/api/waitinglist/count') {
        if (!checkAuth(req, res)) return;
        const r = runSQL(`SELECT COUNT(*) AS Total FROM PreEnrollment WHERE ISNULL(WaitlistStatus,'Pending') NOT IN ('Enrolled','Declined')`);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const line = r.data.trim().split('\n').find(l => l.trim() && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()));
        const count = parseInt(line) || 0;
        return sendJSON(res, 200, { count });
    }

    // GET waiting list (internal - protected)
    if (req.method === 'GET' && url === '/api/waitinglist') {
        if (!checkAuth(req, res)) return;
        runSQL(`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='PreEnrollment' AND COLUMN_NAME='DaysRequested') ALTER TABLE PreEnrollment ADD DaysRequested NVARCHAR(50)`);
        // Rows come back as pipe-delimited text split on newlines, so any newline inside a
        // free-text column would break one record into bogus rows. Flatten those columns here.
        const flat = col => `REPLACE(REPLACE(ISNULL(${col},''),CHAR(13),' '),CHAR(10),' ')`;
        const r = runSQL(`SELECT Id,SubmittedAt,FirstName,LastName,Phone,Email,${flat('ChildrenInfo')} AS ChildrenInfo,ChildName,ChildBirthDate,ISNULL(ChildStartDate,'') AS ChildStartDate,AgeGroup,Homeless,FosterAdopted,IEP,EarlyIntervention,AbuseHistory,MentalIllness,DcfsInvolvement,SubstanceAbuse,CaregiverOther,FamilyDeath,LowBirthWeight,ParentIncarcerated,TeenParent,NoHSDiploma,BornOutsideUS,NonEnglishHome,ActiveMilitary,PublicBenefits,${flat('LivingSituation')} AS LivingSituation,City,HouseholdIncome,ISNULL(CAST(HouseholdSize AS NVARCHAR),'') AS HouseholdSize,Score,ISNULL(WaitlistStatus,'Pending') AS WaitlistStatus,${flat('Notes')} AS Notes,ISNULL(DaysRequested,'') AS DaysRequested FROM PreEnrollment ORDER BY Score DESC,SubmittedAt ASC`);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        const rows = r.data.trim().split('\n')
            // Every real row starts with a numeric Id; that also drops any stray continuation line.
            .filter(l => /^\s*\d+\s*\|/.test(l) && !l.includes('rows affected') && !/^[-|]+$/.test(l.trim()))
            .map(l => {
                const v = l.split('|').map(x => x.trim());
                return { Id:v[0],SubmittedAt:v[1],FirstName:v[2],LastName:v[3],Phone:v[4],Email:v[5],ChildrenInfo:v[6],ChildName:v[7],ChildBirthDate:v[8],ChildStartDate:v[9],AgeGroup:v[10],Homeless:v[11],FosterAdopted:v[12],IEP:v[13],EarlyIntervention:v[14],AbuseHistory:v[15],MentalIllness:v[16],DcfsInvolvement:v[17],SubstanceAbuse:v[18],CaregiverOther:v[19],FamilyDeath:v[20],LowBirthWeight:v[21],ParentIncarcerated:v[22],TeenParent:v[23],NoHSDiploma:v[24],BornOutsideUS:v[25],NonEnglishHome:v[26],ActiveMilitary:v[27],PublicBenefits:v[28],LivingSituation:v[29],City:v[30],HouseholdIncome:v[31],HouseholdSize:v[32],Score:v[33],WaitlistStatus:v[34],Notes:v[35],DaysRequested:v[36]||'' };
            });
        return sendJSON(res, 200, rows);
    }

    // PUT update waitlist status (internal - protected)
    if (req.method === 'PUT' && url.startsWith('/api/waitinglist/')) {
        if (!checkAuth(req, res)) return;
        const id = parseInt(url.split('/')[3]);
        readBody(req, (err, d) => {
            if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
            const fields = [];
            if (d.status !== undefined) fields.push(`WaitlistStatus=${esc(d.status)}`);
            if (d.notes !== undefined) fields.push(`Notes=${esc(d.notes)}`);
            if (d.ageGroup !== undefined) fields.push(`AgeGroup=${esc(d.ageGroup)}`);
            if (!fields.length) return sendJSON(res, 400, { error: 'Nothing to update' });
            const r = runSQL(`UPDATE PreEnrollment SET ${fields.join(',')} WHERE Id=${id}`);
            if (!r.ok) return sendJSON(res, 500, { error: r.error });
            sendJSON(res, 200, { success: true });
        });
        return;
    }

    // External public site static files
    if (url.startsWith('/public')) {
        let subPath = decodeURIComponent(url.slice('/public'.length) || '/');
        if (subPath === '' || subPath === '/') subPath = '/index.html';
        const filePath = path.join(EXTERNAL_DIR, subPath);
        console.log('[PUBLIC]', url, '->', filePath);
        fs.readFile(filePath, (err, data) => {
            if (err) { console.error('[PUBLIC 404]', filePath); res.writeHead(404); return res.end('Not found'); }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
            res.end(data);
        });
        return;
    }

    // Portal page (admin splash)
    if (url === '/portal' || url === '/portal/') {
        const rootIndex = path.join(__dirname, '..', 'index.html');
        fs.readFile(rootIndex, (err, data) => {
            if (err) { res.writeHead(404); return res.end('Not found'); }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
        return;
    }

    // Parent Portal (public - no auth)
    if (url === '/parent' || url === '/parent/') {
        const parentPage = path.join(__dirname, 'parent.html');
        fs.readFile(parentPage, (err, data) => {
            if (err) { res.writeHead(404); return res.end('Not found'); }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
        return;
    }

    // Root landing page — serve public site
    if (url === '/' || url === '/index.html') {
        const pubIndex = path.join(EXTERNAL_DIR, 'index.html');
        fs.readFile(pubIndex, (err, data) => {
            if (err) { res.writeHead(404); return res.end('Not found'); }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
        return;
    }

    // PAS static files (protected - served under /pas/)
    if (url.startsWith('/pas/') || url === '/pas') {
        const subPath = url === '/pas' || url === '/pas/' ? '/pas-documentation.html' : url.replace('/pas', '');
        const filePath = path.join(__dirname, '..', 'PAS', subPath);
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); return res.end('Not found'); }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
            res.end(data);
        });
        return;
    }

    // Internal static files (protected) - served under /staff/
    // Allow images/css without auth (needed for login page logo)
    if (url.startsWith('/staff') && (url.endsWith('.png') || url.endsWith('.jpg') || url.endsWith('.css'))) {
        const subPath = url.replace('/staff', '');
        const filePath = path.join(__dirname, subPath);
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); return res.end('Not found'); }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
            res.end(data);
        });
        return;
    }
    if (url.startsWith('/staff')) {
        // Serve staff HTML files without Basic Auth popup - the portal has its own password gate
        const subPath = url === '/staff' || url === '/staff/' ? '/index.html' : url.replace('/staff', '');
        const filePath = path.join(__dirname, subPath);
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); return res.end('Not found'); }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
            res.end(data);
        });
        return;
    }

    // Fallback: try serving from External directory (public site assets at root level)
    const extPath = decodeURIComponent(url);
    const extFile = path.join(EXTERNAL_DIR, extPath);
    fs.readFile(extFile, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(extFile)] || 'text/plain' });
        res.end(data);
    });
}

server.listen(PORT, () => {
    console.log(`HTTP Server: http://localhost:${PORT}`);
    console.log(`DB: ${DB_SERVER} / ${DB_NAME}`);
});

if (httpsServer) {
    httpsServer.listen(HTTPS_PORT, () => {
        console.log(`HTTPS Server: https://localhost:${HTTPS_PORT}`);
    });
}
