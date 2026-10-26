# Reading data out of SQL — the traps that cost us a day

Every one of these has already bitten. Read before touching `runSQL`, `runSQLRows`,
any `/api/...` read endpoint, or any client code that loads an index of records.

The theme: **a failed read in this codebase does not look like an error. It looks like
an empty table.** That is the single most expensive failure mode here, because an empty
answer is indistinguishable from "nothing has been saved yet" — so the UI confidently
tells staff their work is missing and asks them to redo it.

## The transport, in one paragraph

`runSQL` shells out to `sqlcmd` with `-s "|" -W -h -1`. Text output truncates any
variable-length value at 256 characters, so `runSQLRows` exists: it wraps the caller's
SELECT in `FOR JSON PATH`, assigns it to one `NVARCHAR(MAX)`, and emits it in
60-character chunks (`seq|chunk~`), numbered off `sys.all_objects`, which the Node side
reassembles and `JSON.parse`s.

## ⚠ runSQLRows embeds your SELECT in a SCALAR SUBQUERY

```sql
DECLARE @j NVARCHAR(MAX) = ISNULL(( <your SELECT> FOR JSON PATH, INCLUDE_NULL_VALUES), N'');
```

So the payload **cannot** be:
- a CTE (`WITH x AS (...) SELECT ...`) — not legal in that position
- anything with a leading `;` — `(;WITH` is a syntax error outright

**Use a derived table instead.** Identical rows, legal everywhere:

```sql
SELECT cols FROM ( SELECT cols, ROW_NUMBER() OVER (...) AS rn FROM T WHERE ... ) AS x WHERE rn = 1
```

`runSQLRows` now rejects a leading `WITH`/`;` up front with a message naming this fix.
A leading `;WITH` passed to **`runSQL`** is fine — that is a plain batch, not a
subquery. The distinction is the runner, not the SQL.

### The incident (14–25 Oct 2026, eleven days)

`/api/child-files` was rewritten as `` runSQLRows(`;WITH CandidateFiles AS (...)`) ``.
It never compiled, and three guards each failed to notice:

1. `runSQL` returns **`ok: true`** with `sqlError` set — deliberate, so ensure-block
   noise cannot kill requests.
2. `runSQLRows` checked `!r.ok` and **never looked at `sqlError`**.
3. With no chunk rows parsed, the missing-chunk guard looped `i < parts.length` — zero
   iterations — and the empty payload fell into `return { ok: true, rows: [] }`.

Result: HTTP **200** with `files: []`. Every uploaded parent questionnaire and report
card in the program read as "not uploaded". PI screenings went amber (their completion
needs the questionnaire); non-PI children stayed green (theirs does not). It looked
exactly like mass deletion of documents that were sitting untouched on disk the whole
time. Fixed in `10d3acb`.

## Rules that follow

1. **Never let a failed read return an empty success.** `runSQLRows` now fails when
   there is a batch error *and* nothing parsed. Keep that.
2. **Client loaders must distinguish "failed" from "empty."** `ChildForms.load` always
   did (`loadState`); `loadFiles` did not — its `.catch` set `files = {}` and returned,
   which is what rendered a transport fault as missing paperwork. It now throws on
   `d.error`, tracks `filesState`, and logs loudly. Any new loader does the same.
3. **If a check is about to tell a user their saved work is absent, be sure you read it
   successfully first.** Prefer "couldn't read this" over a confident false negative.

## ⚠ Array-destructuring an elision-padded `Promise.all`

Hit **twice**, both times silently zeroing a feature:

```js
const [a, b, c, d, , , , , weData] = await Promise.all([ ...10 entries... ]);  // 4 holes, needs 5
```

Miscount the commas and you bind a neighbouring promise. Both occurrences bound a
function that returns `undefined`, so the feature read as "no data" with no error:

- `isbe.html` `init()` — `weightedFiles` always `{}`, so every Weighted Eligibility cell
  showed "Create form" however many PDFs existed. Fixed.
- `staff-portal.html` `loadClassroomData()` — `weRes` binds `CofpForms.loadSignatures`
  instead of `/api/weighted-eligibility-files`, so `CLS_WEIGHTED` is always `{}`.
  **Still outstanding.**

**Name the promise instead of counting holes:**

```js
const weightedP = apiFetch('/api/weighted-eligibility-files').then(...).catch(() => null);
const [a, b, c, d] = await Promise.all([ ..., weightedP ]);
const weData = await weightedP;
```

## How to actually debug "the data is gone"

In this order. It works because it walks the path from the disk forward and stops at the
first liar.

1. **Ask the database, not the app.** `SELECT ... FROM <table> WHERE StudentId=...` with
   no year filter and no joins. If rows are there, nothing is deleted — say so plainly
   and stop speculating about deletion.
2. **Run the endpoint's exact query** in the portal's SQL box. If it returns the rows,
   the query is fine and the fault is downstream.
3. **Check how the query is wrapped** — `runSQL` vs `runSQLRows`, and whether the
   payload is subquery-legal. This is where the Oct 2026 bug lived, and steps 1 and 2
   both looked perfect.
4. **Then** the browser: DevTools Network for the status and body, or Console for the
   client's own view (`ChildForms.filesState`, `ChildForms.fileFor(id, field, kind)`).

Two things that are NOT the cause, having been wrongly blamed already: the 60-char
chunking running out of `sys.all_objects` rows (there are ~2745 available against ~586
needed for the whole `ChildFiles` table), and a `Kind` rename leaving orphans (the
`testsheet` kind had zero rows). Measure before theorising.

### A green item turning amber across a whole population is a READ fault

If one child regresses, suspect that child's data. If **every child in one program**
regresses at once, suspect the code: a completion rule changed, or an index stopped
loading. Deletion does not respect a program flag.

## Known-silent endpoints to be careful with

- `POST /api/sql` returns `{success:true}` even when a statement failed inside the
  batch. Always end with a `SELECT` and verify the row really changed.
- `/api/child-files` is **year-scoped**, with all-year exemptions only for
  `ParentInterview/interviewform`, `FamilyCenteredAssessment/initialasq` and
  `FamilyGoalPlan/initialase`. A screening questionnaire from an earlier school year is
  invisible in the current year's view — correct, since screenings repeat annually, but
  check the year picker before concluding a file is missing.
- `/api/weighted-eligibility-files` is deliberately **not** year-scoped (one document
  per child, for life) and is cached; `invalidateDocCache()` clears it.
