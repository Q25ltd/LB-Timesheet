/**
 * Add Vehicle: the first vehicle, into a day that is already running.
 *
 * A driver books on at 06:00 and is handed a truck at 08:00 (D29). The day
 * began without one; this puts that truck into it. It asks the three vehicle
 * questions Start Shift asks — class, number plate, start mileage — through
 * the same fields and the same rules (`vehicleForm.tsx`), and nothing else:
 * no time, no trailer, no checks.
 *
 * Adding is local. The vehicle is written into the open shift on the phone
 * and no request is made (D28), so it works in a yard with no signal.
 *
 * It does NOT check the vehicle. Vehicle checks are still not completed the
 * moment a vehicle arrives, and nothing here pretends otherwise.
 */
import { useRef, useState } from "react";
import { View, Text, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PrimaryButton } from "../components/PrimaryButton";
import type { VehicleClass, VehicleDetails } from "../shift/localShift";
import {
  BackButton,
  VehicleFields,
  formStyles,
  keyboardSafeScrollProps,
  vehicleDetailsFrom,
} from "./vehicleForm";
import { spacing } from "../theme/index";

interface AddVehicleScreenProps {
  onBack: () => void;
  /**
   * Store the vehicle. Resolves once it is written; rejects if it could not
   * be, in which case the form stays open and can be submitted again.
   */
  onAdd: (vehicle: VehicleDetails) => Promise<void>;
}

export function AddVehicleScreen({ onBack, onAdd }: AddVehicleScreenProps) {
  const insets = useSafeAreaInsets();
  const [vehicleClass, setVehicleClass] = useState<VehicleClass | null>(null);
  const [numberPlate, setNumberPlate] = useState("");
  const [mileage, setMileage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  /**
   * ONE SUBMISSION, however many taps. State is not enough on its own: taps
   * landing in the same frame all see `submitting` still false, because the
   * re-render that disables the button has not happened yet. A ref flips
   * synchronously on the first tap, so the second finds it already set.
   */
  const inFlight = useRef(false);

  const vehicle = vehicleDetailsFrom(vehicleClass, numberPlate, mileage);

  function add() {
    if (vehicle === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    // On success the route navigates away, so there is nothing to reset. On
    // failure nothing was stored, and the driver can simply try again.
    onAdd(vehicle).then(undefined, () => {
      inFlight.current = false;
      setSubmitting(false);
    });
  }

  return (
    <View style={formStyles.screen}>
      <ScrollView
        testID="add-vehicle-scroll"
        style={formStyles.screen}
        contentContainerStyle={[
          formStyles.content,
          { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.xxl },
        ]}
        // Keeps Number plate and Start mileage above the keyboard, exactly as
        // Start Shift does — see `keyboardSafeScrollProps`.
        {...keyboardSafeScrollProps}
      >
        <BackButton testID="add-vehicle-back" onPress={onBack} />

        <Text style={formStyles.title} testID="screen-title" accessibilityRole="header">Add Vehicle</Text>

        <VehicleFields
          vehicleClass={vehicleClass}
          onVehicleClass={setVehicleClass}
          numberPlate={numberPlate}
          onNumberPlate={setNumberPlate}
          mileage={mileage}
          onMileage={setMileage}
        />

        <View style={formStyles.action}>
          <PrimaryButton
            label="Add Vehicle"
            onPress={add}
            disabled={vehicle === null}
            submitting={submitting}
            testID="add-vehicle-submit"
          />
        </View>
      </ScrollView>
    </View>
  );
}
