/**
 * The Trailer Use route — one ENDED trailer use, to read and correct. Wiring
 * only.
 *
 * Opened from a USED THIS SHIFT → TRAILERS row with `usage`, the use's
 * `startedAt` — its identity, and the only thing that names it. Never a
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
import { Redirect, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { TrailerUsageScreen } from "../../src/screens/TrailerUsageScreen";
import { Restoring } from "../../src/components/Restoring";
import { USAGE_STATE, readOpenShift, type LocalShift } from "../../src/shift/localShift";

export default function TrailerUsageRoute() {
  const { usage } = useLocalSearchParams<{ usage?: string }>();
  const [shift, setShift] = useState<LocalShift | null | "loading">("loading");

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void readOpenShift().then(open => { if (!cancelled) setShift(open); });
      return () => { cancelled = true; };
    }, []),
  );

  if (shift === "loading") return <Restoring message="Loading shift…" />;
  if (shift === null) return <Redirect href="/today" />;

  const use = usage === undefined ? undefined : shift.previousTrailers.find(entry => entry.startedAt === usage);
  if (use === undefined) return <Redirect href="/active-shift" />;

  const named = { trailer: use.startedAt, usageState: USAGE_STATE.ended };
  return (
    <TrailerUsageScreen
      use={use}
      onLeave={() => { router.back(); }}
      onTrailerChecks={() => { router.push({ pathname: "/trailer-check", params: named }); }}
      onFridgeDiesel={() => { router.push({ pathname: "/trailer-diesel", params: named }); }}
    />
  );
}
