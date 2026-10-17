/**
 * D66 S6 — Save & Send stays OFF until the company website can receive
 * timesheets (S8). With the shipped switch: nothing is queued, nothing is
 * sent — not even a record found on disk — no status is shown, and the
 * declaration says plainly that nothing is sent.
 */
import { render } from "@testing-library/react-native";
import { startLocalShift, type WorkingContext } from "../shift/localShift";
import { FinalDeclaration } from "../screens/FinalDeclaration";
import { SEND_TIMESHEETS } from "../sync/sending";
import { queueTimesheet } from "../sync/submissionQueue";
import { submissionStatusOf } from "../sync/submissionStatus";
import { SUBMISSION_FILE_PREFIX, SUBMISSION_STATE, readSubmission, writeSeal, writeSubmission } from "../sync/submissionStore";
import { runSync, type WithIdentity } from "../sync/syncRunner";
import { finishDeclared } from "./declared";
import { accountDirectoryOf, scopeFor } from "./testScope";

const SCOPE = scopeFor("user_send_off_1");
const NORTHGATE: WorkingContext = { kind: "company", membershipId: "m_north", companyId: "c_north", companyName: "Northgate Haulage" };
const identity: WithIdentity = call => call("id.token");
const at = (hours: number) => new Date(2026, 9, 11, hours, 0);

beforeEach(() => { for (const entry of accountDirectoryOf(SCOPE).list()) entry.delete(); });
afterEach(() => { jest.restoreAllMocks(); });

test("SD1. the app ships with sending OFF", () => {
  expect(SEND_TIMESHEETS).toBe(false);
});

test("SD2. switched off: Save & Send queues nothing, the runner sends nothing — not even a record already on disk — and no status is shown", async () => {
  const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(() => Promise.reject(new Error("no request may be made")));
  const open = await startLocalShift(SCOPE, { workingFor: NORTHGATE, startedAt: at(6), vehicle: null });
  const day = await finishDeclared(SCOPE, { shiftId: open.id, vehicleUseId: null, trailerUseId: null, finalMileage: null, endedAt: at(16), nightOut: false, notes: "" });
  if (day === null) throw new Error("the day did not finish");

  expect((await queueTimesheet(SCOPE, day.id)).kind).toBe("disabled");
  expect(accountDirectoryOf(SCOPE).list().some(entry => entry.name.startsWith(SUBMISSION_FILE_PREFIX))).toBe(false);

  // A genuine, sendable record and seal on disk (from a build with sending on) is still never sent.
  const snapshot = { schemaVersion: 1, day: {}, vehicles: [], trailers: [], declaration: {} };
  writeSeal(SCOPE, { ownerUserId: SCOPE.userId, dayId: day.id, generation: 1, membershipId: "m_north", companyName: "Northgate Haulage", declaredVersion: "v", snapshotJson: JSON.stringify(snapshot) }, true);
  writeSubmission(SCOPE, {
    ownerUserId: SCOPE.userId, dayId: day.id, membershipId: "m_north", companyName: "Northgate Haulage", revision: 1, snapshot,
    declaredVersion: "v", generation: 1, seq: 1, queuedAt: at(16).toISOString(), state: SUBMISSION_STATE.waiting,
    attempts: 0, lastAttemptAt: null, result: null, problem: null, earlier: [],
  });
  expect(readSubmission(SCOPE, day.id).kind).toBe("ok");
  await runSync(SCOPE, identity);

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(submissionStatusOf(SCOPE, day)).toBeNull();
});

test("SD3. switched off, the declaration says plainly that nothing is sent", async () => {
  const view = await render(<FinalDeclaration workingFor={NORTHGATE} confirmed={false} onToggle={() => undefined} submitting={false} onConfirm={() => undefined} testID="final" />);
  expect(view.getByTestId("final-meaning").props.children).toMatch(/nothing is sent to Northgate Haulage/);
  expect(view.queryByText("Save & Send Timesheet")).toBeNull();
});
