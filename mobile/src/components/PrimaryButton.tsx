/**
 * The large primary action from the reference design.
 *
 * Disabled and submitting are DIFFERENT states and look different: disabled
 * is "you cannot do this yet", submitting is "this is happening". Collapsing
 * them makes a slow network look like a broken form.
 */
import { Pressable, Text, ActivityIndicator, StyleSheet } from "react-native";
import { colors, radius, sizing, typography } from "../theme/index";

interface PrimaryButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  submitting?: boolean;
  testID?: string;
}

export function PrimaryButton({ label, onPress, disabled = false, submitting = false, testID }: PrimaryButtonProps) {
  const inactive = disabled || submitting;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy: submitting }}
      style={({ pressed }) => [
        styles.button,
        inactive && styles.inactive,
        pressed && !inactive && styles.pressed,
      ]}
    >
      {submitting ? (
        <ActivityIndicator color={colors.onBrand} testID="submitting-indicator" />
      ) : (
        <Text style={typography.button}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: sizing.control,
    borderRadius: radius.button,
    backgroundColor: colors.brandDark,
    alignItems: "center",
    justifyContent: "center",
  },
  inactive: { backgroundColor: colors.disabled },
  pressed:  { backgroundColor: colors.brandDeep },
});
