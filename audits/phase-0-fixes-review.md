# Review of the Phase 0 audit-fix diff — read-only

*Second-agent adversarial review, 2026-08-25, of the staged (uncommitted) diff on top of `d8137c3`.*

**Nothing was fixed or committed.** These are findings. The reviewer ran the actual regexes, the real `@fastify/cors` v11 against each origin shape, zod 4.5, and drove Prisma 7's bundled WASM schema validator offline (the engine binary host is blocked, the WASM validator is not) with controls to prove the harness was real.

---

## Verdict on the four intended fixes

| Fix | Verdict |
|---|---|
| 1. `Session` in `GLOBAL_MODELS` | **Complete.** Correct entry and rationale. |
| 2. CORS hardening | **Partial.** `origin: true` is genuinely gone and `credentials: false` is right, but `WEB_ORIGIN="*"` still yields a real wildcard outside production, and fail-closed depends entirely on `NODE_ENV` being exactly `"production"`. |
| 3. `no-client-tenant` hardening | **Partial and net-negative in one respect.** Gained multi-line destructuring, **lost** `body.companyId`, and the catch-all blocks correct code. |
| 4. DB tenant integrity | **Complete on the schema** — validated with Prisma's own validator. **Incomplete around it**: no migration, no test of the guarantee, undocumented client-API change. |

## Two findings that were false — caused by stale staging

The reviewer only received the files that were staged for it. Two findings are artifacts of that, now verified directly on disk:

- **6.5 "test glob may not have landed"** — it did. `api/package.json:17` reads `$(find src scripts -name "*.test.ts")`.
- **8.5 "CI doesn't run eslint or prisma validate"** — it does. The workflow calls `npm run check`, which chains typecheck → lint → check:rules → validate:schema → knip → test.

*This is the second time an incomplete stage produced a false finding (the Phase 0 audit made the same mistake about lockfiles). **Fix the process: give the reviewer the whole tree or a git checkout, never a hand-picked subset.***

---

## Must address before committing — ranked

1. **`SAME_LINE` blocks correct code — HIGH.** `tenantPatterns.ts:25-30`. The comment claims "in a route handler there is no legitimate reason for those two things to meet." That premise is wrong. Verified blocked:
   - `return svc.list(auth.companyId, req.query.status);`
   - `app.log.info({ companyId: auth.companyId, path: req.params.id });`
   - `const { membershipId } = req.body; const companyId = auth.companyId;` ← the `switch-company` handler the carve-out existed to protect
   A rule that fires on the canonical correct pattern gets `rules-ignore`'d on sight, and then the guard is dead.

2. **Regression: `body.companyId` detection lost — HIGH.** `tenantPatterns.ts:15`. The old inline rule had a bare `\b(body|query|params)\s*\.\s*companyId\b` alternative. The new `REQUEST_SOURCE` requires a `req.`/`request.` prefix, so `const body = req.body; const companyId = body.companyId;` now passes. AUTH.md documents this as an "honest limitation" — but it was **not** a limitation before the diff. A detection was traded for a footnote.

3. **`WEB_ORIGIN="*"` produces a real wildcard outside production — HIGH.** `env.schema.ts:73-82`. `isValidProductionOrigin` runs only inside `superRefine`, which returns early when `NODE_ENV !== "production"`. So `allowedOrigins({ WEB_ORIGIN: "*", NODE_ENV: "development" })` returns `["*"]` — and the reviewer confirmed against the real plugin that `origin: ["*"]` emits `Access-Control-Allow-Origin: *`, not an exact-match no-op. The function's own docstring says "Never returns `*`". It is false. Staging boxes hold real data.

4. **`CLAUDE.md:167-169` now contradicts AUTH.md and the code — HIGH.** It still claims a route reading `companyId`/`membershipId`/`userId` fails the build. Only `companyId` does now, deliberately. This is in the file marked "read this first, every session" and it breaks the repo's own rule (`CLAUDE.md:122`: "If a doc contradicts the code, the doc is wrong. Fix the doc in the same session.").

5. **The tests cannot detect the regression they exist to prevent — HIGH.** All 11 `CAUGHT` cases match `SAME_LINE` alone; `DIRECT` and `DESTRUCTURE` could both be deleted and the suite stays green. And `ALLOWED` contains no case where `companyId` and a request source appear on the same line — the entire false-positive class the design creates is untested, which is why finding 1 shipped.

6. **Require `WEB_ORIGIN` unless `NODE_ENV` is explicitly development/test — MEDIUM-HIGH.** `env.schema.ts:25`. `NODE_ENV` defaults to `"development"`, so a production deploy that forgets to set it gets no `WEB_ORIGIN` requirement, a localhost allowlist, and dev logging. Invert so the safe branch is the fallback.

7. **Add the two missing proofs — MEDIUM.** (a) An `app.inject()` test that a foreign `Origin` receives no `Access-Control-Allow-Origin` — every CORS assertion is currently at the schema layer, nothing tests the wiring. (b) A database test that a `ShiftSegment` with a mismatched `companyId` is rejected — the strongest claim in the diff ("the DATABASE guarantees…") has zero automated proof, and CI already runs Postgres.

8. **`rules-ignore` doesn't work for the new multi-line check — MEDIUM.** `check-rules.ts:189-200`. The documented escape hatch is unsupported there, and a JSDoc containing the canonical bad example produces an unsilenceable false positive.

9. **`stripComments` truncates at `//` inside strings — MEDIUM.** `tenantPatterns.ts:33`. `const doc = "see https://wiki/x"; const companyId = req.body.companyId;` is a verified miss. Inherited by four other rules.

10. **Reject wildcard hosts in `isValidProductionOrigin` — MEDIUM.** `https://*.example.com` validates, then matches nothing. Production starts cleanly and all browser traffic breaks with nothing pointing at the config — and the fastest fix under pressure is `origin: true`.

11. **Generate the first migration — MEDIUM.** No `prisma/migrations` exists. On a fresh DB this is a plain `CREATE TABLE`, nothing dangerous. Against a developer's already-pushed database, the `ADD CONSTRAINT` validates every row and aborts with a raw Postgres error if any segment's `companyId` disagrees with its shift's — correct, but with no repair path offered.

12. **Other verified bypasses to document or close — MEDIUM.** `req["body"].companyId`; a handler parameter not named `req`/`request`; nested multi-line destructure (`{ filters: { companyId } }` — `[^{}]*` cannot cross a brace, yet AUTH.md claims multi-line is caught); and structurally the largest: `svc.list(auth, req.body)` where the **service** reads `companyId` — services are scanned by no rule at all, and `no-prisma-in-routes` actively pushes work into them.

---

## Confirmed correct

- **The Prisma schema is valid Prisma 7.** Verified with the real validator: `@@unique([id, companyId])` plus composite `references: [id, companyId]` works, and the control (removing the `@@unique`) produces exactly the expected `P1012`.
- **Referential integrity survives removing the direct `Company` relations.** The composite FK requires `(shiftId, companyId)` to exist in `Shift`, and `Shift.companyId` still FKs to `Company` under `Restrict`. Nothing was lost.
- **`credentials: false` is right** — Bearer tokens in browser storage, no ambient credential to protect.
- **`superRefine` is the correct hook** — in zod 4 it still runs when field-level validation has already produced issues, so `describeEnvFailure` reports everything at once.
- **No catastrophic backtracking** in any pattern (measured).
- Side benefit worth keeping: the new `@@unique` gives services a tenant-safe primitive, `findUnique({ where: { id_companyId: { id, companyId } } })`.

## Noted, lower priority

- `GLOBAL_MODELS` keys on the exact name `"Session"`; `model AuthSession` re-arms the trap.
- Check numbering in `check-rules.ts` is now inconsistent (0–8, two unnumbered, then 9); `STATUS.md` says "10 checks", the real count is 12.
- The multi-line reporter prints a description where every other rule prints the offending source line.
- `isValidProductionOrigin` rejects `https://A.Example.COM`, `HTTPS://…` and `https://host:443` — all fail *closed*, but the error message doesn't explain why.
- CORS is not an authorization mechanism: a disallowed origin still gets `200` and the handler still runs; the browser just withholds the body. Harmless under Bearer auth, but don't describe it as access control.
