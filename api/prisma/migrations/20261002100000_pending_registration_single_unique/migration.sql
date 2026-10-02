-- Remove the redundant uniqueness index on PendingCompanyRegistration.
--
-- Migration 20261002090000 created TWO unique indexes that enforce the same
-- rule, "one pending registration per company account":
--
--   "PendingCompanyRegistration_userId_key"              (userId)       ← removed
--   "PendingCompanyRegistration_userId_accountKind_key"  (userId, accountKind)  ← kept
--
-- The composite one is kept because Prisma needs a unique key over the
-- relation's own fields to model the one-to-one relation to User (without it
-- the schema does not validate, P1012). It enforces the rule on its own: the
-- composite foreign key to User(id, accountKind) gives each userId exactly one
-- possible accountKind, so (userId, accountKind) is unique exactly when userId
-- is. Nothing else uses the removed index: no code queries this table yet,
-- and the foreign key references User's key, not this table's.
--
-- Drops an index only. No row is read, changed or removed.

-- DropIndex
DROP INDEX "PendingCompanyRegistration_userId_key";
