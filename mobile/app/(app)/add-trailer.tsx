/**
 * The Add Trailer route. Wiring only.
 *
 * A Stack sibling of the tab group, so it shows no tab bar. ONLY for a day
 * with no trailer in use and a vehicle that tows one (Class 1 or Class 2 —
 * D30); otherwise the driver is sent back to the day rather than shown a form
 * that cannot do what it says. With no open day, Home.
 *
 * On success it returns to Active Shift, which sees the new trailer use and
 * folds the vehicle card so the trailer is in view (D33). Backing out writes
 * nothing, and so folds nothing.
 */
import { useEffect, useState } from "react";
import { Alert } from "react-native";
import { Redirect, router } from "expo-router";
import { AddTrailerScreen } from "../../src/screens/AddTrailerScreen";
import { Restoring } from "../../src/components/Restoring";
import { addTrailerToOpenShift, readOpenShift, type LocalShift } from "../../src/shift/localShift";
import { towsTrailers, type TrailerDetails } from "../../src/shift/trailer";
import { saveFailureMessage } from "../../src/screens/format";
import { useAccountScope } from "../../src/shift/useAccountScope";
import type { AccountScope } from "../../src/shift/accountScope";

export default function AddTrailerRoute() {
  const scope = useAccountScope();
  const [shift, setShift] = useState<LocalShift | null | "loading">("loading");

  useEffect(() => {
    let cancelled = false;
    if (scope === null) return undefined;
    void readOpenShift(scope).then(open => { if (!cancelled) setShift(open); });
    return () => { cancelled = true; };
  }, [scope]);

  // No signed-in account's scope yet: nothing of anyone's is read (F-31).
  if (scope === null) return <Restoring />;
  if (shift === "loading") return <Restoring />;
  if (shift === null) return <Redirect href="/today" />;
  if (shift.trailer !== null || shift.vehicle === null || !towsTrailers(shift.vehicle.vehicleClass)) {
    return <Redirect href="/active-shift" />;
  }

  const shiftId = shift.id;
  return <AddTrailerScreen onBack={() => { router.back(); }} onAdd={trailer => add(scope, shiftId, trailer)} />;
}

/** Write the trailer — its use begins at the press — then return to the day. */
async function add(scope: AccountScope, shiftId: string, trailer: TrailerDetails): Promise<void> {
  try {
    const startedAt = new Date();
    const day = await addTrailerToOpenShift(scope, { shiftId, trailer, startedAt });
    if (day === null) { router.replace("/today"); return; }
    // Add is not change: with a trailer already there the store keeps it. Say
    // so, rather than let the trailer just typed vanish as if it were added.
    if (day.trailer?.startedAt !== startedAt.toISOString()) {
      Alert.alert("Nothing was saved", "A trailer is already in use. Change Trailer to take another.");
    }
    router.dismissTo("/active-shift");
  } catch (error: unknown) {
    Alert.alert("Couldn't add the trailer", saveFailureMessage(error));
    throw error;
  }
}
