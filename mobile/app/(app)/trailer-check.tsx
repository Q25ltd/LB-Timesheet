/**
 * The Trailer Checks route. Wiring only — the screen is the one Vehicle Checks
 * use, named for the trailer (D35).
 *
 * ALWAYS FOR ONE EXACT TRAILER USE: `trailer` is that use's `useId`, and
 * `usageState` says which kind — the trailer IN USE (from its card) or an
 * ENDED use (from its Vehicle-Use-style detail, for a check forgotten before
 * the trailer went back). Anything else — no such use in that state, a trailer
 * handed back or changed since — is not a screen: it goes back to Active Shift
 * rather than showing another trailer's check or one found by number. The
 * store checks the same again on every save, so a trailer changed while the
 * check is open receives nothing, and neither does its replacement.
 *
 * A forgotten check completed afterwards is dated when the driver completes
 * it, like any other: nothing is backdated to the trailer's hours.
 *
 * It opens that use's most recent check, resumed or shown, or a fresh one
 * whose identity and start time are fixed here, once — nothing is written
 * until the driver changes something. Completion carries the authenticated
 * driver's id, as a vehicle's does.
 *
 * A COMPLETED check can be CORRECTED here (D36): the correction is appended as
 * a revision by the signed-in driver, and the original stays as certified.
 */
import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { VehicleCheckScreen, trailerCheckSubject } from "../../src/screens/VehicleCheckScreen";
import { Restoring } from "../../src/components/Restoring";
import { useAuth } from "../../src/auth/AuthContext";
import { trailerChecklistFor } from "../../src/shift/checklists";
import { latestCheck, type CheckAnswer } from "../../src/shift/vehicleCheck";
import {
  USAGE_STATE,
  completeTrailerCheck,
  newLocalId,
  reviseTrailerCheck,
  saveTrailerCheckDraft,
  type LocalShift,
  type UsageState,
} from "../../src/shift/localShift";
import type { LocalTrailer } from "../../src/shift/trailer";
import { saveFailureMessage } from "../../src/screens/format";
import { backToDay, leaveStale, missingHref, readScreenDay } from "../../src/navigation/useScreenDay";
import { useAccountScope } from "../../src/shift/useAccountScope";
import type { AccountScope } from "../../src/shift/accountScope";

export default function TrailerCheckRoute() {
  const scope = useAccountScope();
  const { trailer, usageState, timesheet, via } = useLocalSearchParams<{ trailer?: string; usageState?: string; timesheet?: string; via?: string }>();
  const [shift, setShift] = useState<LocalShift | null | "loading">("loading");

  useEffect(() => {
    let cancelled = false;
    if (scope === null) return undefined;
    void readScreenDay(scope, timesheet).then(open => { if (!cancelled) setShift(open); });
    return () => { cancelled = true; };
  }, [scope, timesheet]);

  const state = Object.values(USAGE_STATE).find(entry => entry === usageState) ?? null;
  // No signed-in account's scope yet: nothing of anyone's is read (F-31).
  if (scope === null) return <Restoring />;
  if (trailer === undefined || state === null) return <Redirect href={missingHref(timesheet, true)} />;
  if (shift === "loading") return <Restoring message="Loading check…" />;
  if (shift === null) return <Redirect href={missingHref(timesheet, false)} />;
  const use = state === USAGE_STATE.inUse
    ? (shift.trailer?.useId === trailer ? shift.trailer : null)
    : (shift.previousTrailers.find(entry => entry.useId === trailer) ?? null);
  if (use === null) return <Redirect href={missingHref(timesheet, true)} />;

  return <OpenCheck scope={scope} shift={shift} trailer={use} usageState={state} onShift={setShift} timesheet={timesheet} via={via} />;
}

function OpenCheck({ scope, shift, trailer, usageState, onShift, timesheet, via }: {
  scope: AccountScope; shift: LocalShift; trailer: LocalTrailer; usageState: UsageState; onShift: (shift: LocalShift | null) => void; timesheet?: string; via?: string;
}) {
  const { account } = useAuth();
  const existing = latestCheck(trailer.checks);
  const identity = useRef<{ id: string; startedAt: Date } | null>(null);
  identity.current ??= existing === null
    ? { id: newLocalId(), startedAt: new Date() }
    : { id: existing.id, startedAt: new Date(existing.startedAt) };

  const target = {
    shiftId: shift.id,
    trailerUseId: trailer.useId,
    usageState,
    checkId: identity.current.id,
    startedAt: identity.current.startedAt,
  };

  async function save(answers: CheckAnswer[]): Promise<void> {
    try {
      const stored = await saveTrailerCheckDraft(scope, { ...target, answers });
      if (stored === null) gone(timesheet);
    } catch (error: unknown) {
      Alert.alert("Couldn't save the check", saveFailureMessage(error, "Your last answer was not saved. Please try again."));
      throw error;
    }
  }

  async function complete(answers: CheckAnswer[]): Promise<void> {
    // A check is never certified without a driver to attribute it to.
    if (account === null) return;
    try {
      const stored = await completeTrailerCheck(scope, { ...target, answers, completedAt: new Date(), completedBy: account.user.id });
      if (stored === null) { gone(timesheet); return; }
      // Back where it was opened from: the day, or the ended use's detail.
      if (usageState === USAGE_STATE.inUse) backToDay(via);
      else router.back();
    } catch (error: unknown) {
      Alert.alert("Couldn't complete the check", saveFailureMessage(error));
      throw error;
    }
  }

  async function revise(answers: CheckAnswer[]): Promise<void> {
    if (account === null || existing === null) return;
    try {
      const stored = await reviseTrailerCheck(scope, {
        shiftId: shift.id, useId: trailer.useId, usageState, checkId: existing.id,
        revisionId: newLocalId(), answers, revisedAt: new Date(), revisedBy: account.user.id,
      });
      if (stored === null) { gone(timesheet); return; }
      onShift(await readScreenDay(scope, timesheet));
    } catch (error: unknown) {
      Alert.alert("Couldn't save the correction", saveFailureMessage(error));
      throw error;
    }
  }

  return (
    <VehicleCheckScreen
      subject={trailerCheckSubject(trailer)}
      checklist={trailerChecklistFor(trailer.trailerType)}
      check={existing}
      onSave={save}
      onComplete={complete}
      onRevise={revise}
      onExit={() => { if (usageState === USAGE_STATE.inUse) backToDay(via); else router.back(); }}
    />
  );
}

/** The trailer this check was opened for is no longer in use. Nothing was written. */
function gone(timesheet: string | undefined): void {
  Alert.alert("Nothing was saved", "That trailer is no longer the one this check was opened for.");
  leaveStale(timesheet);
}
