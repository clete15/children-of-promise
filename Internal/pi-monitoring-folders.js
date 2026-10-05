/* ─────────────────────────────────────────────────────────────────────────────
   PI MONITORING — SharePoint folder crosswalk
   ─────────────────────────────────────────────────────────────────────────────

   WHAT THIS IS
   A single editable map of the folder structure the monitor (Vander Weele Group /
   IDEC) uses on their SharePoint upload site, cross-referenced to how OUR software
   actually stores the matching evidence. It is DATA, not behaviour: nothing imports
   or executes this yet. It exists so the structure lives in version control instead
   of in a screenshot, and so a future "build the SharePoint upload folder" export
   has one authoritative source to read.

   WHY IT MATTERS
   Our app does NOT store PI evidence in the monitor's item-per-folder layout. It uses:
     • Per-child docs  -> "Child Files/<Last, First> - <Id>/{Teacher|Administrative}/…"
                          (keyed by the child; see childFolder/childSubFolder in server.js)
     • Program docs     -> dropped loose into ONE living "PI Monitoring Visit" folder,
                          named "PI<n> - …" / "CB<n> - …" so the indexer attributes them
                          to a PICC item by FILENAME prefix (see docItemNumberFromFile).
   The monitor instead wants one folder per PICC item, with child/family evidence
   nested a level deeper. So aligning to their layout is an EXPORT/COPY step, not a
   change to how we store things day to day.

   SOURCE OF THIS STRUCTURE
   Transcribed from two screenshots of our own 2024 upload, taken from
   "…/Operations/Birth to Three/2026 PI Monitoring Visit/PICC/" and its
   "Child or Family Files - M/" subfolder. The names (including the quirks:
   "Excelrate" not "ExceleRate", "afer" not "after", "Stategies" not "Strategies",
   the trailing " - M" / " - C" owner initials) are reproduced VERBATIM so an export
   recreates exactly what the monitor saw last time.

   ⚠ CONFIRM AT THE JAN 4 2027 PREP MEETING
   The prep meeting shows the CURRENT SharePoint structure. This map is from ~2 years
   ago. Likely differences to check and update here:
     • A PI9 folder (Professional Development Plans) — not present in the 2024 shots.
     • Exact PI5 sub-splits (A-G, H-I, J, K, L) and whether they changed.
     • The " - M" / " - C" owner suffixes (Megan / Clete) — keep or drop.
     • Spelling fixes they may have made.
   When they change something, edit the strings below — that is the whole point of
   this file.

   OWNER SUFFIXES
   "- M" = Megan, "- C" = Clete. Our server's docOwner() already parses these. They
   are organisational, not required by the monitor; an exporter may keep or drop them.

   HOW TO READ AN ENTRY
     folder   exact SharePoint folder name (verbatim, quirks and all)
     piccItem the PICC item key(s) in our PICC_ITEMS (isbe.html), for cross-reference
     owner    'Megan' | 'Clete' | '' (from the trailing initial, if any)
     source   where OUR app holds the matching evidence:
                'program'  — a program-level document in the living visit folder
                             (filename prefixed "PI<n> -" / "CB<n> -")
                'perChild' — per-child evidence under Child Files/<child>/…
                'external' — lives outside the app (public website, SharePoint-only,
                             or completed by the monitor after the visit)
     field    the ISBETracking column / DOC_FORM_SPECS field, where one exists
     note     anything a person assembling the upload needs to know
   ───────────────────────────────────────────────────────────────────────────── */

(function () {
    'use strict';

    // Top level: <visit>/PICC/<these folders>. Order matches the SharePoint listing
    // (CB1–CB8, then the Child or Family Files container, then PI items).
    const PICC_TOP_LEVEL = [
        { folder: 'CB1.A-D PI Program Hours - M', piccItem: 'CB1', owner: 'Megan', source: 'program',
          note: 'Class schedules, policies manual, sign-in sheets, attendance, PI-specific lesson plans.' },
        { folder: 'CB2.D - DCFS License and Evidence of Excelrate', piccItem: 'CB2', owner: 'Clete', source: 'program',
          field: '', note: 'DCFS license (also surfaced in the CB2 site license panel) + ExceleRate award/report. "Excelrate" spelled as on SharePoint.' },
        { folder: 'CB3.B Lesson Plans', piccItem: 'CB3', owner: '', source: 'program',
          note: 'Classroom lesson plans showing IELG references.' },
        { folder: 'CB4 Staffing plan - M', piccItem: 'CB4', owner: 'Megan', source: 'program',
          note: 'Staffing schedules / DCFS ratio documentation.' },
        { folder: 'CB5.A-B Meal Plan - C', piccItem: 'CB5', owner: 'Clete', source: 'program',
          note: 'Menus, meal counts, CACFP records. (Also produced by the Menus page.)' },
        { folder: 'CB6.B Staff working towards Infant Toddler Credential - C', piccItem: 'CB6', owner: 'Clete', source: 'program',
          note: 'Transcripts, Gateways certificates, credential letters.' },
        { folder: 'CB7 The familes are at least offered monthly parent activities - M', piccItem: 'CB7', owner: 'Megan', source: 'program',
          note: 'Parent education calendars, sign-in sheets, newsletters. "familes" as on SharePoint.' },
        { folder: 'CB8 Written policies to provide guidance for staff for suspension and expulsion - M', piccItem: 'CB8', owner: 'Megan', source: 'program',
          note: 'Policies & procedures manual incl. suspension/expulsion policy.' },

        // The per-child container. Its contents are enumerated in CHILD_OR_FAMILY_FILES below.
        { folder: 'Child or Family Files - M', piccItem: 'PI5/PI6/PI7/PI10', owner: 'Megan', source: 'perChild',
          childContainer: true,
          note: 'Nested per-child evidence. In our app these come from Child Files/<child>/… — see CHILD_OR_FAMILY_FILES.' },

        { folder: 'PI 1.B Number of workng days providing services - M', piccItem: 'PI1', owner: 'Megan', source: 'program',
          note: 'Program calendar / handbook schedule. PI1 is Not Scored for IDEC monitoring. "workng" as on SharePoint.' },
        { folder: 'PI2.A-B Mission Statement (Website and Front Door) - C', piccItem: 'PI2', owner: 'Clete', source: 'external',
          note: 'Mission statement on the public website (/mission.html) and posted at the front door.' },
        { folder: 'PI3.A Program does not charge fees for participation in the program - M', piccItem: 'PI3', owner: 'Megan', source: 'program',
          note: 'Fee policy / parent handbook / billing evidence showing PI children are not charged.' },
        { folder: 'PI4.A evidence of mandated reporting for staff - M', piccItem: 'PI4', owner: 'Megan', source: 'program',
          note: 'Mandated-reporter training evidence / policies & procedures manual.' },
        { folder: 'PI5.A-G Weighted Eligibility Screen Form - C (Pre-Enrollment Form)', piccItem: 'PI5', owner: 'Clete', source: 'perChild',
          field: 'WeightedEligibility',
          note: 'The weighted-eligibility form per child (Child Files/<child>/Administrative). Monitor keeps the program copy of the blank form here too.' },
        { folder: 'PI5.H-I Enrollment and Waiting List - C', piccItem: 'PI5', owner: 'Clete', source: 'program',
          note: 'Enrollment list + prioritised waiting list (from the EMS / waiting-list data).' },
        { folder: 'PI8.A written Annual Self-Assessment - Completed after Monitoring Visit', piccItem: 'PI8', owner: '', source: 'external',
          field: '', note: 'PI8.A. Completed AFTER the visit; filed in the living visit folder as "PI8 - …".' },
        { folder: 'PI8.B Written CQIP - Completed afer Monitoring Visit', piccItem: 'PI8', owner: '', source: 'external',
          note: 'PI8.B CQIP. Completed AFTER the visit (due 30 days after results). "afer" as on SharePoint.' }
    ];

    // Inside "Child or Family Files - M/". These are the per-child monitoring buckets.
    // Each child gets their matching documents dropped into the right bucket. In our
    // app the evidence lives under Child Files/<child>/{Teacher|Administrative}/… and
    // is produced by the forms whose DOC_FORM_SPECS field is given below.
    const CHILD_OR_FAMILY_FILES = [
        { folder: 'PI5 J - Proof of Income', piccItem: 'PI5.J', source: 'perChild', field: 'ProofOfIncome',
          childSub: 'Administrative', note: 'Proof of income per child.' },
        { folder: 'PI5 K - Parent Interview Forms', piccItem: 'PI5.K', source: 'perChild', field: 'ParentInterview',
          childSub: 'Teacher', note: 'Signed/scanned Parent Interview Form per child.' },
        { folder: 'PI5.L - Primary Language', piccItem: 'PI5.L', source: 'perChild', field: 'ParentInterview',
          childSub: 'Teacher', note: 'Captured on the Parent Interview form (PI5.L preferred language / PI5.M translator).' },
        { folder: 'PI6 A - Research based Family Center Assessment', piccItem: 'PI6.A', source: 'perChild', field: 'FamilyCenteredAssessment',
          childSub: 'Administrative', note: 'Family Centered Assessment form. "Center" as on SharePoint.' },
        { folder: 'PI6 B - Individual Family Goal Plan', piccItem: 'PI6.B', source: 'perChild', field: 'FamilyGoalPlan',
          childSub: 'Administrative', note: 'Individual Family Goal Plan form.' },
        { folder: 'PI7 B - Evidence referral system is utilized when neccessary', piccItem: 'PI7.B', source: 'perChild', field: 'Referral',
          childSub: 'Administrative', note: 'Referral records / determination that none was needed. "neccessary" as on SharePoint.' },
        { folder: 'PI7.A Written Individualized Transition Plans, as applicable', piccItem: 'PI7.A', source: 'perChild', field: 'TransitionPlan',
          childSub: 'Administrative', note: 'Transition Plan form, where applicable.' },
        { folder: 'PI10 H Teaching Stategies Report Cards', piccItem: 'PI10.H', source: 'perChild', field: 'MidYearReport',
          childSub: 'Teacher', note: 'Mid-year + end-year Teaching Strategies report cards (report-card uploads). "Stategies" as on SharePoint.' },
        { folder: 'PI10 A-F Ages and Stages', piccItem: 'PI10.A-F', source: 'perChild', field: 'BegASQ',
          childSub: 'Teacher', note: 'ASQ-3 + ASQ:SE-2 scored summaries and sheets (BegASQ/BegASE/EndASQ/EndASE).' },
        { folder: 'PI10 G - Signed Permission Slips', piccItem: 'PI10.G', source: 'perChild', field: 'PermissionSlip',
          childSub: 'Teacher', note: 'Signed screening permission slip per child.' },
        { folder: 'PI10 I - Evidence children with concerns are referred', piccItem: 'PI10.I', source: 'perChild', field: 'Referral',
          childSub: 'Administrative', note: 'Referral evidence for children flagged with a concern.' }
    ];

    /* Items our app tracks that did NOT have a dedicated top-level folder in the 2024
       screenshots. Listed so an exporter / the Jan 4 review knows to ask where these go.
         PI9  — Professional Development Plans (we hold these; no PI9 folder seen).
         ScreeningResultsShared (PI10.H component) — our form; folder equivalent unclear. */
    const UNMAPPED_WATCH = [
        { piccItem: 'PI9', field: '', note: 'Professional Development Plans — confirm the folder name at prep meeting.' },
        { piccItem: 'PI10.H', field: 'ScreeningResultsShared', note: 'Results-shared record — confirm whether it files under PI10 H or elsewhere.' }
    ];

    /* The on-disk roots our app uses, for whoever builds the export. These mirror
       server.js (findDocRoot, program folders, living visit folder, Child Files). */
    const APP_STORAGE = {
        docRootCandidates: ['C:\\app\\documents\\Operations', 'C:\\CofP-Docs\\Operations', 'D:\\CofP-Docs\\Operations'],
        piProgramFolder: 'Birth to Three',
        piVisitFolderLiving: 'PI Monitoring Visit',     // preferred; year-named fallback e.g. "2027 PI Monitoring Visit"
        childFilesRoot: 'Child Files',                   // Child Files/<Last, First> - <Id>/{Teacher|Administrative}
        childSubfolders: ['Teacher', 'Administrative']
    };

    const PI_MONITORING_FOLDERS = {
        source: '2026 PI Monitoring Visit / PICC (transcribed from screenshots, ~2024 upload)',
        confirmBy: 'Jan 4 2027 prep meeting',
        topLevel: PICC_TOP_LEVEL,
        childOrFamilyFiles: CHILD_OR_FAMILY_FILES,
        unmappedWatch: UNMAPPED_WATCH,
        appStorage: APP_STORAGE
    };

    // Dual export: usable as a browser global and (if ever needed) a Node module,
    // without taking a dependency either way.
    if (typeof window !== 'undefined') window.PI_MONITORING_FOLDERS = PI_MONITORING_FOLDERS;
    if (typeof module !== 'undefined' && module.exports) module.exports = PI_MONITORING_FOLDERS;
})();
