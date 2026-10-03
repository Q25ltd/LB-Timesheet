/**
 * Correct a number plate or trailer number typed wrong — the vehicle or the
 * trailer IN USE, from its card on Active Shift.
 *
 * Only the name changes. The use keeps its identity, class or type, mileage,
 * fills and checks: this is the same vehicle or trailer, written correctly —
 * a different one is Change Unit / Change Vehicle or Change Trailer. Entered
 * the same way it was first entered: trimmed and upper-cased, never
 * format-checked, and never empty.
 */
import { useRef, useState } from "react";
import { View, Text, TextInput, ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PrimaryButton } from "../components/PrimaryButton";
import { BackButton, FormSection, formStyles, keyboardSafeScrollProps } from "./vehicleForm";
import { colors, spacing, typography } from "../theme/index";

interface CorrectNameScreenProps {
  asset: "vehicle" | "trailer";
  /** The name as stored now. */
  current: string;
  onLeave: () => void;
  /** Store the corrected name. Rejects if it could not be stored; the form stays open. */
  onSave: (value: string) => Promise<void>;
}

export function CorrectNameScreen({ asset, current, onLeave, onSave }: CorrectNameScreenProps) {
  const insets = useSafeAreaInsets();
  const [value, setValue] = useState(current);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const typed = value.trim().toUpperCase();
  const canSave = typed !== "" && typed !== current;
  const title = asset === "vehicle" ? "Correct registration number" : "Correct trailer number";

  function save() {
    if (!canSave || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    onSave(value).then(undefined, () => {
      inFlight.current = false;
      setSubmitting(false);
    });
  }

  return (
    <View style={formStyles.screen}>
      <ScrollView
        style={formStyles.screen}
        contentContainerStyle={[formStyles.content, { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.xxl }]}
        {...keyboardSafeScrollProps}
      >
        <BackButton testID="correct-name-back" onPress={onLeave} />
        <Text style={formStyles.title} testID="screen-title" accessibilityRole="header">{title}</Text>
        <FormSection label={asset === "vehicle" ? "REGISTRATION NUMBER" : "TRAILER NUMBER"}>
          <TextInput
            testID="correct-name-input"
            value={value}
            onChangeText={setValue}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholderTextColor={colors.placeholder}
            style={formStyles.input}
            accessibilityLabel={asset === "vehicle" ? "Registration number" : "Trailer number"}
          />
        </FormSection>
        <Text style={styles.hint} testID="correct-name-hint">
          {`Recorded as ${current}. Only the ${asset === "vehicle" ? "registration number" : "number"} changes — checks, ${asset === "vehicle" ? "mileage and fuel" : "fridge diesel"} stay as they are.`}
        </Text>
        <View style={formStyles.action}>
          <PrimaryButton label="Save" onPress={save} disabled={!canSave} submitting={submitting} testID="correct-name-save" />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  hint: { ...typography.helper, marginTop: -spacing.md, marginBottom: spacing.lg, marginHorizontal: spacing.xs },
});
