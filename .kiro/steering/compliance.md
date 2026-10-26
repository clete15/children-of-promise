# Compliance & design principle

## Guiding principle (read before designing any form or workflow)

Build the system to be **in PICC/ISBE compliance first, then as streamlined and as
easy on parents and teachers as possible.** Compliance is the floor, not the goal —
once an item satisfies the monitor, the remaining work is to remove steps, avoid
double entry, pre-fill from data we already hold, and never ask a parent or teacher
to do by hand what the system can do for them.

When a choice trades compliance for convenience, compliance wins and the tradeoff is
flagged to the user. When two designs are equally compliant, pick the one with fewer
clicks / less retyping for the family and the classroom.

## The PICC is what we're graded on

We are a **DCFS Licensed Center-Based (CB)** Prevention Initiative program, so
**PI1–PI10 plus CB1–CB8** apply (HV items do not). The authoritative per-item text
lives in the compliance-checklist definition in `Internal/isbe.html` (each item has
`requires`, `subs`, `childFields`, `guidance`). That definition — not memory — is the
source of truth for what a monitoring visit checks. Read it before changing anything
tied to a PICC item.

## ASQ-3 / ASQ:SE-2 — who completes them (settled Sep 2026)

Two separate questions, easy to run together. Keep them apart:
**who may SCORE it** (compliance) and **what must be FILED** (our own program policy).

**A teacher completing the ASQ / ASQ:SE is compliant for PICC/monitoring.** The parent
does NOT have to be the screener for us to pass. Do not re-open that, and do not add a
gate that forces a parent to *score* the summary — the teacher scores it.

### Not to be confused with the Parent Interview Form

The **parent questionnaire** is the parent-filled ASQ-3 / ASQ:SE-2 sheet, one of the
four parts of a screening. The **Parent Interview Form** is a separate once-per-child
enrollment document (PI5.K, with L/M for language and translator). They are entirely
unrelated: no Parent Interview state ever affects a screening, and no screening state
ever affects the Parent Interview.

What PI10 actually requires of the parent:
- **G.** Written parent/guardian permission for the screening, valid for the fiscal
  year (our `PermissionSlip`).
- **H.** Evidence the results were **shared** with the parent (our
  `ScreeningResultsShared`).

It does **not** require the parent to be the screener. The results-shared record needs
seven components — child name, tool used, evidence shared, shared with whom, date
screened, date shared, and **screener name** — and the screener may be the teacher.

Sources:
- ISBE Prevention Initiative Implementation Manual, Ch. 3 frames a developmental
  screening as "a short, staff-administered tool or checklist":
  https://www.isbe.net/documents/manual-ch-3-dev.pdf
- The ASQ publisher (Brookes / Ages & Stages) notes the ASQ was *designed* as a
  parent-completed tool but that teacher-completed use in early-ed settings is common
  and accepted, with parents involved at the results-sharing stage:
  https://agesandstages.com/free-resources/articles/should-teachers-take-the-lead-in-completing-asq-questionnaires/
  (Both sources rephrased here for licensing compliance.)

**Design consequence:** the teacher-scored summary + permission + results-shared is what
carries compliance. The questionnaire upload sits ABOVE that floor, and the program has
now made the call the earlier wording left open:

### Questionnaire upload — required for PI, optional otherwise (settled Oct 2026)

- **PI child:** the screening column is complete (green) only with **all four** —
  parent-completed questionnaire uploaded, scores entered, and the summary signed by
  **both** parent and staff. Any subset is amber `partial`. This is a deliberate
  program standard stricter than the PICC floor, not a compliance requirement.
- **PFA / non-PI child:** the teacher-scored summary alone completes it (or an uploaded
  questionnaire), and a bare tick counts as done — a monitor reviews their physical
  folder, not the app. The upload is optional here.

This rule lives in exactly one place in code: the screening branch of
`ChildForms.state()` in `Internal/child-forms.js`. Every pill, chip and tooltip derives
from it via `ChildForms.screeningNeeds()`. Do not re-implement the test anywhere else —
two pages had grown their own copies and drifted, which is how an ASE cell ended up
asking for "the ASQ upload".

Anything that *describes* the rule to a user (roster column titles, chip tooltips, the
screening modal's note, the staff handouts) must state both halves. A header that says
"the questionnaire is optional" over a cell that is amber for a missing upload is the
kind of contradiction a monitor reads as a program that does not know its own procedure.

## Caveat: our own written policy can bind us

If our own Staff/Parent guides (`Handouts/ASQ and Teaching Strategies - *.pdf`) state
that parents complete the ASQ, a monitor can hold us to our own written procedure. Keep
practice, the app, and those handouts saying the same thing. If we standardize on
teacher-administered, the handouts should reflect that.

`Handouts/ASQ-ASE-Teacher-Scoring-Instructions.html` is currently the accurate one and
is the model to match: the parent fills out the questionnaire, the **teacher** uploads
it and scores the summary, the parent signs the scored summary on the IdeaTab, and its
footer states the four-part PI completion rule. Any older handout saying the parent
scores the summary should be updated or retired.
