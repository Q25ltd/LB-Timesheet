# LogisticBay Timesheets — Finding Register

> **This is the canonical registry for every `F-XX` finding ID used anywhere in
> this repository.** Going forward, an F-number is assigned here first; no
> other doc, comment, or test invents one. `STATUS.md` remains the source of
> truth for *current build state*; this file is the source of truth for *what
> each finding ID means and where it stands*.
>
> Built 2026-08-30 by reconstructing every `F-[0-9]{2}` reference from the
> working tree and the full commit history (`git log --all`, 15 commits, all
> on `main`). Two genuine ID collisions turned up during reconstruction
> (`F-03` and `F-04`, both the result of a later commit reusing an ID that was
> already closed) — both are now resolved; see **Collision history** below for
> how and why.

Status vocabulary: `OPEN` · `CLOSED` · `ACCEPTED` · `DEFERRED` · `PARTIAL`.

| ID | Finding | Status | Resolution / owner | Evidence |
|----|---------|--------|--------------------|----------|
| F-01 | Tenant repository boundary — reads/writes must go through `TenantContext` + `shiftRepository`, never raw Prisma in a route | CLOSED | Implemented in `8572732`; 11 Company A/B isolation tests | `DECISIONS.md:243`, `STATUS.md:108` |
| F-02 | Schema: `Shift` bound to `CompanyMembership` by one composite FK (`membershipId`+`companyId`+`userId` must agree) | CLOSED | Implemented in `4417f62` | `DEVLOG.md:113` ("Schema (F-02 closed)"), `DECISIONS.md:242` |
| F-03 | First Prisma migration / tenant-safe schema foundation (`20260830132905_init` + `invariants.sql`) | CLOSED | Implemented in `4417f62` | `DEVLOG.md:121` ("Migration (F-03 closed)") |
| F-04 | Database tenant-integrity test suite (`test:db`) brought inside the authoritative `npm run check` gate | CLOSED | `d3648cd`; re-run repeatedly during later foundation work | `DEVLOG.md:139`, `STATUS.md:103` |
| F-05 | Error envelope only masked 5xx; a handler could fabricate a "safe" 4xx (e.g. a forged `statusCode`) and have it forwarded verbatim | CLOSED | Implemented in `42d950a` — only explicitly-thrown, known-safe errors pass through unmasked now | `api/src/app.ts:54`, `api/src/errorHandling.test.ts:37,123` |
| F-06 | `JWT_SECRET` validation was length-only; a weak/repeated-character or placeholder secret could pass | CLOSED | Implemented in `9bb288f` | `api/src/lib/env.test.ts:60` |
| F-07 | Nothing forced production (or an unset `NODE_ENV`) to have working email config; could boot silently unable to send reports | CLOSED | Implemented in `4de1ed8` | `DEVLOG.md:96`, `STATUS.md:111`, `api/src/lib/env.test.ts:35` |
| F-08 | `check-rules`, the static enforcement mechanism, had no proof every rule actually fires (an unwired rule fails silently) | CLOSED | Rule engine split into `scripts/rules/engine.ts` + fixture-tested in `4de1ed8` | `DEVLOG.md:76`, `STATUS.md:110`, `api/scripts/rules/engine.test.ts:2` |
| F-09 | Outbox (`ShiftSubmitJob`) had no idempotency guarantee — no unique constraint stopped duplicate submit jobs per shift | CLOSED | `SubmitJobStatus` enum + `@@unique([shiftId])`, `4de1ed8` | `DEVLOG.md:87`, `STATUS.md:109`, `api/prisma/schema.prisma:237` |
| F-10 | Default-deny route authentication — a route must be explicitly marked `public` or it's rejected; no registration path (including a child plugin) can accidentally bypass auth | CLOSED | Implemented `55ec542` (originally mislabeled `F-04` in that commit); numbering correction `b7157b6` | `CLAUDE.md:145`, `api/src/app.ts:29`, `api/src/lib/auth.ts:7`, `api/scripts/rules/routePatterns.ts:5` |
| F-11 | Same-company driver ownership/isolation — repository methods were scoped by `companyId` alone, so a second driver in the *same* company could reach another driver's shift by ID | CLOSED | `279004f`; originally mislabeled `F-03` in that commit, relabeled `F-11` during this register's construction | `api/src/tests/db/repositoryTenantBoundary.test.ts:78,195` |
| F-12 | *reserved, unassigned* | — | — | no reference anywhere in the tree or git history |
| F-13 | Docs (README, DEVLOG, STATUS) rewritten to match observed repo state rather than aspirational state | CLOSED | `4de1ed8` | `DEVLOG.md:74,103` |

## Known sub-issues tracked without their own ID

- **`routePatterns.ts` paren-depth matcher blind spot** (surfaced during F-10's adversarial review): the static `route-declares-auth` check can be defeated by an unbalanced `(` inside a string/template literal in a route handler, causing a false negative. Does **not** affect the actual runtime boundary (the `onRequest` hook in `app.ts`, which has no such gap). Recorded as a cleanup item in `STATUS.md`'s "Known limitations / cleanup backlog" section, not as a numbered finding.

## Gaps in numbering

- **F-12 is reserved and unused.** No occurrence anywhere in the current working tree or in any commit across the full `git log --all` history.
- **Informal items awaiting a formal ID** (not assigned here — to be numbered only after the STATUS.md accuracy pass, per plan): the unresolved `Shift.notes` / `ShiftSegment.notes` fields, `/health` readiness semantics, submission immutability, and general tooling-count drift (see the "STATUS.md accuracy" note in the Collision history below). None of these have repository evidence assigning them an ID today, so none appear in the table above.
- The audit source documents (`audits/phase-0-audit.md`, `audits/phase-0-fixes-review.md`) use their own independent numbering (`1.1`–`8.10`) and contain **zero** `F-XX` references. The `F-` numbering is an independently-assigned implementation-ticket scheme, not a restatement of the audit's own section numbers.

## Collision history (resolved)

### `F-03` — first migration vs. same-company isolation

`DEVLOG.md:121` closed `F-03` as the first Prisma migration (commit `4417f62`) — this is the **older, historical assignment and stays canonical.** A later commit, `279004f` ("fix: scope driver-facing repository access by company AND owning membership"), reused `F-03` in `api/src/tests/db/repositoryTenantBoundary.test.ts` for an unrelated finding: repository methods scoped by `companyId` alone allowed one driver to reach another driver's data *within the same company*. That was a numbering mistake, not two names for the same finding — a migration-generation task and a tenant-isolation security bug have nothing in common beyond sharing a label.

**Resolution applied in this pass:** `DEVLOG.md:121` was left untouched (historical record, and it was never wrong — it always meant the migration). The two live references in `api/src/tests/db/repositoryTenantBoundary.test.ts` (lines 78 and 195) that incorrectly reused `F-03` for the same-company-isolation finding were changed to `F-11`, a confirmed-unused ID. `F-11`'s finding is `CLOSED` — the fix already shipped in `279004f`; only the label was wrong. Verified after the rename: `tsc --noEmit` clean, `eslint .` clean, `git diff --check` clean (comment/test-description-only diff, no logic touched).

### `F-04` — test:db-in-check vs. default-deny routing

`STATUS.md:103` / `DEVLOG.md:139` close `F-04` as bringing the `test:db` suite inside `npm run check` (commit `d3648cd`) — this is the **canonical, correct meaning and stays `CLOSED`.** The phrase "F-04 closed pending a green run" was provisional wording at the time of that commit; the authoritative gate has since run green with `test:db` incorporated, and the DB/integrity suites have been re-run repeatedly during later foundation work, so this finding is not technically partial. The stale "not yet re-verified green" CI wording elsewhere in `STATUS.md` is a documentation-accuracy issue to be corrected in the upcoming STATUS.md accuracy pass — it is not evidence against `F-04`'s closure.

Separately, commit `55ec542` (this session) originally mislabeled the *default-deny routing* feature as `F-04`, colliding with the above. That was caught and corrected within the same session: commit `b7157b6` relabeled all 8 of those references to `F-10`. No working-tree file currently uses `F-04` for anything but the `test:db` finding.

### Why this matters going forward

Both collisions above share the same root cause: a later commit assigned "the next number" without checking this register (which didn't exist yet) for what was already taken. Now that `FINDINGS.md` is canonical, any new finding gets an ID from here first — `F-12` is confirmed free, and `F-14`+ remain unassigned pending the STATUS.md accuracy pass.
