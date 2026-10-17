/**
 * D66 S6 — where sending stands, on the timesheet list and the timesheet:
 * the status line, Save & Send only when it may be offered, and a sent
 * (locked) day offering no way to change it in place.
 */
import type { ReactElement } from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { timesheetVersion, type CompletedShift } from "../shift/localShift";
import { TimesheetDetailScreen } from "../screens/TimesheetDetailScreen";
import { TimesheetRow } from "../screens/TimesheetRow";
import type { SubmissionStatus } from "../sync/submissionStatus";

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const onPhone = (element: ReactElement) => render(<SafeAreaProvider initialMetrics={METRICS}>{element}</SafeAreaProvider>);
const noop = () => undefined;

function day(): CompletedShift {
  const base: CompletedShift = {
    ownerUserId: "u1", id: "a1111111-2222-4333-8444-555555555555",
    workingFor: { kind: "company", membershipId: "m_north", companyId: "c_north", companyName: "Northgate Haulage" },
    startedAt: "2026-10-11T05:00:00.000Z", endedAt: "2026-10-11T15:00:00.000Z", nightOut: false, notes: null,
    previousVehicles: [], previousTrailers: [], status: "completed", createdAt: "2026-10-11T15:00:00.000Z",
  };
  return { ...base, declaration: { version: timesheetVersion(base), declaredAt: base.endedAt, declaredBy: "u1" } };
}

const actions = { onEdit: noop, onReview: noop, onDelete: noop, onOpenVehicleUse: noop, onOpenTrailerUse: noop, onVehicleCheck: noop, onTrailerCheck: noop };
const status = (over: Partial<SubmissionStatus>): SubmissionStatus => ({ label: "Waiting to send", detail: null, actionNeeded: false, locked: true, canSend: false, ...over });

test("SV1. the list shows each day's status — and nothing at all while there is none (sending off, a Personal day)", async () => {
  const shown = await onPhone(<TimesheetRow shift={day()} testID="row" last onOpen={noop} status={status({ label: "Sent to Northgate Haulage" })} />);
  expect(shown.getByTestId("row-status").props.children).toBe("Sent to Northgate Haulage");
  const none = await onPhone(<TimesheetRow shift={day()} testID="row" last onOpen={noop} />);
  expect(none.queryByTestId("row-status")).toBeNull();
});

test("SV2. a SENT day says so, and offers no way to change it here — no Edit, no Delete, no Send", async () => {
  const view = await onPhone(<TimesheetDetailScreen shift={day()} onBack={noop} {...actions} onSend={noop} status={status({ label: "Sent to Northgate Haulage", detail: "Reference TS-AAAA1111." })} />);
  expect(view.getByTestId("timesheet-status-label").props.children).toBe("Sent to Northgate Haulage");
  expect(view.getByTestId("timesheet-status-detail").props.children).toBe("Reference TS-AAAA1111.");
  expect(view.queryByTestId("timesheet-edit")).toBeNull();
  expect(view.queryByTestId("timesheet-delete")).toBeNull();
  expect(view.queryByTestId("timesheet-send")).toBeNull();
});

test("SV3. a day that may be sent offers Save & Send, and pressing it sends; it can still be edited", async () => {
  let pressed = 0;
  const view = await onPhone(<TimesheetDetailScreen shift={day()} onBack={noop} {...actions} onSend={() => { pressed += 1; }} status={status({ label: "Not sent", locked: false, canSend: true })} />);
  await fireEvent.press(view.getByTestId("timesheet-send"));
  expect(pressed).toBe(1);
  expect(view.getByTestId("timesheet-edit")).toBeTruthy();
});

test("SV4. sending off: no status, no Save & Send — the day as before", async () => {
  const view = await onPhone(<TimesheetDetailScreen shift={day()} onBack={noop} {...actions} />);
  expect(view.queryByTestId("timesheet-status")).toBeNull();
  expect(view.queryByTestId("timesheet-send")).toBeNull();
  expect(view.getByTestId("timesheet-edit")).toBeTruthy();
});
