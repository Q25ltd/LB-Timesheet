/**
 * Which uses of a day have no COMPLETED check — the one answer both Finish
 * Shift warnings give (D38): before the Finish flow opens, and on its Review.
 *
 * Every use counts, current and ended, vehicle and trailer, each judged by its
 * own checks and named by its own identity — so the same plate or trailer used
 * twice is two uses, and one being checked says nothing about the other. A
 * completed check counts whether or not it was later corrected; a draft is
 * not a completed check. A day that used nothing has nothing to warn about.
 *
 * It only reads. Nothing here completes, fills in or defaults a check.
 */
import type { CompletedShift, LocalShift } from "./localShift";
import { checkStateOf, type VehicleCheck } from "./vehicleCheck";

export interface UncheckedUse {
  asset: "vehicle" | "trailer";
  /** The use's identity (D42). */
  useId: string;
  /** When it began — to tell apart two uses of one name. */
  startedAt: string;
  /** What the driver knows it by: the plate, or "trailer" and its number. */
  name: string;
}

interface Use {
  useId: string;
  startedAt: string;
  checks: readonly VehicleCheck[];
}

export function usesWithoutCompletedCheck(day: LocalShift | CompletedShift): UncheckedUse[] {
  const vehicles: (Use & { numberPlate: string })[] = [...day.previousVehicles];
  const trailers: (Use & { trailerNumber: string })[] = [...day.previousTrailers];
  // An open day also has what is in use now; a finished day has ended it.
  if ("vehicle" in day && day.vehicle !== null) vehicles.push(day.vehicle);
  if ("trailer" in day && day.trailer !== null) trailers.push(day.trailer);
  return [
    ...vehicles.filter(unchecked).map(use => ({ asset: "vehicle" as const, useId: use.useId, startedAt: use.startedAt, name: use.numberPlate })),
    ...trailers.filter(unchecked).map(use => ({ asset: "trailer" as const, useId: use.useId, startedAt: use.startedAt, name: `trailer ${use.trailerNumber}` })),
  ];
}

function unchecked(use: Use): boolean {
  return checkStateOf(use.checks) !== "completed";
}
