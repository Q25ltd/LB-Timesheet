/** Real files and synthetic keychain bytes survive between separate Jest processes. */
import { Text } from "react-native";
import { act, render, waitFor } from "@testing-library/react-native";
import { File, Paths } from "expo-file-system";
import { AuthProvider, useAuth } from "../src/auth/AuthContext";
import { useAccountScope } from "../src/shift/useAccountScope";
import { AccountScope } from "../src/shift/accountScope";
import { LOGOUT_INTENT_FILE } from "../src/auth/logoutIntent";
import { startLocalShift, readOpenShift, correctOpenShift, findInterruptedWrites, recoverInterruptedWrite, OPEN_SHIFT_FILE } from "../src/shift/localShift";
import { accountDirectoryOf } from "../src/__tests__/testScope";

jest.mock("expo-file-system", () => jest.requireActual<object>("../src/__fixtures__/restart-disk.cjs"));
jest.mock("expo-secure-store", () => {
  const adapter: { secureStore: unknown } = jest.requireActual("../src/__fixtures__/restart-disk.cjs");
  return adapter.secureStore;
});
let auth: ReturnType<typeof useAuth> | undefined;
let scope: AccountScope | null = null;
function Probe() { auth = useAuth(); scope = useAccountScope(); return <Text>{auth.status}</Text>; }
function current() { if (auth === undefined) throw new Error("No auth"); return auth; }
function live() { if (scope === null) throw new Error("No scope"); return scope; }
const A = { user: { id: "restart_a", firstName: "A", lastName: "Driver", email: "a@example.test" }, identityToken: "synthetic.identity", refreshToken: "synthetic.refresh", memberships: [] };
const INPUT = { workingFor: { kind: "personal" as const }, startedAt: new Date("2026-10-10T06:00:00Z"), vehicle: null };

test(`separate process: ${process.env.LB_RESTART_PHASE ?? "missing"}`, async () => {
  jest.spyOn(global, "fetch").mockRejectedValue(new Error("No network needed for these checks"));
  await render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => { expect(current().status).toBe("unauthenticated"); });
  const phase: unknown = process.env.LB_RESTART_PHASE;
  if (phase === "logout-seed") {
    await act(async () => { await current().signIn(A); });
    await waitFor(() => { expect(live().userId).toBe(A.user.id); });
    await startLocalShift(live(), INPUT);
    await act(async () => { await expect(current().signOut()).rejects.toThrow("cleanup is incomplete"); });
    expect(new File(Paths.document, LOGOUT_INTENT_FILE).exists).toBe(true);
  } else if (phase === "logout-blocked") {
    await waitFor(() => { expect(current().logoutCleanupError).toContain("restoration is blocked"); });
    expect(scope).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(new File(Paths.document, LOGOUT_INTENT_FILE).exists).toBe(true);
  } else if (phase === "logout-retry") {
    await waitFor(() => { expect(new File(Paths.document, LOGOUT_INTENT_FILE).exists).toBe(false); });
    expect(global.fetch).not.toHaveBeenCalled();
    await act(async () => { await current().signIn(A); });
    await waitFor(() => { expect(live().userId).toBe(A.user.id); });
    expect((await readOpenShift(live()))?.startedAt).toBe(INPUT.startedAt.toISOString());
    await act(async () => { await current().signOut(); });
  } else if (phase === "write-seed") {
    await act(async () => { await current().signIn(A); });
    await waitFor(() => { expect(live().userId).toBe(A.user.id); });
    const day = await readOpenShift(live());
    if (day === null) throw new Error("Logout lost the day");
    process.env.LB_INTERRUPT_MOVE = "yes";
    await expect(correctOpenShift(live(), { shiftId: day.id, workingFor: day.workingFor, startedAt: new Date("2026-10-10T05:00:00Z") })).rejects.toThrow();
    expect(new File(accountDirectoryOf(live()), OPEN_SHIFT_FILE).exists).toBe(false);
    delete process.env.LB_INTERRUPT_MOVE;
    await act(async () => { await current().signOut(); });
  } else if (phase === "write-not-now" || phase === "write-confirm" || phase === "write-read") {
    const b = { ...A, user: { ...A.user, id: "restart_b" } };
    await act(async () => { await current().signIn(b); });
    await waitFor(() => { expect(live().userId).toBe(b.user.id); });
    expect(await findInterruptedWrites(live())).toEqual([]);
    expect(await readOpenShift(live())).toBeNull();
    await act(async () => { await current().signOut(); await current().signIn(A); });
    await waitFor(() => { expect(live().userId).toBe(A.user.id); });
    if (phase === "write-read") {
      const day = await readOpenShift(live());
      expect(day?.startedAt).toBe("2026-10-10T05:00:00.000Z");
      expect(day?.recoveredAt).toEqual(expect.any(String));
      expect(await findInterruptedWrites(live())).toEqual([]);
    } else {
      expect(await readOpenShift(live())).toBeNull();
      const [offer] = await findInterruptedWrites(live());
      if (offer === undefined) throw new Error("Copy stranded after process restart");
      const confirm = phase === "write-confirm";
      expect(await recoverInterruptedWrite(live(), offer, { confirmedByDriver: confirm })).toBe(confirm ? "recovered" : "refused");
      if (!confirm) {
        expect(await findInterruptedWrites(live())).toEqual([offer]);
        expect(await readOpenShift(live())).toBeNull();
      }
    }
    await act(async () => { await current().signOut(); });
  } else throw new Error("Unknown restart phase");
});
