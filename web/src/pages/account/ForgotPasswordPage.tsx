import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { requestPasswordReset } from "../../auth/publicFlows";
import { Field, FormMessage } from "../../components/Field";
import { PATHS } from "../../paths";
import { AuthPanel } from "./AuthPanel";

/**
 * Asks for a reset email. The answer is the same whether or not the address
 * has an account (D49) — and so is this page's message.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "sent" | "rate-limited" | "offline" | "error">("idle");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (state === "busy") return;
    setState("busy");
    const outcome = await requestPasswordReset(email.trim());
    setState(outcome === "done" ? "sent" : outcome === "rate-limited" ? "rate-limited" : outcome === "offline" ? "offline" : "error");
  }

  return (
    <AuthPanel title="Reset your password" intro="Enter the email address of your account. If it has an account, we will send it a link to choose a new password.">
      {state === "sent" ? (
        <FormMessage tone="success">If that address has an account, a reset link is on its way. It works once and expires in 30 minutes.</FormMessage>
      ) : (
        <form className="auth-form" onSubmit={event => void submit(event)} noValidate>
          {state === "rate-limited" ? <FormMessage tone="error">Too many requests. Please wait a while and try again.</FormMessage> : null}
          {state === "offline" ? <FormMessage tone="error">We could not reach LogisticBay Timesheets. Check your connection and try again.</FormMessage> : null}
          {state === "error" ? <FormMessage tone="error">Please enter a valid email address.</FormMessage> : null}
          <Field label="Email" type="email" name="email" autoComplete="username" required maxLength={320}
            value={email} onChange={event => setEmail(event.target.value)} />
          <button className="button button--primary auth-form__submit" type="submit" disabled={state === "busy"}>
            {state === "busy" ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}
      <p className="auth__links">
        <Link to={PATHS.login}>Back to sign in</Link>
      </p>
    </AuthPanel>
  );
}
