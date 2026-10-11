/**
 * When the phone's connection comes back (D66) — the one place the app reads
 * the network state, so the sync runner can retry then. A hint only: a
 * request is still the only proof the server can be reached.
 */
import { addNetworkStateListener } from "expo-network";

/** Calls `onBack` each time the phone goes from no connection to one. Returns the unsubscribe. */
export function onReconnect(onBack: () => void): () => void {
  let connected: boolean | null = null;
  const subscription = addNetworkStateListener(state => {
    const now = state.isConnected === true && state.isInternetReachable !== false;
    if (now && connected === false) onBack();
    connected = now;
  });
  return () => { subscription.remove(); };
}
