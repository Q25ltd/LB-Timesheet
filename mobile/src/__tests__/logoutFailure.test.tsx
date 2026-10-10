/** F-36: failed native deletion must terminate access and survive a restart. */
import { act, render, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";
import * as SecureStore from "expo-secure-store";
import { Directory, File, Paths } from "expo-file-system";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import { useAccountScope } from "../shift/useAccountScope";
import { AccountScopeError, type AccountScope } from "../shift/accountScope";
import { OPEN_SHIFT_FILE, readOpenShift, startLocalShift } from "../shift/localShift";
import { accountDirectoryOf } from "./testScope";
import { LOGOUT_INTENT_FILE } from "../auth/logoutIntent";

// SecureStore is already a jest.fn in the native adapter. Capture its
// implementation, not the mutable mock function itself, to avoid recursion.
const nativeDelete = jest.mocked(SecureStore.deleteItemAsync).getMockImplementation();
function failDeletion(key: string) {
  jest.mocked(SecureStore.deleteItemAsync).mockImplementation(requested => {
    if (requested === key) return Promise.reject(new Error("native deletion failed"));
    if (nativeDelete === undefined) throw new Error("Missing native test adapter");
    return nativeDelete(requested);
  });
}

const ACCOUNT = {
  user: { id: "logout_failure_a", firstName: "A", lastName: "Driver", email: "a@example.test" },
  identityToken: "a.identity", refreshToken: "a.refresh", memberships: [],
};
let current: ReturnType<typeof useAuth> | undefined;
let currentScope: AccountScope | null = null;
function Probe() {
  current = useAuth();
  currentScope = useAccountScope();
  return <Text>{current.status}</Text>;
}
function auth() {
  if (current === undefined) throw new Error("AuthProvider was not mounted");
  return current;
}
function scope() {
  if (currentScope === null) throw new Error("No account scope");
  return currentScope;
}
function response(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);
}
async function mountSignedIn() {
  const view = await render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => { expect(auth().status).toBe("unauthenticated"); });
  await act(async () => { await auth().signIn(ACCOUNT); });
  await waitFor(() => { expect(scope().userId).toBe(ACCOUNT.user.id); });
  const held = scope();
  const day = await startLocalShift(held, { workingFor: { kind: "personal" }, startedAt: new Date("2026-10-10T06:00:00Z"), vehicle: null });
  return { view, held, day };
}
beforeEach(() => {
  current = undefined;
  currentScope = null;
  for (const entry of new Directory(Paths.document).list()) entry.delete();
  jest.spyOn(global, "fetch").mockImplementation(input => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/auth/refresh")) return response(200, { identityToken: "rotated.identity", refreshToken: "rotated.refresh" });
    if (url.includes("/auth/me")) return response(200, { user: ACCOUNT.user, memberships: [] });
    return response(204, null);
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  if (nativeDelete !== undefined) jest.mocked(SecureStore.deleteItemAsync).mockImplementation(nativeDelete);
});

test.each(["logisticbay.biometricUnlock", "logisticbay.refreshToken"])("failed deletion of %s ends in-memory access and revokes held scopes", async key => {
  const { held } = await mountSignedIn();
  const file = new File(accountDirectoryOf(held), OPEN_SHIFT_FILE);
  const before = file.textSync();
  failDeletion(key);
  await act(async () => { await expect(auth().signOut()).rejects.toThrow(); });
  expect(auth().status).toBe("unauthenticated");
  expect(auth().account).toBeNull();
  expect(auth().identityToken).toBeNull();
  expect(auth().tenantToken).toBeNull();
  await expect(readOpenShift(held)).rejects.toBeInstanceOf(AccountScopeError);
  // Ending access must not delete the driver's unsynchronised day.
  expect(file.textSync()).toBe(before);
});

test("failed refresh deletion cannot silently restore the old session on restart", async () => {
  const { view } = await mountSignedIn();
  failDeletion("logisticbay.refreshToken");
  await act(async () => { await expect(auth().signOut()).rejects.toThrow(); });
  expect(await SecureStore.getItemAsync("logisticbay.refreshToken")).toBe(ACCOUNT.refreshToken);
  await view.unmount();
  await render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => { expect(auth().status).not.toBe("restoring"); });
  expect(auth().status).toBe("unauthenticated");
  expect(auth().account).toBeNull();
  expect(currentScope).toBeNull();
  expect(auth().logoutCleanupError).toContain("restoration is blocked");
  expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining("/auth/refresh"), expect.anything());
});

function allowDeletion() {
  if (nativeDelete === undefined) throw new Error("Missing native adapter");
  jest.mocked(SecureStore.deleteItemAsync).mockImplementation(nativeDelete);
}

test("logout failure, retry, switching to B and signing back into A preserve A's data", async () => {
  const { held, day } = await mountSignedIn();
  const bytes = new File(accountDirectoryOf(held), OPEN_SHIFT_FILE).textSync();
  failDeletion("logisticbay.refreshToken");
  await act(async () => { await expect(auth().signOut()).rejects.toThrow("cleanup is incomplete"); });
  const b = { ...ACCOUNT, user: { ...ACCOUNT.user, id: "logout_failure_b" }, refreshToken: "b.refresh" };
  await act(async () => { await expect(auth().signIn(b)).rejects.toThrow(); });
  expect(auth().account).toBeNull();
  allowDeletion();
  await act(async () => { await auth().signOut(); });
  expect(auth().logoutCleanupError).toBeNull();
  expect(new File(Paths.document, LOGOUT_INTENT_FILE).exists).toBe(false);
  expect(await SecureStore.getItemAsync("logisticbay.refreshToken")).toBeNull();
  await act(async () => { await auth().signIn(b); });
  await waitFor(() => { expect(scope().userId).toBe(b.user.id); });
  expect(await readOpenShift(scope())).toBeNull();
  await act(async () => { await auth().signOut(); await auth().signIn(ACCOUNT); });
  await waitFor(() => { expect(scope().userId).toBe(ACCOUNT.user.id); });
  expect(await readOpenShift(scope())).toEqual(day);
  expect(new File(accountDirectoryOf(scope()), OPEN_SHIFT_FILE).textSync()).toBe(bytes);
});

test("a restart retries successful cleanup without redeeming the stale credential", async () => {
  const { view } = await mountSignedIn();
  failDeletion("logisticbay.refreshToken");
  await act(async () => { await expect(auth().signOut()).rejects.toThrow(); });
  await view.unmount();
  allowDeletion();
  jest.mocked(global.fetch).mockClear();
  await render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => { expect(auth().status).toBe("unauthenticated"); });
  await waitFor(() => { expect(new File(Paths.document, LOGOUT_INTENT_FILE).exists).toBe(false); });
  expect(await SecureStore.getItemAsync("logisticbay.refreshToken")).toBeNull();
  expect(global.fetch).not.toHaveBeenCalled();
});

test("marker failure plus deletion failure explicitly reports unprotected restart", async () => {
  const { held } = await mountSignedIn();
  const create = jest.spyOn(File.prototype, "create");
  const original = create.getMockImplementation();
  create.mockImplementation(function (this: File, options) {
    if (this.name === LOGOUT_INTENT_FILE) throw new Error("disk full");
    if (original === undefined) throw new Error("Missing filesystem adapter");
    return original.call(this, options);
  });
  failDeletion("logisticbay.refreshToken");
  await act(async () => { await expect(auth().signOut()).rejects.toThrow("Restart protection cannot be guaranteed"); });
  expect(auth().status).toBe("unauthenticated");
  await expect(readOpenShift(held)).rejects.toBeInstanceOf(AccountScopeError);
  expect(auth().logoutCleanupError).toContain("Restart protection cannot be guaranteed");
});

test("scopes are revoked synchronously even while native deletion is pending", async () => {
  const { held } = await mountSignedIn();
  let release: (() => void) | undefined;
  jest.mocked(SecureStore.deleteItemAsync).mockImplementation(key => {
    if (key !== "logisticbay.refreshToken") {
      if (nativeDelete === undefined) throw new Error("No adapter");
      return nativeDelete(key);
    }
    return new Promise<void>(resolve => { release = resolve; });
  });
  let signingOut: Promise<void> | undefined;
  await act(async () => {
    signingOut = auth().signOut();
    await expect(readOpenShift(held)).rejects.toBeInstanceOf(AccountScopeError);
  });
  expect(auth().account).toBeNull();
  await act(async () => {
    if (release === undefined) throw new Error("Deletion did not start");
    // A native call resolving without deleting is also rejected by read-back.
    release();
    await expect(signingOut).rejects.toThrow("cleanup is incomplete");
  });
});
