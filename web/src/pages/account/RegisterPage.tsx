import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useAuth } from "../../auth/AuthProvider";
import { PASSWORD_RULE, passwordProblem } from "../../auth/passwordRule";
import { Field, FormMessage } from "../../components/Field";
import { PATHS } from "../../paths";
import { AuthPanel } from "./AuthPanel";
import { failureText } from "./failureText";

/**
 * Creating YOUR OWN account (D48 step 1). A company is created afterwards,
 * from the account page, once the email address is confirmed.
 */
export function RegisterPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", password: "", repeat: "" });
  const [problems, setProblems] = useState<Partial<Record<keyof typeof form, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void auth.restore(); }, [auth]);
  useEffect(() => {
    if (auth.state.status === "signed-in") void navigate(PATHS.account, { replace: true });
  }, [auth.state, navigate]);

  function update(key: keyof typeof form, value: string) {
    setForm(current => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const found: Partial<Record<keyof typeof form, string>> = {};
    if (form.firstName.trim() === "") found.firstName = "Enter your first name";
    if (form.lastName.trim() === "") found.lastName = "Enter your last name";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) found.email = "Enter a valid email address";
    const passwordIssue = passwordProblem(form.password);
    if (passwordIssue !== null) found.password = passwordIssue;
    if (form.repeat !== form.password) found.repeat = "The passwords do not match";
    setProblems(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    setError(null);
    // Exactly the four fields the API accepts — built field by field, never
    // by spreading form state (the repeat box is not a request field).
    const outcome = await auth.register({
      firstName: form.firstName,
      lastName:  form.lastName,
      email:     form.email,
      password:  form.password,
    });
    setBusy(false);
    if (!outcome.ok) setError(failureText(outcome.failure));
  }

  return (
    <AuthPanel title="Create your account" intro="Start with your own account. You can set up your company once your email address is confirmed.">
      <form className="auth-form" onSubmit={event => void submit(event)} noValidate>
        {error === null ? null : <FormMessage tone="error">{error}</FormMessage>}
        <Field label="First name" name="firstName" autoComplete="given-name" required maxLength={200}
          value={form.firstName} error={problems.firstName ?? null} onChange={event => update("firstName", event.target.value)} />
        <Field label="Last name" name="lastName" autoComplete="family-name" required maxLength={200}
          value={form.lastName} error={problems.lastName ?? null} onChange={event => update("lastName", event.target.value)} />
        <Field label="Email" type="email" name="email" autoComplete="username" required maxLength={320}
          value={form.email} error={problems.email ?? null} onChange={event => update("email", event.target.value)} />
        <Field label="Password" type="password" name="password" autoComplete="new-password" required hint={PASSWORD_RULE}
          value={form.password} error={problems.password ?? null} onChange={event => update("password", event.target.value)} />
        <Field label="Repeat password" type="password" name="repeat" autoComplete="new-password" required
          value={form.repeat} error={problems.repeat ?? null} onChange={event => update("repeat", event.target.value)} />
        <button className="button button--primary auth-form__submit" type="submit" disabled={busy}>
          {busy ? "Creating account…" : "Create account"}
        </button>
      </form>
      <p className="auth__links">
        <Link to={PATHS.login}>Already have an account? Sign in</Link>
      </p>
    </AuthPanel>
  );
}
