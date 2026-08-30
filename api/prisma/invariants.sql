-- Invariants that Prisma's schema language cannot express.
--
-- These are NOT applied by `prisma db push` or by `prisma generate`. They must
-- be appended by hand to the FIRST migration, and to any later migration that
-- recreates the objects they depend on. Until that migration exists, these
-- invariants are DESIGN INTENT and are not enforced anywhere.
--
-- Verify after applying:
--   \d+ "Shift"      -- the partial index should be listed

-- ─────────────────────────────────────────────────────────────────────────────
-- One open shift per user, across all companies
-- ─────────────────────────────────────────────────────────────────────────────
-- A driver has one body and one working day. Even holding memberships in several
-- haulage companies, he cannot be on shift for two of them at once.
--
-- Deliberately keyed on "userId" and NOT on ("userId", "companyId"): the point is
-- to make "which company is this shift for?" unanswerable-in-two-ways. AUTH.md
-- refuses a company switch while a shift is open, and that rule needs there to be
-- at most one open shift to reason about.
--
-- Postgres treats a partial index as covering only the matching rows, so any
-- number of CLOSED shifts per user is fine.
CREATE UNIQUE INDEX IF NOT EXISTS "Shift_one_open_per_user"
    ON "Shift" ("userId")
    WHERE "status" IN ('draft', 'active', 'finishing');
