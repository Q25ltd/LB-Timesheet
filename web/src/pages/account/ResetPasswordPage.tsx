import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { PASSWORD_RULE, passwordProblem } from "../../auth/passwordRule";
import { resetPassword, type PublicOutcome } from "../../auth/publicFlows";
import { useLinkToken } from "../../auth/useLinkToken";
import { Field, FormMessage } from "../../components/Field";
import { PATHS } from "../../paths";
import { AuthPanel } from "./AuthPanel";

/**
 * Where the reset email's link lands (D49). Choosing a new password here
 * signs the account out on EVERY device, this browser included.
 */
export function ResetPasswordPage() {
  const token = useLinkToken();
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<PublicOutcome | "busy" | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (token == null || outcome === "busy") return;
    const issue = passwordProblem(password) ?? (repeat === password ? null : "The passwords do not match");
    setProblem(issue);
    if (issue !== null) return;
    setOutcome("busy");
    setOutcome(await resetPassword(token, password));
  }

  if (token === null || outcome === "invalid-link") {
    return (
      <AuthPanel title="Reset your password">
        <FormMessage tone="error">This link is invalid or has expired. Ask for a new one.</FormMessage>
        <p className="auth__links"><Link to={PATHS.forgotPassword}>Send a new reset link</Link></p>
      </AuthPanel>
    );
  }

  if (outcome === "done") {
    return (
      <AuthPanel title="Your password has been changed">
        <FormMessage tone="success">Your password has been changed and you have been signed out everywhere. Sign in with your new password.</FormMessage>
        <p className="auth__links"><Link to={PATHS.login}>Sign in</Link></p>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel title="Choose a new password" intro="This signs you out on every device.">
      <form className="auth-form" onSubmit={event => void submit(event)} noValidate>
        {outcome === "offline" ? <FormMessage tone="error">We could not reach LogisticBay Timesheets. Check your connection and try again.</FormMessage> : null}
        {outcome === "rejected" || outcome === "unexpected" ? <FormMessage tone="error">That password could not be used. Please try another.</FormMessage> : null}
        {outcome === "rate-limited" ? <FormMessage tone="error">Too many attempts. Please wait a while and try again.</FormMessage> : null}
        <Field label="New password" type="password" name="password" autoComplete="new-password" required hint={PASSWORD_RULE}
          value={password} error={problem} onChange={event => setPassword(event.target.value)} />
        <Field label="Repeat new password" type="password" name="repeat" autoComplete="new-password" required
          value={repeat} onChange={event => setRepeat(event.target.value)} />
        <button className="button button--primary auth-form__submit" type="submit" disabled={token === undefined || outcome === "busy"}>
          {outcome === "busy" ? "Saving…" : "Save new password"}
        </button>
      </form>
    </AuthPanel>
  );
}
