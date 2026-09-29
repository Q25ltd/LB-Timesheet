/**
 * The Correct number plate / trailer number route. Wiring only.
 *
 * A Stack sibling of the tab group. Opened with `asset`, `usage` (the use's
 * `useId`) and `usageState` — from Active Shift's cards for the use in
 * use, or from a Vehicle Use / Trailer Use page for an ended one, with
 * `timesheet` naming a finished day (D40). The use is found by its identity,
 * never by the name being corrected; one that cannot be found is not shown,
 * and a save that finds it changed writes nothing and says so.
 */
import { useEffect, useState } from "react";
import { Alert } from "react-native";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { CorrectNameScreen } from "../../src/screens/CorrectNameScreen";
import { Restoring } from "../../src/components/Restoring";
import { saveFailureMessage } from "../../src/screens/format";
import { backToDay, leaveStale, missingHref, readScreenDay } from "../../src/navigation/useScreenDay";
import { USAGE_STATE, correctNumberPlate, correctTrailerNumber, type LocalShift, type UsageState } from "../../src/shift/localShift";

export default function CorrectNameRoute() {
  const { asset, usage, usageState, timesheet, via } = useLocalSearchParams<{ asset?: string; usage?: string; usageState?: string; timesheet?: string; via?: string }>();
  const [shift, setShift] = useState<LocalShift | null | "loading">("loading");

  useEffect(() => {
    let cancelled = false;
    void readScreenDay(timesheet).then(open => { if (!cancelled) setShift(open); });
    return () => { cancelled = true; };
  }, [timesheet]);

  if (shift === "loading") return <Restoring message="Loading shift…" />;
  if (shift === null) return <Redirect href={missingHref(timesheet, false)} />;
  const kind = asset === "vehicle" || asset === "trailer" ? asset : null;
  const state = Object.values(USAGE_STATE).find(entry => entry === usageState) ?? null;
  const current = kind === null || state === null || usage === undefined ? null : nameOf(shift, kind, usage, state);
  if (kind === null || state === null || usage === undefined || current === null) return <Redirect href={missingHref(timesheet, true)} />;

  return (
    <CorrectNameScreen
      asset={kind}
      current={current}
      onLeave={() => { router.back(); }}
      onSave={value => save(kind, { shiftId: shift.id, useId: usage, usageState: state, value }, timesheet, via)}
    />
  );
}

/** The name of EXACTLY the use named, in the state named — or `null`. */
function nameOf(shift: LocalShift, asset: "vehicle" | "trailer", usage: string, state: UsageState): string | null {
  if (asset === "vehicle") {
    if (state === USAGE_STATE.inUse) return shift.vehicle !== null && shift.vehicle.useId === usage ? shift.vehicle.numberPlate : null;
    return shift.previousVehicles.find(use => use.useId === usage)?.numberPlate ?? null;
  }
  if (state === USAGE_STATE.inUse) return shift.trailer !== null && shift.trailer.useId === usage ? shift.trailer.trailerNumber : null;
  return shift.previousTrailers.find(use => use.useId === usage)?.trailerNumber ?? null;
}

async function save(
  asset: "vehicle" | "trailer",
  input: { shiftId: string; useId: string; usageState: UsageState; value: string },
  timesheet: string | undefined,
  via: string | undefined,
): Promise<void> {
  try {
    const correct = asset === "vehicle" ? correctNumberPlate : correctTrailerNumber;
    const day = await correct(input);
    if (day === null) {
      Alert.alert("Nothing was saved", asset === "vehicle" ? "That vehicle is no longer the one this was opened for." : "That trailer is no longer the one this was opened for.");
      leaveStale(timesheet);
      return;
    }
    // Back where it was opened from: the day's card, or the use's own page.
    if (input.usageState === USAGE_STATE.inUse) backToDay(via);
    else router.back();
  } catch (error: unknown) {
    Alert.alert("Couldn't save that", saveFailureMessage(error));
    throw error;
  }
}
