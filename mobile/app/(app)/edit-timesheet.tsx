/**
 * The Edit Timesheet route. Wiring only.
 *
 * A Stack sibling of the tab group. Opened from a finished day's page with
 * `id`, the day's own id. The day is read once, when the screen opens; the
 * correction it saves names the version it was opened on (`basedOn`), so a
 * day corrected elsewhere meanwhile is not overwritten, and carries one id
 * for the life of the screen, so a repeated press is one correction (D39).
 * Who corrected it is the signed-in driver; when is the press. A company's
 * day is saved with the driver's declaration of the version reviewed (D42);
 * `review` opens straight on that Review, for a day to be declared.
 */
import { useEffect, useState } from "react";
import { Alert } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { EditTimesheetScreen, type TimesheetEdit } from "../../src/screens/EditTimesheetScreen";
import { Restoring } from "../../src/components/Restoring";
import { useAuth } from "../../src/auth/AuthContext";
import { saveFailureMessage } from "../../src/screens/format";
import {
  TimesheetBoundsError,
  correctCompletedShift,
  newLocalId,
  readCompletedShift,
  type CompletedShift,
  type Declared,
} from "../../src/shift/localShift";
import { REVIEW_TO_DECLARE } from "../../src/navigation/useScreenDay";

export default function EditTimesheetRoute() {
  const { id, review } = useLocalSearchParams<{ id?: string; review?: string }>();
  const { account } = useAuth();
  const [shift, setShift] = useState<CompletedShift | null | "loading">("loading");
  const [correctionId] = useState(newLocalId);

  useEffect(() => {
    let cancelled = false;
    void readCompletedShift(id ?? "").then(found => { if (!cancelled) setShift(found); });
    return () => { cancelled = true; };
  }, [id]);

  if (shift === "loading") return <Restoring message="Loading timesheet…" />;
  // The gate renders this route only when authenticated; a correction is never unattributed.
  if (shift === null || account === null) {
    return <Missing />;
  }

  const corrections = shift.corrections ?? [];
  const basedOn = corrections[corrections.length - 1]?.id ?? null;
  const correctedBy = account.user.id;
  return (
    <EditTimesheetScreen
      shift={shift}
      memberships={account.memberships}
      onLeave={() => { router.back(); }}
      startInReview={review === REVIEW_TO_DECLARE}
      onSave={(edit, version) => save(
        { shiftId: shift.id, basedOn, correctionId, correctedBy },
        edit,
        version === null ? null : { at: new Date(), by: correctedBy, version },
      )}
    />
  );
}

function Missing() {
  useEffect(() => {
    Alert.alert("Nothing to edit", "This timesheet is no longer on this phone.");
    router.back();
  }, []);
  return null;
}

async function save(
  by: { shiftId: string; basedOn: string | null; correctionId: string; correctedBy: string },
  edit: TimesheetEdit,
  declared: Declared | null,
): Promise<void> {
  try {
    const day = await correctCompletedShift({ ...by, correctedAt: new Date(), ...edit, declared });
    if (day === null) {
      Alert.alert("Nothing was saved", "This timesheet changed after you opened it, or is no longer on this phone. Open it again to make your correction.");
    }
    router.back();
  } catch (error: unknown) {
    Alert.alert("Couldn't save the correction", failureMessage(error));
    throw error;
  }
}

/** A refused time is the driver's to correct; anything else is a save that failed. */
function failureMessage(error: unknown): string {
  if (error instanceof TimesheetBoundsError) return "The times don't hold everything recorded in this shift. Check the start and finish.";
  return saveFailureMessage(error);
}
