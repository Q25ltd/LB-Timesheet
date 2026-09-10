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

test("the module exposes NO generic setter — only the refresh secret may be stored", () => {
  // A general `setItem(key, value)` is how an access token or a password
  // ends up on disk later. Adding one has to fail this assertion first.
  expect(Object.keys(secureStoreModule).sort()).toEqual([
    "clearRefreshToken", "readRefreshToken", "storeRefreshToken",
  ]);
});
