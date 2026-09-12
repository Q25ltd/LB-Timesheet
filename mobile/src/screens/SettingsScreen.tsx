/**
 * Settings — and unlike its two neighbours, this one is real.
 *
 * Everything on it already exists: the account comes from the authenticated
 * session, the biometric preference is the one `AuthProvider` already owns, and
 * Sign out is the same call Home used to make. Nothing here is a placeholder,
 * and nothing here is new capability — this screen is where existing
 * capability finally became reachable.
 *
 * SIGN OUT LIVES HERE NOW, and only here. It was a link at the bottom of Home;
 * Home is the driver's operational landing screen and the approved design has
 * no room for account actions on it. Two sign-out controls would be worse than
 * either one, so it moved rather than being duplicated. The behaviour is
 * unchanged: the server is asked first while the token is still valid, and the
 * device is cleared either way, because a driver who taps sign out in a yard
 * with no signal must still be signed out of the phone.
 *
 * THE BIOMETRIC CONTROL IS A PREFERENCE, not a security boundary (D26). Turning
 * it on prompts once, so the driver proves the method works before the app
 * starts relying on it; a refused prompt leaves it OFF rather than showing a
 * switch that claims otherwise. On a device with no hardware or no enrolment
 * there is no switch at all — offering one that cannot work is how a driver
 * learns to distrust the app.
 *
 * Deliberately ABSENT, because none of it exists: change password, email
 * verification, delete account, notifications, subscription, company
 * management. A settings row that opens nothing is the same lie as a fake
 * timesheet.
 */
import { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { AppScreen } from "./AppScreen";
import type { AccountUser } from "../api/account";
import type { BiometricCapability } from "../auth/biometrics";
import { colors, radius, sizing, spacing, typography } from "../theme/index";

interface SettingsScreenProps {
  user: AccountUser;
  biometrics: BiometricCapability;
  biometricUnlockEnabled: boolean;
  /** Prompts once; resolves false on cancel or failure. */
  onEnableBiometrics: () => Promise<boolean>;
  onDisableBiometrics: () => Promise<void>;
  onSignOut: () => void;
}

export function SettingsScreen({
  user, biometrics, biometricUnlockEnabled,
  onEnableBiometrics, onDisableBiometrics, onSignOut,
}: SettingsScreenProps) {
  const [busy, setBusy] = useState(false);

  async function toggleBiometrics() {
    if (busy) return;
    setBusy(true);
    // No optimistic flip: the switch follows the PROVIDER, which only reports
    // enabled after the OS prompt succeeded and the preference was stored.
    if (biometricUnlockEnabled) await onDisableBiometrics();
    else await onEnableBiometrics();
    setBusy(false);
  }

  return (
    <AppScreen title="Settings">
      <Section label="Account">
        <Row label="Name" value={`${user.firstName} ${user.lastName}`} valueTestID="account-name" />
        <Row label="Email" value={user.email} valueTestID="account-email" last />
      </Section>

      <Section label="Security">
        {biometrics.available ? (
          <Pressable
            testID="biometric-toggle"
            onPress={() => { void toggleBiometrics(); }}
            disabled={busy}
            accessibilityRole="switch"
            accessibilityLabel={`Unlock with ${biometrics.label}`}
            accessibilityState={{ checked: biometricUnlockEnabled, disabled: busy, busy }}
            style={styles.row}
          >
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>{`Unlock with ${biometrics.label}`}</Text>
              <Text style={typography.helper}>
                {biometricUnlockEnabled
                  ? "You'll be asked for this when you open the app."
                  : "Open the app without typing your password."}
              </Text>
            </View>
            {/* A drawn switch rather than RN's Switch: the platform control
                cannot take the brand palette on both platforms, and this one
                is read from the provider like everything else here. */}
            <View style={[styles.track, biometricUnlockEnabled ? styles.trackOn : null]}>
              <View style={[styles.knob, biometricUnlockEnabled ? styles.knobOn : null]} />
            </View>
          </Pressable>
        ) : (
          <View style={styles.row} testID="biometric-unavailable">
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>Biometric unlock</Text>
              <Text style={typography.helper}>
                This phone has no fingerprint or face unlock set up, so it can&apos;t be used here.
              </Text>
            </View>
          </View>
        )}
      </Section>

      <Pressable
        testID="sign-out"
        onPress={onSignOut}
        accessibilityRole="button"
        accessibilityLabel="Sign out"
        style={styles.signOut}
      >
        <Text style={styles.signOutLabel}>Sign out</Text>
      </Pressable>
    </AppScreen>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label.toUpperCase()}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Row({ label, value, valueTestID, last = false }: {
  label: string; value: string; valueTestID: string; last?: boolean;
}) {
  return (
    <View style={[styles.row, last ? null : styles.rowDivided]}>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
      </View>
      <Text style={styles.rowValue} testID={valueTestID} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: spacing.xl },
  sectionLabel: {
    ...typography.label,
    letterSpacing: 1,
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.lg,
    minHeight: sizing.control,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  rowDivided: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  // `flexShrink` so a long email truncates instead of pushing the row wide.
  rowText: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 16, fontWeight: "600", color: colors.text },
  rowValue: { ...typography.subtitle, flexShrink: 1, textAlign: "right" },

  track: {
    width: 50,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.border,
    padding: 3,
    justifyContent: "center",
  },
  trackOn: { backgroundColor: colors.brandLight },
  knob: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.surface,
    alignSelf: "flex-start",
  },
  knobOn: { alignSelf: "flex-end" },

  signOut: {
    minHeight: sizing.control,
    borderRadius: radius.button,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.sm,
  },
  signOutLabel: { fontSize: 17, fontWeight: "700", color: colors.danger },
});
