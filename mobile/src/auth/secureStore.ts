/**
 * The ONLY place a long-lived authentication secret is written to the device
 * (D25).
 *
 * The rule this module exists to make greppable:
 *
 *   refresh secret  -> SecureStore (keychain / Android keystore)
 *   access token    -> memory only, never here, never AsyncStorage
 *   password        -> never persisted at all, anywhere
 *
 * There is deliberately no generic `setItem(key, value)` export. A general
 * storage helper is how an access token or a password ends up on disk six
 * months from now; naming the one secret that may be stored means adding a
 * second one is a visible edit to this file.
 *
 * The refresh secret is stored WITHOUT `requireAuthentication` (owner
 * decision, 2026-09-11). Biometric protection is an application-level gate in
 * front of `readRefreshToken`, not a biometric-bound key — see
 * `./biometrics` for the measured reasons and the honest trade-off.
 */
import * as SecureStore from "expo-secure-store";

/** The one SECRET this app stores. */
const REFRESH_TOKEN_KEY = "logisticbay.refreshToken";

/**
 * The biometric opt-in flag. NOT a secret and NOT authority — it answers
 * exactly one question ("did the driver ask us to offer biometric unlock?")
 * and is stored here only because SecureStore is already wired and adding an
 * AsyncStorage dependency for one boolean is not worth it.
 *
 * Deleting or forging it grants NOTHING: with it set, the app still has to
 * pass the OS biometric prompt, still has to read the refresh secret, and
 * still has to have `/auth/refresh` validate the Session. With it unset, the
 * driver simply types their password. It is a preference, not a credential.
 */
const BIOMETRIC_OPT_IN_KEY = "logisticbay.biometricUnlock";
const OPTED_IN = "enabled";

export async function storeRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token);
}

export async function readRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

export async function clearRefreshToken(): Promise<void> {
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
}

/** Remember that the driver chose biometric unlock. */
export async function storeBiometricOptIn(): Promise<void> {
  await SecureStore.setItemAsync(BIOMETRIC_OPT_IN_KEY, OPTED_IN);
}

/**
 * Did the driver opt in?
 *
 * Compared against the exact sentinel rather than tested for truthiness, so
 * a leftover or corrupted value reads as "no" and the driver is asked for
 * their password — the safe direction.
 */
export async function readBiometricOptIn(): Promise<boolean> {
  return (await SecureStore.getItemAsync(BIOMETRIC_OPT_IN_KEY)) === OPTED_IN;
}

export async function clearBiometricOptIn(): Promise<void> {
  await SecureStore.deleteItemAsync(BIOMETRIC_OPT_IN_KEY);
}
