-- Authorization roles are a closed database vocabulary. Auth middleware loads
-- this value on every protected request, so an unknown string must be rejected
-- before application code can interpret it inconsistently.

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('driver', 'admin');

-- AlterTable
-- The cast fails loudly if pre-existing data contains an unsupported role.
ALTER TABLE "CompanyMembership"
  ALTER COLUMN "role" DROP DEFAULT,
  ALTER COLUMN "role" TYPE "MembershipRole" USING ("role"::"MembershipRole"),
  ALTER COLUMN "role" SET DEFAULT 'driver';
