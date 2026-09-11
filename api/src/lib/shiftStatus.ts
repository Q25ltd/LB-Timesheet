/**
 * The ONE registry of Shift status values (CLAUDE.md, "one status string
 * registry").
 *
 * `ShiftStatus` itself is the Prisma enum — the canonical vocabulary. What
 * needs a name here is the SUBSET that means "this shift is still open", and
 * it needs exactly one definition because two places now depend on it:
 *
 *   - `startShiftRepository.findOpen` — the driver's own recovery read;
 *   - the cross-company open-shift guard on company selection.
 *
 * The set is also the predicate of the `Shift_one_open_per_user` partial
 * unique index (`prisma/invariants.sql`). If these ever disagreed, the
 * database would permit a second "open" shift the application considered
 * impossible — so this list and that index are one fact and must be changed
 * together.
 */
import type { ShiftStatus } from "../generated/enums.js";

export const OPEN_SHIFT_STATUSES: readonly ShiftStatus[] = ["draft", "active", "finishing"];
