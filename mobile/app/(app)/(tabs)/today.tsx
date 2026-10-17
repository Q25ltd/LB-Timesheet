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
import { InterruptedRecovery } from "../../../src/components/InterruptedRecovery";
import { EmailConfirmation } from "../../../src/components/EmailConfirmation";
import { Invitations } from "../../../src/components/Invitations";
import { useAuth } from "../../../src/auth/AuthContext";
import { useAccountScope } from "../../../src/shift/useAccountScope";
import { listCompletedShifts, type CompletedShift } from "../../../src/shift/localShift";
import { submissionStatusOf } from "../../../src/sync/submissionStatus";

/** How many finished days Home previews; the Timesheets tab has them all. */
const RECENT_TIMESHEETS = 3;

export default function TodayRoute() {
  const scope = useAccountScope();
  const {
    account, biometrics, biometricUnlockEnabled, enableBiometricUnlock,
  } = useAuth();
  const [recent, setRecent] = useState<readonly CompletedShift[] | "loading" | "unreadable">("loading");
  /** Bumped when the email is confirmed here, so the invitations are read again (D63). */
  const [invitationsRead, setInvitationsRead] = useState(0);

  // Read again EVERY time Home comes into view — after Finish Shift returns
  // here, a finished day is listed without a restart. The phone's own files:
  // no request, no shared store.
  useFocusEffect(useCallback(() => {
    let cancelled = false;
    // Only the signed-in account's days, once its scope exists (F-31).
    if (scope === null) return undefined;
    listCompletedShifts(scope).then(
      // Readable days only; Home carries no warning about any that are not.
      ({ timesheets }) => { if (!cancelled) setRecent(timesheets.slice(0, RECENT_TIMESHEETS)); },
      () => { if (!cancelled) setRecent("unreadable"); },
    );
    return () => { cancelled = true; };
  }, [scope]));

  // The gate renders this route only when the provider is `authenticated`, and
  // `account` is set in the same update as that status. A null here would be a
  // wiring defect rather than a driver state, so it renders nothing instead of
  // inventing an account — and the gate, not this line, is what a signed-out
  // driver actually meets.
  if (account === null) return null;

  return (
    <>
    <InterruptedRecovery scope={scope} onRecovered={() => { router.replace("/today"); }} />
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
      statusOf={shift => (scope === null ? null : submissionStatusOf(scope, shift))}
      // D63: companies add drivers by email; invitations need it confirmed.
      // Once it is, the invitations are read again — a new key, a fresh read.
      notice={
        <>
          <EmailConfirmation variant="home" onConfirmed={() => { setInvitationsRead(n => n + 1); }} />
          <Invitations key={invitationsRead} />
        </>
      }
    />
    </>
  );
}
