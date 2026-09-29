/**
 * Test helper: the stored identity (`useId`) of the vehicle or trailer use
 * that STARTED at an instant — read from the files as stored, the open day
 * and every finished day, never from the store's own readers.
 *
 * Tests name uses by the instant they wrote them at; the store names them by
 * `useId` (D42). This bridges the two WITHOUT letting identity follow
 * `startedAt`: it resolves once, from what is stored — the open day first,
 * then the finished days — and fails loudly when the instant names more than
 * one use there. A use written without a `useId` (a
 * legacy fixture) resolves to its legacy identity; an instant naming no use
 * resolves to the legacy identity it would have, which names nothing stored.
 */
import { Directory, File, Paths } from "expo-file-system";
import { COMPLETED_SHIFT_FILE_PREFIX, OPEN_SHIFT_FILE } from "../shift/localShift";
import { legacyUseId, type UseKind } from "../shift/useIdentity";

function storedDays(names: readonly string[]): Record<string, unknown>[] {
  const days: Record<string, unknown>[] = [];
  for (const name of names) {
    const file = new File(Paths.document, name);
    if (!file.exists) continue;
    try {
      const parsed: unknown = JSON.parse(file.textSync());
      if (typeof parsed === "object" && parsed !== null) days.push(parsed as Record<string, unknown>);
    } catch {
      // Not a day this helper can read — a test's deliberately damaged file.
      continue;
    }
  }
  return days;
}

function usesOf(day: Record<string, unknown>, kind: UseKind): Record<string, unknown>[] {
  const current = day[kind];
  const previous = day[kind === "vehicle" ? "previousVehicles" : "previousTrailers"];
  const earlier: unknown[] = Array.isArray(previous) ? previous : [];
  const all = [current, ...earlier];
  return all.filter((use): use is Record<string, unknown> => typeof use === "object" && use !== null);
}

function idsAt(names: readonly string[], kind: UseKind, startedAt: string): Set<string> {
  const ids = new Set<string>();
  for (const day of storedDays(names)) {
    for (const use of usesOf(day, kind)) {
      if (use["startedAt"] !== startedAt) continue;
      const id = use["useId"];
      ids.add(typeof id === "string" ? id : legacyUseId(kind, startedAt));
    }
  }
  return ids;
}

/** The open day first — the day a test is working on — then the finished days. */
function useIdAt(kind: UseKind, startedAt: string): string {
  const open = idsAt([OPEN_SHIFT_FILE], kind, startedAt);
  const finished = new Directory(Paths.document).list().map(entry => entry.name).filter(name => name.startsWith(COMPLETED_SHIFT_FILE_PREFIX));
  const ids = open.size > 0 ? open : idsAt(finished, kind, startedAt);
  if (ids.size > 1) throw new Error(`useIdAt: ${String(ids.size)} ${kind} uses started at ${startedAt} — name the use by its useId`);
  return [...ids][0] ?? legacyUseId(kind, startedAt);
}

/** The stored `useId` of the vehicle use that started at `startedAt`. */
export const vehicleUseAt = (startedAt: string): string => useIdAt("vehicle", startedAt);

/** The stored `useId` of the trailer use that started at `startedAt`. */
export const trailerUseAt = (startedAt: string): string => useIdAt("trailer", startedAt);

/** Any stored `useId` — for a use created in the test, whose id is fresh and unknown to it. */
export const ANY_USE_ID: unknown = expect.any(String);
