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
 */
import * as SecureStore from "expo-secure-store";

/** The single key this app stores. */
const REFRESH_TOKEN_KEY = "logisticbay.refreshToken";

export async function storeRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token);
}

export async function readRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

export async function clearRefreshToken(): Promise<void> {
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
}
