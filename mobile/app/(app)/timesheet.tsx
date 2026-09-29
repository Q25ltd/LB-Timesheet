/**
 * One finished day's page. Wiring only.
 *
 * A Stack sibling of the tab group, so it shows no tab bar. Opened from Home's
 * Recent Timesheets or the Timesheets tab with `id`, the day's own id — the
 * only thing that names it. An id no readable day has is said plainly; nothing
 * else is shown in its place.
 *
 * Read again whenever it comes into view, so a correction made on the edit
 * screen, or a fill or check corrected on a use's page, shows on return. Each
 * use is opened by its identity, with `timesheet` naming the finished day
 * (D39). A company's day with no valid declaration, or changed since it was
 * declared, is reviewed and declared on Edit Timesheet's Review (D42). Delete asks first (the screen), then removes exactly this day and
 * returns to where the driver came from, which lists what remains.
 */
import { useCallback, useState } from "react";
import { Alert } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { TimesheetDetailScreen } from "../../src/screens/TimesheetDetailScreen";
import { Restoring } from "../../src/components/Restoring";
import { REVIEW_TO_DECLARE } from "../../src/navigation/useScreenDay";
import { DeleteUncertainError, USAGE_STATE, deleteCompletedShift, readCompletedShift, type CompletedShift } from "../../src/shift/localShift";

export default function TimesheetRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const [shift, setShift] = useState<CompletedShift | null | "loading">("loading");

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    void readCompletedShift(id ?? "").then(found => { if (!cancelled) setShift(found); });
    return () => { cancelled = true; };
  }, [id]));

  if (shift === "loading") return <Restoring message="Loading timesheet…" />;
  const timesheet = shift?.id ?? "";
  const ended = USAGE_STATE.ended;
  return (
    <TimesheetDetailScreen
      shift={shift}
      onBack={() => { router.back(); }}
      onEdit={() => { router.push({ pathname: "/edit-timesheet", params: { id: timesheet } }); }}
      onReview={() => { router.push({ pathname: "/edit-timesheet", params: { id: timesheet, review: REVIEW_TO_DECLARE } }); }}
      onDelete={() => { void remove(timesheet); }}
      onOpenVehicleUse={usage => { router.push({ pathname: "/vehicle-usage", params: { usage, timesheet } }); }}
      onOpenTrailerUse={usage => { router.push({ pathname: "/trailer-usage", params: { usage, timesheet } }); }}
      onVehicleCheck={usage => { router.push({ pathname: "/vehicle-check", params: { usage, usageState: ended, timesheet } }); }}
      onTrailerCheck={trailer => { router.push({ pathname: "/trailer-check", params: { trailer, usageState: ended, timesheet } }); }}
    />
  );
}

/** Delete exactly this day, and say only what is true of the result. */
async function remove(id: string): Promise<void> {
  try {
    const deleted = await deleteCompletedShift(id);
    if (!deleted) {
      Alert.alert("Nothing was deleted", "This timesheet is no longer on this phone.");
    } else {
      Alert.alert("Timesheet deleted", "It has been removed from this phone.");
    }
    router.back();
  } catch (error: unknown) {
    Alert.alert(
      "Couldn't delete the timesheet",
      error instanceof DeleteUncertainError
        ? "It may not have been deleted. Check your timesheets before trying again."
        : "Nothing was deleted. Please try again.",
    );
  }
}
