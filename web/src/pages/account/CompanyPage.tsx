import { Link, Navigate } from "react-router";
import { useAuth } from "../../auth/AuthProvider";
import { PATHS } from "../../paths";
import { AuthPanel } from "./AuthPanel";

/**
 * Signed in to ONE company (tenant context): the membership the server
 * validated at switch-company. The company workspace itself — submitted
 * timesheets, drivers, settings — is not built, and this page says so rather
 * than showing anything that does not exist (D43, O11).
 */
export function CompanyPage() {
  const auth = useAuth();

  if (auth.state.status !== "signed-in") return null;
  const { company } = auth.state;
  if (company === null) return <Navigate to={PATHS.account} replace />;

  async function signOut() {
    // The account guard takes the browser to sign-in once the state changes.
    await auth.logout();
  }

  return (
    <AuthPanel title={company.membership.companyName} intro="You are signed in to this company.">
      <div className="account-block" data-status="planned">
        <p className="badge badge--neutral">Not available yet</p>
        <p className="account-block__line">
          The company workspace is the next stage of development and is not available yet.
        </p>
      </div>
      <p className="auth__links">
        <Link to={PATHS.account}>Your account and companies</Link>
      </p>
      <button className="button button--secondary" type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </AuthPanel>
  );
}
