/**
 * The Trailer Use route — one ENDED trailer use, to read and correct. Wiring
 * only.
 *
 * Opened from a USED THIS SHIFT → TRAILERS row with `usage`, the use's
 * `useId` — its identity, and the only thing that names it (D42). Never a
 * trailer number: a day may hold TR23 twice, and they are two records.
 *
 * A `usage` that names no ENDED trailer use of the open day is not a screen —
 * it goes back to Active Shift rather than showing, or correcting, another
 * use or the trailer in use. With no open day it goes Home.
 *
 * Re-read on every return, so a forgotten check completed or fridge diesel
 * corrected on the screen above shows here at once.
 */
import { useCallback, useState } from "react";
import { Alert } from "react-native";
import { Redirect, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { TrailerUsageScreen } from "../../src/screens/TrailerUsageScreen";
import { Restoring } from "../../src/components/Restoring";
import { USAGE_STATE, UseTimesError, correctTrailerUseTimes, type LocalShift, type UsageState } from "../../src/shift/localShift";
import { leaveStale, missingHref, readScreenDay, withTimesheet, withVia } from "../../src/navigation/useScreenDay";
import { useTimesMessage, type UseTimes } from "../../src/screens/UseTimesEditor";
import { saveFailureMessage } from "../../src/screens/format";

export default function TrailerUsageRoute() {
  const { usage, usageState, timesheet, via } = useLocalSearchParams<{ usage?: string; usageState?: string; timesheet?: string; via?: string }>();
  // Ended unless named otherwise: the trailer IN USE is opened from the Finish Review (D41).
  const state: UsageState = usageState === USAGE_STATE.inUse ? USAGE_STATE.inUse : USAGE_STATE.ended;
  const [shift, setShift] = useState<LocalShift | null | "loading">("loading");

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void readScreenDay(timesheet).then(open => { if (!cancelled) setShift(open); });
      return () => { cancelled = true; };
    }, [timesheet]),
  );

  if (shift === "loading") return <Restoring message="Loading shift…" />;
  if (shift === null) return <Redirect href={missingHref(timesheet, false)} />;

  const use = usage === undefined
    ? undefined
    : state === USAGE_STATE.inUse
      ? (shift.trailer !== null && shift.trailer.useId === usage ? shift.trailer : undefined)
      : shift.previousTrailers.find(entry => entry.useId === usage);
  if (use === undefined) return <Redirect href={missingHref(timesheet, true)} />;

  const named = withVia(withTimesheet({ trailer: use.useId, usageState: state }, timesheet), via);
  return (
    <TrailerUsageScreen
      use={use}
      onLeave={() => { router.back(); }}
      onTrailerChecks={() => { router.push({ pathname: "/trailer-check", params: named }); }}
      onFridgeDiesel={() => { router.push({ pathname: "/trailer-diesel", params: named }); }}
      onCorrectNumber={() => {
        router.push({ pathname: "/correct-name", params: withVia(withTimesheet({ asset: "trailer", usage: use.useId, usageState: state }, timesheet), via) });
      }}
      onSaveTimes={times => saveTimes({ shiftId: shift.id, useId: use.useId, usageState: state, ...times }, setShift, timesheet)}
    />
  );
}

async function saveTimes(
  input: { shiftId: string; useId: string; usageState: UsageState } & UseTimes,
  show: (shift: LocalShift) => void,
  timesheet: string | undefined,
): Promise<void> {
  try {
    const day = await correctTrailerUseTimes(input);
    if (day === null) {
      Alert.alert("Nothing was saved", "That trailer is no longer the one this was opened for.");
      leaveStale(timesheet);
      return;
    }
    show(day);
  } catch (error: unknown) {
    Alert.alert("Couldn't save those times", error instanceof UseTimesError ? useTimesMessage(error.problem) : saveFailureMessage(error));
    throw error;
  }
}
