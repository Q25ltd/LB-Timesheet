/**
 * F-31 — the phone's records belong to ONE account each.
 *
 * A phone may be shared: driver A signs out and driver B signs in. Before
 * F-31 every local record lived in one shared place and named no account, so
 * B was shown, and could change, finish and delete, A's days. These tests
 * drive the REAL store against the in-memory filesystem, through the same
 * functions the app's routes call, and prove at the STORAGE layer — not the
 * UI — that:
 *
 *   - one account's records are unreachable through another account's scope
 *     (read, write, finish, correct, delete, recover);
 *   - sign-out keeps every record, and the same driver signing in again
 *     finds them;
 *   - a forged, revoked or malformed scope reaches nothing;
 *   - a record whose stored owner is wrong or missing is never served;
 *   - interrupted-write and recovery files stay in their own account;
 *   - records written before accounts existed are quarantined, never handed
 *     to whoever signs in, and recovered only on conclusive evidence AND the
 *     driver's explicit confirmation.
 */
import { Directory, File, Paths } from "expo-file-system";
import { ACCOUNTS_DIRECTORY, AccountScope, AccountScopeError } from "../shift/accountScope";
import {
  COMPLETED_SHIFT_FILE_PREFIX,
  LEGACY_QUARANTINE_DIRECTORY,
  OPEN_SHIFT_FILE,
  OPEN_SHIFT_TEMP_FILE,
  RECOVERY_FILE_PREFIX,
  addVehicleToOpenShift,
  clearOpenShift,
  completedFrom,
  correctCompletedShift,
  correctOpenShift,
  deleteCompletedShift,
  findRecoverableLegacyRecords,
  finishOpenShift,
  listCompletedShifts,
  readCompletedShift,
  readFinishedDayOfUses,
  readOpenShift,
  recoverLegacyRecord,
  recordVehicleFill,
  startLocalShift,
  timesheetVersion,
  type FinishShiftInput,
  type WorkingContext,
} from "../shift/localShift";
import { correctDeclared } from "./declared";

const A = { id: "user_driver_a" };
const B = { id: "user_driver_b" };

const NORTHGATE: WorkingContext = { kind: "company", membershipId: "mem_a_northgate", companyId: "co_northgate", companyName: "Northgate Logistics" };
const SEAWAY: WorkingContext = { kind: "company", membershipId: "mem_a_seaway", companyId: "co_seaway", companyName: "Seaway Freight" };
const A_MEMBERSHIPS = [
  { membershipId: "mem_a_northgate", companyId: "co_northgate", companyName: "Northgate Logistics", role: "driver" as const },
  { membershipId: "mem_a_seaway", companyId: "co_seaway", companyName: "Seaway Freight", role: "driver" as const },
];
const B_MEMBERSHIPS = [{ membershipId: "mem_b_northgate", companyId: "co_northgate", companyName: "Northgate Logistics", role: "driver" as const }];

const LORRY = { vehicleClass: "class1" as const, numberPlate: "AB24 XYZ", startMileage: 184_203 };
const at = (hour: number, day = 13) => new Date(2026, 8, day, hour, 0);

/** Everything under the document directory — the simulated phone. */
function wipePhone(): void {
  for (const entry of new Directory(Paths.document).list()) entry.delete();
}

function accountDir(user: { id: string }): Directory {
  return new Directory(Paths.document, ACCOUNTS_DIRECTORY, user.id);
}

/** A driver's day from start to a finished record, declared as the Review would. */
async function finishedDay(scope: AccountScope, workingFor: WorkingContext, day = 13) {
  const open = await startLocalShift(scope, { workingFor, startedAt: at(5, day), vehicle: null });
  const finish: FinishShiftInput = {
    shiftId: open.id, vehicleUseId: null, trailerUseId: null,
    finalMileage: null, endedAt: at(17, day), nightOut: false, notes: "", declared: null,
  };
  const version = timesheetVersion(completedFrom(open, finish));
  const done = await finishOpenShift(scope, { ...finish, declared: { at: at(17, day), by: "driver", version } });
  expect(done).not.toBeNull();
  return done!;
}

beforeEach(() => { wipePhone(); });

// ═══════════════════════════════════════════════════════════════════════════
// The original vulnerability: A signs out, B signs in
// ═══════════════════════════════════════════════════════════════════════════

test("RED-1. B, signed in after A, does not see A's unfinished day — and starting B's own day does not hand back A's", async () => {
  const a = AccountScope.forAccount(A);
  const aDay = await startLocalShift(a, { workingFor: NORTHGATE, startedAt: at(5), vehicle: LORRY });
  a.revoke(); // A signs out

  const b = AccountScope.forAccount(B);
  expect(await readOpenShift(b)).toBeNull();
  const bDay = await startLocalShift(b, { workingFor: { kind: "personal" }, startedAt: at(6), vehicle: null });
  expect(bDay.id).not.toBe(aDay.id);
  expect(bDay.workingFor).toEqual({ kind: "personal" });
});

test("RED-2. B cannot modify, correct, finish or discard A's unfinished day, by its id or otherwise", async () => {
  const a = AccountScope.forAccount(A);
  const aDay = await startLocalShift(a, { workingFor: NORTHGATE, startedAt: at(5), vehicle: LORRY });
  a.revoke();

  const b = AccountScope.forAccount(B);
  expect(await addVehicleToOpenShift(b, { vehicle: LORRY, startedAt: at(7) })).toBeNull();
  expect(await recordVehicleFill(b, {
    shiftId: aDay.id, vehicleUseId: aDay.vehicle!.useId, usageState: "in-use", fillId: "fill-1", type: "fuel",
    recordedAt: at(8), litres: 50, note: "",
  })).toBeNull();
  expect(await correctOpenShift(b, { shiftId: aDay.id, workingFor: { kind: "personal" }, startedAt: at(4) })).toBeNull();
  expect(await finishOpenShift(b, {
    shiftId: aDay.id, vehicleUseId: aDay.vehicle!.useId, trailerUseId: null,
    finalMileage: 184_300, endedAt: at(17), nightOut: false, notes: "", declared: { at: at(17), by: "driver", version: "any" },
  })).toBeNull();
  await clearOpenShift(b);

  // A signs in again: the day is exactly as A left it.
  const aAgain = AccountScope.forAccount(A);
  expect(await readOpenShift(aAgain)).toEqual(aDay);
});

test("RED-3. A's FINISHED days are invisible to B: not listed, not read, not corrected, not deleted, not reopened", async () => {
  const a = AccountScope.forAccount(A);
  const done = await finishedDay(a, NORTHGATE);
  a.revoke();

  const b = AccountScope.forAccount(B);
  expect((await listCompletedShifts(b)).timesheets).toEqual([]);
  expect(await readCompletedShift(b, done.id)).toBeNull();
  expect(await readFinishedDayOfUses(b, done.id)).toBeNull();
  expect(await correctCompletedShift(b, {
    shiftId: done.id, basedOn: null, correctionId: "corr-b", workingFor: { kind: "personal" },
    startedAt: at(4), endedAt: at(18), nightOut: true, notes: "B's edit",
    correctedAt: at(19), correctedBy: "driver-b", declared: null,
  })).toBeNull();
  expect(await deleteCompletedShift(b, done.id)).toBe(false);

  const aAgain = AccountScope.forAccount(A);
  expect(await readCompletedShift(aAgain, done.id)).toEqual(done);
  expect((await listCompletedShifts(aAgain)).timesheets.map(s => s.id)).toEqual([done.id]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Sign-out keeps everything; the same driver gets it back
// ═══════════════════════════════════════════════════════════════════════════

test("sign-out keeps the unsynchronised day and finished days; a restart with a fresh scope for A finds them all", async () => {
  const a = AccountScope.forAccount(A);
  const done = await finishedDay(a, NORTHGATE, 12);
  const open = await startLocalShift(a, { workingFor: SEAWAY, startedAt: at(5), vehicle: LORRY });
  a.revoke(); // signed out; the process may now be killed — only the files remain

  const afterRestart = AccountScope.forAccount(A);
  expect(await readOpenShift(afterRestart)).toEqual(open);
  expect(await readCompletedShift(afterRestart, done.id)).toEqual(done);
  // On disk, under A's own directory, each record naming A.
  const stored = JSON.parse(new File(accountDir(A), OPEN_SHIFT_FILE).textSync()) as { ownerUserId?: string };
  expect(stored.ownerUserId).toBe(A.id);
});

test("a driver working for two companies keeps each day's own company — the association lives inside the driver's account", async () => {
  const a = AccountScope.forAccount(A);
  const northgateDay = await finishedDay(a, NORTHGATE, 11);
  const seawayDay = await finishedDay(a, SEAWAY, 12);

  const listed = (await listCompletedShifts(a)).timesheets;
  expect(new Map(listed.map(s => [s.id, s.workingFor]))).toEqual(new Map([[northgateDay.id, NORTHGATE], [seawayDay.id, SEAWAY]]));
  // B, who also drives for Northgate, learns nothing of A's Northgate day.
  expect((await listCompletedShifts(AccountScope.forAccount(B))).timesheets).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Forged, revoked and malformed scopes
// ═══════════════════════════════════════════════════════════════════════════

test("a revoked scope reaches nothing — including work queued before the revocation", async () => {
  const a = AccountScope.forAccount(A);
  const day = await startLocalShift(a, { workingFor: NORTHGATE, startedAt: at(5), vehicle: null });
  const pending = addVehicleToOpenShift(a, { vehicle: LORRY, startedAt: at(6) });
  a.revoke();
  await expect(pending).rejects.toBeInstanceOf(AccountScopeError);
  await expect(readOpenShift(a)).rejects.toBeInstanceOf(AccountScopeError);
  await expect(listCompletedShifts(a)).rejects.toBeInstanceOf(AccountScopeError);
  // Nothing was written by the refused call.
  const kept = await readOpenShift(AccountScope.forAccount(A));
  expect(kept?.id).toBe(day.id);
  expect(kept?.vehicle).toBeNull();
});

test("a FORGED scope — a look-alike object, or one built from the class's prototype — is refused", async () => {
  await startLocalShift(AccountScope.forAccount(A), { workingFor: NORTHGATE, startedAt: at(5), vehicle: null });
  const lookAlike = { userId: A.id, revoke: () => undefined } as unknown as AccountScope;
  const prototypeForgery = Object.assign(Object.create(AccountScope.prototype) as object, { userId: A.id }) as AccountScope;
  for (const forged of [lookAlike, prototypeForgery, null as unknown as AccountScope, undefined as unknown as AccountScope]) {
    await expect(readOpenShift(forged)).rejects.toBeInstanceOf(AccountScopeError);
    await expect(listCompletedShifts(forged)).rejects.toBeInstanceOf(AccountScopeError);
  }
});

test("an account id that could escape its directory is refused before any storage exists for it", () => {
  for (const id of ["", "../user_driver_a", "user/a", ".", "..", "a b", "x".repeat(65), 42, null]) {
    expect(() => AccountScope.forAccount({ id })).toThrow(AccountScopeError);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Manipulated ownership on disk
// ═══════════════════════════════════════════════════════════════════════════

test("a record placed in B's directory but naming A as owner is never served to B — nor written over", async () => {
  const a = AccountScope.forAccount(A);
  const aDay = await startLocalShift(a, { workingFor: NORTHGATE, startedAt: at(5), vehicle: LORRY });
  // Someone copies A's day into B's directory.
  const planted = new File(accountDir(B), OPEN_SHIFT_FILE);
  accountDir(B).create({ intermediates: true, idempotent: true });
  planted.create({ overwrite: true });
  planted.write(new File(accountDir(A), OPEN_SHIFT_FILE).textSync());

  const b = AccountScope.forAccount(B);
  expect(await readOpenShift(b)).toBeNull();
  expect(await addVehicleToOpenShift(b, { vehicle: LORRY, startedAt: at(7) })).toBeNull();
  // B starting a day moves the foreign file aside rather than overwriting or adopting it.
  const bDay = await startLocalShift(b, { workingFor: { kind: "personal" }, startedAt: at(6), vehicle: null });
  expect(bDay.ownerUserId).toBe(B.id);
  expect(bDay.id).not.toBe(aDay.id);
  // A's bytes went to quarantine as FOREIGN — not into B's recovery files,
  // where they would still be inside B's account.
  expect(accountDir(B).list().some(entry => entry instanceof File && entry.textSync().includes(aDay.id))).toBe(false);
  expect(quarantined().filter(entry => entry.name.startsWith("foreign-")).map(entry => (JSON.parse(entry.text) as { id: string }).id)).toEqual([aDay.id]);
});

test("a record re-labelled with another owner, or with no owner, is refused in its own account too", async () => {
  const a = AccountScope.forAccount(A);
  const done = await finishedDay(a, NORTHGATE);
  const file = new File(accountDir(A), `${COMPLETED_SHIFT_FILE_PREFIX}${done.id}.json`);
  const record = JSON.parse(file.textSync()) as Record<string, unknown>;

  for (const owner of [B.id, undefined, "", 7]) {
    const tampered = { ...record, ownerUserId: owner };
    if (owner === undefined) delete tampered.ownerUserId;
    file.write(JSON.stringify(tampered));
    expect(await readCompletedShift(a, done.id)).toBeNull();
    expect((await listCompletedShifts(a)).timesheets).toEqual([]);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Interrupted writes and recovery files
// ═══════════════════════════════════════════════════════════════════════════

test("an interrupted write's temporary file stays in its own account: never read by B, never moved into B's records", async () => {
  const a = AccountScope.forAccount(A);
  const aDay = await startLocalShift(a, { workingFor: NORTHGATE, startedAt: at(5), vehicle: null });
  // A crash between the delete and the rename: only the temp copy of A's day.
  const aDir = accountDir(A);
  new File(aDir, OPEN_SHIFT_FILE).moveSync(new File(aDir, OPEN_SHIFT_TEMP_FILE), { overwrite: true });

  const b = AccountScope.forAccount(B);
  expect(await readOpenShift(b)).toBeNull();
  await startLocalShift(b, { workingFor: { kind: "personal" }, startedAt: at(6), vehicle: null });
  const bNames = accountDir(B).list().map(entry => entry.name);
  expect(bNames.some(name => name.startsWith(RECOVERY_FILE_PREFIX))).toBe(false);
  expect(new File(aDir, OPEN_SHIFT_TEMP_FILE).exists).toBe(true);

  // A's own next write keeps that copy for recovery, inside A's directory.
  await startLocalShift(AccountScope.forAccount(A), { workingFor: NORTHGATE, startedAt: at(7), vehicle: null });
  const kept = aDir.list().filter(entry => entry.name.startsWith(RECOVERY_FILE_PREFIX));
  expect(kept).toHaveLength(1);
  expect((JSON.parse((kept[0] as File).textSync()) as { id: string }).id).toBe(aDay.id);
});

// ═══════════════════════════════════════════════════════════════════════════
// Records written before accounts existed
// ═══════════════════════════════════════════════════════════════════════════

function legacyRecord(id: string, workingFor: WorkingContext) {
  return {
    id, workingFor, startedAt: at(5).toISOString(),
    vehicle: null, previousVehicles: [], trailer: null, previousTrailers: [],
    status: "open", createdAt: at(5).toISOString(),
  };
}

function plantLegacy(name: string, content: string): void {
  const file = new File(Paths.document, name);
  file.create({ overwrite: true });
  file.write(content);
}

function quarantined(): { name: string; text: string }[] {
  const root = new Directory(Paths.document, LEGACY_QUARANTINE_DIRECTORY);
  if (!root.exists) return [];
  const out: { name: string; text: string }[] = [];
  const walk = (dir: Directory): void => {
    for (const entry of dir.list()) {
      if (entry instanceof Directory) walk(entry);
      else out.push({ name: entry.name, text: entry.textSync() });
    }
  };
  walk(root);
  return out;
}

test("records from before accounts existed are NOT given to whoever signs in: quarantined byte for byte, nothing deleted", async () => {
  const openText = JSON.stringify(legacyRecord("11111111-1111-4111-8111-111111111111", NORTHGATE));
  plantLegacy(OPEN_SHIFT_FILE, openText);
  plantLegacy(OPEN_SHIFT_TEMP_FILE, "{\"partial\":");
  plantLegacy(`${RECOVERY_FILE_PREFIX}unreadable-1-x.json`, "garbage");
  plantLegacy(`${COMPLETED_SHIFT_FILE_PREFIX}22222222-2222-4222-8222-222222222222.json`, "{\"legacy\":true}");

  const b = AccountScope.forAccount(B);
  expect(await readOpenShift(b)).toBeNull();
  expect((await listCompletedShifts(b)).timesheets).toEqual([]);
  const a = AccountScope.forAccount(A);
  expect(await readOpenShift(a)).toBeNull();
  expect((await listCompletedShifts(a)).timesheets).toEqual([]);

  // Nothing left in the shared place, nothing lost.
  for (const name of [OPEN_SHIFT_FILE, OPEN_SHIFT_TEMP_FILE]) expect(new File(Paths.document, name).exists).toBe(false);
  const kept = quarantined().map(entry => entry.text).sort();
  expect(kept).toEqual([openText, "{\"partial\":", "garbage", "{\"legacy\":true}"].sort());
});

test("legacy recovery: only a record whose company membership the SIGNED-IN account holds is offered; personal, foreign and unreadable ones stay quarantined", async () => {
  plantLegacy(OPEN_SHIFT_FILE, JSON.stringify(legacyRecord("33333333-3333-4333-8333-333333333333", NORTHGATE)));
  plantLegacy(`${COMPLETED_SHIFT_FILE_PREFIX}44444444-4444-4444-8444-444444444444.json`, "{\"not\":\"a day\"}");

  // B shares the COMPANY but not the MEMBERSHIP — the evidence is the membership.
  expect(await findRecoverableLegacyRecords(AccountScope.forAccount(B), B_MEMBERSHIPS)).toEqual([]);
  const offered = await findRecoverableLegacyRecords(AccountScope.forAccount(A), A_MEMBERSHIPS);
  expect(offered.map(record => record.shiftId)).toEqual(["33333333-3333-4333-8333-333333333333"]);

  plantLegacy(OPEN_SHIFT_FILE, JSON.stringify(legacyRecord("55555555-5555-4555-8555-555555555555", { kind: "personal" })));
  const personalOffered = await findRecoverableLegacyRecords(AccountScope.forAccount(A), A_MEMBERSHIPS);
  expect(personalOffered.map(record => record.shiftId)).not.toContain("55555555-5555-4555-8555-555555555555");
});

test("legacy recovery needs the driver's explicit confirmation, writes the day into THAT account with its owner, and never overwrites an open day", async () => {
  plantLegacy(OPEN_SHIFT_FILE, JSON.stringify(legacyRecord("66666666-6666-4666-8666-666666666666", NORTHGATE)));
  const a = AccountScope.forAccount(A);
  const [offer] = await findRecoverableLegacyRecords(a, A_MEMBERSHIPS);
  expect(offer).toBeDefined();

  // Without the driver's confirmation: refused, nothing moves.
  await expect(recoverLegacyRecord(a, A_MEMBERSHIPS, offer!.key, { confirmedByDriver: false } as unknown as { confirmedByDriver: true })).rejects.toThrow();
  expect(await readOpenShift(a)).toBeNull();

  // B cannot recover A's record even by naming its key.
  expect(await recoverLegacyRecord(AccountScope.forAccount(B), B_MEMBERSHIPS, offer!.key, { confirmedByDriver: true })).toBe("refused");

  expect(await recoverLegacyRecord(a, A_MEMBERSHIPS, offer!.key, { confirmedByDriver: true })).toBe("recovered");
  const recovered = await readOpenShift(a);
  expect(recovered?.id).toBe("66666666-6666-4666-8666-666666666666");
  expect(recovered?.ownerUserId).toBe(A.id);
  expect(await findRecoverableLegacyRecords(a, A_MEMBERSHIPS)).toEqual([]);

  // A second legacy open day cannot replace the one A now has: it stays quarantined.
  plantLegacy(OPEN_SHIFT_FILE, JSON.stringify(legacyRecord("77777777-7777-4777-8777-777777777777", SEAWAY)));
  const [second] = await findRecoverableLegacyRecords(a, A_MEMBERSHIPS);
  expect(await recoverLegacyRecord(a, A_MEMBERSHIPS, second!.key, { confirmedByDriver: true })).toBe("refused");
  expect((await readOpenShift(a))?.id).toBe("66666666-6666-4666-8666-666666666666");
});

test("legacy recovery: a record in the shared place that ALREADY names an owner is not legacy — it is never offered, never recovered", async () => {
  // No build before F-31 wrote an owner; one that carries one was put there.
  for (const owner of [A.id, B.id]) {
    wipePhone();
    plantLegacy(OPEN_SHIFT_FILE, JSON.stringify({ ...legacyRecord("88888888-8888-4888-8888-888888888888", NORTHGATE), ownerUserId: owner }));
    const a = AccountScope.forAccount(A);
    expect(await findRecoverableLegacyRecords(a, A_MEMBERSHIPS)).toEqual([]);
    const [kept] = quarantined();
    expect(await recoverLegacyRecord(a, A_MEMBERSHIPS, kept!.name, { confirmedByDriver: true })).toBe("refused");
    expect(await readOpenShift(a)).toBeNull();
    expect(quarantined()).toEqual([kept]);
  }
});

test("legacy recovery: a finished day is attributable only if EVERY company it names — every correction too — is a membership the account holds", async () => {
  // Build a finished day in a throwaway account, then strip its owner: the
  // shape a pre-F-31 phone holds. Northgate (A's) originally, corrected to
  // a context A does not hold.
  const cases: [WorkingContext, "recovered" | "refused"][] = [
    [{ kind: "personal" }, "refused"],
    [{ ...NORTHGATE, membershipId: "mem_b_northgate" }, "refused"],
    // CONTROL: corrected to Seaway, which A also holds — conclusive, so offered.
    [SEAWAY, "recovered"],
  ];
  for (const [correctedTo, outcome] of cases) {
    wipePhone();
    const maker = AccountScope.forAccount({ id: "user_legacy_maker" });
    const done = await finishedDay(maker, NORTHGATE);
    const corrected = await correctDeclared(maker, {
      shiftId: done.id, basedOn: null, correctionId: "corr-legacy", workingFor: correctedTo,
      startedAt: at(5), endedAt: at(17), nightOut: false, notes: "", correctedAt: at(18), correctedBy: "driver",
    });
    expect(corrected?.corrections).toHaveLength(1);
    const name = `${COMPLETED_SHIFT_FILE_PREFIX}${done.id}.json`;
    const record = JSON.parse(new File(accountDir({ id: "user_legacy_maker" }), name).textSync()) as Record<string, unknown>;
    delete record.ownerUserId;
    maker.revoke();
    new Directory(Paths.document, ACCOUNTS_DIRECTORY).delete();
    plantLegacy(name, JSON.stringify(record));

    const a = AccountScope.forAccount(A);
    expect((await findRecoverableLegacyRecords(a, A_MEMBERSHIPS)).map(offer => offer.shiftId)).toEqual(outcome === "recovered" ? [done.id] : []);
    const [kept] = quarantined();
    expect(await recoverLegacyRecord(a, A_MEMBERSHIPS, kept!.name, { confirmedByDriver: true })).toBe(outcome);
    const read = await readCompletedShift(a, done.id);
    if (outcome === "refused") expect(read).toBeNull();
    else expect(read?.ownerUserId).toBe(A.id);
  }
});
