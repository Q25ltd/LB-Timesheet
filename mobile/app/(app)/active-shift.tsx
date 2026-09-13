/**
 * The Active Shift route. Wiring only.
 *
 * A Stack sibling of the tab group, so it has no tab bar — a driver mid-shift
 * should not wander out of it by tapping Timesheets. It reads the open shift
 * from the local store, which is the same read a cold start performs, so
 * reaching this route directly after a relaunch recovers the day.
 */
import { useEffect, useState } from "react";
import { Redirect } from "expo-router";
import { ActiveShiftScreen } from "../../src/screens/ActiveShiftScreen";
import { Restoring } from "../../src/components/Restoring";
import { readOpenShift, type LocalShift } from "../../src/shift/localShift";

export default function ActiveShiftRoute() {
  const [shift, setShift] = useState<LocalShift | null | "loading">("loading");

  useEffect(() => {
    let cancelled = false;
    void readOpenShift().then(open => { if (!cancelled) setShift(open); });
    return () => { cancelled = true; };
  }, []);

  // Reading a file is fast, but it is not synchronous: holding avoids a frame
  // that claims there is no shift before anyone has looked.
  if (shift === "loading") return <Restoring />;
  // No open shift — nothing to be active about. Back to the tabs.
  if (shift === null) return <Redirect href="/today" />;

  return <ActiveShiftScreen shift={shift} />;
}
