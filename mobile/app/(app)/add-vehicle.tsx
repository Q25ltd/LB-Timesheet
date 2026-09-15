/**
 * The Add Vehicle route. Wiring only.
 *
 * A Stack sibling of the tab group, like Start Shift and Active Shift, so it
 * shows no tab bar and sits inside the `(app)` gate.
 *
 * ONLY FOR A DAY WITH NO VEHICLE. Reached with no open shift, there is nothing
 * to add to; reached for a day that already has a vehicle, adding would be
 * replacing — the Change flow's job, with an end mileage for the old one. In
 * either case the driver is sent where the day actually is, rather than shown
 * a form that cannot do what it says.
 */
import { useEffect, useState } from "react";
import { Alert } from "react-native";
import { Redirect, router } from "expo-router";
import { AddVehicleScreen } from "../../src/screens/AddVehicleScreen";
import { Restoring } from "../../src/components/Restoring";
import { addVehicleToOpenShift, readOpenShift, type VehicleDetails } from "../../src/shift/localShift";

type Where = "loading" | "no-shift" | "has-vehicle" | "ready";

export default function AddVehicleRoute() {
  const [where, setWhere] = useState<Where>("loading");

  useEffect(() => {
    let cancelled = false;
    void readOpenShift().then(open => {
      if (cancelled) return;
      if (open === null) setWhere("no-shift");
      else setWhere(open.vehicle === null ? "ready" : "has-vehicle");
    });
    return () => { cancelled = true; };
  }, []);

  if (where === "loading") return <Restoring />;
  if (where === "no-shift") return <Redirect href="/today" />;
  if (where === "has-vehicle") return <Redirect href="/active-shift" />;

  return <AddVehicleScreen onBack={() => { router.back(); }} onAdd={add} />;
}

/**
 * Write the vehicle, then return to the day.
 *
 * The moment of the press is recorded as the vehicle's `startedAt` — when
 * its use in the day began; see `LocalVehicle`. `dismissTo` rather than `back`: it lands on Active Shift
 * whether this screen was opened from there or reached some other way, and
 * never leaves the form behind the back gesture.
 */
async function add(vehicle: VehicleDetails): Promise<void> {
  try {
    const shift = await addVehicleToOpenShift({ vehicle, startedAt: new Date() });
    // The day was discarded or finished while this form was open.
    if (shift === null) { router.replace("/today"); return; }
    router.dismissTo("/active-shift");
  } catch (error: unknown) {
    Alert.alert("Couldn't add the vehicle", "Nothing was changed. Please try again.");
    throw error;
  }
}
