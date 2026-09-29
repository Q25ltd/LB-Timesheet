/**
 * The Finish Shift route. Wiring only.
 *
 * A Stack sibling of the tab group, like Change Vehicle, so it shows no tab
 * bar. With no open day it goes Home.
 *
 * The day is read when the flow opens and again whenever it comes back into
 * view, so the Review shows every correction made from it (D41). The flow
 * finishes exactly the day it shows, with exactly the vehicle and trailer it
 * shows: if either has changed by the final press, the store finishes
 * nothing and the driver is sent back to the day (`finishOpenShift`). The
 * finish time starts at the moment the flow opened.
 *
 * Nothing is sent anywhere. For a company day the final action says so: it
 * becomes Save & Send only once sending exists (D41).
 */
import { useCallback, useState } from "react";
import { Alert } from "react-native";
import { Redirect, router, useFocusEffect } from "expo-router";
import { FinishShiftScreen } from "../../src/screens/FinishShiftScreen";
import { Restoring } from "../../src/components/Restoring";
import { saveFailureMessage } from "../../src/screens/format";
import { VIA_FINISH_REVIEW } from "../../src/navigation/useScreenDay";
import { useAuth } from "../../src/auth/AuthContext";
import {
  FinishTooEarlyError,
  USAGE_STATE,
  finishOpenShift,
  readOpenShift,
  type Declared,
  type LocalShift,
  type ShiftFinish,
} from "../../src/shift/localShift";

export default function FinishShiftRoute() {
  const [shift, setShift] = useState<LocalShift | null | "loading">("loading");
  const { account } = useAuth();
  // Read once: the finish time must not creep forward while the driver types.
  const [openedAt] = useState(() => new Date());

  // Re-read whenever the flow comes back into view — after a correction
  // opened from the Review — so it always shows the day as it now is (D41).
  useFocusEffect(useCallback(() => {
    let cancelled = false;
    void readOpenShift().then(open => { if (!cancelled) setShift(open); });
    return () => { cancelled = true; };
  }, []));

  if (shift === "loading") return <Restoring message="Loading shift…" />;
  // The gate renders this route only when authenticated; a declaration is never unattributed.
  if (shift === null || account === null) return <Redirect href="/today" />;

  return (
    <FinishShiftScreen
      shift={shift}
      openedAt={openedAt}
      onLeave={() => { router.back(); }}
      // Declared by the signed-in driver, at the press (D42).
      onConfirm={(finish, version) => confirm(shift, finish, { at: new Date(), by: account.user.id, version })}
      onEditShift={() => { router.push("/edit-shift"); }}
      // Each use by its identity, in the state it is in; its screens come back here.
      onOpenVehicleUse={(usage, inUse) => {
        router.push({ pathname: "/vehicle-usage", params: { usage, usageState: inUse ? USAGE_STATE.inUse : USAGE_STATE.ended, via: VIA_FINISH_REVIEW } });
      }}
      onOpenTrailerUse={(usage, inUse) => {
        router.push({ pathname: "/trailer-usage", params: { usage, usageState: inUse ? USAGE_STATE.inUse : USAGE_STATE.ended, via: VIA_FINISH_REVIEW } });
      }}
    />
  );
}

/** Finish the day on screen, and say only what is true of the result. */
async function confirm(shift: LocalShift, finish: ShiftFinish, declared: Declared): Promise<void> {
  try {
    const done = await finishOpenShift({
      shiftId: shift.id,
      vehicleUseId: shift.vehicle?.useId ?? null,
      trailerUseId: shift.trailer?.useId ?? null,
      ...finish,
      declared,
    });
    if (done === null) {
      // The day, its vehicle or trailer, or what the Review showed, changed beneath it.
      Alert.alert("Nothing was saved", "This shift changed after Finish Shift was opened. Check it, then finish again.");
      router.dismissTo("/active-shift");
      return;
    }
    // Finished — by this press, or by one just before it. Back to Home,
    // dismissing Active Shift and this flow so neither can be returned to;
    // Home re-reads the phone as it comes into view and lists the day.
    Alert.alert("Shift finished", "Your timesheet is saved on this phone. Nothing has been sent.");
    router.dismissTo("/today");
  } catch (error: unknown) {
    Alert.alert("Couldn't finish the shift", failureMessage(error));
    throw error;
  }
}

/** Refusals of the finish time are the driver's to correct; anything else is a save that failed. */
function failureMessage(error: unknown): string {
  if (error instanceof FinishTooEarlyError) {
    return "The finish is earlier than something already in this shift. Go back, check the finish date and time, then try again.";
  }
  return saveFailureMessage(error);
}
