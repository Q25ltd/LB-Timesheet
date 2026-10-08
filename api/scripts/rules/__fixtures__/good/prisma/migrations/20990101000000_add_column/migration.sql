-- Additive: a new nullable column. The previous version simply ignores it.
ALTER TABLE "User" ADD COLUMN "nickname" TEXT;
CREATE INDEX "User_nickname_idx" ON "User"("nickname");
