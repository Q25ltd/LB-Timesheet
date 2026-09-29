/**
 * A vehicle or trailer use's IDENTITY (D42) — immutable, and separate from
 * when the use started.
 *
 * A use is created with a fresh `useId` (`newLocalId`), and that id names it
 * for good: correcting its start or end time, its plate or trailer number,
 * or anything else about it never changes it. Every exact-use operation —
 * fills, mileage, checks, names, times — finds the use by it; never by plate,
 * trailer number, position or time.
 *
 * A use stored before ids existed has none. It is read under an id derived
 * from what identified it then — its kind and its start — which is unique
 * within its day (no two uses of a kind share a start) and the same on every
 * read. The first time the day is saved again, that id is written out and
 * from then on it is the use's id, whatever its start becomes.
 */
export type UseKind = "vehicle" | "trailer";

export function legacyUseId(kind: UseKind, startedAt: string): string {
  return `legacy-${kind}-${startedAt}`;
}

/** A stored `useId`, or — for a use stored before ids existed — its derived one; `null` when present but unusable. */
export function readUseId(value: unknown, kind: UseKind, startedAt: string): string | null {
  if (value === undefined) return legacyUseId(kind, startedAt);
  return typeof value === "string" && value !== "" && value.length <= 64 ? value : null;
}
