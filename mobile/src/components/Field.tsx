/**
 * One labelled text field, with the error slot the design needs.
 *
 * The error is rendered UNDER the field and the field's border turns red, so
 * the failure is visible both to someone scanning colour and to someone
 * reading text. `accessibilityLabel` carries the error too, because a screen
 * reader user cannot see the red border at all.
 */
import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, type TextInputProps } from "react-native";
import { colors, radius, sizing, spacing, typography } from "../theme/index";

interface FieldProps extends Omit<TextInputProps, "style"> {
  label: string;
  error?: string | undefined;
  /** Renders the show/hide control and starts obscured. */
  secure?: boolean;
  helper?: string | undefined;
}

export function Field({ label, error, secure = false, helper, ...input }: FieldProps) {
  const [revealed, setRevealed] = useState(false);
  const [focused, setFocused] = useState(false);
  const hasError = error !== undefined && error !== "";

  return (
    <View style={styles.wrapper}>
      <Text style={typography.label}>{label.toUpperCase()}</Text>
      <View
        style={[
          styles.control,
          focused && styles.controlFocused,
          hasError && styles.controlError,
        ]}
      >
        <TextInput
          {...input}
          style={styles.input}
          placeholderTextColor={colors.placeholder}
          secureTextEntry={secure && !revealed}
          onFocus={() => { setFocused(true); }}
          onBlur={() => { setFocused(false); }}
          accessibilityLabel={hasError ? `${label}. ${error}` : label}
          // A password manager must not be fought with, and autocorrect on an
          // email or a name produces wrong data the driver will not notice.
          autoCorrect={false}
          spellCheck={false}
        />
        {secure ? (
          <Pressable
            onPress={() => { setRevealed(current => !current); }}
            style={styles.reveal}
            accessibilityRole="button"
            accessibilityLabel={revealed ? "Hide password" : "Show password"}
            testID="toggle-password-visibility"
            // The tap target is padded well beyond the glyph: this control
            // sits at the edge of a 56pt field and is pressed in a hurry.
            hitSlop={12}
          >
            <Text style={styles.revealText}>{revealed ? "Hide" : "Show"}</Text>
          </Pressable>
        ) : null}
      </View>
      {hasError ? (
        <Text style={typography.error} accessibilityLiveRegion="polite">{error}</Text>
      ) : helper !== undefined ? (
        <Text style={typography.helper}>{helper}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: spacing.xs, marginBottom: spacing.lg },
  control: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: sizing.control,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.field,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
  },
  controlFocused: { borderColor: colors.borderFocus },
  controlError:   { borderColor: colors.danger, backgroundColor: colors.dangerBg },
  input: { flex: 1, ...typography.input, paddingVertical: spacing.md },
  reveal: { paddingLeft: spacing.md, minHeight: sizing.minTouch, justifyContent: "center" },
  revealText: { color: colors.brandLight, fontWeight: "600", fontSize: 15 },
});
