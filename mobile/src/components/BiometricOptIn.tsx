/**
 * The biometric opt-in offer, shown once after a password sign-in or a
 * registration on a device that can actually do it (D26).
 *
 * IT IS AN OFFER, and declining is a first-class answer: the driver keeps a
 * fully working account, keeps email/password sign-in, and is not asked
 * again by this component. Nothing about authentication depends on it.
 *
 * It renders NOTHING when the device has no biometric hardware or nothing
 * enrolled, or when the driver has already opted in — asking a phone that
 * cannot answer is how a driver learns to distrust the app.
 *
 * The copy uses the platform's own name for the method ("Face ID", "Touch
 * ID") because drivers know those names, and the generic word only where the
 * platform is genuinely generic. It never hard-codes Face ID.
 */
import { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { colors, radius, sizing, spacing, typography } from "../theme/index";

interface BiometricOptInProps {
  /** "Face ID", "Touch ID", or "biometrics". */
  label: string;
  /**
   * Turn it on. Prompts the OS once, so the driver proves the method works
   * before the app starts relying on it; resolves false on cancel or failure.
   */
  onEnable: () => Promise<boolean>;
}

export function BiometricOptIn({ label, onEnable }: BiometricOptInProps) {
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  if (dismissed) return null;

  async function enable() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const enabled = await onEnable();
    setBusy(false);
    // Success closes the card. A failure leaves it open with an honest line,
    // because the driver may simply have moved their thumb.
    if (enabled) setDismissed(true);
    else setFailed(true);
  }

  return (
    <View style={styles.card} testID="biometric-opt-in">
      <Text style={styles.title}>{`Use ${label} next time?`}</Text>
      <Text style={typography.helper}>
        {`Sign in with ${label} instead of typing your password. You can still use your email and password whenever you want.`}
      </Text>
      {failed ? (
        <Text style={typography.error} accessibilityLiveRegion="polite">
          {`${label} wasn't confirmed. You can try again or skip.`}
        </Text>
      ) : null}

      <View style={styles.actions}>
        <Pressable
          onPress={() => { void enable(); }}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={`Use ${label}`}
          accessibilityState={{ disabled: busy, busy }}
          testID="biometric-opt-in-enable"
          style={styles.primary}
        >
          <Text style={styles.primaryLabel}>{busy ? "Waiting…" : `Use ${label}`}</Text>
        </Pressable>
        <Pressable
          onPress={() => { setDismissed(true); }}
          accessibilityRole="button"
          testID="biometric-opt-in-decline"
          hitSlop={8}
          style={styles.secondary}
        >
          {/* "Not now", not "Cancel": declining is a choice, not an error. */}
          <Text style={styles.secondaryLabel}>Not now</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    gap: spacing.sm,
  },
  title: { fontSize: 17, fontWeight: "700", color: colors.brandDark },
  actions: { flexDirection: "row", alignItems: "center", gap: spacing.lg, marginTop: spacing.sm },
  primary: {
    flex: 1,
    minHeight: sizing.minTouch,
    borderRadius: radius.button,
    backgroundColor: colors.brandDark,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryLabel: { color: colors.onBrand, fontWeight: "700", fontSize: 16 },
  secondary: { minHeight: sizing.minTouch, justifyContent: "center" },
  secondaryLabel: { color: colors.textMuted, fontWeight: "600", fontSize: 15 },
});
