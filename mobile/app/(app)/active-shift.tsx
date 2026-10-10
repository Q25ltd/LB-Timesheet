/**
 * The Active Shift route. Wiring only.
 *
 * A Stack sibling of the tab group, so it has no tab bar — a driver mid-shift
 * should not wander out of it by tapping Timesheets. It reads the open shift
 * from the local store, which is the same read a cold start performs, so
 * reaching this route directly after a relaunch recovers the day.
 *
 * READ ON EVERY FOCUS, not once. Add Vehicle opens on top of this screen and
 * writes into the same day; when the driver comes back, the day on the phone
 * has changed and this screen, still mounted underneath, must show it at once
 * rather than the no-vehicle state it was left in.
 */
import { useCallback, useState } from "react";
import { Alert } from "react-native";
import { Redirect, router, useFocusEffect } from "expo-router";
import { ActiveShiftScreen } from "../../src/screens/ActiveShiftScreen";
import { Restoring } from "../../src/components/Restoring";
import { DiscardIncompleteError, USAGE_STATE, clearOpenShift, readOpenShift, type LocalShift } from "../../src/shift/localShift";
import { useAccountScope } from "../../src/shift/useAccountScope";
import type { AccountScope } from "../../src/shift/accountScope";

export default function ActiveShiftRoute() {
  const scope = useAccountScope();
  const [shift, setShift] = useState<LocalShift | null | "loading">("loading");

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    if (scope === null) return undefined;
    void readOpenShift(scope).then(open => { if (!cancelled) setShift(open); });
    return () => { cancelled = true; };
  }, [scope]));

  // Reading a file is fast, but it is not synchronous: holding avoids a frame
  // that claims there is no shift before anyone has looked.
  // No signed-in account's scope yet: nothing of anyone's is read (F-31).
  if (scope === null) return <Restoring />;
  if (shift === "loading") return <Restoring />;
  // No open shift — nothing to be active about. Back to the tabs.
  if (shift === null) return <Redirect href="/today" />;

  return (
    <ActiveShiftScreen
      shift={shift}
      onDiscard={() => { discard(scope); }}
      onFinish={() => { router.push("/finish-shift"); }}
      onAddVehicle={() => { router.push("/add-vehicle"); }}
      // Vehicle Checks name the EXACT use in the card, as Trailer Checks do.
      onVehicleChecks={() => {
        if (shift.vehicle !== null) {
          router.push({ pathname: "/vehicle-check", params: { usage: shift.vehicle.useId, usageState: USAGE_STATE.inUse } });
        }
      }}
      onChangeVehicle={() => { router.push("/change-vehicle"); }}
      // Fuel and AdBlue name the EXACT use in the card, and say it is the one
      // in use: if it has been handed back by the time the driver saves, the
      // save is refused rather than landing on it or on its replacement.
      onFill={(type, usage) => {
        router.push({ pathname: "/vehicle-fill", params: { type, usage, usageState: USAGE_STATE.inUse } });
      }}
      // An ended use is opened by its identity — never by plate.
      onOpenUsage={usage => { router.push({ pathname: "/vehicle-usage", params: { usage } }); }}
      // An ended trailer use is opened by its identity — never by trailer number.
      onOpenTrailerUsage={usage => { router.push({ pathname: "/trailer-usage", params: { usage } }); }}
      onAddTrailer={() => { router.push("/add-trailer"); }}
      onChangeTrailer={() => { router.push("/change-trailer"); }}
      // A typing mistake in the plate or trailer number, by the EXACT use in the card.
      onCorrectPlate={usage => { router.push({ pathname: "/correct-name", params: { asset: "vehicle", usage, usageState: USAGE_STATE.inUse } }); }}
      onCorrectTrailerNumber={usage => { router.push({ pathname: "/correct-name", params: { asset: "trailer", usage, usageState: USAGE_STATE.inUse } }); }}
      // Fridge Diesel names the EXACT trailer use in the card; if it has been
      // handed back by the time the driver saves, nothing is written (D34).
      onFridgeDiesel={trailer => { router.push({ pathname: "/trailer-diesel", params: { trailer, usageState: USAGE_STATE.inUse } }); }}
      // Trailer Checks name the EXACT trailer use in the card (D35).
      onTrailerChecks={trailer => { router.push({ pathname: "/trailer-check", params: { trailer, usageState: USAGE_STATE.inUse } }); }}
    />
  );
}

/**
 * Throw the day away, once the driver has confirmed it on the screen.
 *
 * The record is local and was never sent anywhere (D28), so this asks no
 * server for permission and there is nothing to withdraw — the file goes and
 * the driver is returned to the tabs, where Start Shift can begin a new day
 * because the one-open-shift rule no longer has anything to hold.
 *
 * NAVIGATION WAITS FOR THE DELETE. Leaving first and deleting afterwards
 * would send a driver to Home while the shift was still open, and the next
 * press of Start Shift would walk them straight back into the day they just
 * discarded. If the delete fails they are told, rather than being moved
 * somewhere that implies it worked — and told the truth: "nothing was
 * changed" only when nothing was removed. A discard that failed part-way
 * (`DiscardIncompleteError`) may already have removed the day.
 */
function discard(scope: AccountScope): void {
  void clearOpenShift(scope).then(
    () => { router.replace("/today"); },
    (error: unknown) => {
      Alert.alert(
        "Couldn't discard the shift",
        error instanceof DiscardIncompleteError
          ? "The shift could not be discarded safely. Check your current shift before trying again."
          : "Nothing was changed. Please try again.",
      );
    },
  );
}
