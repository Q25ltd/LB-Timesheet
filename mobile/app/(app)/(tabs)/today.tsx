/**
 * The Home route. Wiring only: the screen owns the rendering, the auth
 * provider owns the session, and this file connects them and navigates —
 * the same shape every other route has.
 *
 * It carries no "account is null" placeholder. `(app)/_layout.tsx` holds while
 * the session is restoring and redirects a signed-out driver to sign-in, so
 * this route is only ever reached with a live session.
 */
import { useCallback, useState } from "react";
import { router, useFocusEffect } from "expo-router";
import { HomeScreen } from "../../../src/screens/HomeScreen";
import { useAuth } from "../../../src/auth/AuthContext";
import { listCompletedShifts, type CompletedShift } from "../../../src/shift/localShift";

/** How many finished days Home previews; the Timesheets tab has them all. */
const RECENT_TIMESHEETS = 3;

export default function TodayRoute() {
  const {
    account, biometrics, biometricUnlockEnabled, enableBiometricUnlock,
  } = useAuth();
  const [recent, setRecent] = useState<readonly CompletedShift[] | "loading" | "unreadable">("loading");

  // Read again EVERY time Home comes into view — after Finish Shift returns
  // here, a finished day is listed without a restart. The phone's own files:
  // no request, no shared store.
  useFocusEffect(useCallback(() => {
    let cancelled = false;
    listCompletedShifts().then(
      // Readable days only; Home carries no warning about any that are not.
      ({ timesheets }) => { if (!cancelled) setRecent(timesheets.slice(0, RECENT_TIMESHEETS)); },
      () => { if (!cancelled) setRecent("unreadable"); },
    );
    return () => { cancelled = true; };
  }, []));

  // The gate renders this route only when the provider is `authenticated`, and
  // `account` is set in the same update as that status. A null here would be a
  // wiring defect rather than a driver state, so it renders nothing instead of
  // inventing an account — and the gate, not this line, is what a signed-out
  // driver actually meets.
  if (account === null) return null;

  return (
    <HomeScreen
      user={account.user}
      biometrics={biometrics}
      biometricUnlockEnabled={biometricUnlockEnabled}
      onEnableBiometrics={enableBiometricUnlock}
      // Sign out moved to Settings, which the badge opens. `navigate` rather
      // than `replace`: these are sibling tabs, not a stack to rewrite.
      onOpenAccount={() => { router.navigate("/settings"); }}
      // A workflow, not a tab: `navigate` pushes it over the shell and Back
      // returns here.
      onStartShift={() => { router.navigate("/start-shift"); }}
      recent={recent}
      // By the day's id — never its date, employer or place in the list.
      onOpenTimesheet={id => { router.push({ pathname: "/timesheet", params: { id } }); }}
    />
  );
}
