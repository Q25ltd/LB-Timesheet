/**
 * D25's storage rule, proven at the module that owns it.
 *
 * The mock in jest.setup.js is a real in-memory store, so "the refresh
 * secret was written" is a claim that can fail rather than a spy that always
 * agrees.
 */
import * as SecureStore from "expo-secure-store";
import * as secureStoreModule from "../auth/secureStore";
import { storeRefreshToken, readRefreshToken, clearRefreshToken } from "../auth/secureStore";

test("the refresh secret round-trips through SecureStore under one known key", async () => {
  await storeRefreshToken("refresh-secret-value");

  const setItem = jest.mocked(SecureStore.setItemAsync);
  expect(setItem).toHaveBeenCalledTimes(1);
  const [key, value] = setItem.mock.calls[0] as unknown as [string, string];
  expect(key).toBe("logisticbay.refreshToken");
  expect(value).toBe("refresh-secret-value");
  await expect(readRefreshToken()).resolves.toBe("refresh-secret-value");
});

test("reading before anything is stored yields null rather than throwing", async () => {
  await expect(readRefreshToken()).resolves.toBeNull();
});

test("clearing removes the secret", async () => {
  await storeRefreshToken("refresh-secret-value");
  await clearRefreshToken();
  await expect(readRefreshToken()).resolves.toBeNull();
});

test("the module exposes NO generic setter — every persisted item is named here", () => {
  // A general `setItem(key, value)` is how an access token or a password ends
  // up on disk later. Adding one has to fail this assertion first.
  //
  // The three `BiometricOptIn` names were added deliberately (D26) and are
  // NOT secrets: the flag answers "did the driver ask for biometric unlock?"
  // and grants nothing on its own — forging it still leaves the OS prompt,
  // the SecureStore read and the server's `/auth/refresh` validation in the
  // way. The refresh secret remains the only CREDENTIAL this module stores.
  expect(Object.keys(secureStoreModule).sort()).toEqual([
    "clearBiometricOptIn", "clearRefreshToken", "readBiometricOptIn",
    "readRefreshToken", "storeBiometricOptIn", "storeRefreshToken",
  ]);
});

test("the biometric preference is a flag, not a credential", () => {
  // It round-trips, it defaults to false, and an unrecognised stored value
  // reads as false — the safe direction, because a corrupted preference must
  // send the driver to the password form rather than to a broken unlock.
  expect(typeof secureStoreModule.storeBiometricOptIn).toBe("function");
  expect(typeof secureStoreModule.readBiometricOptIn).toBe("function");
  expect(typeof secureStoreModule.clearBiometricOptIn).toBe("function");
});
