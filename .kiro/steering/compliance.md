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

**A teacher completing the ASQ / ASQ:SE is compliant for PICC/monitoring.** The parent
does NOT have to fill out the questionnaire for us to pass. Do not re-open this or add
a gate that forces parent completion.

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

**Design consequence:** the screening flow's two required artefacts (parent
questionnaire upload + teacher-scored signed summary) reflect best practice, but the
teacher-scored summary + permission + results-shared is what carries compliance. Keep
the questionnaire upload OPTIONAL-friendly (do not block completion on it in a way that
forces parents to do the questionnaire) unless the program later chooses to require it.

## Caveat: our own written policy can bind us

If our own Staff/Parent guides (`Handouts/ASQ and Teaching Strategies - *.pdf`) state
that parents complete the ASQ, a monitor can hold us to our own written procedure. Keep
practice, the app, and those handouts saying the same thing. If we standardize on
teacher-administered, the handouts should reflect that.
