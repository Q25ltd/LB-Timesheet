import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useAuth } from "../../auth/AuthProvider";
import { Field, FormMessage } from "../../components/Field";
import { PATHS } from "../../paths";
import { AuthPanel } from "./AuthPanel";
import { failureText } from "./failureText";

/**
 * How this browser signed out, if it just did. Logout always completes
 * locally; this says truthfully whether the server confirmed it too.
 */
const SIGNED_OUT = {
  "confirmed":  "You have signed out.",
  "local-only": "You are signed out on this device, but we could not reach the server to end the session.",
} as const;

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const ended = auth.state.status === "signed-out" ? auth.state.ended : undefined;
  const note = ended === undefined ? null : SIGNED_OUT[ended];
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void auth.restore(); }, [auth]);
  useEffect(() => {
    if (auth.state.status === "signed-in") void navigate(auth.state.company === null ? PATHS.account : PATHS.company, { replace: true });
  }, [auth.state, navigate]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const outcome = await auth.login({ email, password });
    setBusy(false);
    // One message for a wrong email and a wrong password: the API does not
    // say which, and neither does this page.
    if (!outcome.ok) setError(outcome.failure === "credentials" ? "Email or password is incorrect." : failureText(outcome.failure));
  }

  return (
    <AuthPanel title="Sign in">
      <form className="auth-form" onSubmit={event => void submit(event)} noValidate>
        {error === null && note !== null ? <FormMessage tone="info">{note}</FormMessage> : null}
        {error === null ? null : <FormMessage tone="error">{error}</FormMessage>}
        <Field label="Email" type="email" name="email" autoComplete="username" required maxLength={320}
          value={email} onChange={event => setEmail(event.target.value)} />
        <Field label="Password" type="password" name="password" autoComplete="current-password" required
          value={password} onChange={event => setPassword(event.target.value)} />
        <button className="button button--primary auth-form__submit" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="auth__links">
        <Link to={PATHS.forgotPassword}>Forgotten your password?</Link>
        <Link to={PATHS.register}>Create an account</Link>
      </p>
    </AuthPanel>
  );
}
