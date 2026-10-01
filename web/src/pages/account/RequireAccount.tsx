import { useEffect, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useAuth } from "../../auth/AuthProvider";
import { PATHS } from "../../paths";
import { AuthPanel } from "./AuthPanel";

/**
 * A page for signed-in people only — as PRESENTATION. It decides what to
 * show, never what is allowed: every request the page makes carries an
 * access token the API validates, and the API refuses whatever this guard
 * might wrongly let through.
 */
export function RequireAccount({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();

  useEffect(() => { void auth.restore(); }, [auth]);

  switch (auth.state.status) {
    case "signed-in":
      return children;
    case "signed-out":
      return <Navigate to={PATHS.login} replace state={{ from: location.pathname }} />;
    case "unavailable":
      return (
        <AuthPanel title="We could not reach LogisticBay Timesheets">
          <p className="auth__intro">Check your connection, then reload this page.</p>
        </AuthPanel>
      );
    case "unknown":
    case "restoring":
      return (
        <AuthPanel title="Loading your account">
          <p className="auth__intro" role="status">Just a moment…</p>
        </AuthPanel>
      );
  }
}
