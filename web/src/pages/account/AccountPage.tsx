import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../../auth/AuthProvider";
import { PASSWORD_RULE, passwordProblem } from "../../auth/passwordRule";
import { Field, FormMessage } from "../../components/Field";
import { PATHS } from "../../paths";
import { AuthCard } from "./AuthCard";
import { AuthPanel } from "./AuthPanel";
import { DevelopmentEmail } from "./DevelopmentEmail";
import { EmailCorrection } from "./EmailCorrection";
import { failureText } from "./failureText";

type Message = { tone: "error" | "success"; text: string } | null;

/**
 * The signed-in COMPANY ACCOUNT (identity context, D21), in the state its
 * registration is in (D51):
 *
 *   PENDING   "Check your email" — the company being registered, the address
 *             to confirm, a new link; nothing else is open until it is done
 *   COMPANY   who you are, the company to open, your password, sign out
 *   NEITHER   an account with no company and no registration, said plainly
 *
 * Nothing here creates a company: a company is created only by confirming a
 * company registration (the old "Set up a company" is gone). It shows only
 * this account's own data — the API returns nothing else.
 */
export function AccountPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [verifyMessage, setVerifyMessage] = useState<Message>(null);
  // Moves after each resend, so the development helper shows the NEW link.
  const [linkRevision, setLinkRevision] = useState(0);
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
    if (outcome.ok) setLinkRevision(revision => revision + 1);
    setVerifyMessage(outcome.ok
      ? { tone: "success", text: `We have sent a new link to ${account.user.email}.` }
      : { tone: "error", text: failureText(outcome.failure) });
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

  const pending = account.pendingCompanyRegistration;
  if (pending !== null) {
    return (
      <AuthCard
        title="Check your email"
        intro={`To finish registering ${pending.companyName}, confirm the administrator's email address: ${account.user.email}.`}
        footer={
          <p className="auth-card__switch">
            Signed in as {account.user.email}.{" "}
            <button className="auth-card__inline-button" type="button" disabled={busy === "signout"} onClick={() => void signOut()}>Sign out</button>
          </p>
        }
      >
        <div className="check-email">
          <p className="check-email__line">
            Open the link we sent to that address. It works once, and for 24 hours. Your company is set up the moment you open it.
          </p>
          {import.meta.env.DEV ? <DevelopmentEmail revision={linkRevision} /> : null}
          {verifyMessage === null ? null : <FormMessage tone={verifyMessage.tone}>{verifyMessage.text}</FormMessage>}
          <button className="button button--secondary button--large check-email__resend" type="button" disabled={busy === "verify"} onClick={() => void resend()}>
            {busy === "verify" ? "Sending…" : "Send a new link"}
          </button>
          <EmailCorrection email={account.user.email} problem={account.emailDeliveryProblem} />
        </div>
      </AuthCard>
    );
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
            <p className="account-block__line">Open the link we emailed you to confirm it.</p>
            {verifyMessage === null ? null : <FormMessage tone={verifyMessage.tone}>{verifyMessage.text}</FormMessage>}
            <button className="button button--secondary" type="button" disabled={busy === "verify"} onClick={() => void resend()}>
              {busy === "verify" ? "Sending…" : "Send a new confirmation link"}
            </button>
          </>
        )}
      </div>

      {account.emailDeliveryProblem === null ? null : (
        <section className="account-block" aria-labelledby="email-address-title">
          <h2 id="email-address-title" className="account-block__title">Your email address</h2>
          <EmailCorrection email={account.user.email} problem={account.emailDeliveryProblem} />
        </section>
      )}

      <div className="account-block">
        <h2 className="account-block__title">Your companies</h2>
        {selectMessage === null ? null : <FormMessage tone={selectMessage.tone}>{selectMessage.text}</FormMessage>}
        {account.memberships.length === 0 ? (
          <p className="account-block__line">This account has no company. A company account is created by registering a company and confirming its email.</p>
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
