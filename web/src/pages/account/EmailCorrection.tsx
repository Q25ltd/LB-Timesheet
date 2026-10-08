import { useState, type FormEvent } from "react";
import { useAuth } from "../../auth/AuthProvider";
import type { EmailDeliveryProblem } from "../../auth/responses";
import { Field, FormMessage } from "../../components/Field";
import { failureText } from "./failureText";

type Message = { tone: "error" | "success"; text: string } | null;

const PROBLEM_TEXT: Record<EmailDeliveryProblem, (email: string) => string> = {
  hard_bounce: email => `Email could not be delivered to ${email}. The address may be mistyped or no longer exist.`,
  complaint:   email => `Email to ${email} was reported to us as spam, so we have stopped sending to it.`,
};

/**
 * Correcting the account's OWN email address (D56): a new address and the
 * password, nothing else. The server decides whether a correction is
 * allowed; this is shown where it would be — a registration waiting for its
 * link, or an address SES reported as a problem. Open from the start when
 * there is a known problem; one button away otherwise.
 */
export function EmailCorrection({ email, problem }: { email: string; problem: EmailDeliveryProblem | null }) {
  const auth = useAuth();
  const [open, setOpen] = useState(problem !== null);
  const [form, setForm] = useState({ email: "", password: "" });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const corrected = form.email.trim();
    const outcome = await auth.correctEmail(corrected, form.password);
    setBusy(false);
    if (outcome.ok) {
      setForm({ email: "", password: "" });
      setOpen(false);
      setMessage({ tone: "success", text: `Your email address is corrected. We have sent a new link to ${corrected.toLowerCase()}.` });
      return;
    }
    setMessage({ tone: "error", text: outcome.failure === "forbidden" ? "Your password is incorrect." : failureText(outcome.failure) });
  }

  return (
    <div className="email-correction">
      {problem === null ? null : <p className="email-correction__problem">{PROBLEM_TEXT[problem](email)}</p>}
      {message === null ? null : <FormMessage tone={message.tone}>{message.text}</FormMessage>}
      {open ? (
        <form className="auth-form" onSubmit={event => void submit(event)} noValidate>
          <Field label="Correct email address" type="email" name="email" autoComplete="email" required maxLength={320}
            value={form.email} onChange={event => setForm(f => ({ ...f, email: event.target.value }))} />
          <Field label="Password" type="password" name="currentPassword" autoComplete="current-password" required
            value={form.password} onChange={event => setForm(f => ({ ...f, password: event.target.value }))} />
          <button className="button button--secondary auth-form__submit" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Use this address"}
          </button>
        </form>
      ) : (
        <button className="auth-card__inline-button" type="button" onClick={() => setOpen(true)}>Use a different email address</button>
      )}
    </div>
  );
}
