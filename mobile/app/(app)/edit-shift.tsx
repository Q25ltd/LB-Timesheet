/**
 * The Edit Shift route — who the OPEN day is for, and when it started. Wiring
 * only. Opened from the Finish Review (D41); returns there, which re-reads
 * the day. With no open day it goes Home.
 */
import { useEffect, useState } from "react";
import { Alert } from "react-native";
import { Redirect, router } from "expo-router";
import { EditShiftStartScreen, type ShiftStartEdit } from "../../src/screens/EditShiftStartScreen";
import { Restoring } from "../../src/components/Restoring";
import { useAuth } from "../../src/auth/AuthContext";
import { saveFailureMessage } from "../../src/screens/format";
import { TimesheetBoundsError, correctOpenShift, readOpenShift, type LocalShift } from "../../src/shift/localShift";

export default function EditShiftRoute() {
  const { account } = useAuth();
  const [shift, setShift] = useState<LocalShift | null | "loading">("loading");

  useEffect(() => {
    let cancelled = false;
    void readOpenShift().then(open => { if (!cancelled) setShift(open); });
    return () => { cancelled = true; };
  }, []);

  if (shift === "loading") return <Restoring message="Loading shift…" />;
  if (shift === null || account === null) return <Redirect href="/today" />;

  return (
    <EditShiftStartScreen
      shift={shift}
      memberships={account.memberships}
      onLeave={() => { router.back(); }}
      onSave={edit => save(shift.id, edit)}
    />
  );
}

async function save(shiftId: string, edit: ShiftStartEdit): Promise<void> {
  try {
    const day = await correctOpenShift({ shiftId, ...edit });
    if (day === null) Alert.alert("Nothing was saved", "This shift is no longer the one open.");
    router.back();
  } catch (error: unknown) {
    Alert.alert(
      "Couldn't save that",
      error instanceof TimesheetBoundsError ? "The start can't be after a vehicle or trailer began." : saveFailureMessage(error),
    );
    throw error;
  }
}
