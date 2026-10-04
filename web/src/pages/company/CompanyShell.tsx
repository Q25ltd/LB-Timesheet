import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, NavLink, Outlet, ScrollRestoration } from "react-router";
import { useAuth } from "../../auth/AuthProvider";
import { BrandLockup } from "../../components/BrandLockup";
import { useNavigationFocus } from "../../components/useNavigationFocus";
import { PATHS } from "../../paths";
import { AuthPanel } from "../account/AuthPanel";
import { RequireAccount } from "../account/RequireAccount";
import "../../styles/site.css";
import "../../styles/company.css";

/**
 * The COMPANY WORKSPACE's frame — every company page renders inside it.
 *
 * Four primary areas and no more: Home, Drivers, Timesheets, Settings. Only
 * Home exists. The other three are named, so the workspace's shape is clear,
 * but they are NOT links: an area that does not exist is not offered as a
 * control. When one is built it becomes a `NavLink` here and a child route in
 * `routes.tsx` — nothing else in the frame changes.
 *
 * Who gets in is the server's decision. `RequireAccount` is presentation;
 * `RequireCompany` asks the API for the tenant context and shows nothing of a
 * company the API has not confirmed.
 */
const AREAS_NOT_BUILT = ["Drivers", "Timesheets", "Settings"] as const;

export function CompanyShell() {
  const auth = useAuth();
  const mainRef = useRef<HTMLElement>(null);
  useNavigationFocus(mainRef);
  const signedIn = auth.state.status === "signed-in" ? auth.state : null;
  const inCompany = signedIn !== null && isAdministrator(signedIn.company?.membership);

  return (
    <div className="workspace">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="workspace-header">
        <div className="workspace-header__bar">
          <span className="workspace-header__brand">
            <BrandLockup />
            <span className="visually-hidden">LogisticBay Timesheets</span>
          </span>

          {inCompany ? (
            <nav className="workspace-nav" aria-label="Company">
              <ul className="workspace-nav__list">
                <li className="workspace-nav__item">
                  <NavLink to={PATHS.company} end className="workspace-nav__link">
                    <span className="workspace-nav__label" data-nav-label>Home</span>
                  </NavLink>
                </li>
                {AREAS_NOT_BUILT.map(area => (
                  <li key={area} className="workspace-nav__item">
                    <span className="workspace-nav__unavailable">
                      <span className="workspace-nav__label" data-nav-label>{area}</span>
                      <span className="workspace-nav__note">Not available yet</span>
                    </span>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}

          {inCompany ? (
            <div className="workspace-account">
              <span className="workspace-account__name">{signedIn.account.user.firstName} {signedIn.account.user.lastName}</span>
              <Link className="workspace-account__link" to={PATHS.account}>Account</Link>
              <button className="workspace-account__link" type="button" onClick={() => void auth.logout()}>Sign out</button>
            </div>
          ) : null}
        </div>
      </header>
      <main id="main" className="workspace-main" ref={mainRef} tabIndex={-1}>
        <RequireAccount>
          <RequireCompany>
            <Outlet />
          </RequireCompany>
        </RequireAccount>
      </main>
      <ScrollRestoration />
    </div>
  );
}

/**
 * Company-web authority is the ADMINISTRATOR's (O11, V1): only an `admin`
 * membership is shown as the company's workspace. Presentation, mirroring the
 * API — which refuses anything else at `authorizeCompanyAdmin` — never the
 * guarantee itself.
 */
function isAdministrator(membership: { role: string } | undefined): boolean {
  return membership?.role === "admin";
}

/**
 * The company pages need the TENANT context — a company the server confirmed.
 *
 * A reload forgets it (tokens live in memory only, D45). With exactly ONE
 * company on the account it is asked for again through
 * `POST /auth/switch-company` — the rule sign-in already applies (D13) — and
 * the server re-validates the membership from its own rows. With none, a
 * registration still pending, or several to choose between, the account page
 * is where that is settled: nothing is guessed.
 */
function RequireCompany({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [failed, setFailed] = useState(false);
  const asked = useRef(false);
  const signedIn = auth.state.status === "signed-in" ? auth.state : null;
  const company = signedIn !== null && isAdministrator(signedIn.company?.membership) ? signedIn.company : null;
  // Only ADMINISTRATOR memberships are the company's workspace (O11). A
  // registration still pending has no membership yet (D51), so it, too, goes
  // to the account page — which shows Check your email.
  const administered = signedIn === null ? [] : signedIn.account.memberships.filter(isAdministrator);
  const only = administered.length === 1 ? administered[0] : undefined;

  useEffect(() => {
    if (company !== null || only === undefined || asked.current) return;
    asked.current = true;
    void auth.selectCompany(only.membershipId).then(outcome => {
      if (!outcome.ok) setFailed(true);
    });
  }, [auth, company, only]);

  if (signedIn === null) return null;
  if (company !== null) return children;
  if (only === undefined) return <Navigate to={PATHS.account} replace />;

  if (failed) {
    return (
      <AuthPanel title="We could not open your company" intro="Nothing has changed. Check your connection, then try again.">
        <p className="auth__links">
          <button className="button button--primary" type="button" onClick={() => { asked.current = false; setFailed(false); }}>
            Try again
          </button>{" "}
          <Link to={PATHS.account}>Your account</Link>
        </p>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel title="Opening your company">
      <p className="auth__intro" role="status">Just a moment…</p>
    </AuthPanel>
  );
}
