/**
 * "Confirm your email address" (D63, stage 2).
 *
 * Home: a card shown ONLY while the address is unconfirmed — a confirmed
 * driver sees nothing, and a status that could not be read is not nagged
 * about. Settings: a line that always says where the address stands, with the
 * same action while it is unconfirmed.
 */
import { StyleSheet, Text, View } from "react-native";
import { useAuth } from "../auth/AuthContext";
import { useEmailConfirmation } from "../auth/useEmailConfirmation";
import { colors, radius, spacing, typography } from "../theme";
import { PrimaryButton } from "./PrimaryButton";

export function EmailConfirmation({ variant, onConfirmed }: { variant: "home" | "settings"; onConfirmed?: () => void }) {
  const { account } = useAuth();
  const email = account?.user.email ?? "";
  const confirmation = useEmailConfirmation(email, onConfirmed);
  const { state, sent, message, busy, send, recheck } = confirmation;

  if (account === null) return null;

  if (variant === "settings") {
    const label = state === "confirmed" ? "Confirmed" : state === "unconfirmed" ? "Not confirmed" : state === "checking" ? "Checking…" : "Could not be checked";
    return (
      <View style={styles.settings} testID="email-confirmation">
        <View style={styles.settingsRow}>
          <Text style={styles.settingsLabel}>Email confirmation</Text>
          <Text style={styles.settingsValue} testID="email-confirmation-state">{label}</Text>
        </View>
        {state === "unconfirmed" ? <Actions sent={sent} busy={busy} send={send} recheck={recheck} /> : null}
        {state === "unknown" ? <PrimaryButton label="Check again" onPress={recheck} submitting={busy} testID="email-confirmation-recheck" /> : null}
        {message === null ? null : <Text style={styles.message} testID="email-confirmation-message" accessibilityLiveRegion="polite">{message}</Text>}
      </View>
    );
  }

  if (state !== "unconfirmed") return null;
  return (
    <View style={styles.card} testID="email-confirmation">
      <Text style={styles.title} accessibilityRole="header">Confirm your email address</Text>
      <Text style={styles.body} testID="email-confirmation-why">
        Companies can add you as a driver by your email address. Once it is confirmed, their invitations will appear here.
      </Text>
      <Text style={styles.address} testID="email-confirmation-address">{email}</Text>
      <Actions sent={sent} busy={busy} send={send} recheck={recheck} />
      {message === null ? null : <Text style={styles.message} testID="email-confirmation-message" accessibilityLiveRegion="polite">{message}</Text>}
    </View>
  );
}

function Actions({ sent, busy, send, recheck }: { sent: boolean; busy: boolean; send: () => void; recheck: () => void }) {
  return (
    <View style={styles.actions}>
      {sent
        ? <PrimaryButton label="I've confirmed it" onPress={recheck} submitting={busy} testID="email-confirmation-recheck" />
        : null}
      <PrimaryButton
        label={sent ? "Send the email again" : "Send confirmation email"}
        onPress={send}
        submitting={busy}
        testID="email-confirmation-send"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card:          { backgroundColor: colors.surfaceAccent, borderRadius: radius.card, padding: spacing.lg, gap: spacing.sm, marginBottom: spacing.lg },
  title:         { fontSize: 17, fontWeight: "700", color: colors.brandDark },
  body:          { ...typography.subtitle, fontSize: 15, color: colors.text },
  address:       { fontSize: 15, fontWeight: "600", color: colors.text },
  actions:       { gap: spacing.sm, marginTop: spacing.xs },
  message:       { ...typography.helper, color: colors.text },
  settings:      { gap: spacing.sm, paddingVertical: spacing.sm },
  settingsRow:   { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  settingsLabel: { fontSize: 16, color: colors.text },
  settingsValue: { fontSize: 16, color: colors.textMuted },
});
