-- D66 (stage S1): a company's measurement units (D52).
--
-- ADDITIVE ONLY: two new enums and four nullable columns. No existing row is
-- changed and nothing is back-filled: a company — or a registration waiting
-- for its link — that existed before units has NONE until an administrator
-- chooses them (it is prompted), and nothing ever guesses one. New
-- registrations must choose both; the API, not a default, requires it, so a
-- registration already pending when this runs is never refused or blocked.

-- CreateEnum
CREATE TYPE "DistanceUnit" AS ENUM ('kilometre', 'mile');

-- CreateEnum
CREATE TYPE "VolumeUnit" AS ENUM ('litre', 'us_gallon', 'imperial_gallon');

ALTER TABLE "Company" ADD COLUMN "distanceUnit" "DistanceUnit";
ALTER TABLE "Company" ADD COLUMN "volumeUnit" "VolumeUnit";

ALTER TABLE "PendingCompanyRegistration" ADD COLUMN "distanceUnit" "DistanceUnit";
ALTER TABLE "PendingCompanyRegistration" ADD COLUMN "volumeUnit" "VolumeUnit";
