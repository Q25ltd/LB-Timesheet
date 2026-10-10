/** F-37: an interrupted replacement must not strand an owned working day. */
import { Directory, File, Paths } from "expo-file-system";
import { AccountScope } from "../shift/accountScope";
import {
  correctOpenShift, OPEN_SHIFT_FILE, OPEN_SHIFT_TEMP_FILE, readOpenShift,
  SafeSaveFailedError, startLocalShift,
  findInterruptedWrites, recoverInterruptedWrite, readCompletedShift, finishOpenShift,
  completedFrom, timesheetVersion, clearOpenShift, RECOVERY_FILE_PREFIX,
} from "../shift/localShift";
import { accountDirectoryOf } from "./testScope";

const A = "interrupted_recovery_a";
const B = "interrupted_recovery_b";
const INPUT = { workingFor: { kind: "personal" as const }, startedAt: new Date("2026-10-10T06:00:00Z"), vehicle: null };
beforeEach(() => { for (const entry of new Directory(Paths.document).list()) entry.delete(); });
afterEach(() => { jest.restoreAllMocks(); });

test("interruption after live deletion retains a recoverable owned day without granting B access", async () => {
  const a = AccountScope.forAccount({ id: A });
  const day = await startLocalShift(a, INPUT);
  jest.spyOn(File.prototype, "moveSync").mockImplementationOnce(destination => {
    if (typeof destination === "string") throw new Error("Expected the record target");
    if (destination.exists) destination.delete();
    throw new Error("Interrupted after target deletion");
  });
  await expect(correctOpenShift(a, { shiftId: day.id, workingFor: day.workingFor, startedAt: new Date("2026-10-10T05:00:00Z") })).rejects.toBeInstanceOf(SafeSaveFailedError);
  jest.restoreAllMocks();
  expect(new File(accountDirectoryOf(a), OPEN_SHIFT_FILE).exists).toBe(false);
  expect(new File(accountDirectoryOf(a), OPEN_SHIFT_TEMP_FILE).exists).toBe(true);
  a.revoke();
  expect(await readOpenShift(AccountScope.forAccount({ id: B }))).toBeNull();
  const restoredScope = AccountScope.forAccount({ id: A });
  // D37: the unacknowledged copy remains an offer until explicitly accepted.
  expect(await readOpenShift(restoredScope)).toBeNull();
  const [offer] = await findInterruptedWrites(restoredScope);
  if (offer === undefined) throw new Error("Interrupted copy was stranded");
  expect(await recoverInterruptedWrite(restoredScope, offer, { confirmedByDriver: false })).toBe("refused");
  expect(await readOpenShift(restoredScope)).toBeNull();
  expect(await recoverInterruptedWrite(restoredScope, offer, { confirmedByDriver: true })).toBe("recovered");
  const recovered = await readOpenShift(restoredScope);
  expect(recovered?.id).toBe(day.id);
  expect(recovered?.ownerUserId).toBe(A);
  expect(recovered?.startedAt).toBe("2026-10-10T05:00:00.000Z");
  expect(recovered?.recoveredAt).toEqual(expect.any(String));
});

test("a valid live record wins over an older temporary copy", async () => {
  const a = AccountScope.forAccount({ id: A });
  const old = await startLocalShift(a, INPUT);
  const oldBytes = new File(accountDirectoryOf(a), OPEN_SHIFT_FILE).textSync();
  const newer = await correctOpenShift(a, { shiftId: old.id, workingFor: old.workingFor, startedAt: new Date("2026-10-10T07:00:00Z") });
  const temp = new File(accountDirectoryOf(a), OPEN_SHIFT_TEMP_FILE);
  temp.create({ overwrite: true });
  temp.write(oldBytes);
  a.revoke();
  expect(await readOpenShift(AccountScope.forAccount({ id: A }))).toEqual(newer);
  expect(await findInterruptedWrites(AccountScope.forAccount({ id: A }))).toEqual([]);
});

test.each(["foreign", "incomplete"])("a %s temporary copy is never adopted as this account's day", async kind => {
  const a = AccountScope.forAccount({ id: A });
  await startLocalShift(a, INPUT);
  const bytes = new File(accountDirectoryOf(a), OPEN_SHIFT_FILE).textSync();
  const b = AccountScope.forAccount({ id: B });
  const temp = new File(accountDirectoryOf(b), OPEN_SHIFT_TEMP_FILE);
  temp.create({ overwrite: true });
  temp.write(kind === "foreign" ? bytes : "{\"partial\":");
  expect(await readOpenShift(b)).toBeNull();
  expect(await findInterruptedWrites(b)).toEqual([]);
  expect(temp.textSync()).toBe(kind === "foreign" ? bytes : "{\"partial\":");
});

async function pendingOpen() {
  const scope = AccountScope.forAccount({ id: A });
  const day = await startLocalShift(scope, INPUT);
  const live = new File(accountDirectoryOf(scope), OPEN_SHIFT_FILE);
  const temp = new File(accountDirectoryOf(scope), OPEN_SHIFT_TEMP_FILE);
  temp.create(); temp.write(live.textSync()); live.delete();
  const [offer] = await findInterruptedWrites(scope);
  if (offer === undefined) throw new Error("No recovery offer");
  return { scope, day, live, temp, offer };
}

test("an offer cannot be accepted by B or through a revoked A scope", async () => {
  const { scope, offer } = await pendingOpen();
  expect(await recoverInterruptedWrite(AccountScope.forAccount({ id: B }), offer, { confirmedByDriver: true })).toBe("refused");
  scope.revoke();
  await expect(recoverInterruptedWrite(scope, offer, { confirmedByDriver: true })).rejects.toThrow();
});

test("changed bytes and an intervening destination both invalidate an offer", async () => {
  const { scope, offer, temp, live } = await pendingOpen();
  temp.write(offer.bytes.replace("06:00:00", "05:00:00"));
  expect(await recoverInterruptedWrite(scope, offer, { confirmedByDriver: true })).toBe("refused");
  temp.write(offer.bytes);
  live.create(); live.write("newer destination — preserve even if unreadable");
  expect(await recoverInterruptedWrite(scope, offer, { confirmedByDriver: true })).toBe("refused");
  expect(live.textSync()).toBe("newer destination — preserve even if unreadable");
});

test("interruption during recovery installation preserves the original and permits retry", async () => {
  const { scope, offer, temp } = await pendingOpen();
  jest.spyOn(File.prototype, "moveSync").mockImplementationOnce(() => { throw new Error("process interrupted"); });
  await expect(recoverInterruptedWrite(scope, offer, { confirmedByDriver: true })).rejects.toBeInstanceOf(SafeSaveFailedError);
  jest.restoreAllMocks();
  expect(temp.textSync()).toBe(offer.bytes);
  expect(await recoverInterruptedWrite(scope, offer, { confirmedByDriver: true })).toBe("recovered");
  expect(await recoverInterruptedWrite(scope, offer, { confirmedByDriver: true })).toBe("refused");
});

test("a completed interrupted copy is recovered only to its own missing destination", async () => {
  const scope = AccountScope.forAccount({ id: A });
  const day = await startLocalShift(scope, INPUT);
  jest.spyOn(File.prototype, "moveSync").mockImplementationOnce(() => { throw new Error("interrupted finish"); });
  await expect(finishOpenShift(scope, { shiftId: day.id, vehicleUseId: null, trailerUseId: null, finalMileage: null, endedAt: new Date("2026-10-10T12:00:00Z"), nightOut: false, notes: "", declared: null })).rejects.toBeInstanceOf(SafeSaveFailedError);
  jest.restoreAllMocks();
  const [offer] = await findInterruptedWrites(scope);
  if (offer === undefined) throw new Error("Missing completed offer");
  expect(offer.kind).toBe("completed");
  expect(await recoverInterruptedWrite(scope, offer, { confirmedByDriver: true })).toBe("recovered");
  expect((await readCompletedShift(scope, day.id))?.recoveredAt).toEqual(expect.any(String));
  expect(await readOpenShift(scope)).toBeNull();
});

test("company recovery preserves original membership and requires fresh declaration", async () => {
  const scope = AccountScope.forAccount({ id: A });
  const context = { kind: "company" as const, membershipId: "original_membership", companyId: "original_company", companyName: "Original Company" };
  const open = await startLocalShift(scope, { ...INPUT, workingFor: context });
  const completed = completedFrom(open, { finalMileage: null, endedAt: new Date("2026-10-10T12:00:00Z"), nightOut: false, notes: "Keep these facts" });
  const copy = { ...completed, declaration: { version: timesheetVersion(completed), declaredAt: "2026-10-10T12:00:00Z", declaredBy: "Original Driver" } };
  const temp = new File(accountDirectoryOf(scope), OPEN_SHIFT_TEMP_FILE);
  temp.create(); temp.write(JSON.stringify(copy));
  const [offer] = await findInterruptedWrites(scope);
  if (offer === undefined) throw new Error("No completed offer");
  expect(await recoverInterruptedWrite(scope, offer, { confirmedByDriver: true })).toBe("recovered");
  const recovered = await readCompletedShift(scope, completed.id);
  expect(recovered?.ownerUserId).toBe(A);
  expect(recovered?.workingFor).toEqual(context);
  expect(recovered?.notes).toBe("Keep these facts");
  expect(recovered?.declaration).toBeUndefined();
  expect(recovered?.recoveredAt).toEqual(expect.any(String));
});

/** The interruption D37 documents: the verified next state is in the temporary file, the live file gone. */
function strand(scope: AccountScope): string {
  const live = new File(accountDirectoryOf(scope), OPEN_SHIFT_FILE);
  const bytes = live.textSync();
  live.moveSync(new File(accountDirectoryOf(scope), OPEN_SHIFT_TEMP_FILE), { overwrite: true });
  return bytes;
}

test("only an UNFINISHED copy is offered — a valid day kept as unreadable is retained, not offered", async () => {
  const a = AccountScope.forAccount({ id: A });
  await startLocalShift(a, INPUT);
  const bytes = strand(a);
  // The same valid bytes, but filed under the reason the store gives a day it could NOT read.
  const kept = new File(accountDirectoryOf(a), `${RECOVERY_FILE_PREFIX}unreadable-1-x.json`);
  new File(accountDirectoryOf(a), OPEN_SHIFT_TEMP_FILE).moveSync(kept, { overwrite: false });

  expect(await findInterruptedWrites(a)).toEqual([]);
  expect(kept.textSync()).toBe(bytes);
});

test("an accepted copy is archived: discarding the recovered day never brings the same copy back as an offer", async () => {
  const a = AccountScope.forAccount({ id: A });
  await startLocalShift(a, INPUT);
  strand(a);
  const [offer] = await findInterruptedWrites(a);
  if (offer === undefined) throw new Error("expected an offer");
  expect(await recoverInterruptedWrite(a, offer, { confirmedByDriver: true })).toBe("recovered");

  await clearOpenShift(a);
  // A later write may move leftovers aside; none of them is the accepted copy.
  await startLocalShift(a, { ...INPUT, startedAt: new Date("2026-10-11T06:00:00Z") });
  await clearOpenShift(a);

  expect(await findInterruptedWrites(a)).toEqual([]);
  const archived = accountDirectoryOf(a).list().filter(entry => entry.name.startsWith(`${RECOVERY_FILE_PREFIX}accepted-`));
  expect(archived).toHaveLength(1);
});
