import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useAuth } from "../../auth/AuthProvider";
import { confirmEmail, type PublicOutcome } from "../../auth/publicFlows";
import { useLinkToken } from "../../auth/useLinkToken";
import { FormMessage } from "../../components/Field";
import { PATHS } from "../../paths";
import { AuthPanel } from "./AuthPanel";

const MESSAGES: Record<Exclude<PublicOutcome, "done">, string> = {
  "invalid-link": "This link is invalid or has expired. Sign in and send a new one from your account page.",
  "rejected":     "This link is invalid or has expired. Sign in and send a new one from your account page.",
  "rate-limited": "Too many attempts. Please wait a while and try again.",
  "offline":      "We could not reach LogisticBay Timesheets. Check your connection and open the link again.",
  "unexpected":   "Something went wrong. Please open the link again.",
};

/** Where the verification email's link lands (D47). The token is posted once. */
export function VerifyEmailPage() {
  const auth = useAuth();
  const token = useLinkToken();
  const [outcome, setOutcome] = useState<PublicOutcome | null>(null);
  const sent = useRef(false);

  useEffect(() => {
    if (token === undefined || sent.current) return;
    sent.current = true;
    if (token === null) {
      setOutcome("invalid-link");
      return;
    }
    void confirmEmail(token).then(result => {
      setOutcome(result);
      // A signed-in tab now shows the account as verified.
      if (result === "done" && auth.state.status === "signed-in") void auth.reloadAccount();
    });
  }, [auth, token]);

  return (
    <AuthPanel title="Confirm your email address">
      {outcome === null ? <p className="auth__intro" role="status">Confirming…</p> : null}
      {outcome === "done" ? <FormMessage tone="success">Your email address is confirmed.</FormMessage> : null}
      {outcome !== null && outcome !== "done" ? <FormMessage tone="error">{MESSAGES[outcome]}</FormMessage> : null}
      {outcome === null ? null : (
        <p className="auth__links">
          <Link to={PATHS.account}>Go to your account</Link>
        </p>
      )}
    </AuthPanel>
  );
}
