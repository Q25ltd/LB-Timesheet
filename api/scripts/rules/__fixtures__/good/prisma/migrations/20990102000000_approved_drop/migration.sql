-- migration-destructive-approved: owner approved 2099-01-02; step 2 of 2, no deployed version reads "legacy" since step 1
ALTER TABLE "User" DROP COLUMN "legacy";
