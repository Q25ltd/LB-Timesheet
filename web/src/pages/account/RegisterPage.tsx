import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useAuth } from "../../auth/AuthProvider";
import { PASSWORD_RULE, passwordProblem } from "../../auth/passwordRule";
import { Field, FormMessage } from "../../components/Field";
import { PATHS } from "../../paths";
import { AuthPanel } from "./AuthPanel";

/** The approved company-name rule (D51): trimmed, never empty, at most 200 characters. Not unique. */
const COMPANY_NAME_MAX = 200;

type FieldName = "companyName" | "firstName" | "lastName" | "email" | "password" | "repeat";

/**
 * Registering a COMPANY on LogisticBay Timesheets (D51): the company's
 * details, and the details of the administrator who will manage it here.
 *
 * NOT OPEN YET. The company-registration API — which stores the pending
 * registration and creates the Company when the administrator confirms their
 * email — is the next increment. Until it exists this form validates what it
 * will send and SENDS NOTHING: it must not fall back on the old person-first
 * endpoint, which would drop the company name and report a registration that
 * did not happen. The page says so before and after the button is pressed.
 */
export function RegisterPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState<Record<FieldName, string>>({
    companyName: "", firstName: "", lastName: "", email: "", password: "", repeat: "",
  });
  const [problems, setProblems] = useState<Partial<Record<FieldName, string>>>({});
  const [checked, setChecked] = useState(false);

  useEffect(() => { void auth.restore(); }, [auth]);
  useEffect(() => {
    if (auth.state.status === "signed-in") void navigate(PATHS.account, { replace: true });
  }, [auth.state, navigate]);

  function update(key: FieldName, value: string) {
    setForm(current => ({ ...current, [key]: value }));
    setChecked(false);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const found: Partial<Record<FieldName, string>> = {};
    const companyName = form.companyName.trim();
    if (companyName === "") found.companyName = "Enter your company's name";
    else if (companyName.length > COMPANY_NAME_MAX) found.companyName = `Company name must be ${String(COMPANY_NAME_MAX)} characters or fewer`;
    if (form.firstName.trim() === "") found.firstName = "Enter the administrator's first name";
    if (form.lastName.trim() === "") found.lastName = "Enter the administrator's last name";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) found.email = "Enter a valid email address";
    const passwordIssue = passwordProblem(form.password);
    if (passwordIssue !== null) found.password = passwordIssue;
    if (form.repeat !== form.password) found.repeat = "The passwords do not match";
    setProblems(found);
    // Valid or not, nothing is sent: company registration is not open yet.
    setChecked(Object.keys(found).length === 0);
  }

  return (
    <AuthPanel
      title="Register your company"
      intro="Register your company with LogisticBay Timesheets and set up the administrator who will manage it on this website."
    >
      {/* A standing notice, not a live region: it is true from the first render. */}
      <p className="form-message form-message--info">
        Company registration is not open yet. You can check your details here, but the form cannot be sent until registration opens.
      </p>
      <form className="auth-form" onSubmit={submit} noValidate>
        <fieldset className="auth-fieldset">
          <legend className="auth-fieldset__legend">Company details</legend>
          <Field label="Company name" name="companyName" autoComplete="organization" required maxLength={COMPANY_NAME_MAX}
            value={form.companyName} error={problems.companyName ?? null} onChange={event => update("companyName", event.target.value)} />
        </fieldset>

        <fieldset className="auth-fieldset">
          <legend className="auth-fieldset__legend">Administrator details</legend>
          <p className="auth-fieldset__hint">The person who will manage your company&apos;s account and sign in here.</p>
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
        </fieldset>

        {checked ? (
          <FormMessage tone="success">
            Your details are complete. Company registration is not open yet, so nothing has been sent.
          </FormMessage>
        ) : null}
        <button className="button button--primary auth-form__submit" type="submit">
          Register company
        </button>
      </form>
      <p className="auth__links">
        <Link to={PATHS.login}>Already registered? Sign in</Link>
      </p>
    </AuthPanel>
  );
}
