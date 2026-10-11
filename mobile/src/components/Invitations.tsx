/**
 * A company's invitations on Home (D63, stage 5): Accept, Decline, Not now.
 *
 * Shown only for a driver whose email address is confirmed — the server
 * answers `EMAIL_NOT_VERIFIED` otherwise, and the Confirm your email card is
 * the next step, so nothing is shown here. Each invitation says who invited,
 * as whom (the names the company typed), until when, and what that company
 * will see. Accepting joins it and reads the account again, so the company
 * is offered under Working for at Start Shift at once. Declining asks first
 * and says the company will see it (owner decision, 2026-10-11). Not now
 * asks the server nothing: the invitation stays open and returns next time.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { acceptInvitation, declineInvitation, listInvitations, type DriverInvitation } from "../api/account";
import type { ApiResult } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { colors, radius, spacing, typography } from "../theme";
import { PrimaryButton } from "./PrimaryButton";

function expiryOf(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function failure(result: Exclude<ApiResult<unknown>, { kind: "ok" }>, what: "accept" | "decline"): string {
  if (result.kind === "network") return "No connection. Nothing was changed — try again when you have signal.";
  if (result.status === 409 || result.status === 404) return "That invitation is no longer open — it was answered, cancelled or it expired.";
  return what === "accept"
    ? "The invitation could not be accepted just now. Nothing was changed — try again shortly."
    : "The invitation could not be declined just now. Nothing was changed — try again shortly.";
}

export function Invitations() {
  const { withIdentity, reloadAccount } = useAuth();
  const [invitations, setInvitations] = useState<DriverInvitation[]>([]);
  const [later, setLater] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** One answer at a time — a double tap is one request. */
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const read = useCallback(async () => {
    const result = await withIdentity(token => listInvitations(token));
    // Not confirmed, offline or refused: nothing to answer here, and nothing guessed.
    if (mounted.current) setInvitations(result.kind === "ok" ? result.value.invitations : []);
  }, [withIdentity]);

  useEffect(() => { void read(); }, [read]);

  const answer = useCallback((invitation: DriverInvitation, what: "accept" | "decline") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    void (async () => {
      const result = what === "accept"
        ? await withIdentity(token => acceptInvitation(token, invitation.id))
        : await withIdentity(token => declineInvitation(token, invitation.id));
      if (result.kind === "ok" && what === "accept") await reloadAccount();
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      setConfirming(null);
      if (result.kind === "ok") {
        setInvitations(previous => previous.filter(i => i.id !== invitation.id));
        setMessage(what === "accept"
          ? `You have joined ${invitation.companyName}. Choose it under Working for when you start a shift.`
          : `You declined the invitation from ${invitation.companyName}.`);
        return;
      }
      setMessage(failure(result, what));
      if (result.kind === "api" && (result.status === 409 || result.status === 404)) await read();
    })();
  }, [read, reloadAccount, withIdentity]);

  const shown = invitations.filter(invitation => !later.has(invitation.id));
  if (shown.length === 0 && message === null) return null;

  return (
    <View style={styles.wrap} testID="invitations">
      {message === null ? null : <Text style={styles.message} testID="invitations-message" accessibilityLiveRegion="polite">{message}</Text>}
      {shown.map(invitation => {
        const id = invitation.id;
        return (
          <View key={id} style={styles.card} testID={`invitation-${id}`}>
            <Text style={styles.title} accessibilityRole="header">Invitation from {invitation.companyName}</Text>
            <Text style={styles.body} testID={`invitation-${id}-text`}>
              {`${invitation.companyName} has added you as a driver, as ${invitation.firstName} ${invitation.lastName}.`}
            </Text>
            <Text style={styles.body} testID={`invitation-${id}-privacy`}>
              If you accept, they will see your name and email address — nothing about other companies or your own records.
            </Text>
            <Text style={styles.expiry} testID={`invitation-${id}-expiry`}>{`Open until ${expiryOf(invitation.expiresAt)}`}</Text>
            {confirming === id ? (
              <View style={styles.actions}>
                <Text style={styles.confirm} testID={`invitation-${id}-confirm`}>
                  {`${invitation.companyName} will see that you declined. Decline the invitation?`}
                </Text>
                <PrimaryButton label="Decline" onPress={() => { answer(invitation, "decline"); }} submitting={busy} testID={`invitation-${id}-decline-confirm`} />
                <PrimaryButton label="Keep it" onPress={() => { setConfirming(null); }} disabled={busy} testID={`invitation-${id}-keep`} />
              </View>
            ) : (
              <View style={styles.actions}>
                <PrimaryButton label="Accept" onPress={() => { answer(invitation, "accept"); }} submitting={busy} testID={`invitation-${id}-accept`} />
                <PrimaryButton label="Decline" onPress={() => { setConfirming(id); }} disabled={busy} testID={`invitation-${id}-decline`} />
                <PrimaryButton
                  label="Not now"
                  onPress={() => { setLater(previous => new Set([...previous, id])); }}
                  disabled={busy}
                  testID={`invitation-${id}-later`}
                />
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap:    { gap: spacing.md, marginBottom: spacing.lg },
  card:    { backgroundColor: colors.surfaceAccent, borderRadius: radius.card, padding: spacing.lg, gap: spacing.sm },
  title:   { fontSize: 17, fontWeight: "700", color: colors.brandDark },
  body:    { ...typography.subtitle, fontSize: 15, color: colors.text },
  expiry:  { ...typography.helper },
  confirm: { fontSize: 15, fontWeight: "600", color: colors.text },
  actions: { gap: spacing.sm, marginTop: spacing.xs },
  message: { fontSize: 15, color: colors.text },
});
