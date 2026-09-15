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
        'FamilyCenteredAssessment', 'FamilyGoalPlan', 'TransitionPlan', 'Referral'
    ];

    /* The four screening columns need TWO artefacts to be complete: the parent's
       filled-in questionnaire (uploaded scan) AND the teacher's scored, signed
       summary (an in-app form). One without the other is not a file a monitor would
       pass, so both are required here. */
    var SCREENING_FIELDS = ['BegASQ', 'BegASE', 'EndASQ', 'EndASE'];
    // The two report-card columns are complete on an uploaded scan alone.
    var REPORT_FIELDS = ['MidYearReport', 'EndYearReport'];

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

    /* The one question every view asks. `ticked` is the ISBETracking bit the
       caller already holds, passed in rather than fetched again here.

       'unknown' when the form index could not be read: showing a tick as
       unbacked because the network failed would be a lie in the other
       direction.

       Two columns are special:
         - A screening (ASQ/ASE) is 'form' only when BOTH the scored summary and the
           parent questionnaire upload are present. With one of the two it is
           'partial' — real progress, but not a file that would pass review, so it is
           not done. Nothing there but a tick is 'tick-only'.
         - A report card is 'form' when its scan is uploaded, else tick-only/none. */
    function state(studentId, field, ticked) {
        if (!isBacked(field)) return ticked ? 'tick' : 'none';
        if (loadState !== 'ready') return ticked ? 'unknown' : 'none';

        if (isScreening(field)) {
            var scored = hasForm(studentId, field);
            var quest = hasFile(studentId, field, 'questionnaire');
            if (scored && quest) return 'form';
            if (scored || quest) return 'partial';
            return ticked ? 'tick-only' : 'none';
        }
        if (isReport(field)) {
            if (hasFile(studentId, field, 'report')) return 'form';
            return ticked ? 'tick-only' : 'none';
        }
        if (hasForm(studentId, field)) return 'form';
        return ticked ? 'tick-only' : 'none';
    }

    // Done for checklist purposes: a form on file, or a tick where there is no
    // form to have. A tick-only on a backed field is deliberately NOT done.
    function isDone(studentId, field, ticked) {
        var s = state(studentId, field, ticked);
        return s === 'form' || s === 'tick' || s === 'unknown';
    }

    /* ── Compliance roll-up ────────────────────────────────────────────────
       Counts how many children's files would survive a review of these fields,
       and separates the two ways a file can fail: nothing there at all, or a
       tick with nothing behind it. The second used to be counted as complete.

       roster    the children in scope (already filtered to the program)
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
            var anyMissing = false, anyUnbacked = false;
            fields.forEach(function (f) {
                var st = state(s.Id, f, !!t[f]);
                if (st === 'tick-only') { anyUnbacked = true; anyMissing = true; }
                else if (st === 'none') anyMissing = true;
                // A screening with only one of its two artefacts, or any other
                // half-done backed field: real progress, but not a passing file.
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
        hasFile: hasFile,
        fileFor: fileFor,
        state: state,
        isDone: isDone,
        rollup: rollup,
        indexItems: indexItems,
        get loadState() { return loadState; },
        get year() { return loadedYear; },
        // Exposed for tests and for a page that wants the raw index.
        get all() { return forms; },
        _set: function (f, st) { forms = f || {}; loadState = st || 'ready'; },
        // Tests set the upload index directly, same as _set does for forms.
        _setFiles: function (f) { files = f || {}; }
    };
})();
