import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../../auth/AuthProvider";
import { PASSWORD_RULE, passwordProblem } from "../../auth/passwordRule";
import { Field, FormMessage } from "../../components/Field";
import { PATHS } from "../../paths";
import { AuthPanel } from "./AuthPanel";
import { failureText } from "./failureText";

type Message = { tone: "error" | "success"; text: string } | null;

/**
 * The signed-in ACCOUNT (identity context, D21): who you are, whether your
 * email is confirmed, the companies you belong to, setting up a company
 * (D48), your password, and signing out. It shows only this account's own
 * memberships — the API returns nothing else.
 */
export function AccountPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [verifyMessage, setVerifyMessage] = useState<Message>(null);
  const [companyName, setCompanyName] = useState("");
  const [companyMessage, setCompanyMessage] = useState<Message>(null);
  const [selectMessage, setSelectMessage] = useState<Message>(null);
  const [passwords, setPasswords] = useState({ current: "", next: "" });
  const [passwordMessage, setPasswordMessage] = useState<Message>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (auth.state.status !== "signed-in") return null;
  const { account } = auth.state;

  async function resend() {
    setBusy("verify");
    const outcome = await auth.resendVerification();
    setBusy(null);
    setVerifyMessage(outcome.ok
      ? { tone: "success", text: `We have sent a new confirmation link to ${account.user.email}.` }
      : { tone: "error", text: failureText(outcome.failure) });
  }

  async function createCompany(event: FormEvent) {
    event.preventDefault();
    if (companyName.trim() === "") {
      setCompanyMessage({ tone: "error", text: "Enter your company's name." });
      return;
    }
    setBusy("company");
    const outcome = await auth.createCompany(companyName.trim());
    setBusy(null);
    if (!outcome.ok) {
      setCompanyMessage({ tone: "error", text: failureText(outcome.failure) });
      return;
    }
    setCompanyName("");
    setCompanyMessage({ tone: "success", text: `${outcome.membership.companyName} has been set up.` });
  }

  async function open(membershipId: string) {
    setBusy(membershipId);
    const outcome = await auth.selectCompany(membershipId);
    setBusy(null);
    if (outcome.ok) {
      void navigate(PATHS.company);
      return;
    }
    setSelectMessage({ tone: "error", text: failureText(outcome.failure) });
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    const problem = passwordProblem(passwords.next);
    if (problem !== null) {
      setPasswordMessage({ tone: "error", text: `New password: ${problem}.` });
      return;
    }
    setBusy("password");
    const outcome = await auth.changePassword(passwords.current, passwords.next);
    setBusy(null);
    if (outcome.ok) {
      setPasswords({ current: "", next: "" });
      setPasswordMessage({ tone: "success", text: "Your password has been changed. You have been signed out on your other devices." });
      return;
    }
    setPasswordMessage({ tone: "error", text: outcome.failure === "forbidden" ? "Your current password is incorrect." : failureText(outcome.failure) });
  }

  async function signOut() {
    setBusy("signout");
    // The account guard takes the browser to sign-in once the state changes.
    await auth.logout();
  }

  return (
    <AuthPanel title="Your account">
      <div className="account-block">
        <h2 className="account-block__title">{account.user.firstName} {account.user.lastName}</h2>
        <p className="account-block__line">{account.user.email}</p>
        {account.emailVerified ? (
          <p className="badge badge--success">Email address confirmed</p>
        ) : (
          <>
            <p className="badge badge--warning">Email address not confirmed</p>
            <p className="account-block__line">Open the link we emailed you to confirm it. You need a confirmed address to set up a company.</p>
            {verifyMessage === null ? null : <FormMessage tone={verifyMessage.tone}>{verifyMessage.text}</FormMessage>}
            <button className="button button--secondary" type="button" disabled={busy === "verify"} onClick={() => void resend()}>
              {busy === "verify" ? "Sending…" : "Send a new confirmation link"}
            </button>
          </>
        )}
      </div>

      <div className="account-block">
        <h2 className="account-block__title">Your companies</h2>
        {selectMessage === null ? null : <FormMessage tone={selectMessage.tone}>{selectMessage.text}</FormMessage>}
        {account.memberships.length === 0 ? (
          <p className="account-block__line">You are not part of any company yet.</p>
        ) : (
          <ul className="company-list">
            {account.memberships.map(membership => (
              <li key={membership.membershipId} className="company-list__item">
                <span className="company-list__name">{membership.companyName}</span>
                <button className="button button--primary" type="button" disabled={busy === membership.membershipId}
                  onClick={() => void open(membership.membershipId)} aria-label={`Open ${membership.companyName}`}>
                  {busy === membership.membershipId ? "Opening…" : "Open"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="account-block">
        <h2 className="account-block__title">Set up a company</h2>
        {account.emailVerified ? (
          <form className="auth-form" onSubmit={event => void createCompany(event)} noValidate>
            {companyMessage === null ? null : <FormMessage tone={companyMessage.tone}>{companyMessage.text}</FormMessage>}
            <Field label="Company name" name="companyName" autoComplete="organization" required maxLength={200}
              value={companyName} onChange={event => setCompanyName(event.target.value)} />
            <button className="button button--primary auth-form__submit" type="submit" disabled={busy === "company"}>
              {busy === "company" ? "Setting up…" : "Set up company"}
            </button>
          </form>
        ) : (
          <p className="account-block__line">Confirm your email address first.</p>
        )}
      </div>

      <div className="account-block">
        <h2 className="account-block__title">Change password</h2>
        <form className="auth-form" onSubmit={event => void changePassword(event)} noValidate>
          {passwordMessage === null ? null : <FormMessage tone={passwordMessage.tone}>{passwordMessage.text}</FormMessage>}
          <Field label="Current password" type="password" name="currentPassword" autoComplete="current-password" required
            value={passwords.current} onChange={event => setPasswords(p => ({ ...p, current: event.target.value }))} />
          <Field label="New password" type="password" name="newPassword" autoComplete="new-password" required hint={PASSWORD_RULE}
            value={passwords.next} onChange={event => setPasswords(p => ({ ...p, next: event.target.value }))} />
          <button className="button button--secondary auth-form__submit" type="submit" disabled={busy === "password"}>
            {busy === "password" ? "Saving…" : "Change password"}
          </button>
        </form>
      </div>

      <button className="button button--secondary" type="button" disabled={busy === "signout"} onClick={() => void signOut()}>
        Sign out
      </button>
    </AuthPanel>
  );
}
