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
 *
 * THE USE IN USE, NAMED. Opened from Active Shift or after a change, `usage`
 * names the use in the card (`usageState: "in-use"`); if that is no longer the
 * vehicle in use the screen is not shown — the replacement is never checked in
 * its place. With no parameters it opens the vehicle in use.
 *
 * AN ENDED USE, EXPLICITLY. With `usage` (a use's `startedAt`) and
 * `usageState: "ended"` it opens THAT ended vehicle use's check instead — a
 * check forgotten before the vehicle went back (D36): its draft resumed, or a
 * fresh one. A name that is not an ended use of this day is not a screen.
 * Completing it is dated when it is actually completed, never backdated.
 *
 * A COMPLETED check can be CORRECTED here (D36): the correction is appended as
 * a revision by the signed-in driver, and the original stays as certified.
 */
import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { VehicleCheckScreen, vehicleCheckSubject } from "../../src/screens/VehicleCheckScreen";
import { Restoring } from "../../src/components/Restoring";
import { useAuth } from "../../src/auth/AuthContext";
import { checklistFor } from "../../src/shift/checklists";
import { latestCheck, type CheckAnswer } from "../../src/shift/vehicleCheck";
import {
  USAGE_STATE,
  completeVehicleCheck,
  newLocalId,
  readOpenShift,
  reviseVehicleCheck,
  saveVehicleCheckDraft,
  type LocalShift,
  type LocalVehicle,
  type UsageState,
} from "../../src/shift/localShift";
import { saveFailureMessage } from "../../src/screens/format";

export default function VehicleCheckRoute() {
  const { usage, usageState } = useLocalSearchParams<{ usage?: string; usageState?: string }>();
  const [shift, setShift] = useState<LocalShift | null | "loading">("loading");

  useEffect(() => {
    let cancelled = false;
    void readOpenShift().then(open => { if (!cancelled) setShift(open); });
    return () => { cancelled = true; };
  }, []);

  // Reading the phone's own shift file — not signing anyone in.
  if (shift === "loading") return <Restoring message="Loading check…" />;
  if (shift === null) return <Redirect href="/today" />;

  if (usageState === USAGE_STATE.ended) {
    const ended = shift.previousVehicles.find(use => use.startedAt === usage);
    if (usage === undefined || ended === undefined) return <Redirect href="/active-shift" />;
    return <OpenCheck shift={shift} vehicle={ended} usageState={USAGE_STATE.ended} onShift={setShift} />;
  }
  // Anything but "ended" named explicitly is not a way to reach an ended use.
  if (usageState !== undefined && usageState !== USAGE_STATE.inUse) return <Redirect href="/active-shift" />;
  if (shift.vehicle === null) return <Redirect href="/active-shift" />;
  // A use NAMED as in use must still be the one in use: a vehicle changed since
  // is never silently replaced by whatever is current now.
  if (usage !== undefined && usage !== shift.vehicle.startedAt) return <Redirect href="/active-shift" />;

  return <OpenCheck shift={shift} vehicle={shift.vehicle} usageState={USAGE_STATE.inUse} onShift={setShift} />;
}

function OpenCheck({ shift, vehicle, usageState, onShift }: {
  shift: LocalShift; vehicle: LocalVehicle; usageState: UsageState; onShift: (shift: LocalShift | null) => void;
}) {
  const { account } = useAuth();
  const existing = latestCheck(vehicle.checks);
  const identity = useRef<{ id: string; startedAt: Date } | null>(null);
  identity.current ??= existing === null
    ? { id: newLocalId(), startedAt: new Date() }
    : { id: existing.id, startedAt: new Date(existing.startedAt) };

  const target = {
    shiftId: shift.id,
    vehicleStartedAt: vehicle.startedAt,
    usageState,
    checkId: identity.current.id,
    startedAt: identity.current.startedAt,
  };

  async function save(answers: CheckAnswer[]): Promise<void> {
    try {
      const stored = await saveVehicleCheckDraft({ ...target, answers });
      if (stored === null) gone();
    } catch (error: unknown) {
      Alert.alert("Couldn't save the check", saveFailureMessage(error, "Your last answer was not saved. Please try again."));
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
      if (stored === null) { gone(); return; }
      // Back where it was opened from: the day, or the ended use's detail.
      if (usageState === USAGE_STATE.inUse) router.dismissTo("/active-shift");
      else router.back();
    } catch (error: unknown) {
      Alert.alert("Couldn't complete the check", saveFailureMessage(error));
      throw error;
    }
  }

  async function revise(answers: CheckAnswer[]): Promise<void> {
    if (account === null || existing === null) return;
    try {
      const stored = await reviseVehicleCheck({
        shiftId: shift.id, usageStartedAt: vehicle.startedAt, usageState, checkId: existing.id,
        revisionId: newLocalId(), answers, revisedAt: new Date(), revisedBy: account.user.id,
      });
      if (stored === null) { gone(); return; }
      // Show the corrected certificate from the file.
      onShift(await readOpenShift());
    } catch (error: unknown) {
      Alert.alert("Couldn't save the correction", saveFailureMessage(error));
      throw error;
    }
  }

  return (
    <VehicleCheckScreen
      subject={vehicleCheckSubject(vehicle)}
      checklist={checklistFor(vehicle.vehicleClass)}
      check={existing}
      onSave={save}
      onComplete={complete}
      onRevise={revise}
      onExit={() => { if (usageState === USAGE_STATE.inUse) router.dismissTo("/active-shift"); else router.back(); }}
    />
  );
}

/**
 * The use this check was opened for is no longer where it was — the vehicle
 * changed or was handed back, or the day was discarded. Nothing was written.
 * Said, and back to the day (Active Shift sends a discarded day Home itself).
 */
function gone(): void {
  Alert.alert("Nothing was saved", "That vehicle is no longer the one this check was opened for.");
  router.dismissTo("/active-shift");
}
