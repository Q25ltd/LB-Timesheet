/** F-36: a deny-only marker. Contains no credential or account data. */
import { File, Paths } from "expo-file-system";
import { clearBiometricOptIn, clearRefreshToken, biometricPreferencePresent, readRefreshToken } from "./secureStore";

export const LOGOUT_INTENT_FILE = "logisticbay-logout-pending";
function marker(): File { return new File(Paths.document, LOGOUT_INTENT_FILE); }

/** Existence, including an incomplete/corrupt marker, blocks restoration. */
export function logoutPending(): boolean { return marker().exists; }

export function markLogoutPending(): void {
  const file = marker();
  if (!file.exists) file.create();
  file.write("logout-pending");
  if (file.textSync() !== "logout-pending") throw new Error("Logout intent was not persisted");
}

export class LogoutCleanupError extends Error {
  constructor(protectedRestart: boolean) {
    super(protectedRestart
      ? "Account access has ended, but sign-out cleanup is incomplete. Session restoration is blocked. Retry sign-out cleanup."
      : "Account access has ended, but sign-out cleanup is incomplete. Restart protection cannot be guaranteed. Retry sign-out cleanup before closing the app.");
    this.name = "LogoutCleanupError";
  }
}

/** Attempt both removals even if one fails; remove the deny marker last. */
export async function finishLogoutCleanup(): Promise<void> {
  const removed = await Promise.allSettled([clearRefreshToken(), clearBiometricOptIn()]);
  try {
    if (removed.some(result => result.status === "rejected")) throw new Error("Credential deletion failed");
    const [token, preferencePresent] = await Promise.all([readRefreshToken(), biometricPreferencePresent()]);
    if (token !== null || preferencePresent) throw new Error("Credentials remain");
    const file = marker();
    if (file.exists) file.delete();
    if (file.exists) throw new Error("Logout intent remains");
  } catch {
    let protectedRestart = false;
    try { protectedRestart = logoutPending(); } catch { /* Cannot confirm disk state. */ }
    throw new LogoutCleanupError(protectedRestart);
  }
}
