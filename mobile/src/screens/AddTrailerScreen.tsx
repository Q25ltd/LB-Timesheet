/**
 * Add Trailer — a trailer into a day that has none in use (D34).
 *
 * Two questions, the trailer's number and whether it is refrigerated, and one
 * button. No mileage, no checks, no fridge diesel: diesel is recorded once the
 * trailer exists, and Trailer Checks are their own workflow. Nothing is stored
 * until the button is pressed, and one press stores one trailer.
 */
import { useRef, useState } from "react";
import { View, Text, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PrimaryButton } from "../components/PrimaryButton";
import type { TrailerDetails, TrailerType } from "../shift/trailer";
import { BackButton, formStyles, keyboardSafeScrollProps } from "./vehicleForm";
import { TrailerFields, trailerDetailsFrom } from "./trailerForm";
import { spacing } from "../theme/index";

interface AddTrailerScreenProps {
  onBack: () => void;
  /** Store the trailer. Rejects if it could not be stored; the form stays open. */
  onAdd: (trailer: TrailerDetails) => Promise<void>;
}

export function AddTrailerScreen({ onBack, onAdd }: AddTrailerScreenProps) {
  const insets = useSafeAreaInsets();
  const [trailerNumber, setTrailerNumber] = useState("");
  const [trailerType, setTrailerType] = useState<TrailerType | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** ONE trailer, however many taps — set synchronously, before any re-render. */
  const inFlight = useRef(false);

  const trailer = trailerDetailsFrom(trailerNumber, trailerType);

  function add() {
    if (trailer === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    onAdd(trailer).then(undefined, () => {
      inFlight.current = false;
      setSubmitting(false);
    });
  }

  return (
    <View style={formStyles.screen}>
      <ScrollView
        testID="add-trailer-scroll"
        style={formStyles.screen}
        contentContainerStyle={[
          formStyles.content,
          { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.xxl },
        ]}
        {...keyboardSafeScrollProps}
      >
        <BackButton testID="add-trailer-back" onPress={onBack} />
        <Text style={formStyles.title} testID="screen-title" accessibilityRole="header">Add Trailer</Text>

        <TrailerFields
          trailerNumber={trailerNumber}
          onTrailerNumber={setTrailerNumber}
          trailerType={trailerType}
          onTrailerType={setTrailerType}
        />

        <View style={formStyles.action}>
          <PrimaryButton
            label="Add Trailer"
            onPress={add}
            disabled={trailer === null}
            submitting={submitting}
            testID="add-trailer-submit"
          />
        </View>
      </ScrollView>
    </View>
  );
}
