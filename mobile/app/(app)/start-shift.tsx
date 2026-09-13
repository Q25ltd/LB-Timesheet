/**
 * The Start Shift workflow route. Wiring only.
 *
 * It sits inside `(app)`, so the route-group gate protects it exactly as it
 * protects the tabs — no second authentication check here, and none wanted. It
 * is a Stack sibling of the tab group rather than a member, so the workflow
 * shows no tab bar.
 *
 * CONTINUATION, not a second start. A driver returning with a day already open
 * is sent to it rather than offered the form again: one open shift at a time,
 * and the store would refuse a second anyway (`shift/localShift.ts`).
 */
import { useEffect, useState } from "react";
import { router } from "expo-router";
import { StartShiftScreen } from "../../src/screens/StartShiftScreen";
import { Restoring } from "../../src/components/Restoring";
import { useAuth } from "../../src/auth/AuthContext";
import { readOpenShift, startLocalShift, type LocalVehicle, type WorkingContext } from "../../src/shift/localShift";

export default function StartShiftRoute() {
  const { account } = useAuth();
  const [checkedForOpenShift, setChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readOpenShift().then(open => {
      if (cancelled) return;
      if (open !== null) router.replace("/active-shift");
      else setChecked(true);
    });
    return () => { cancelled = true; };
  }, []);

  // The gate renders this route only when the provider is `authenticated`, and
  // `account` is set in the same update as that status.
  if (account === null) return null;
  // Hold until we know whether a day is already open, so the form is never
  // shown to someone who is mid-shift.
  if (!checkedForOpenShift) return <Restoring />;

  return (
    <StartShiftScreen
      // ACTIVE memberships, as the authenticated account reports them.
      memberships={account.memberships}
      onBack={() => { router.back(); }}
      onStart={(input: { workingFor: WorkingContext; startedAt: Date; vehicle: LocalVehicle | null }) => {
        // Local only: this cannot fail for want of a network, and it cannot
        // create a second day. `replace`, not `navigate` — the form must not
        // be behind the back gesture once the shift is running.
        void startLocalShift(input).then(() => { router.replace("/active-shift"); });
      }}
    />
  );
}
