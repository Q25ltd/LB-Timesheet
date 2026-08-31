# LogisticBay Timesheets — Coding Agent Operating Contract

> **This file owns the agent process only.** It does not restate product scope,
> code rules, architecture, authentication or project state. Those are owned
> elsewhere and are cross-referenced, never rephrased.
>
> Read `CLAUDE.md` first, then this file, every session.

---

## How to read this document

| Word | Meaning |
|---|---|
| **MUST** | Required. Not doing it is a process failure, regardless of outcome. |
| **MUST NOT** | Prohibited. No task-level convenience overrides it. |
| **STOP** | End the action, report, and wait for an owner decision. Do not proceed to the next logical step. |

A rule with an owner elsewhere appears here **only** as a pointer. If you are
about to explain such a rule in your own words, you are creating a second
version of it — read the owning document instead.

## Document ownership

| Subject | Owner | This file's role |
|---|---|---|
| Product scope, what may be built | `PRODUCT.md`, and `CLAUDE.md`'s feature test | none |
| Repository identity, which repo you are in | `CLAUDE.md` | require the check (§2) |
| Code rules, architecture, security mechanisms, the authoritative gate | `CLAUDE.md` | require the check (§12), never restate |
| Authentication, tokens, tenant context | `AUTH.md` (frozen) | require review before change (§15) |
| Decisions, open questions, evidence layering (D16) | `DECISIONS.md` | require compliance (§11) |
| Finding IDs and their status | `FINDINGS.md` | prohibit invention (§19) |
| What is currently built | `STATUS.md` | prohibit competing vocabulary (§18) |
| Historical record | `DEVLOG.md` | prohibit unauthorized edits (§18) |

The repository is the durable project memory. Agent conversation history is not
authoritative.

---

# Part A — Authority

## 1. Authority hierarchy

When determining what is true, or what may be changed:

1. Explicit current task authorization from the project owner
2. Frozen contracts and settled decisions
3. Current repository implementation — code, schema, migrations
4. Executable tests and database constraints
5. `STATUS.md`
6. `FINDINGS.md`
7. `DEVLOG.md`
8. Agent conversation history
9. Agent assumptions

If two authoritative sources contradict each other you **MUST STOP**. Report the
contradiction, the exact evidence, why it matters, and the options — including
doing nothing.

You **MUST NOT** write a resolution, apply one, or record one in any document
before the owner has decided. Reporting a conflict and then acting on your own
answer is not compliance with this rule.

## 2. Baseline verification

A fresh agent **MUST NOT** trust cached repository state, another agent's
description of the repository, or the assumption that discussed work was
implemented, or that local work exists on the remote.

At the start of every phase, handover or session, you **MUST** verify, in order:

1. the required Node version is active (`.nvmrc`)
2. the repository path — `CLAUDE.md` owns which repository is correct and which
   is not; follow it
3. the branch
4. local `HEAD`
5. the cached remote reference
6. the **live** remote reference, queried from the remote
7. a clean working tree

Then perform `CLAUDE.md`'s session-start checklist. Verification establishes
*where* you are; the checklist establishes *what is there*. Both are required.

Git and the live remote are the authority for baseline identity. Project
documentation **MUST NOT** be treated as evidence of the current HEAD.

If any required reference does not match the expected baseline: **STOP.** You
**MUST NOT** pull, reset, checkout, stash, clean or otherwise repair the
checkout. Report the discrepancy.

## 3. Scope is authorization

The task defines the authorized scope.

You **MUST NOT** widen it because another improvement looks useful, nearby code
is untidy, documentation is stale, a dependency could be upgraded, another test
would be interesting, a security issue looks fixable, or refactoring would make
implementation easier.

Work found outside scope is reported (§19), not performed.

`CLAUDE.md`'s feature test decides whether something belongs in this *product*.
This rule decides whether it belongs in this *task*. Both must pass.

## 4. No silent assumptions

If the work requires a product, security, data-model or architecture decision
that has not been made, you **MUST NOT** decide it.

Report: the problem · why it matters · realistic options · trade-offs · your
recommendation · the option to defer where legitimate. Then wait.

An agent recommendation is not a project decision. Only the owner converts one
(§5). `DECISIONS.md` owns which questions are settled and which are open.

## 5. The owner decision gate

The agent proposes and implements within authorization. The owner decides
whether to accept a design · proceed from RED to GREEN · accept GREEN · run the
full gate · commit · remediate a finding · alter architecture · change frozen
behaviour · change documentation · proceed to the next boundary.

You **MUST NOT** collapse these gates because the next action appears obvious.

## 6. STOP means STOP

On STOP you **MUST NOT**: continue to the next logical task · tidy nearby files
· update documentation · commit · push · fix newly discovered issues · begin
exploratory implementation.

Return the requested report and wait.

---

# Part B — How work is done

## 7. The smallest correct boundary

You **MUST** prefer one independently provable invariant over a subsystem.

```
invariant → RED → review → minimal GREEN → targeted verification
→ full gate → scope inspection → commit → push → live remote verification → STOP
```

Insufficient boundaries: "build authentication", "implement offline mode",
"build submissions", "secure the API".

Sufficient boundaries: one persistence invariant · one authorization boundary ·
one state transition · one recovery guarantee · one submission-integrity
guarantee.

Small boundaries improve reviewability, rollback, debugging, security analysis
and attribution of failures.

## 8. RED before GREEN

For security, tenant-isolation, authorization, persistence, state-machine and
data-integrity work you **MUST** establish an honest failing proof before
implementing, whenever practical. RED must demonstrate the guarantee is
genuinely absent.

You **MUST NOT** manufacture RED through broken imports, syntax errors, wrong
configuration, unrelated failures or deliberately invalid setup.

Where the missing implementation prevents runtime tests from executing, use the
smallest honest compile, schema or runtime proof for the missing layer, and
state exactly why RED occurs.

You **MUST NOT** begin GREEN before the owner authorizes it (§5).

## 9. Tests are evidence

A test **MUST** prove an invariant or a behaviour. You **MUST NOT** add tests to
raise a count.

Prefer testing externally observable behaviour · database guarantees ·
authorization boundaries · state transitions · failure behaviour · adversarial
input.

Security and data-integrity tests **MUST** assert precisely — exact HTTP status,
stable application error code, PostgreSQL SQLSTATE, row count, persisted state,
or absence of unauthorized mutation. They **MUST NOT** assert on human-readable
message text.

## 10. Never weaken a test to obtain GREEN

You **MUST NOT** delete, skip, broaden or soften a failing test, and **MUST
NOT** change an expectation merely to match the implementation.

You **MUST** first establish which is true: the implementation is wrong · the
test's assumption is wrong · the tooling represents the failure differently than
expected · the contract is ambiguous.

If the test itself is wrong, present the evidence before changing it. A
corrected test **MUST** prove the same invariant at least as strongly.

## 11. What counts as proof

`DECISIONS.md` **D16** owns evidence layering — which mechanisms carry a
guarantee and which only raise the cost of mistakes. Comply with it. Do not
restate it here, and do not construct a second ranking of evidence.

The process consequences:

- Agent reasoning, and an agent's own assertion that work succeeded, **MUST
  NOT** be offered as proof of anything.
- Every claim in a report **MUST** identify the actual executable or structural
  evidence supporting it — the test, the constraint, the command and its result.
- A claim **MUST NOT** exceed what that evidence proves. A green suite proves
  only the operations it exercises; you **MUST NOT** write "secure", "fully
  protected", "production safe" or "all edge cases covered" because tests
  passed.

## 12. The authoritative gate

`CLAUDE.md` owns the gate and what it runs.

Order of work: targeted RED → minimal implementation → targeted GREEN → relevant
regression tests → **full gate** → diff and scope inspection.

The full gate **MUST NOT** be used as a substitute for targeted diagnosis. If it
fails: **STOP**, report the failing stage and the evidence. You **MUST NOT**
automatically fix unrelated failures.

## 13. Inspect the actual diff

`git diff --stat` omits untracked files, so it is not sufficient.

Before commit you **MUST** inspect tracked modifications · staged changes ·
untracked files · generated files · migrations · lockfiles · configuration ·
documentation, and run `git diff --check`. Only authorized files may be staged.

## 14. Commit boundaries

Prefer atomic commits, each answering: *what single guarantee or project-state
change became true here?*

You **MUST NOT** combine unrelated refactors, documentation changes, dependency
upgrades, formatting, findings remediation and new features in one commit.
`CLAUDE.md` owns the one required exception, where a created file must be
registered in the same commit.

After an authorized commit: push, then verify local `HEAD`, the cached remote,
the live remote and a clean tree. Then **STOP** unless the next task was
explicitly authorized.

---

# Part C — Boundaries

## 15. Substantive contracts are owned elsewhere

`CLAUDE.md` and `AUTH.md` own the tenant-scoping rules, the default-deny route
mechanism, the error envelope, dependency rules, and the code rules generally.
`PRODUCT.md` and `CLAUDE.md`'s feature test own product scope. `AUTH.md` is
frozen. `DECISIONS.md` §Settled is settled.

This file adds only the process consequences:

- You **MUST NOT** route around an existing enforced boundary — a tenant-safe
  repository, an authentication mechanism, an environment guard — to make a
  task, a test or local development easier.
- You **MUST NOT** create an alternative path to the same authority casually.
- Prefer structural prevention over instruction: a constraint, a scoped
  credential, middleware or environment isolation over "remember not to".
  Assume humans and agents both eventually make mistakes.
- Any change to route protection, authentication bypass, tenant derivation,
  authorization context or public-route declaration requires explicit security
  review (§20) before it lands.
- A frozen contract may be challenged **only** by identifying a concrete
  security flaw, contradiction, impossibility, data-integrity problem,
  regulatory problem or requirement conflict — and then you **MUST STOP** and
  report. You **MUST NOT** silently redesign around it.
- You **MUST NOT** add or upgrade a dependency without task relevance and
  authorization.

## 16. Production authority

You **MUST NOT** modify production data, point development tooling at a
production database, run destructive production commands, alter production
infrastructure, expose production secrets, or test destructive behaviour against
production.

Use local and test environments. Where a script already guards its own
environment, you **MUST NOT** loosen that guard to make a task easier.

A task genuinely requiring production access is a separate, explicitly
authorized operation.

## 17. Migrations

Treat migrations as irreversible-risk artifacts even where rollback is
technically possible.

- You **MUST NOT** modify an already-landed migration without explicit
  authorization.
- New schema changes **MUST** get new migrations.
- Migrations **MUST** be verified against a clean database.
- A clean-install verification proves clean installation only. It does **not**
  prove safe upgrade of an existing populated database. State which one you
  proved.
- Before adding a constraint, consider existing data · migration safety ·
  concurrency · legitimate states · rollback.

## 18. Documentation authority

Documentation is a repository change and carries no special permission.

**Documentation changes require explicit authorization, like any other
repository change.** If your work makes `STATUS.md`, `DEVLOG.md`,
`DECISIONS.md`, `FINDINGS.md` or any other document stale, you **MUST** report
exactly what needs reconciliation, and you **MUST NOT** modify it unless the
current task authorizes that documentation change. An explicit STOP means no
documentation changes at all.

There are no automatic documentation updates and no automatic docs-only commits.

**Status vocabulary.** `STATUS.md` owns the only status vocabulary in this
project: ✅ done · 🔶 partial · 🔲 not started. You **MUST NOT** introduce a
parallel or additional set of formal status states. Evidence, stubs, deferred
work and missing behaviour are explained in prose, and prose **MUST** be precise
and under-claiming.

**Documentation is not implementation.** A document, a schema field, a database
table or a planned endpoint is not proof that behaviour exists. When reporting
state, cite the artifact that proves it (§11).

Historical records are corrected transparently when authorized, never silently
rewritten.

## 19. Findings

On discovering a potential issue you **MUST NOT** fix it. Report: finding ·
severity and impact · evidence · reproduction where appropriate · options ·
recommendation. Then wait.

`FINDINGS.md` owns every finding ID and its status. You **MUST NOT** invent,
assign or reuse a finding ID. Planned implementation work is not a finding.

---

# Part D — Roles and reporting

## 20. Builder and reviewer are different roles

An agent that implements a security-sensitive boundary is not sufficient
independent validation of its own work.

```
build agent   → implements authorized boundary → proves tests/gate → commit → push
review agent  → attacks the exact committed baseline → reports → does NOT repair
build agent   → if authorized: reproduces, fixes minimally, verifies
review agent  → retests
```

A review agent **MUST** remain read-only unless remediation authority is
explicitly granted, **MUST** treat implementation claims as hypotheses, **MUST**
attempt to falsify the intended guarantees, and **MUST NOT** modify evidence.

## 21. One implementation agent at a time

Only one agent holds implementation authority over the repository at a time. Two
build agents **MUST NOT** modify the same branch or worktree concurrently.
Parallel read-only analysis is permitted; its findings **MUST** be reconciled
before implementation begins.

## 22. Reporting

Reports **MUST** be factual and auditable: files changed · commands run · exact
relevant results · test counts · migration state · scope inspection · git status
· unresolved issues.

You **MUST** separate **observed fact**, **inference** and **recommendation**.

You **MUST NOT** describe work as complete when part of it is implemented, and
**MUST NOT** claim a verification you did not run.

---

# Part E — Process invariants for future subsystems

These do not design the subsystems. They state what the process requires before
one may be built.

## 23. Offline behaviour

"Retry the API" is not a design. Before offline work begins you **MUST**
explicitly reason about local authoritative in-progress state · restart recovery
· queued operations · idempotency · duplicate submission · ordering · conflict
behaviour · server acknowledgement · a crash between the local and server
transitions.

Offline behaviour **MUST** receive its own invariants and its own tests.

## 24. Submission immutability

When submission is built you **MUST** define and prove the exact transition from
editable work to immutable submitted record, covering idempotency · duplicate
requests · retries · outbox behaviour · generation failure · delivery failure ·
recovery after partial failure.

Delivery success **MUST NOT** be treated as evidence that the submission was
safely persisted.

## 25. No throwaway and no speculative architecture

Small scope does not license fake implementation. You **MUST NOT** build mock or
temporary architecture that must obviously be torn out when the next planned
boundary starts. Build the smallest production-quality slice compatible with the
known direction.

Equally, you **MUST NOT** introduce infrastructure the requirements do not
justify. Simple is not weak: strength comes from constraints and clean
boundaries, not machinery.

## 26. Core principle

AI-generated code is not trusted because it looks correct. It earns trust
through constrained scope and independent evidence.

For every boundary: **What must be true? What proves it? What is the smallest
change that makes it true?** Then verify nothing else changed.

Speed is useful. Correctness, security, data integrity, recoverability and
maintainability come first.

---

## Standard new-agent handover

1. Read `CLAUDE.md`, then this file.
2. Complete baseline verification (§2), including `CLAUDE.md`'s session-start
   checklist.
3. Read the contract that owns the subsystem in hand.
4. Inspect the existing implementation for the assigned boundary.
5. Report any discrepancy before modifying anything.
6. Perform only the explicitly authorized task.
7. Stop at the requested decision gate.

## Standard security-agent handover

1. Verify the exact committed baseline (§2).
2. Remain read-only unless remediation authority is explicitly granted.
3. Treat implementation claims as hypotheses; attempt to falsify them.
4. Reproduce findings precisely; do not modify evidence.
5. Distinguish exploitable defects from theoretical concerns.
6. Report for the owner's decision (§19 — no new finding IDs).
7. Stop.

---

## Final rule

When uncertain whether an action is authorized, you **MUST NOT** perform it.
Report the uncertainty and ask for a decision.
