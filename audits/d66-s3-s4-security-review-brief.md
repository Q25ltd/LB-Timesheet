# D66 S3–S4 — independent security review brief

> For a SEPARATE, read-only reviewer (AGENT_WORKFLOW.md §20, "Standard
> security-agent handover"). The build agent that wrote this code has NOT
> reviewed it and does not certify it. Prepared 2026-10-17.

## The exact baseline

| | |
|---|---|
| Repository | `/Volumes/Development/Projects/LogisticBay/LB-Timesheet` — github.com/Q25ltd/LB-Timesheet, branch `main` |
| Review this commit | **`b6da23d`** (S4 docs; contains everything below). Verify with `git rev-parse HEAD` after `git checkout b6da23d` in a clean worktree. |
| S3 code commit | `9d3fdef` — feat(api): the driver's submission authority and start receipts |
| S4 code commit | `9addb37` — feat(api): timesheet submission |
| Phone side of S3 (lower priority) | `a305ea1` — the receipt queue and the sync runner |
| Deployed | both to production (private deployment; nothing calls `/driver/timesheets` yet) |

Diff to read: `git show 9d3fdef 9addb37` (S3 and S4 server code), or the
files below as they stand at `b6da23d`.

## What changed, and why it is security-sensitive

A new authority path: an IDENTITY token (account-level, no tenant authority —
AUTH.md "Identity token") may act on one of the signed-in driver's OWN
memberships — active, deactivated **or removed** — to record a start receipt
and to submit a timesheet. This deliberately lets a driver whose company access
was withdrawn still submit work (D65 Option A), so the review must prove that
nothing else leaks through it.

Contract: AUTH.md "Driver timesheet submission (D66)" and contract tests 21–25;
DECISIONS.md D66 ("AUTHORITY", "HOW A START IS EVIDENCED", "IDEMPOTENCY").

## Files in scope

- `api/src/lib/submissionContext.ts` — the nominal `SubmissionContext`
- `api/src/lib/submissionAuthorization.ts` — `authorizeTimesheetSubmission`, `authorizeStartReceipt`
- `api/src/repositories/startReceiptRepository.ts` — incl. `submissionMembershipLookup`
- `api/src/repositories/timesheetSubmissionRepository.ts`
- `api/src/services/startReceipts.ts`, `api/src/services/timesheetSubmissions.ts`
- `api/src/routes/driverTimesheets.ts` and its registration in `api/src/app.ts`
- `api/src/lib/timesheetSnapshot.ts`, `api/src/lib/checklistKeys.ts`
- `api/prisma/migrations/20261011180000_shift_start_receipts/migration.sql`
- `api/prisma/migrations/20261011190000_timesheet_submissions/migration.sql` (incl. the immutability triggers)
- `api/scripts/rules/engine.ts` — rule `submission-context-trust-sites`

## Guarantees to try to FALSIFY

1. **Membership ownership.** No request can submit, or record a receipt, for a
   membership that is not the signed-in user's own `driver` membership —
   including an administrator's membership, a membership of another driver,
   and one named with a case/whitespace/encoding variant of its id.
2. **No tenant authority.** A `SubmissionContext` never reaches a tenant
   repository or tenant route; a `TenantContext` cannot be made from it;
   `SubmissionContext.trust` has exactly one production call site.
3. **Identity vs tenant tokens.** A tenant token is refused on both routes; an
   identity token is refused on every tenant route (unchanged pipeline).
4. **Company isolation.** The stored `companyId` is always the membership
   ROW's; nothing in a body can choose or influence it (the strict envelopes;
   `no-client-tenant`; the composite foreign keys).
5. **Evidence uses server time only.** No client value — `startedAt`,
   `declaredAt`, any timestamp in the snapshot — can turn an unverified
   submission into a verified one; a withdrawn membership can never obtain a
   receipt; a receipt for one day cannot verify another.
6. **Idempotency without oracles.** The replay / `SUBMISSION_MISMATCH` /
   `RECEIPT_MISMATCH` answers cannot be used to learn about another driver's
   or another company's data, and the 404s are byte-identical.
7. **Immutability.** A submitted revision, a review decision and an audit event
   cannot be updated or deleted through the application or the database
   (triggers), except via the `lb.retention_purge` session flag — check that
   nothing in the application sets it and that it cannot be set by input.
8. **Validation.** A malicious snapshot cannot store something the PDF and
   company screens would trust as certified (e.g. a check certified by another
   user, a draft shown as completed) or exhaust the server (body limit 512 KB,
   refusal bounds, per-membership caps that never count replays).
9. **Concurrency.** Racing submissions or receipts cannot create two
   timesheets, two deliveries, or a header without its revision.
10. **Privacy.** A response never names another company, and nothing of the
    driver's private diary can enter a snapshot.

## How to run

- `npm ci` at the root; Postgres on `localhost:5544` (`docker compose up -d`).
- The whole gate: `npm run check` from the repo root (the db stage builds a
  throwaway `lb_timesheet_check` database; it never touches `lb_timesheet`).
- Just these suites: `cd api && npm run test:db` (all) — or, against the check
  database, `node --import tsx/esm --test src/tests/db/shiftReceipts.test.ts
  src/tests/db/timesheetSubmissions.test.ts`.
- Never point anything at production. No production data, Railway, Vercel or
  SES access is needed or authorised.

## Out of scope

Company review decisions, amendments, delivery, PDFs, the company website's
Timesheets area and driver history — none is built yet (STATUS.md). The phone's
sync runner (`a305ea1`) only if time allows.

## Reporting

Read-only: no code, test or document changes, no commits. Report each issue as:
what, severity and exploitability (exploitable vs theoretical), exact
reproduction, evidence, options, recommendation — for the owner's decision.
Do not assign finding IDs (FINDINGS.md owns them; AGENT_WORKFLOW §19). Then stop.
