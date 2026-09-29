/**
 * WHY a vehicle or trailer use ended — recorded only where it matters (D40).
 *
 * A use ended by the day's Finish Shift carries `endedBy: "finish"`: its end
 * belongs to that finish, so a later correction of the finish moves it too.
 * Every other end — Change Unit / Vehicle, No vehicle, Change Trailer, No
 * trailer — carries nothing, and so does every use finished before this was
 * recorded. Those ends are the driver's own act, or cannot be proved not to
 * be, and a finish correction never moves them. Equal times are never taken
 * as proof: a use may have been handed back at the very minute the day ended.
 */
export const USE_ENDED_BY = { finish: "finish" } as const;

export type UseEndedBy = (typeof USE_ENDED_BY)[keyof typeof USE_ENDED_BY];

/** A stored `endedBy`: `undefined` when absent, `null` when present but not one this app writes. */
export function asUseEndedBy(value: unknown): UseEndedBy | undefined | null {
  if (value === undefined) return undefined;
  return value === USE_ENDED_BY.finish ? USE_ENDED_BY.finish : null;
}
