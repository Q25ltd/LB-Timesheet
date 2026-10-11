/**
 * Runs the sync runner for the signed-in account (D66): when the app opens
 * signed in, when it comes back to the foreground, when the connection
 * returns, and when something new is queued (`requestSync`). While something
 * is still waiting, it tries again with a growing delay — 15 seconds up to
 * 15 minutes — for as long as the app is open. Renders nothing.
 */
import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { useAuth } from "../auth/AuthContext";
import { useAccountScope } from "../shift/useAccountScope";
import { onReconnect } from "./connectivity";
import { runSync } from "./syncRunner";

const listeners = new Set<() => void>();

/** Ask for a run now — after a receipt or a submission is queued. */
export function requestSync(): void {
  for (const listener of listeners) listener();
}

const FIRST_RETRY_MS = 15_000;
const LAST_RETRY_MS = 15 * 60_000;

export function SyncDriver() {
  const scope = useAccountScope();
  const { withIdentity } = useAuth();
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const delay = useRef(FIRST_RETRY_MS);

  useEffect(() => {
    if (scope === null) return undefined;
    let live = true;

    function schedule() {
      if (retry.current !== null) clearTimeout(retry.current);
      retry.current = setTimeout(run, delay.current);
      delay.current = Math.min(delay.current * 2, LAST_RETRY_MS);
    }

    function run() {
      if (scope === null) return;
      void runSync(scope, withIdentity).then(report => {
        if (!live) return;
        if (report.retryLater) schedule();
        else delay.current = FIRST_RETRY_MS;
      }, () => {
        // A run that threw (storage unreadable) is tried again later, never dropped.
        if (live) schedule();
      });
    }

    listeners.add(run);
    const appState = AppState.addEventListener("change", state => { if (state === "active") run(); });
    const stopListening = onReconnect(run);
    run();
    return () => {
      live = false;
      listeners.delete(run);
      appState.remove();
      stopListening();
      if (retry.current !== null) clearTimeout(retry.current);
    };
  }, [scope, withIdentity]);

  return null;
}
