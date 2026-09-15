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
import { clearOpenShift, readOpenShift, type LocalShift } from "../../src/shift/localShift";

export default function ActiveShiftRoute() {
  const [shift, setShift] = useState<LocalShift | null | "loading">("loading");

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    void readOpenShift().then(open => { if (!cancelled) setShift(open); });
    return () => { cancelled = true; };
  }, []));

  // Reading a file is fast, but it is not synchronous: holding avoids a frame
  // that claims there is no shift before anyone has looked.
  if (shift === "loading") return <Restoring />;
  // No open shift — nothing to be active about. Back to the tabs.
  if (shift === null) return <Redirect href="/today" />;

  return (
    <ActiveShiftScreen
      shift={shift}
      onDiscard={discard}
      onAddVehicle={() => { router.push("/add-vehicle"); }}
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
 * discarded. If the delete fails the shift is untouched and they are told,
 * rather than being moved somewhere that implies it worked.
 */
function discard(): void {
  void clearOpenShift().then(
    () => { router.replace("/today"); },
    () => {
      Alert.alert("Couldn't discard the shift", "Nothing was changed. Please try again.");
    },
  );
}
