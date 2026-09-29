/**
 * The Timesheets tab. Wiring only — the screen owns the rendering.
 *
 * The phone's finished days are read again every time the tab comes into
 * view, so a day finished a moment ago is already here.
 */
import { useCallback, useState } from "react";
import { router, useFocusEffect } from "expo-router";
import { TimesheetsScreen } from "../../../src/screens/TimesheetsScreen";
import { listCompletedShifts, type CompletedShiftListing } from "../../../src/shift/localShift";

export default function TimesheetsRoute() {
  const [listing, setListing] = useState<CompletedShiftListing | "loading" | "unreadable">("loading");

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    listCompletedShifts().then(
      found => { if (!cancelled) setListing(found); },
      () => { if (!cancelled) setListing("unreadable"); },
    );
    return () => { cancelled = true; };
  }, []));

  return (
    <TimesheetsScreen
      listing={listing}
      // By the day's id — never its date, employer or place in the list.
      onOpen={id => { router.push({ pathname: "/timesheet", params: { id } }); }}
    />
  );
}
