/**
 * One text field, with the error slot the design needs.
 *
 * There is no VISIBLE label — the placeholder carries the name, as the
 * reference design does. That is not a shortcut: five visible labels cost
 * roughly 120pt of height, which is the difference between this form fitting
 * a phone screen and scrolling. `label` is still required and still reaches
 * assistive technology through `accessibilityLabel`, so nothing is lost to a
 * screen reader.
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
  /**
   * Secondary text shown INSIDE the field, on a second line beneath the
   * input. Inside rather than below because a helper line sitting between
   * two inputs reads as a gap in the form rather than as part of the field
   * it describes.
   *
   * Suppressed while `error` is set — the error occupies the same role, and
   * showing both says the same thing twice.
   */
  helper?: string | undefined;
  /** Distinct per field: two password fields must not share a testID. */
  revealTestID?: string;
  /** Identifies the bordered container, so a test can assert what is inside it. */
  controlTestID?: string;
}

export function Field({
  label, error, secure = false, helper,
  revealTestID = "toggle-password-visibility",
  controlTestID,
  ...input
}: FieldProps) {
  const [revealed, setRevealed] = useState(false);
  const [focused, setFocused] = useState(false);
  const hasError = error !== undefined && error !== "";
  const inlineHelper = !hasError && helper !== undefined && helper !== "";

  // The helper is folded into the input's accessible name rather than left
  // as a separate node: a screen reader should hear the requirement while
  // focused on the box it applies to, and hear it once.
  const accessibleName = hasError ? `${label}. ${error}`
    : inlineHelper ? `${label}. ${helper}`
    : label;

  return (
    <View style={styles.wrapper}>
      <View
        testID={controlTestID}
        style={[
          styles.control,
          // Two lines of content need vertical breathing room; a single-line
          // field keeps its exact fixed height so nothing else on the screen
          // moves.
          inlineHelper ? styles.controlStacked : styles.controlSingleLine,
          focused && styles.controlFocused,
          hasError && styles.controlError,
        ]}
      >
        <View style={styles.stack}>
          <TextInput
            {...input}
            style={styles.input}
            placeholderTextColor={colors.placeholder}
            secureTextEntry={secure && !revealed}
            onFocus={() => { setFocused(true); }}
            onBlur={() => { setFocused(false); }}
            accessibilityLabel={accessibleName}
            // A password manager must not be fought with, and autocorrect on an
            // email or a name produces wrong data the driver will not notice.
            autoCorrect={false}
            spellCheck={false}
          />
          {inlineHelper ? (
            // Not independently accessible: it is already part of the
            // input's name above, and announcing it twice is noise.
            <Text style={styles.helperInside} accessible={false}>{helper}</Text>
          ) : null}
        </View>
        {secure ? (
          <Pressable
            onPress={() => { setRevealed(current => !current); }}
            style={styles.reveal}
            accessibilityRole="button"
            accessibilityLabel={revealed ? "Hide password" : "Show password"}
            testID={revealTestID}
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
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: spacing.xs, marginBottom: spacing.md },
  control: {
    flexDirection: "row",
    // Centred, so "Show" sits on the optical middle of a one- or two-line
    // field without being positioned by hand for each case.
    alignItems: "center",
    minHeight: sizing.control,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.field,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
  },
  // A single-line field is pinned to exactly the control height, so adding
  // the inline helper to ONE field cannot shift the others.
  controlSingleLine: { maxHeight: sizing.control },
  // Two lines: the padding is what makes the box taller, not a magic height.
  // 12 keeps the two-line box visually balanced against its single-line
  // neighbours without drifting far from their 52pt.
  controlStacked: { paddingVertical: spacing.md },
  /** The input and its helper, stacked; `flex: 1` keeps "Show" at the edge. */
  stack: { flex: 1, justifyContent: "center" },
  helperInside: { fontSize: 12, lineHeight: 15, color: colors.textMuted, marginTop: 1 },
  controlFocused: { borderColor: colors.borderFocus },
  controlError:   { borderColor: colors.danger, backgroundColor: colors.dangerBg },
  input: { ...typography.input, paddingVertical: 0 },
  reveal: { paddingLeft: spacing.md, minHeight: sizing.minTouch, justifyContent: "center" },
  revealText: { color: colors.brandLight, fontWeight: "600", fontSize: 15 },
});
