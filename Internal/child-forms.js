/* ══════════════════════════════════════════════════════════════════════════
   Per-child form state, shared by the roster, the compliance panel and the
   staff portal.

   THE PROBLEM THIS SOLVES

   A checklist tick and a completed form were two separate facts. ISBETracking
   holds one bit per child per column; saving a form sets that bit. But nothing
   keeps them together afterwards:

     - a box can be ticked with no form behind it, by hand, in a second
     - deleting or never finishing a form leaves the tick set
     - the compliance roll-up counted ticks, so "18 of 18 files complete" could
       be true of a drawer with nothing in it

   That is the exact failure a monitoring visit is looking for, and the roster
   was reporting it as done.

   So state here has three values, not two:

     'form'      a record exists  -> the file would survive a review
     'tick-only' ticked by hand, nothing behind it -> shown differently, on purpose
     'none'      neither

   Nothing auto-unticks. A tick someone set deliberately is data, not noise, and
   quietly clearing it would lose whatever they knew that the system does not.
   It is shown as what it is instead.

   WHY A SEPARATE FILE

   Three pages need the same answers and none of them should own them. The
   roster asks per cell, the compliance panel asks per item, the staff portal
   asks per classroom. Keeping it here means one fetch, one meaning, and no
   page-to-page copies to drift apart.

   Everything below is either a plain data store or a pure function, so the
   counting logic can be tested without a browser.
   ══════════════════════════════════════════════════════════════════════════ */

(function () {
    'use strict';
    if (window.ChildForms) return;

    // Checklist fields a form can actually exist behind. Anything not in here is
    // a manual tick with no document to check, and must not be reported as
    // evidence on file. Mirrors the sources in /api/child-forms.
    var BACKED_FIELDS = [
        'ParentInterview', 'PermissionSlip',
        'BegASQ', 'BegASE', 'EndASQ', 'EndASE',
        'MidYearReport', 'EndYearReport',
        'WeightedEligibility', 'ScreeningResultsShared',
        'ExitInterview',
        'FamilyCenteredAssessment', 'FamilyGoalPlan', 'TransitionPlan', 'Referral'
    ];

    /* The four screening columns. For a PI child a column is complete only when the
       parent-completed ASQ/ASE questionnaire is uploaded, the form is scored (filed as
       the summary PDF), AND that summary is signed by both the parent and the staff
       member — see the PI branch in state(). For a non-PI child the questionnaire
       upload is optional and the scored summary alone completes it.
       One upload (the ASQ/ASE) plus the signed scored summary; there is no separate
       "test sheets" artefact.

       Note this questionnaire is the parent-filled ASQ-3 / ASQ:SE-2 sheet. It is NOT
       the Parent Interview Form, which is a separate once-per-child enrollment
       document (PI5.K/L/M) with no bearing on any screening. */
    var SCREENING_FIELDS = ['BegASQ', 'BegASE', 'EndASQ', 'EndASE'];
    // The two report-card columns are complete on an uploaded scan alone.
    var REPORT_FIELDS = ['MidYearReport', 'EndYearReport'];

    /* The kinds a screening's uploaded ASQ/ASE can be filed under, newest naming first.
       'questionnaire' is what the current single upload slot writes. 'testsheet' is the
       RETIRED second slot: screenings used to take two uploads and needed both to go
       green, and that slot was removed on 12 Oct 2026. Every PDF already filed under
       the old kind is still a parent's completed ASQ/ASE sitting in the child's folder,
       so it must keep counting — otherwise a column that was green goes amber and asks
       a teacher to upload a document they already uploaded, which is exactly what
       happened. Look under both names; never make somebody re-do filed work because an
       internal label changed. */
    var SCREENING_UPLOAD_KINDS = ['questionnaire', 'testsheet'];

    /* The screening's uploaded ASQ/ASE under whichever kind it was filed as, or null. */
    function screeningUpload(studentId, field) {
        for (var i = 0; i < SCREENING_UPLOAD_KINDS.length; i++) {
            var f = fileFor(studentId, field, SCREENING_UPLOAD_KINDS[i]);
            if (f && (f.relPath || f.name)) return f;
        }
        return null;
    }

    var forms = {};          // { studentId: { Field: { on, date } } }  in-app forms
    var files = {};          // { studentId: { Field: { Kind: { relPath, name, date } } } }  uploads
    var loadedYear = null;
    var loadState = 'idle';  // idle | loading | ready | failed

    function isBacked(field) {
        return BACKED_FIELDS.indexOf(field) !== -1;
    }
    function isScreening(field) { return SCREENING_FIELDS.indexOf(field) !== -1; }
    function isReport(field) { return REPORT_FIELDS.indexOf(field) !== -1; }

    /* Reads the year's form records. The caller supplies its own fetch wrapper so
       this file carries no opinion about authentication. Failure is recorded, not
       thrown: a roster that cannot reach this endpoint should still render its
       ticks rather than showing nothing at all. */
    function load(year, fetcher) {
        loadState = 'loading';
        return fetcher('/api/child-forms?year=' + encodeURIComponent(year))
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (d) {
                forms = (d && d.forms) || {};
                loadedYear = (d && d.year) || year;
                loadState = 'ready';
                return forms;
            })
            .catch(function (e) {
                forms = {};
                loadedYear = year;
                loadState = 'failed';
                // Swallowed deliberately; state() reports 'unknown' from here on.
                return null;
            });
    }

    /* Records a form that has just been saved, so the cell turns from "ticked by
       hand" to "form on file" on the spot. The save handlers already update the
       tick locally for the same reason; without this the box would go green only
       after a reload, which reads as the save not having worked. */
    function mark(studentId, field, date) {
        var id = String(studentId);
        if (!forms[id]) forms[id] = {};
        forms[id][field] = { on: true, date: date || '' };
    }

    function hasForm(studentId, field) {
        var rec = forms[String(studentId)];
        return !!(rec && rec[field] && rec[field].on);
    }

    function formDate(studentId, field) {
        var rec = forms[String(studentId)];
        return (rec && rec[field] && rec[field].date) || '';
    }

    /* Uploaded scans (parent questionnaires, report cards), keyed the same way as
       forms. Loaded from /api/child-files. Failure is again swallowed: an upload
       index that will not load should not blank the roster. */
    function loadFiles(year, fetcher) {
        return fetcher('/api/child-files?year=' + encodeURIComponent(year))
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (d) {
                files = {};
                (d && d.files || []).forEach(function (f) {
                    var id = String(f.StudentId);
                    if (!files[id]) files[id] = {};
                    if (!files[id][f.FormField]) files[id][f.FormField] = {};
                    files[id][f.FormField][f.Kind] = {
                        relPath: f.RelPath, name: f.FileName, date: f.UploadedAt || ''
                    };
                });
                return files;
            })
            .catch(function () { files = {}; return null; });
    }

    // Records an upload that just happened, so the cell updates without a reload.
    function markFile(studentId, field, kind, relPath, name) {
        var id = String(studentId);
        if (!files[id]) files[id] = {};
        if (!files[id][field]) files[id][field] = {};
        files[id][field][kind] = { relPath: relPath || '', name: name || '',
            date: new Date().toISOString().slice(0, 10) };
    }

    function fileFor(studentId, field, kind) {
        var rec = files[String(studentId)];
        return (rec && rec[field] && rec[field][kind]) || null;
    }
    function hasFile(studentId, field, kind) {
        return !!fileFor(studentId, field, kind);
    }

    /* Captured signatures, keyed studentId -> field -> role ('parent'|'staff').
       Loaded from /api/child-signatures (same year as forms/files). The screening
       completion rule requires BOTH roles signed, so state() reads these. Failure is
       swallowed like the others: a signature index that will not load must not blank
       the roster — state() falls back to not-signed, which reads as not-yet-done
       rather than falsely complete. */
    var sigs = {};   // { studentId: { Field: { role: true } } }
    function loadSignatures(year, fetcher) {
        return fetcher('/api/child-signatures?year=' + encodeURIComponent(year))
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (d) {
                sigs = {};
                (d && d.signatures || []).forEach(function (s) {
                    var id = String(s.StudentId);
                    if (!sigs[id]) sigs[id] = {};
                    if (!sigs[id][s.FormField]) sigs[id][s.FormField] = {};
                    sigs[id][s.FormField][String(s.Role || '').toLowerCase()] = true;
                });
                return sigs;
            })
            .catch(function () { sigs = {}; return null; });
    }
    // Records a signature that just happened, so a cell updates without a reload.
    function markSignature(studentId, field, role) {
        var id = String(studentId);
        if (!sigs[id]) sigs[id] = {};
        if (!sigs[id][field]) sigs[id][field] = {};
        sigs[id][field][String(role || '').toLowerCase()] = true;
    }
    function hasSignature(studentId, field, role) {
        var rec = sigs[String(studentId)];
        return !!(rec && rec[field] && rec[field][String(role || '').toLowerCase()]);
    }
    // Removes a signature from the local store, so a cell drops back out of 'form'
    // the instant a signature is explicitly cleared — without waiting for a reload.
    function unmarkSignature(studentId, field, role) {
        var rec = sigs[String(studentId)];
        if (rec && rec[field]) delete rec[field][String(role || '').toLowerCase()];
    }

    /* The one question every view asks. `ticked` is the ISBETracking bit the
       caller already holds, passed in rather than fetched again here.

       'unknown' when the form index could not be read: showing a tick as
       unbacked because the network failed would be a lie in the other
       direction.

       Two columns are special:
         - A screening (ASQ/ASE). Who may SCORE it and what must be FILED are two
           different questions, and this comment used to run them together.
             Scoring: the TEACHER administers and scores it. A teacher-scored summary
             is compliant for PICC/monitoring — PI10 requires the screening on file,
             parent permission and results shared, and does not require the parent to
             be the screener.
             Filing: the parent-completed questionnaire upload is REQUIRED for a PI
             child (program policy) and OPTIONAL for everyone else. So a PI screening
             is 'form' only with all four parts — questionnaire upload, entered scores,
             parent signature, staff signature — while a PFA/non-PI screening is 'form'
             on the scored summary (or an uploaded questionnaire) alone.
           Some-but-not-all of the four on a PI child is 'partial'; nothing but a tick
           is 'tick-only'.
         - A report card is 'form' when its scan is uploaded, else tick-only/none.

       isPI — whether this child is in the Prevention Initiative. Only PI children need
       a real backing form for a "backed" field: PI files are the ones a monitor opens
       (electronic files uploaded through the portal), so a bare tick on a PI child is
       'tick-only' (not done). For everyone else — PFA (monitors review the physical
       folder, not the app) and the 2s/3s and other non-PI rooms — the app checklist is
       just a working tick, so a checked box counts as done. A real filed form still
       reads as 'form' for any child when one exists. isPI defaults to true so any
       caller that does not pass it keeps the strict (safe) behavior. */
    function state(studentId, field, ticked, isPI) {
        if (isPI === undefined) isPI = true;
        if (!isBacked(field)) return ticked ? 'tick' : 'none';
        // A signed/scanned Parent Interview is the authoritative once-per-child
        // evidence. Recognize it even if the electronic-form index failed to load.
        if (field === 'ParentInterview' && hasFile(studentId, field, 'interviewform')) return 'form';
        if (loadState !== 'ready') return ticked ? 'unknown' : 'none';

        if (isScreening(field)) {
            var scored = hasForm(studentId, field);           // scores filed as the signed summary PDF
            // The uploaded ASQ/ASE, under either the current or the retired kind.
            var quest = !!screeningUpload(studentId, field);
            var parentSig = hasSignature(studentId, field, 'parent');
            var staffSig = hasSignature(studentId, field, 'staff');

            /* PI rule (program policy, confirmed with the director): a screening column
               is COMPLETE (green) only when all three are true —
                 1. the ASQ/ASE questionnaire is uploaded,
                 2. the form is scored, filed as the summary PDF (hasForm), and
                 3. that summary is signed by BOTH the parent and the staff member.
               The uploaded ASQ/ASE is the only upload; it IS the questionnaire, and the
               signed scored form IS the summary — there is no separate "test sheets"
               artefact any more. Anything with some-but-not-all of the three is 'partial'
               (yellow): real progress, not yet a file a monitor would pass. */
            if (isPI) {
                if (quest && scored && parentSig && staffSig) return 'form';
                if (quest || scored || parentSig || staffSig) return 'partial';
                return ticked ? 'tick-only' : 'none';
            }

            /* PFA / non-PI rooms keep the streamlined rule: the scored summary (or an
               uploaded questionnaire) completes it, and a bare tick counts as done since
               a monitor reviews the physical folder, not the app, for these children. */
            if (scored || quest) return 'form';
            return ticked ? 'tick' : 'none';
        }
        if (field === 'WeightedEligibility') {
            /* Weighted eligibility is one enrollment document per child, not a form the
               family repeats every school year. The roster seeds this file entry from
               the unscoped generated-document map after load, so PI5 rollups recognize
               the same PDF that its green pill opens. */
            if (hasFile(studentId, field, 'generated')) return 'form';
            return ticked ? 'tick-only' : 'none';
        }
        if (field === 'FamilyCenteredAssessment' || field === 'FamilyGoalPlan') {
            /* These are the child's explicitly identified initial-ever assessments.
               Never infer them from BegASQ/BegASE, which describe the selected school
               year and may be a later administration for an established child. */
            var initialKind = field === 'FamilyCenteredAssessment' ? 'initialasq' : 'initialase';
            if (hasFile(studentId, field, initialKind)) return 'form';
            return ticked ? 'tick-only' : 'none';
        }
        if (isReport(field)) {
            if (hasFile(studentId, field, 'report')) return 'form';
            return ticked ? (isPI ? 'tick-only' : 'tick') : 'none';
        }
        if (hasForm(studentId, field)) return 'form';
        return ticked ? (isPI ? 'tick-only' : 'tick') : 'none';
    }

    // Done for checklist purposes: a form on file, or a tick where there is no
    // form to have. A tick-only on a backed field (PI children only) is NOT done.
    function isDone(studentId, field, ticked, isPI) {
        var s = state(studentId, field, ticked, isPI);
        return s === 'form' || s === 'tick' || s === 'unknown';
    }

    /* What a screening column already has and what it still needs, as two lists of
       plain phrases ready to drop into a sentence.

       It reads the SAME four facts the screening branch of state() uses to pick a
       pill's colour, so a tooltip phrased from this can never contradict the colour
       beside it. It lives here, not on a page, because the ISBE roster and the staff
       portal both explain these cells and had grown their own near-duplicate copies —
       which is how one of them ended up saying "the ASQ upload" on an ASE cell.

       `tool` is ASQ or ASE, named from the field so the wording is right for both. */
    function screeningNeeds(studentId, field) {
        var tool = (field === 'BegASQ' || field === 'EndASQ') ? 'ASQ' : 'ASE';
        var parts = [
            ['the ' + tool + ' upload', !!screeningUpload(studentId, field)],
            ['the entered scores', hasForm(studentId, field)],
            ['the parent signature', hasSignature(studentId, field, 'parent')],
            ['the staff signature', hasSignature(studentId, field, 'staff')]
        ];
        var have = [], need = [];
        parts.forEach(function (p) { (p[1] ? have : need).push(p[0]); });
        return { tool: tool, have: have, need: need };
    }

    /* "a", "a and b", "a, b and c" — for reading a list out inside a sentence.
       Shared so the two pages' tooltips punctuate identically. */
    function phraseList(items) {
        var a = items || [];
        if (!a.length) return '';
        if (a.length === 1) return a[0];
        return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
    }

    /* ── Compliance roll-up ────────────────────────────────────────────────
       Counts how many children's files would survive a review of these fields,
       and separates the two ways a file can fail: nothing there at all, or a
       tick with nothing behind it. The second used to be counted as complete.

       roster    the children in scope (already filtered to the program). Each child's
                 own PFA_PI_na decides whether a bare tick counts: PI children need a
                 real form, everyone else (PFA, non-PI rooms) may complete on a tick.
       fields    the item's childFields
       tracking  { studentId: { Field: bool } }, the caller's ISBETracking map  */
    function rollup(fields, roster, tracking) {
        if (!fields || !fields.length) return null;
        var out = {
            total: roster.length, complete: 0,
            missing: [],          // children with at least one field not done
            unbacked: [],         // children with at least one tick and no form
            fields: fields.slice()
        };
        roster.forEach(function (s) {
            var t = (tracking && tracking[s.Id]) || {};
            var isPI = String(s.PFA_PI_na || '').trim().toUpperCase() === 'PI';
            var anyMissing = false, anyUnbacked = false;
            fields.forEach(function (f) {
                var st = state(s.Id, f, !!t[f], isPI);
                if (st === 'tick-only') { anyUnbacked = true; anyMissing = true; }
                else if (st === 'none') anyMissing = true;
                // 'partial' is retained for any future half-done backed field; screenings
                // no longer produce it (scored summary alone completes them).
                else if (st === 'partial') anyMissing = true;
            });
            if (anyUnbacked) out.unbacked.push(s);
            if (anyMissing) out.missing.push(s); else out.complete++;
        });
        return out;
    }

    /* Which compliance items a checklist field is evidence for, derived from the
       items' own childFields rather than declared a second time here. A field can
       serve more than one item, so matches are collected.

       itemLists is [{ program: 'PI', items: PICC_ITEMS }, ...]. */
    function indexItems(itemLists) {
        var index = {};
        (itemLists || []).forEach(function (list) {
            (list.items || []).forEach(function (item) {
                (item.childFields || []).forEach(function (f) {
                    if (!index[f]) index[f] = [];
                    index[f].push({ program: list.program, num: item.num, title: item.title });
                });
            });
        });
        return index;
    }

    window.ChildForms = {
        load: load,
        loadFiles: loadFiles,
        loadSignatures: loadSignatures,
        BACKED_FIELDS: BACKED_FIELDS,
        SCREENING_FIELDS: SCREENING_FIELDS,
        REPORT_FIELDS: REPORT_FIELDS,
        isBacked: isBacked,
        isScreening: isScreening,
        isReport: isReport,
        hasForm: hasForm,
        formDate: formDate,
        mark: mark,
        markFile: markFile,
        markSignature: markSignature,
        unmarkSignature: unmarkSignature,
        hasFile: hasFile,
        fileFor: fileFor,
        screeningUpload: screeningUpload,
        SCREENING_UPLOAD_KINDS: SCREENING_UPLOAD_KINDS,
        hasSignature: hasSignature,
        state: state,
        isDone: isDone,
        screeningNeeds: screeningNeeds,
        phraseList: phraseList,
        rollup: rollup,
        indexItems: indexItems,
        get loadState() { return loadState; },
        get year() { return loadedYear; },
        // Exposed for tests and for a page that wants the raw index.
        get all() { return forms; },
        _set: function (f, st) { forms = f || {}; loadState = st || 'ready'; },
        // Tests set the upload index directly, same as _set does for forms.
        _setFiles: function (f) { files = f || {}; },
        // Tests set the signature index directly, same shape loadSignatures builds.
        _setSignatures: function (s) { sigs = s || {}; }
    };
})();
