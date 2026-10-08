-- A later migration that removes what the running version still reads.
ALTER TABLE "User" ADD COLUMN "nickname" TEXT;
ALTER TABLE "User" DROP COLUMN "name";
