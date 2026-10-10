import { Alert } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Directory, File, Paths } from "expo-file-system";
import { InterruptedRecovery } from "../components/InterruptedRecovery";
import { AccountScope } from "../shift/accountScope";
import { startLocalShift, readOpenShift, OPEN_SHIFT_FILE, OPEN_SHIFT_TEMP_FILE } from "../shift/localShift";
import { accountDirectoryOf } from "./testScope";

jest.mock("expo-router", () => {
  const react = jest.requireActual<typeof import("react")>("react");
  return { useFocusEffect: (effect: () => (() => void) | undefined) => { react.useEffect(effect, [effect]); } };
});
beforeEach(() => { for (const entry of new Directory(Paths.document).list()) entry.delete(); });
afterEach(() => { jest.restoreAllMocks(); });
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

async function setup() {
  const scope = AccountScope.forAccount({ id: "recovery_ui_a" });
  const day = await startLocalShift(scope, { workingFor: { kind: "personal" }, startedAt: new Date("2026-10-10T06:00:00Z"), vehicle: null });
  const live = new File(accountDirectoryOf(scope), OPEN_SHIFT_FILE);
  const temp = new File(accountDirectoryOf(scope), OPEN_SHIFT_TEMP_FILE);
  const bytes = live.textSync(); temp.create(); temp.write(bytes); live.delete();
  const alerts = jest.spyOn(Alert, "alert");
  const onRecovered = jest.fn();
  const view = await render(<SafeAreaProvider initialMetrics={METRICS}><InterruptedRecovery scope={scope} onRecovered={onRecovered} /></SafeAreaProvider>);
  await waitFor(() => { expect(view.getByRole("button")).toBeTruthy(); });
  return { scope, day, temp, bytes, alerts, view, onRecovered };
}

test("Not now preserves bytes; only the explicit Recover action accepts the copy", async () => {
  const { scope, temp, bytes, alerts, view, onRecovered } = await setup();
  await fireEvent.press(view.getByRole("button"));
  const buttons = alerts.mock.calls[0]?.[2];
  expect(buttons?.find(button => button.text === "Not now")?.style).toBe("cancel");
  expect(temp.textSync()).toBe(bytes);
  expect(await readOpenShift(scope)).toBeNull();
  expect(onRecovered).not.toHaveBeenCalled();
  const recover = buttons?.find(button => button.text === "Recover")?.onPress;
  if (recover === undefined) throw new Error("Missing confirmation control");
  await act(() => { recover(); });
  await waitFor(() => { expect(onRecovered).toHaveBeenCalledTimes(1); });
  expect((await readOpenShift(scope))?.recoveredAt).toEqual(expect.any(String));
  expect(alerts).toHaveBeenLastCalledWith("Interrupted copy recovered", expect.stringContaining("not acknowledged"));
});

test("switching accounts hides the offer and invalidates a pending confirmation", async () => {
  const { scope, temp, bytes, alerts, view, onRecovered } = await setup();
  await fireEvent.press(view.getByRole("button"));
  const recover = alerts.mock.calls[0]?.[2]?.find(button => button.text === "Recover")?.onPress;
  if (recover === undefined) throw new Error("Missing confirmation");
  scope.revoke();
  const b = AccountScope.forAccount({ id: "recovery_ui_b" });
  await view.rerender(<SafeAreaProvider initialMetrics={METRICS}><InterruptedRecovery scope={b} onRecovered={onRecovered} /></SafeAreaProvider>);
  expect(view.queryByRole("button")).toBeNull();
  await act(() => { recover(); });
  expect(onRecovered).not.toHaveBeenCalled();
  expect(temp.textSync()).toBe(bytes);
  expect(await readOpenShift(b)).toBeNull();
});
