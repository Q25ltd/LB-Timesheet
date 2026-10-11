/**
 * Where the signed-in driver's email address stands, and asking for the link
 * that confirms it (D63, stage 2).
 *
 * Companies add drivers by email, and an invitation is shown only to an
 * account that has VERIFIED its address (D24, D63). Phone registration sends
 * no email (D47), so the app asks — through the identity-posture
 * `POST /auth/email-verification`, which can only send to the account's OWN
 * address. Both calls go through `withIdentity`, so an expired identity token
 * is renewed rather than failing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { requestEmailVerification } from "../api/account";
import type { ApiResult } from "../api/client";
import { useAuth } from "./AuthContext";

/** `unknown`: it could not be read — never assumed either way. */
type ConfirmationState = "checking" | "unconfirmed" | "confirmed" | "unknown";

export interface EmailConfirmation {
  state: ConfirmationState;
  /** True once the email has been asked for in this session — the "I've confirmed it" step. */
  sent: boolean;
  /** What happened last, in the driver's words; null when there is nothing to say. */
  message: string | null;
  busy: boolean;
  send: () => void;
  recheck: () => void;
}

function sendFailure(result: ApiResult<unknown>): string {
  if (result.kind === "network") return "No connection. Try again when you have signal.";
  if (result.kind !== "api") return "The email could not be sent. Try again shortly.";
  if (result.status === 429) return "You have asked for several emails. Wait a few minutes and try again.";
  if (result.status === 409) return "Emails cannot be delivered to this address. Check that it is spelled correctly — to change it, contact support@logisticbay.com.";
  return "The email could not be sent. Try again shortly.";
}

export function useEmailConfirmation(email: string, onConfirmed?: () => void): EmailConfirmation {
  const { withIdentity, refreshAccount } = useAuth();
  const [state, setState] = useState<ConfirmationState>("checking");
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** One request at a time — a double tap is one email, not two. */
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // The same read brings the account's companies up to date (D65).
  const read = useCallback(async (): Promise<ConfirmationState> => {
    const result = await refreshAccount();
    if (result === null) return "unknown";
    return result.emailVerified ? "confirmed" : "unconfirmed";
  }, [refreshAccount]);

  useEffect(() => {
    void read().then(found => { if (mounted.current) setState(found); });
  }, [read]);

  const send = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    void withIdentity(token => requestEmailVerification(token)).then(result => {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      if (result.kind === "ok") {
        setSent(true);
        setMessage(`We have sent a link to ${email}. Open it on this phone or any other device, then tap "I've confirmed it".`);
      } else {
        setMessage(sendFailure(result));
      }
    });
  }, [email, withIdentity]);

  const recheck = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    void read().then(found => {
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      setState(found);
      if (found === "unconfirmed") setMessage("Not confirmed yet. Open the link in the email, then try again.");
      else if (found === "unknown") setMessage("No connection. Try again when you have signal.");
      else {
        setMessage(null);
        // Invitations wait for a confirmed address (D63): whoever shows them reads them again now.
        onConfirmed?.();
      }
    });
  }, [onConfirmed, read]);

  return { state, sent, message, busy, send, recheck };
}
