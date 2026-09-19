/**
 * The Vehicle Check route. Wiring only.
 *
 * A Stack sibling of the tabs, like the other workflow screens, so it shows no
 * tab bar and sits inside the `(app)` gate.
 *
 * It opens the check for the vehicle the driver is using NOW: the most recent
 * check on that vehicle, resumed or shown; or, if there is none, a fresh one.
 * A fresh check's identity and start time are fixed here, once, when the
 * screen opens — so every save of it names the same check, and a replayed
 * completion is the same event rather than a second certificate (D19) — but
 * nothing is written until the driver changes something. Completion carries
 * the authenticated driver's id, because it is a declaration and a
 * declaration has an author. Reached with no open day it goes
 * to Home; with no vehicle, back to Active Shift, where Add Vehicle is.
 */
import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import { Redirect, router } from "expo-router";
import { VehicleCheckScreen } from "../../src/screens/VehicleCheckScreen";
import { Restoring } from "../../src/components/Restoring";
import { useAuth } from "../../src/auth/AuthContext";
import { checklistFor } from "../../src/shift/checklists";
import { latestCheck, type CheckAnswer } from "../../src/shift/vehicleCheck";
import {
  completeVehicleCheck,
  newLocalId,
  readOpenShift,
  saveVehicleCheckDraft,
  type LocalShift,
  type LocalVehicle,
} from "../../src/shift/localShift";

export default function VehicleCheckRoute() {
  const [shift, setShift] = useState<LocalShift | null | "loading">("loading");

  useEffect(() => {
    let cancelled = false;
    void readOpenShift().then(open => { if (!cancelled) setShift(open); });
    return () => { cancelled = true; };
  }, []);

  // Reading the phone's own shift file — not signing anyone in.
  if (shift === "loading") return <Restoring message="Loading check…" />;
  if (shift === null) return <Redirect href="/today" />;
  if (shift.vehicle === null) return <Redirect href="/active-shift" />;

  return <OpenCheck shift={shift} vehicle={shift.vehicle} />;
}

function OpenCheck({ shift, vehicle }: { shift: LocalShift; vehicle: LocalVehicle }) {
  const { account } = useAuth();
  const existing = latestCheck(vehicle.checks);
  const identity = useRef<{ id: string; startedAt: Date } | null>(null);
  identity.current ??= existing === null
    ? { id: newLocalId(), startedAt: new Date() }
    : { id: existing.id, startedAt: new Date(existing.startedAt) };

  const target = {
    shiftId: shift.id,
    vehicleStartedAt: vehicle.startedAt,
    checkId: identity.current.id,
    startedAt: identity.current.startedAt,
  };

  async function save(answers: CheckAnswer[]): Promise<void> {
    try {
      const stored = await saveVehicleCheckDraft({ ...target, answers });
      // The day was discarded while the check was open.
      if (stored === null) router.replace("/today");
    } catch (error: unknown) {
      Alert.alert("Couldn't save the check", "Your last answer was not saved. Please try again.");
      throw error;
    }
  }

  async function complete(answers: CheckAnswer[]): Promise<void> {
    // The gate above this route renders it only when authenticated, so this is
    // defensive: a check is never certified without a driver to attribute it to.
    if (account === null) return;
    try {
      const stored = await completeVehicleCheck({
        ...target,
        answers,
        // The driver's declared moment, from the device clock — not a server
        // acceptance time; see `VehicleCheck`.
        completedAt: new Date(),
        completedBy: account.user.id,
      });
      if (stored === null) { router.replace("/today"); return; }
      router.dismissTo("/active-shift");
    } catch (error: unknown) {
      Alert.alert("Couldn't complete the check", "Nothing was changed. Please try again.");
      throw error;
    }
  }

  return (
    <VehicleCheckScreen
      vehicle={vehicle}
      checklist={checklistFor(vehicle.vehicleClass)}
      check={existing}
      onSave={save}
      onComplete={complete}
      onExit={() => { router.dismissTo("/active-shift"); }}
    />
  );
}
