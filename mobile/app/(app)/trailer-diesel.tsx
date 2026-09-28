/**
 * The Fridge Diesel route — diesel put into a refrigerated trailer's fridge
 * unit. Wiring only; the form is the one Fuel and AdBlue use.
 *
 * ALWAYS FOR ONE EXACT REFRIGERATED TRAILER USE: `trailer` is that use's
 * `startedAt`, and `usageState` says which kind — the trailer IN USE (its
 * card) or an ENDED use (its Edit, correcting what it holds). Anything else —
 * no such use in that state, a standard trailer, a trailer handed back since —
 * is not a screen, and goes back to Active Shift rather than falling back to
 * whatever trailer is current or looking one up by number. The store checks
 * the same again at save time (D34).
 *
 * Never the unit's Fuel: it is stored on the trailer use and nowhere else.
 */
import { useCallback, useState } from "react";
import { Alert } from "react-native";
import { Redirect, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { VehicleFillScreen, type FillEntry } from "../../src/screens/VehicleFillScreen";
import { Restoring } from "../../src/components/Restoring";
import {
  USAGE_STATE,
  newLocalId,
  readOpenShift,
  recordReeferDiesel,
  removeReeferDiesel,
  type LocalShift,
  type UsageState,
} from "../../src/shift/localShift";
import { TRAILER_TYPE } from "../../src/shift/trailer";
import { formatClockTime, saveFailureMessage } from "../../src/screens/format";

export default function TrailerDieselRoute() {
  const { trailer, usageState } = useLocalSearchParams<{ trailer?: string; usageState?: string }>();
  const [shift, setShift] = useState<LocalShift | null | "loading">("loading");

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void readOpenShift().then(open => { if (!cancelled) setShift(open); });
      return () => { cancelled = true; };
    }, []),
  );

  const state = Object.values(USAGE_STATE).find(entry => entry === usageState) ?? null;
  if (trailer === undefined || state === null) return <Redirect href="/active-shift" />;
  if (shift === "loading") return <Restoring message="Loading shift…" />;
  if (shift === null) return <Redirect href="/today" />;

  const ended = state === USAGE_STATE.ended ? shift.previousTrailers.find(entry => entry.startedAt === trailer) ?? null : null;
  const use = state === USAGE_STATE.inUse ? (shift.trailer?.startedAt === trailer ? shift.trailer : null) : ended;
  if (use === null || use.trailerType !== TRAILER_TYPE.refrigerated) return <Redirect href="/active-shift" />;

  const named: NamedTrailer = { shiftId: shift.id, trailerStartedAt: trailer, usageState: state };
  return (
    <VehicleFillScreen
      label="Fridge Diesel"
      asset="trailer"
      usage={{
        name: use.trailerNumber,
        // An ended use says when it ran, so two uses of one number are told apart.
        hours: ended === null ? null : `${formatClockTime(ended.startedAt)}–${formatClockTime(ended.endedAt)}`,
        fills: use.reeferDiesel,
      }}
      onLeave={() => { router.back(); }}
      onSave={entry => save(named, entry, setShift)}
      onRemove={fillId => remove(named, fillId, setShift)}
    />
  );
}

interface NamedTrailer { shiftId: string; trailerStartedAt: string; usageState: UsageState }
type Show = (shift: LocalShift | null) => void;

async function save(named: NamedTrailer, entry: FillEntry, show: Show): Promise<void> {
  try {
    settle(await recordReeferDiesel({
      ...named,
      fillId: entry.fillId ?? newLocalId(),
      recordedAt: entry.recordedAt,
      litres: entry.litres,
      note: entry.note,
    }), show);
  } catch (error: unknown) {
    Alert.alert("Couldn't save that", saveFailureMessage(error));
    throw error;
  }
}

async function remove(named: NamedTrailer, fillId: string, show: Show): Promise<void> {
  try {
    settle(await removeReeferDiesel({ ...named, fillId }), show);
  } catch (error: unknown) {
    Alert.alert("Couldn't remove that", saveFailureMessage(error));
    throw error;
  }
}

/** `null`: the trailer this was opened for is no longer in use. Nothing was written. */
function settle(day: LocalShift | null, show: Show): void {
  if (day === null) {
    Alert.alert("Nothing was saved", "That trailer is no longer the one this was opened for.");
    router.dismissTo("/active-shift");
    return;
  }
  show(day);
}
