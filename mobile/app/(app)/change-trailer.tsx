/**
 * The Change Trailer route. Wiring only.
 *
 * A Stack sibling of the tab group. ONLY for a day with a trailer in use;
 * otherwise back to Active Shift (or Home with no open day). The trailer it
 * ends is the one on screen when it opened, named by its `startedAt`: if it
 * has changed since, the store writes nothing (`changeTrailer`).
 *
 * The vehicle is never touched here (D34). A new trailer returns to Active
 * Shift, which folds the vehicle card to bring the trailer into view (D33);
 * No trailer returns to it unchanged in every other respect.
 */
import { useEffect, useState } from "react";
import { Alert } from "react-native";
import { Redirect, router } from "expo-router";
import { ChangeTrailerScreen } from "../../src/screens/ChangeTrailerScreen";
import { Restoring } from "../../src/components/Restoring";
import { UseEndsBeforeItStartedError, changeTrailer, readOpenShift, type LocalShift } from "../../src/shift/localShift";
import type { LocalTrailer, TrailerDetails } from "../../src/shift/trailer";
import { saveFailureMessage } from "../../src/screens/format";

export default function ChangeTrailerRoute() {
  const [shift, setShift] = useState<LocalShift | null | "loading">("loading");

  useEffect(() => {
    let cancelled = false;
    void readOpenShift().then(open => { if (!cancelled) setShift(open); });
    return () => { cancelled = true; };
  }, []);

  if (shift === "loading") return <Restoring />;
  if (shift === null) return <Redirect href="/today" />;
  const current = shift.trailer;
  if (current === null) return <Redirect href="/active-shift" />;

  return (
    <ChangeTrailerScreen
      current={current}
      onLeave={() => { router.back(); }}
      onConfirm={next => confirm(shift.id, current, next)}
    />
  );
}

async function confirm(shiftId: string, current: LocalTrailer, next: TrailerDetails | null): Promise<void> {
  try {
    const changedAt = new Date();
    const day = await changeTrailer({ shiftId, endingStartedAt: current.startedAt, next, changedAt });
    if (day === null) { router.replace("/today"); return; }
    // Success is the trailer on screen having ended AT THIS PRESS; the store
    // changes nothing once another has replaced it, and the driver is told so.
    if (!day.previousTrailers.some(use => use.startedAt === current.startedAt && use.endedAt === changedAt.toISOString())) {
      Alert.alert("Nothing was saved", "That trailer is no longer the one in use.");
    }
    router.dismissTo("/active-shift");
  } catch (error: unknown) {
    Alert.alert(
      "Couldn't change the trailer",
      // The phone's clock went back since this trailer's use began (see change-vehicle).
      error instanceof UseEndsBeforeItStartedError
        ? "The phone's clock is earlier than when this trailer started. Nothing was changed. Check the phone's date and time, then try again."
        : saveFailureMessage(error),
    );
    throw error;
  }
}
