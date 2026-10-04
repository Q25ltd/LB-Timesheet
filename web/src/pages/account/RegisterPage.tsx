import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useAuth } from "../../auth/AuthProvider";
import { PASSWORD_RULE, passwordProblem } from "../../auth/passwordRule";
import { Field, FormMessage, SelectField } from "../../components/Field";
import { PATHS } from "../../paths";
import { AuthCard } from "./AuthCard";
import { failureText } from "./failureText";
import { isOfferedTimeZone, suggestedTimeZone, timeZoneGroups } from "./companyTimeZone";

/** The approved company-name rule (D51): trimmed, never empty, at most 200 characters. Not unique. */
const COMPANY_NAME_MAX = 200;

type FieldName = "companyName" | "timeZone" | "firstName" | "lastName" | "email" | "password" | "repeat";

/**
 * Registering a COMPANY on LogisticBay Timesheets (D51): the company's
 * details, and the details of the administrator who will manage it here.
 *
 * Pressing Register company sends ONE request (`POST /auth/web/register`):
 * the server creates the company account and its pending registration and
 * signs this browser in to the restricted "check your email" state (/account).
 * No company exists until the emailed link is opened. Failures keep the form
 * and say what happened; nothing is reported as registered that was not.
 */
export function RegisterPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  // The company's time zone (D53): this device's zone is only a SUGGESTION,
  // read once, and the company may change it; with no usable one the company
  // chooses — nothing is guessed, and Europe/London is not a default.
  const zones = useMemo(timeZoneGroups, []);
  const [suggested] = useState(() => suggestedTimeZone(zones));
  const [form, setForm] = useState<Record<FieldName, string>>(() => ({
    companyName: "", timeZone: suggested ?? "", firstName: "", lastName: "", email: "", password: "", repeat: "",
  }));
  const [problems, setProblems] = useState<Partial<Record<FieldName, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void auth.restore(); }, [auth]);
  useEffect(() => {
    if (auth.state.status === "signed-in") void navigate(PATHS.account, { replace: true });
  }, [auth.state, navigate]);

  function update(key: FieldName, value: string) {
    setForm(current => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const found: Partial<Record<FieldName, string>> = {};
    const companyName = form.companyName.trim();
    if (companyName === "") found.companyName = "Enter your company's name";
    else if (companyName.length > COMPANY_NAME_MAX) found.companyName = `Company name must be ${String(COMPANY_NAME_MAX)} characters or fewer`;
    if (!isOfferedTimeZone(form.timeZone, zones)) found.timeZone = "Choose your company's time zone";
    if (form.firstName.trim() === "") found.firstName = "Enter the administrator's first name";
    if (form.lastName.trim() === "") found.lastName = "Enter the administrator's last name";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) found.email = "Enter a valid email address";
    const passwordIssue = passwordProblem(form.password);
    if (passwordIssue !== null) found.password = passwordIssue;
    if (form.repeat !== form.password) found.repeat = "The passwords do not match";
    setProblems(found);
    setFailure(null);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    const outcome = await auth.registerCompany({
      companyName,
      timeZone:  form.timeZone,
      firstName: form.firstName.trim(),
      lastName:  form.lastName.trim(),
      email:     form.email.trim(),
      password:  form.password,
    });
    setBusy(false);
    // Success signs this browser in; the effect above moves on to /account.
    if (outcome.ok) return;
    if (outcome.failure === "email-in-use") {
      setProblems({ email: "A company account already uses this email. Sign in instead, or reset its password." });
      return;
    }
    setFailure(failureText(outcome.failure));
  }

  return (
    <AuthCard
      wide
      title="Register your company"
      intro="Set up your company on LogisticBay Timesheets, and the administrator who will manage it on this website."
      footer={<p className="auth-card__switch">Already registered? <Link to={PATHS.login}>Sign in</Link></p>}
    >
      <form className="auth-form" onSubmit={event => void submit(event)} noValidate>
        {failure === null ? null : <FormMessage tone="error">{failure}</FormMessage>}
        <fieldset className="auth-section">
          <legend className="auth-section__legend">Company details</legend>
          <p className="auth-section__hint">Your company&apos;s name, and the time zone it works in.</p>
          <div className="auth-section__fields">
            <Field label="Company name" name="companyName" autoComplete="organization" required maxLength={COMPANY_NAME_MAX}
              value={form.companyName} error={problems.companyName ?? null} onChange={event => update("companyName", event.target.value)} />
            <SelectField label="Time zone" name="timeZone" autoComplete="off" required
              hint={suggested !== null && form.timeZone === suggested
                ? "Suggested from this device. Change it if your company works in another time zone."
                : "Where your company works. It decides which day each shift is filed under."}
              value={form.timeZone} error={problems.timeZone ?? null} onChange={event => update("timeZone", event.target.value)}>
              <option value="" disabled>Choose a time zone</option>
              {zones.map(group => (
                <optgroup key={group.region} label={group.region}>
                  {group.zones.map(zone => <option key={zone.value} value={zone.value}>{zone.label}</option>)}
                </optgroup>
              ))}
            </SelectField>
          </div>
        </fieldset>

        <fieldset className="auth-section">
          <legend className="auth-section__legend">Administrator details</legend>
          <p className="auth-section__hint">The person who will manage your company&apos;s account and sign in here.</p>
          <div className="auth-section__fields">
            <div className="auth-section__pair">
              <Field label="First name" name="firstName" autoComplete="given-name" required maxLength={200}
                value={form.firstName} error={problems.firstName ?? null} onChange={event => update("firstName", event.target.value)} />
              <Field label="Last name" name="lastName" autoComplete="family-name" required maxLength={200}
                value={form.lastName} error={problems.lastName ?? null} onChange={event => update("lastName", event.target.value)} />
            </div>
            <Field label="Email" type="email" name="email" autoComplete="username" required maxLength={320}
              value={form.email} error={problems.email ?? null} onChange={event => update("email", event.target.value)} />
            <Field label="Password" type="password" name="password" autoComplete="new-password" required hint={PASSWORD_RULE}
              value={form.password} error={problems.password ?? null} onChange={event => update("password", event.target.value)} />
            <Field label="Repeat password" type="password" name="repeat" autoComplete="new-password" required
              value={form.repeat} error={problems.repeat ?? null} onChange={event => update("repeat", event.target.value)} />
          </div>
        </fieldset>

        <div className="auth-form__actions">
          <button className="button button--primary button--large auth-form__submit" type="submit" disabled={busy}>
            {busy ? "Registering…" : "Register company"}
          </button>
        </div>
      </form>
    </AuthCard>
  );
}
