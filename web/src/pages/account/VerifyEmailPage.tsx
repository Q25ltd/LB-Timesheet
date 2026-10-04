import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useAuth } from "../../auth/AuthProvider";
import { confirmEmail, type PublicOutcome } from "../../auth/publicFlows";
import { useLinkToken } from "../../auth/useLinkToken";
import { PATHS } from "../../paths";
import { AuthCard } from "./AuthCard";

type Shown = { outcome: PublicOutcome; companyRegistered: boolean } | null;

/**
 * The emailed link (B4, D51). Opening it confirms the address — and, for a
 * company registration, completes it: the server creates the Company and its
 * initial administrator in the same act. The answer says only what happened;
 * every refused link (used, expired, superseded, tampered) is one message.
 *
 * Signing in is NOT automatic: a browser still signed in to the registration
 * continues to its account; any other is sent to sign in.
 */
export function VerifyEmailPage() {
  const auth = useAuth();
  const token = useLinkToken();
  const [shown, setShown] = useState<Shown>(null);
  const sent = useRef(false);
  const signedIn = auth.state.status === "signed-in";

  useEffect(() => { void auth.restore(); }, [auth]);

  useEffect(() => {
    if (token === undefined || sent.current) return;
    sent.current = true;
    if (token === null) {
      setShown({ outcome: "invalid-link", companyRegistered: false });
      return;
    }
    void confirmEmail(token).then(setShown);
  }, [token]);

  // A tab signed in to the registration now shows the company it created.
  const reloaded = useRef(false);
  useEffect(() => {
    if (shown?.outcome !== "done" || !signedIn || reloaded.current) return;
    reloaded.current = true;
    void auth.reloadAccount();
  }, [auth, shown, signedIn]);

  // A completed company registration continues to the company's Home.
  const next = signedIn
    ? <Link className="button button--primary button--large verify__next" to={shown?.companyRegistered === true ? PATHS.company : PATHS.account}>Continue</Link>
    : <Link className="button button--primary button--large verify__next" to={PATHS.login}>Sign in</Link>;
  const home = <p className="auth-card__switch"><Link to={PATHS.home}>LogisticBay Timesheets home</Link></p>;

  if (shown === null) {
    return (
      <AuthCard title="Confirming your email" intro="Just a moment." footer={home}>
        <p className="verify__line" role="status">Confirming…</p>
      </AuthCard>
    );
  }

  if (shown.outcome === "done" && shown.companyRegistered) {
    return (
      <AuthCard
        title="Your company is registered"
        intro="Your email address is confirmed, and your company is set up on LogisticBay Timesheets."
        footer={home}
      >
        {next}
      </AuthCard>
    );
  }

  if (shown.outcome === "done") {
    return (
      <AuthCard title="Your email address is confirmed" intro="Thank you — this address is confirmed." footer={home}>
        {next}
      </AuthCard>
    );
  }

  if (shown.outcome === "invalid-link" || shown.outcome === "rejected") {
    return (
      <AuthCard
        title="This link has expired or was already used"
        intro="Each link works once, for 24 hours, and a newer link replaces an older one. Sign in to your company account to send a new link."
        footer={home}
      >
        <Link className="button button--primary button--large verify__next" to={signedIn ? PATHS.account : PATHS.login}>
          {signedIn ? "Send a new link" : "Sign in"}
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="We could not confirm your email just now"
      intro={shown.outcome === "rate-limited"
        ? "Too many attempts. Nothing has changed — wait a little, then open the link again."
        : "Nothing has changed, and the link still works. Please open the link again in a moment."}
      footer={home}
    >
      <p className="verify__line">If it keeps happening, check your connection.</p>
    </AuthCard>
  );
}
