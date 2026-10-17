/**
 * D66 stage S6 — Save & Send on the phone: the queue, its lock, its seal, the
 * sync runner's sending, what each answer means, and recovery from every
 * interruption between pressing Save & Send and the server's answer being
 * kept. Real account-isolated files; a scripted server (fetch).
 *
 * Sending is switched ON for this file (`sending.ts` is mocked): the app
 * ships with it off until S8 (`saveAndSendDisabled.test.ts`).
 */
import { File } from "expo-file-system";
import {
  TimesheetLockedError,
  USAGE_STATE,
  correctNumberPlate,
  deleteCompletedShift,
  readCompletedShift,
  startLocalShift,
  type CompletedShift,
  type WorkingContext,
} from "../shift/localShift";
import type { AccountScope } from "../shift/accountScope";
import { SESSION_RENEWAL_UNAVAILABLE } from "../auth/sessionRenewal";
import { runSync, type WithIdentity } from "../sync/syncRunner";
import { queueTimesheet } from "../sync/submissionQueue";
import { SUBMISSION_FILE_PREFIX, SUBMISSION_STATE, isDayLocked, readSeal, readSubmission, writeSeal, type TimesheetSubmissionRecord } from "../sync/submissionStore";
import { submissionStatusOf } from "../sync/submissionStatus";
import { correctDeclared, finishDeclared } from "./declared";
import { accountDirectoryOf, scopeFor } from "./testScope";

jest.mock("../sync/sending", () => ({ SEND_TIMESHEETS: true }));

const SCOPE = scopeFor("user_send_1");
const OTHER = scopeFor("user_send_2");
const NORTHGATE: WorkingContext = { kind: "company", membershipId: "m_north", companyId: "c_north", companyName: "Northgate Haulage" };
const SOUTHPORT: WorkingContext = { kind: "company", membershipId: "m_south", companyId: "c_south", companyName: "Southport Freight" };
const at = (hours: number, day = 11) => new Date(2026, 9, day, hours, 0);
const identity: WithIdentity = call => call("id.token");

// ── The scripted server ──────────────────────────────────────────────────────

interface Sent { raw: string; body: { membershipId: string; clientEventId: string; revision: number; snapshot: unknown }; authorization: string | null }
type Answer = () => Promise<Response>;

const respond = (status: number, body: unknown): Answer => () =>
  Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) } as unknown as Response);
const accepted = (reference = "TS-AAAA1111", standing = "accepted"): Answer =>
  respond(201, { timesheet: { reference, revision: 1, standing, verification: standing === "accepted" ? "membership_active" : "unverified", receivedAt: "2026-10-11T15:00:01.000Z" } });
const replayed = (reference = "TS-AAAA1111"): Answer =>
  respond(200, { timesheet: { reference, revision: 1, standing: "accepted", verification: "membership_active", receivedAt: "2026-10-11T15:00:01.000Z" } });
const refusal = (status: number, code: string, details: unknown[] = []): Answer => respond(status, { error: "Refused", code, details });
const OFFLINE: Answer = () => Promise.reject(new TypeError("Network request failed"));

/** Answers in order — the last one repeats. Every timesheet request is kept, raw bytes included. */
function server(...answers: Answer[]): Sent[] {
  const sent: Sent[] = [];
  let call = 0;
  jest.spyOn(global, "fetch").mockImplementation(((input: string, init: RequestInit = {}) => {
    if (!String(input).endsWith("/driver/timesheets")) return Promise.reject(new Error(`unexpected request ${String(input)}`));
    const raw = typeof init.body === "string" ? init.body : "";
    sent.push({ raw, body: JSON.parse(raw) as Sent["body"], authorization: new Headers(init.headers).get("authorization") });
    const answer = answers[Math.min(call, answers.length - 1)] ?? OFFLINE;
    call += 1;
    return answer();
  }) as unknown as typeof fetch);
  return sent;
}

// ── Days ─────────────────────────────────────────────────────────────────────

async function finishedDay(scope: AccountScope, workingFor: WorkingContext, notes = "Waited at the depot", vehicle = false): Promise<CompletedShift> {
  const open = await startLocalShift(scope, {
    workingFor, startedAt: at(6),
    vehicle: vehicle ? { vehicleClass: "class1", numberPlate: "LY12 ABC", startMileage: 120_000 } : null,
  });
  const done = await finishDeclared(scope, {
    shiftId: open.id, vehicleUseId: open.vehicle?.useId ?? null, trailerUseId: null,
    finalMileage: vehicle ? 120_350 : null, endedAt: at(16), nightOut: false, notes,
  });
  if (done === null) throw new Error("the day did not finish");
  return done;
}

function correct(scope: AccountScope, day: CompletedShift, notes: string, correctionId = "corr-1") {
  const latest = day.corrections?.[day.corrections.length - 1];
  return correctDeclared(scope, {
    shiftId: day.id, basedOn: latest?.id ?? null, correctionId, correctedAt: at(17), correctedBy: "driver",
    workingFor: day.workingFor, startedAt: at(6), endedAt: at(16), nightOut: false, notes,
  });
}

async function queued(scope: AccountScope, day: CompletedShift): Promise<TimesheetSubmissionRecord> {
  const outcome = await queueTimesheet(scope, day.id);
  if (outcome.kind !== "queued") throw new Error(`not queued: ${outcome.kind}`);
  return outcome.record;
}

function recordOf(scope: AccountScope, dayId: string): TimesheetSubmissionRecord {
  const read = readSubmission(scope, dayId);
  if (read.kind !== "ok") throw new Error(`no readable record: ${read.kind}`);
  return read.record;
}

function liveFile(scope: AccountScope, dayId: string): File {
  return new File(accountDirectoryOf(scope), `${SUBMISSION_FILE_PREFIX}${dayId}.json`);
}

/** The exact snapshot bytes a request carried. */
const snapshotBytes = (request: Sent | undefined) => JSON.stringify(request?.body.snapshot);

/**
 * A run in a FRESH process: every module loaded again — the runner's memory,
 * the store's queue, the scopes it trusts — with only the disk carried over.
 */
function runInFreshProcess(userId: string): Promise<unknown> {
  let run: Promise<unknown> | null = null;
  // The platform's file system is the same one across a restart; the app's modules are not.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const platformFiles: unknown = require("expo-file-system");
  jest.isolateModules(() => {
    jest.doMock("expo-file-system", () => platformFiles);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const runner = require("../sync/syncRunner") as typeof import("../sync/syncRunner");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const scopes = require("../shift/accountScope") as typeof import("../shift/accountScope");
    run = runner.runSync(scopes.AccountScope.forAccount({ id: userId }), identity);
  });
  if (run === null) throw new Error("the fresh runner did not load");
  return run;
}

function wipe(scope: AccountScope): void {
  for (const entry of accountDirectoryOf(scope).list()) entry.delete();
}

beforeEach(() => { wipe(SCOPE); wipe(OTHER); });
afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// Queueing, the seal, the lock
// ═══════════════════════════════════════════════════════════════════════════

test("SS1. Save & Send freezes the declared day ONCE: a record and its seal, the same bytes in both; the day is LOCKED — no correction, use change or delete", async () => {
  const day = await finishedDay(SCOPE, NORTHGATE, "Waited at the depot", true);
  const record = await queued(SCOPE, day);

  expect(record).toMatchObject({ dayId: day.id, membershipId: "m_north", revision: 1, generation: 1, state: SUBMISSION_STATE.waiting });
  expect(readSeal(SCOPE, day.id, 1)?.snapshotJson).toBe(JSON.stringify(record.snapshot));
  expect(isDayLocked(SCOPE, day.id)).toBe(true);

  await expect(correct(SCOPE, day, "Changed after sending")).rejects.toBeInstanceOf(TimesheetLockedError);
  const use = day.previousVehicles[0];
  await expect(correctNumberPlate(SCOPE, { shiftId: day.id, useId: use?.useId ?? "", usageState: USAGE_STATE.ended, value: "XX11 XXX" })).rejects.toBeInstanceOf(TimesheetLockedError);
  await expect(deleteCompletedShift(SCOPE, day.id)).rejects.toBeInstanceOf(TimesheetLockedError);

  // Queued again: the SAME record — never a second snapshot under the identity.
  const again = await queued(SCOPE, day);
  expect(again.seq).toBe(record.seq);
  expect(JSON.stringify(again.snapshot)).toBe(JSON.stringify(record.snapshot));
});

test("SS2. sent: the day's id, revision 1, its membership, the identity token — and EXACTLY the sealed bytes; the server's reference is kept", async () => {
  const sent = server(accepted("TS-NORTH001"));
  const day = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, day);

  const report = await runSync(SCOPE, identity);

  expect(report).toMatchObject({ timesheetsSent: 1, timesheetsWaiting: 0, retryLater: false });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.authorization).toBe("Bearer id.token");
  expect(sent[0]?.body).toMatchObject({ membershipId: "m_north", clientEventId: day.id, revision: 1 });
  expect(snapshotBytes(sent[0])).toBe(readSeal(SCOPE, day.id, 1)?.snapshotJson);
  expect(recordOf(SCOPE, day.id)).toMatchObject({ state: SUBMISSION_STATE.submitted, result: { reference: "TS-NORTH001" } });
  expect(submissionStatusOf(SCOPE, day)).toMatchObject({ label: "Sent to Northgate Haulage", locked: true, canSend: false });

  // Done is done: a later run sends nothing.
  await runSync(SCOPE, identity);
  expect(sent).toHaveLength(1);
});

test("SS3. a Personal day is NEVER sent — nothing queued, nothing on disk, no request", async () => {
  const sent = server(accepted());
  const day = await finishedDay(SCOPE, { kind: "personal" });

  expect((await queueTimesheet(SCOPE, day.id)).kind).toBe("personal");
  await runSync(SCOPE, identity);

  expect(sent).toEqual([]);
  expect(accountDirectoryOf(SCOPE).list().filter(entry => entry.name.startsWith(SUBMISSION_FILE_PREFIX))).toEqual([]);
  expect(isDayLocked(SCOPE, day.id)).toBe(false);
  expect(submissionStatusOf(SCOPE, day)).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// Offline, restart, a lost answer
// ═══════════════════════════════════════════════════════════════════════════

test("SS4. OFFLINE: queued and kept, waiting; when the connection returns the SAME bytes go and land", async () => {
  const offline = server(OFFLINE);
  const day = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, day);

  expect(await runSync(SCOPE, identity)).toMatchObject({ timesheetsWaiting: 1, retryLater: true });
  expect(recordOf(SCOPE, day.id)).toMatchObject({ state: SUBMISSION_STATE.waiting, attempts: 1, problem: { kind: "temporary" } });
  expect(submissionStatusOf(SCOPE, day)).toMatchObject({ label: "Waiting to send", locked: true });

  jest.restoreAllMocks();
  const online = server(accepted());
  await runSync(SCOPE, identity);
  expect(online[0]?.raw).toBe(offline[0]?.raw);
  expect(recordOf(SCOPE, day.id)).toMatchObject({ state: SUBMISSION_STATE.submitted, attempts: 2 });
});

test("SS5. APP RESTART: what was queued before is found on disk by a fresh runner and sent — once", async () => {
  server(OFFLINE);
  const day = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, day);
  await runSync(SCOPE, identity);
  jest.restoreAllMocks();

  const sent = server(accepted());
  // A fresh process: the runner's memory is gone, the disk is not.
  await runInFreshProcess("user_send_1");
  expect(sent).toHaveLength(1);
  expect(recordOf(SCOPE, day.id).state).toBe(SUBMISSION_STATE.submitted);
});

test("SS6. a LOST ANSWER: the server kept it but the phone heard nothing — the next run sends the same bytes, the server replays, one timesheet", async () => {
  const sent = server(OFFLINE, replayed("TS-KEPT0001"));
  const day = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, day);

  await runSync(SCOPE, identity);
  await runSync(SCOPE, identity);

  expect(sent).toHaveLength(2);
  expect(sent[1]?.raw).toBe(sent[0]?.raw);
  expect(recordOf(SCOPE, day.id)).toMatchObject({ state: SUBMISSION_STATE.submitted, result: { reference: "TS-KEPT0001" } });
});

test("SS7. two runs at once are ONE run: one request", async () => {
  const sent = server(accepted());
  const day = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, day);

  await Promise.all([runSync(SCOPE, identity), runSync(SCOPE, identity), runSync(SCOPE, identity)]);

  expect(sent).toHaveLength(1);
});

// ═══════════════════════════════════════════════════════════════════════════
// What an answer MEANS
// ═══════════════════════════════════════════════════════════════════════════

test.each([
  ["400 VALIDATION",            refusal(400, "VALIDATION"),                  SUBMISSION_STATE.needsCorrection, false],
  ["400 TIMESHEET_INVALID",     refusal(400, "TIMESHEET_INVALID"),           SUBMISSION_STATE.needsCorrection, false],
  ["413 body too large",        refusal(413, "FST_ERR_CTP_BODY_TOO_LARGE"),  SUBMISSION_STATE.needsCorrection, false],
  ["403 FORBIDDEN",             refusal(403, "FORBIDDEN"),                   SUBMISSION_STATE.refused,         false],
  ["404 NOT_FOUND",             refusal(404, "NOT_FOUND"),                   SUBMISSION_STATE.refused,         false],
  ["409 SUBMISSION_MISMATCH",   refusal(409, "SUBMISSION_MISMATCH"),         SUBMISSION_STATE.conflict,        true],
  ["400 with an unknown code",  refusal(400, "FST_ERR_CTP_INVALID_JSON_BODY"), SUBMISSION_STATE.waiting,       true],
  ["409 with an unknown code",  refusal(409, "SOMETHING_ELSE"),              SUBMISSION_STATE.waiting,         true],
  ["429 RATE_LIMITED",          refusal(429, "RATE_LIMITED"),                SUBMISSION_STATE.waiting,         true],
  ["500 INTERNAL",              refusal(500, "INTERNAL"),                    SUBMISSION_STATE.waiting,         true],
  ["503 no envelope",           respond(503, null),                          SUBMISSION_STATE.waiting,         true],
  ["401 UNAUTHENTICATED",       refusal(401, "UNAUTHENTICATED"),             SUBMISSION_STATE.waiting,         true],
  ["a 2xx it cannot read",      respond(201, { nonsense: true }),            SUBMISSION_STATE.waiting,         true],
])("SS8. %s → %s (locked: %s) — by the server's CODE, never its status alone; the snapshot is kept", async (_name, answer, state, locked) => {
  server(answer);
  const day = await finishedDay(SCOPE, NORTHGATE);
  const before = await queued(SCOPE, day);

  await runSync(SCOPE, identity);

  const after = recordOf(SCOPE, day.id);
  expect(after.state).toBe(state);
  expect(isDayLocked(SCOPE, day.id)).toBe(locked);
  expect(JSON.stringify(after.snapshot)).toBe(JSON.stringify(before.snapshot));
});

test("SS9. AUTHENTICATION: no identity, or one that cannot be renewed, is a SESSION problem — kept, waiting, retried once signed in; never discarded", async () => {
  const sent = server(accepted());
  const day = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, day);

  const signedOut: WithIdentity = () => Promise.resolve({ kind: "api", status: 401, body: { error: "Not authenticated", code: "UNAUTHENTICATED" } });
  await runSync(SCOPE, signedOut);
  expect(recordOf(SCOPE, day.id)).toMatchObject({ state: SUBMISSION_STATE.waiting, problem: { kind: "session" } });
  expect(submissionStatusOf(SCOPE, day)?.actionNeeded).toBe(true);
  expect(submissionStatusOf(SCOPE, day)?.detail).toContain("Sign in again");

  const unrenewable: WithIdentity = () => Promise.resolve({ kind: "network", message: SESSION_RENEWAL_UNAVAILABLE, detail: null });
  await runSync(SCOPE, unrenewable);
  expect(recordOf(SCOPE, day.id)).toMatchObject({ state: SUBMISSION_STATE.waiting, problem: { kind: "session" } });

  await runSync(SCOPE, identity);
  expect(sent).toHaveLength(1);
  expect(recordOf(SCOPE, day.id).state).toBe(SUBMISSION_STATE.submitted);
});

test("SS10. MEMBERSHIP WITHDRAWN while the day was open: the server takes it for review — kept, locked, 'waiting for the company's review'", async () => {
  server(accepted("TS-REVIEW01", "pending_review"));
  const day = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, day);

  await runSync(SCOPE, identity);

  expect(recordOf(SCOPE, day.id)).toMatchObject({ state: SUBMISSION_STATE.pendingReview, result: { standing: "pending_review" } });
  expect(isDayLocked(SCOPE, day.id)).toBe(true);
  expect(submissionStatusOf(SCOPE, day)?.label).toBe("Sent — waiting for Northgate Haulage's review");
});

test("SS11. SAFE CORRECTION after a definitive rejection: the server stored nothing, so the day unlocks; corrected and declared again, the NEXT generation goes under the same identity — the refused one kept", async () => {
  const sent = server(refusal(400, "TIMESHEET_INVALID", [{ path: "", message: "The finish is before the start." }]), accepted());
  const day = await finishedDay(SCOPE, NORTHGATE, "First notes");
  const first = await queued(SCOPE, day);
  await runSync(SCOPE, identity);

  expect(isDayLocked(SCOPE, day.id)).toBe(false);
  expect(submissionStatusOf(SCOPE, day)).toMatchObject({ actionNeeded: true, canSend: true });
  expect(submissionStatusOf(SCOPE, day)?.detail).toContain("The finish is before the start.");

  const corrected = await correct(SCOPE, day, "Corrected notes");
  if (corrected === null) throw new Error("the correction was refused");
  const second = await queued(SCOPE, corrected);
  expect(second).toMatchObject({ generation: 2, state: SUBMISSION_STATE.waiting });
  expect(second.earlier).toEqual([expect.objectContaining({ generation: 1, state: SUBMISSION_STATE.needsCorrection })]);
  expect(JSON.stringify(second.earlier[0]?.snapshot)).toBe(JSON.stringify(first.snapshot));
  expect(readSeal(SCOPE, day.id, 1)?.snapshotJson).toBe(JSON.stringify(first.snapshot));

  await runSync(SCOPE, identity);
  expect(sent).toHaveLength(2);
  expect(sent[1]?.body.clientEventId).toBe(day.id);
  expect(snapshotBytes(sent[1])).toBe(readSeal(SCOPE, day.id, 2)?.snapshotJson);
  expect(snapshotBytes(sent[1])).toContain("Corrected notes");
});

test("SS12. a CONFLICT keeps the frozen snapshot and the lock, and is never sent again", async () => {
  const sent = server(refusal(409, "SUBMISSION_MISMATCH"));
  const day = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, day);

  await runSync(SCOPE, identity);
  await runSync(SCOPE, identity);

  expect(sent).toHaveLength(1);
  expect(isDayLocked(SCOPE, day.id)).toBe(true);
  await expect(correct(SCOPE, day, "x")).rejects.toBeInstanceOf(TimesheetLockedError);
  expect(submissionStatusOf(SCOPE, day)).toMatchObject({ label: "Action needed — already sent differently", canSend: false });
});

// ═══════════════════════════════════════════════════════════════════════════
// Accounts and companies
// ═══════════════════════════════════════════════════════════════════════════

test("SS13. ACCOUNT ISOLATION: another driver on the phone never sees, sends or is locked by this one's timesheets — and a record planted in their directory is never sent as theirs", async () => {
  const sent = server(accepted());
  const mine = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, mine);

  // Driver 2 signs in on the same phone.
  await runSync(OTHER, identity);
  expect(sent).toEqual([]);
  expect(readSubmission(OTHER, mine.id).kind).toBe("none");

  // Driver 1's record copied into driver 2's directory: not theirs, never sent.
  liveFile(SCOPE, mine.id).copy(liveFile(OTHER, mine.id));
  await runSync(OTHER, identity);
  expect(sent).toEqual([]);

  // Driver 1 back: theirs goes, under their identity.
  await runSync(SCOPE, identity);
  expect(sent).toHaveLength(1);
});

test("SS14. SIGNED OUT with a timesheet queued: nothing is sent while signed out, nothing is lost, and it goes on the next sign-in", async () => {
  const sent = server(accepted());
  const day = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, day);

  const signedOut: WithIdentity = () => Promise.resolve({ kind: "api", status: 401, body: { error: "Not authenticated", code: "UNAUTHENTICATED" } });
  await runSync(SCOPE, signedOut);
  expect(sent).toEqual([]);
  expect(recordOf(SCOPE, day.id).state).toBe(SUBMISSION_STATE.waiting);

  await runSync(SCOPE, identity);
  expect(sent).toHaveLength(1);
});

test("SS15. SEVERAL COMPANIES: each day goes once, to its own membership, under its own id", async () => {
  const sent = server(accepted());
  const north = await finishedDay(SCOPE, NORTHGATE);
  const south = await finishedDay(SCOPE, SOUTHPORT);
  await queued(SCOPE, north);
  await queued(SCOPE, south);

  await runSync(SCOPE, identity);

  expect(sent.map(request => [request.body.clientEventId, request.body.membershipId]).sort()).toEqual([[north.id, "m_north"], [south.id, "m_south"]].sort());
});

test("SS16. queueing and a correction RACING: whichever the store runs first, the snapshot is the version on disk — never a stale one, never a change to a locked day", async () => {
  const day = await finishedDay(SCOPE, NORTHGATE, "Before");
  const [queuedOutcome, correction] = await Promise.allSettled([queueTimesheet(SCOPE, day.id), correct(SCOPE, day, "After")]);

  expect(queuedOutcome.status).toBe("fulfilled");
  const record = recordOf(SCOPE, day.id);
  if (correction.status === "fulfilled") {
    expect(JSON.stringify(record.snapshot)).toContain("After");
  } else {
    expect(correction.reason).toBeInstanceOf(TimesheetLockedError);
    expect(JSON.stringify(record.snapshot)).toContain("Before");
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// INTERRUPTIONS — before, during and after every step
// ═══════════════════════════════════════════════════════════════════════════

/** Make the NEXT write whose text matches fail — the moment the app stopped. */
function failWriteMatching(pattern: RegExp, times = 1): void {
  const original: unknown = Reflect.get(File.prototype, "write");
  let left = times;
  jest.spyOn(File.prototype, "write").mockImplementation(function (this: File, content: string | Uint8Array) {
    if (left > 0 && typeof content === "string" && pattern.test(content)) {
      left -= 1;
      throw new Error("the app stopped here");
    }
    if (typeof original === "function") Reflect.apply(original, this, [content]);
  });
}

test("SI1. stopped while writing the SEAL: nothing queued — no record, no lock, nothing sent", async () => {
  const sent = server(accepted());
  const day = await finishedDay(SCOPE, NORTHGATE);
  failWriteMatching(/"snapshotJson"/);

  expect((await queueTimesheet(SCOPE, day.id)).kind).toBe("failed");
  expect(readSubmission(SCOPE, day.id).kind).toBe("none");
  expect(readSeal(SCOPE, day.id, 1)).toBeNull();
  expect(isDayLocked(SCOPE, day.id)).toBe(false);
  jest.restoreAllMocks();
  server(accepted());
  await runSync(SCOPE, identity);
  expect(sent).toEqual([]);
});

test("SI2. stopped AFTER the seal, before the record: nothing was sent and the day is not locked; corrected and sent again, it goes as the NEXT generation — the first seal is kept byte for byte, never overwritten, and its bytes never travel", async () => {
  const day = await finishedDay(SCOPE, NORTHGATE, "Before");
  failWriteMatching(/"state":"waiting"/);

  expect((await queueTimesheet(SCOPE, day.id)).kind).toBe("failed");
  const firstSeal = readSeal(SCOPE, day.id, 1)?.snapshotJson;
  expect(firstSeal).toContain("Before");
  expect(isDayLocked(SCOPE, day.id)).toBe(false);
  jest.restoreAllMocks();

  const corrected = await correct(SCOPE, day, "After");
  if (corrected === null) throw new Error("the correction was refused");
  const sent = server(accepted());
  expect(await queued(SCOPE, corrected)).toMatchObject({ generation: 2 });
  await runSync(SCOPE, identity);
  expect(sent).toHaveLength(1);
  expect(snapshotBytes(sent[0])).toContain("After");
  expect(snapshotBytes(sent[0])).toBe(readSeal(SCOPE, day.id, 2)?.snapshotJson);
  expect(readSeal(SCOPE, day.id, 1)?.snapshotJson).toBe(firstSeal);
});

test("SI3. stopped while VERIFYING the record's copy (read back short): nothing promoted, nothing locked", async () => {
  const day = await finishedDay(SCOPE, NORTHGATE);
  const original: unknown = Reflect.get(File.prototype, "textSync");
  jest.spyOn(File.prototype, "textSync").mockImplementation(function (this: File) {
    const read: unknown = typeof original === "function" ? Reflect.apply(original, this, []) : "";
    const text = typeof read === "string" ? read : "";
    return this.name.endsWith(".next.json") && !this.name.includes("seal-") ? text.slice(0, 10) : text;
  });

  expect((await queueTimesheet(SCOPE, day.id)).kind).toBe("failed");
  jest.restoreAllMocks();
  expect(readSubmission(SCOPE, day.id).kind).toBe("none");
  expect(isDayLocked(SCOPE, day.id)).toBe(false);
});

test("SI4. stopped DURING PROMOTION (the move had removed the record, not yet renamed the copy): the verified copy is promoted — locked, and sent with the sealed bytes", async () => {
  const sent = server(accepted());
  const day = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, day);
  // What the two-step move leaves: no record, its complete next copy.
  liveFile(SCOPE, day.id).move(new File(accountDirectoryOf(SCOPE), `${SUBMISSION_FILE_PREFIX}${day.id}.next.json`));

  expect(isDayLocked(SCOPE, day.id)).toBe(true);
  expect(liveFile(SCOPE, day.id).exists).toBe(true);
  await runSync(SCOPE, identity);
  expect(snapshotBytes(sent[0])).toBe(readSeal(SCOPE, day.id, 1)?.snapshotJson);
});

test("SI5. a torn next copy — written, never verified — is worth nothing: on create it locks nothing; on an update the record stands", async () => {
  const day = await finishedDay(SCOPE, NORTHGATE);
  const torn = new File(accountDirectoryOf(SCOPE), `${SUBMISSION_FILE_PREFIX}${day.id}.next.json`);
  torn.create({ overwrite: true });
  torn.write("{\"ownerUserId\":\"user_se");
  expect(readSubmission(SCOPE, day.id).kind).toBe("none");
  expect(torn.exists).toBe(false);
  expect(isDayLocked(SCOPE, day.id)).toBe(false);

  const record = await queued(SCOPE, day);
  torn.create({ overwrite: true });
  torn.write("{\"state\":\"subm");
  expect(recordOf(SCOPE, day.id).seq).toBe(record.seq);
});

test("SI6. stopped while marking it SENDING: no request was made, it still waits, and it goes later", async () => {
  const day = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, day);
  const sent = server(accepted());
  failWriteMatching(/"state":"sending"/);

  await runSync(SCOPE, identity);
  expect(sent).toEqual([]);
  expect(recordOf(SCOPE, day.id).state).toBe(SUBMISSION_STATE.waiting);

  await runSync(SCOPE, identity);
  expect(sent).toHaveLength(1);
});

test("SI7. stopped after marking it SENDING, before the request left: the next run sends it — the same bytes, once", async () => {
  const day = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, day);
  // The request never left: the app died inside it (this process's request is
  // held open, and only released — as a failure — once the test is done).
  let die: (error: Error) => void = () => undefined;
  jest.spyOn(global, "fetch").mockImplementation(() => new Promise<Response>((_resolve, reject) => { die = reject; }));
  const dead = runSync(SCOPE, identity);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(recordOf(SCOPE, day.id).state).toBe(SUBMISSION_STATE.sending);
  jest.restoreAllMocks();

  // A fresh process finds it `sending` — outcome unknown — and sends it.
  const sent = server(accepted());
  await runInFreshProcess("user_send_1");
  expect(sent).toHaveLength(1);
  die(new TypeError("the old process is gone"));
  await dead;
  // The dead process's late failure does not overwrite what the new one kept.
  expect(recordOf(SCOPE, day.id).state).toBe(SUBMISSION_STATE.submitted);
  expect(snapshotBytes(sent[0])).toBe(readSeal(SCOPE, day.id, 1)?.snapshotJson);
  expect(recordOf(SCOPE, day.id).state).toBe(SUBMISSION_STATE.submitted);
});

test("SI8. the server ACCEPTED it but the phone stopped before KEEPING the answer: still `sending`; the replay of the same bytes lands as one timesheet", async () => {
  const sent = server(accepted("TS-ONCE0001"), replayed("TS-ONCE0001"));
  const day = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, day);
  failWriteMatching(/"state":"submitted"/);

  await runSync(SCOPE, identity);
  expect(recordOf(SCOPE, day.id).state).toBe(SUBMISSION_STATE.sending);

  await runSync(SCOPE, identity);
  expect(sent).toHaveLength(2);
  expect(sent[1]?.raw).toBe(sent[0]?.raw);
  expect(recordOf(SCOPE, day.id)).toMatchObject({ state: SUBMISSION_STATE.submitted, result: { reference: "TS-ONCE0001" } });
});

test("SI9. a DAMAGED record, its seal intact: the bytes are set aside, the record is restored FROM THE SEAL — and the replay carries exactly the bytes first sent, under the same id and revision", async () => {
  const sent = server(accepted("TS-SEAL0001"), replayed("TS-SEAL0001"));
  const day = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, day);
  await runSync(SCOPE, identity);
  const first = sent[0];

  const damaged = liveFile(SCOPE, day.id);
  damaged.write("\u0000\u0000 not a record");
  expect(isDayLocked(SCOPE, day.id)).toBe(true);
  expect(submissionStatusOf(SCOPE, day)?.label).toBe("Action needed — being checked");

  await runSync(SCOPE, identity);

  expect(sent).toHaveLength(2);
  expect(sent[1]?.raw).toBe(first?.raw);
  const aside = accountDirectoryOf(SCOPE).list().filter(entry => entry.name.startsWith(`${SUBMISSION_FILE_PREFIX}unreadable-${day.id}`));
  expect(aside).toHaveLength(1);
  expect(aside[0] instanceof File ? aside[0].textSync() : "").toBe("\u0000\u0000 not a record");
  expect(recordOf(SCOPE, day.id)).toMatchObject({ state: SUBMISSION_STATE.submitted, revision: 1, generation: 1 });
});

test("SI10. a damaged record AND a damaged seal: nothing is REBUILT from the day — it stays locked, nothing is sent, the driver is told it needs checking", async () => {
  const sent = server(accepted());
  const day = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, day);
  liveFile(SCOPE, day.id).write("damaged");
  new File(accountDirectoryOf(SCOPE), `${SUBMISSION_FILE_PREFIX}seal-${day.id}-g1.json`).write("damaged too");

  await runSync(SCOPE, identity);

  expect(sent).toEqual([]);
  expect(isDayLocked(SCOPE, day.id)).toBe(true);
  await expect(correct(SCOPE, day, "x")).rejects.toBeInstanceOf(TimesheetLockedError);
  expect(liveFile(SCOPE, day.id).textSync()).toBe("damaged");
});

test("SI11. a record that DISAGREES with its seal is never sent — locked, as it is", async () => {
  const sent = server(accepted());
  const day = await finishedDay(SCOPE, NORTHGATE, "As declared");
  await queued(SCOPE, day);
  const file = liveFile(SCOPE, day.id);
  file.write(file.textSync().replace("As declared", "Altered later"));

  await runSync(SCOPE, identity);

  expect(sent).toEqual([]);
  expect(isDayLocked(SCOPE, day.id)).toBe(true);
});

test("SS17. an over-long registration stored BEFORE the limits: never cut, never sent as it is — Save & Send says what to correct, and the day stays editable", async () => {
  const sent = server(accepted());
  const day = await finishedDay(SCOPE, NORTHGATE, "Long plate", true);
  const legacy = "OLDPLATE-1234567890-XYZ";
  const file = new File(accountDirectoryOf(SCOPE), `logisticbay-completed-shift-${day.id}.json`);
  file.write(file.textSync().replace("LY12 ABC", legacy));
  // Declared again as it now reads — the plate is part of what was declared.
  const redeclared = await correct(SCOPE, (await readCompletedShift(SCOPE, day.id)) ?? day, "Long plate");
  if (redeclared === null) throw new Error("not declared");

  const outcome = await queueTimesheet(SCOPE, day.id);
  expect(outcome).toEqual({ kind: "needs-correction", problems: [expect.stringContaining(legacy)] });
  expect(readSubmission(SCOPE, day.id).kind).toBe("none");
  expect(isDayLocked(SCOPE, day.id)).toBe(false);
  expect(file.textSync()).toContain(legacy);
  await runSync(SCOPE, identity);
  expect(sent).toEqual([]);
});

test("SI12. even when the day ITSELF now reads differently (as a new app version, or a changed file, could make a rebuild differ), recovery sends the ORIGINAL sealed bytes — never the day's new content", async () => {
  const sent = server(accepted("TS-ORIG0001"), replayed("TS-ORIG0001"));
  const day = await finishedDay(SCOPE, NORTHGATE, "Original notes");
  await queued(SCOPE, day);
  await runSync(SCOPE, identity);

  // The day's own file now says something else; then the record is damaged.
  const dayFile = new File(accountDirectoryOf(SCOPE), `logisticbay-completed-shift-${day.id}.json`);
  dayFile.write(dayFile.textSync().replace("Original notes", "Rewritten notes"));
  liveFile(SCOPE, day.id).write("damaged");

  await runSync(SCOPE, identity);

  expect(sent).toHaveLength(2);
  expect(sent[1]?.raw).toBe(sent[0]?.raw);
  expect(sent[1]?.raw).toContain("Original notes");
  expect(sent[1]?.raw).not.toContain("Rewritten notes");
});

// ═══════════════════════════════════════════════════════════════════════════
// S6 remediation: a 400 after an uncertain transmission; a lost record
// ═══════════════════════════════════════════════════════════════════════════

test("SR1. a 400 AFTER a transmission whose outcome is unknown proves nothing: the day stays LOCKED, the frozen bytes kept — and the next replay settles it", async () => {
  const sent = server(OFFLINE, refusal(400, "TIMESHEET_INVALID"), replayed("TS-KEPT0002"));
  const day = await finishedDay(SCOPE, NORTHGATE);
  const frozen = (await queued(SCOPE, day)).snapshot;

  await runSync(SCOPE, identity); // no answer: it may have reached the server
  await runSync(SCOPE, identity); // a 400 for the same bytes — from a server that may hold them

  expect(isDayLocked(SCOPE, day.id)).toBe(true);
  expect(recordOf(SCOPE, day.id)).toMatchObject({ state: SUBMISSION_STATE.waiting, uncertain: true, problem: { kind: "unconfirmed" } });
  expect(submissionStatusOf(SCOPE, day)).toMatchObject({ label: "Waiting to confirm", locked: true, canSend: false });
  await expect(correct(SCOPE, day, "x")).rejects.toBeInstanceOf(TimesheetLockedError);
  expect(JSON.stringify(recordOf(SCOPE, day.id).snapshot)).toBe(JSON.stringify(frozen));

  await runSync(SCOPE, identity); // the server replays what it kept
  expect(sent).toHaveLength(3);
  expect(new Set(sent.map(request => request.raw)).size).toBe(1);
  expect(recordOf(SCOPE, day.id)).toMatchObject({ state: SUBMISSION_STATE.submitted, result: { reference: "TS-KEPT0002" } });
});

test.each([
  ["400 VALIDATION", refusal(400, "VALIDATION")],
  ["403 FORBIDDEN", refusal(403, "FORBIDDEN")],
  ["404 NOT_FOUND", refusal(404, "NOT_FOUND")],
  ["413 body too large", refusal(413, "FST_ERR_CTP_BODY_TOO_LARGE")],
])("SR2. %s after an uncertain transmission does not unlock either", async (_name, answer) => {
  server(refusal(503, "INTERNAL"), answer);
  const day = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, day);
  await runSync(SCOPE, identity);
  await runSync(SCOPE, identity);
  expect(isDayLocked(SCOPE, day.id)).toBe(true);
});

test("SR3. TIMESHEET_REJECTED is the server's PROOF that nothing is kept under the id — even after an uncertain transmission it unlocks the day for correction", async () => {
  server(OFFLINE, refusal(400, "TIMESHEET_REJECTED", [{ path: "", message: "The finish is before the start." }]));
  const day = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, day);
  await runSync(SCOPE, identity);
  await runSync(SCOPE, identity);

  expect(recordOf(SCOPE, day.id).state).toBe(SUBMISSION_STATE.needsCorrection);
  expect(isDayLocked(SCOPE, day.id)).toBe(false);
  expect(await correct(SCOPE, day, "Corrected")).not.toBeNull();
});

test("SR4. a crash while SENDING is an unknown outcome too: a 400 that follows keeps the day locked", async () => {
  const day = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, day);
  let die: (error: Error) => void = () => undefined;
  jest.spyOn(global, "fetch").mockImplementation(() => new Promise<Response>((_resolve, reject) => { die = reject; }));
  const dead = runSync(SCOPE, identity);
  await new Promise(resolve => setTimeout(resolve, 20));
  jest.restoreAllMocks();

  server(refusal(400, "VALIDATION"));
  await runInFreshProcess("user_send_1");
  die(new TypeError("gone"));
  await dead;

  expect(isDayLocked(SCOPE, day.id)).toBe(true);
  expect(recordOf(SCOPE, day.id)).toMatchObject({ uncertain: true });
});

test("SR5. a GENUINE rejection on the first, answered transmission still permits correction", async () => {
  server(refusal(400, "VALIDATION"));
  const day = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, day);
  await runSync(SCOPE, identity);
  expect(recordOf(SCOPE, day.id)).toMatchObject({ state: SUBMISSION_STATE.needsCorrection, uncertain: false });
  expect(isDayLocked(SCOPE, day.id)).toBe(false);
});

/** The record and its next copy are gone — the disk lost them; the seal (and any sent-marker) survived. */
function loseRecord(scope: AccountScope, dayId: string): void {
  liveFile(scope, dayId).delete();
  const next = new File(accountDirectoryOf(scope), `${SUBMISSION_FILE_PREFIX}${dayId}.next.json`);
  if (next.exists) next.delete();
}

test("SR6. the record LOST after a request may have left (its sent-marker survives): the day stays LOCKED, a new Save & Send makes NO new snapshot, the seal is untouched — and the runner restores it and replays the original bytes", async () => {
  const sent = server(OFFLINE, replayed("TS-LOST0001"));
  const day = await finishedDay(SCOPE, NORTHGATE, "Original");
  await queued(SCOPE, day);
  await runSync(SCOPE, identity);
  const original = readSeal(SCOPE, day.id, 1)?.snapshotJson;

  loseRecord(SCOPE, day.id);

  expect(isDayLocked(SCOPE, day.id)).toBe(true);
  await expect(correct(SCOPE, day, "Rewritten")).rejects.toBeInstanceOf(TimesheetLockedError);
  const again = await queueTimesheet(SCOPE, day.id);
  expect(again).toMatchObject({ kind: "queued", record: { generation: 1, uncertain: true } });
  expect(readSeal(SCOPE, day.id, 1)?.snapshotJson).toBe(original);
  expect(readSeal(SCOPE, day.id, 2)).toBeNull();

  await runSync(SCOPE, identity);
  expect(sent[1]?.raw).toBe(sent[0]?.raw);
  expect(recordOf(SCOPE, day.id)).toMatchObject({ state: SUBMISSION_STATE.submitted, result: { reference: "TS-LOST0001" } });
});

test("SR7. the record lost with NO sent-marker (no request ever left): the day is not locked; sent again it is the NEXT generation — the first seal kept as it was", async () => {
  server(accepted());
  const day = await finishedDay(SCOPE, NORTHGATE, "Original");
  await queued(SCOPE, day);
  const original = readSeal(SCOPE, day.id, 1)?.snapshotJson;
  loseRecord(SCOPE, day.id);

  expect(isDayLocked(SCOPE, day.id)).toBe(false);
  const corrected = await correct(SCOPE, day, "Rewritten");
  if (corrected === null) throw new Error("the correction was refused");
  expect(await queued(SCOPE, corrected)).toMatchObject({ generation: 2 });
  expect(readSeal(SCOPE, day.id, 1)?.snapshotJson).toBe(original);
});

test("SR8. a SEAL is never overwritten — by anything", async () => {
  const day = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, day);
  const seal = readSeal(SCOPE, day.id, 1);
  if (seal === null) throw new Error("no seal");
  expect(() => { writeSeal(SCOPE, { ...seal, snapshotJson: "{\"other\":true}" }); }).toThrow();
  expect(readSeal(SCOPE, day.id, 1)?.snapshotJson).toBe(seal.snapshotJson);
});

test("SR9. ISOLATION holds for markers and seals: another account's never lock, restore or send this one's days", async () => {
  const sent = server(accepted());
  const mine = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, mine);
  server(OFFLINE);
  await runSync(SCOPE, identity);
  jest.restoreAllMocks();
  // Driver 1's seal and marker copied into driver 2's directory.
  for (const entry of accountDirectoryOf(SCOPE).list()) {
    if (entry instanceof File && entry.name.includes("seal-")) entry.copy(new File(accountDirectoryOf(OTHER), entry.name));
  }
  const theirs = server(accepted());
  await runSync(OTHER, identity);
  expect(theirs).toEqual([]);
  expect(isDayLocked(OTHER, mine.id)).toBe(false);
  expect(sent).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Independent review of S6 (2026-10-17): surviving evidence must never be
// ignored — gaps between generations, a marker with no seal, a blank marker
// ═══════════════════════════════════════════════════════════════════════════

const sealPath = (dayId: string, generation: number) => new File(accountDirectoryOf(SCOPE), `${SUBMISSION_FILE_PREFIX}seal-${dayId}-g${String(generation)}.json`);
const markerPath = (dayId: string, generation: number) => new File(accountDirectoryOf(SCOPE), `${SUBMISSION_FILE_PREFIX}seal-${dayId}-g${String(generation)}.sent.json`);

/** A day whose generation 1 was REJECTED and whose generation 2 then went out with no answer. */
async function secondGenerationUncertain(): Promise<{ day: CompletedShift; second: string }> {
  server(refusal(400, "TIMESHEET_REJECTED"), OFFLINE);
  const day = await finishedDay(SCOPE, NORTHGATE, "First");
  await queued(SCOPE, day);
  await runSync(SCOPE, identity);
  const corrected = await correct(SCOPE, day, "Second");
  if (corrected === null) throw new Error("the correction was refused");
  await queued(SCOPE, corrected);
  await runSync(SCOPE, identity);
  expect(recordOf(SCOPE, day.id)).toMatchObject({ generation: 2, uncertain: true });
  jest.restoreAllMocks();
  return { day, second: readSeal(SCOPE, day.id, 2)?.snapshotJson ?? "" };
}

test("RV1. (review) the record AND its seal lost, the sent-marker kept: the day stays LOCKED — no edit, no new queue, nothing sent — and says it needs checking", async () => {
  server(OFFLINE);
  const day = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, day);
  await runSync(SCOPE, identity);
  jest.restoreAllMocks();
  liveFile(SCOPE, day.id).delete();
  sealPath(day.id, 1).delete();
  expect(markerPath(day.id, 1).exists).toBe(true);

  const sent = server(accepted());
  expect(isDayLocked(SCOPE, day.id)).toBe(true);
  await expect(correct(SCOPE, day, "Changed")).rejects.toBeInstanceOf(TimesheetLockedError);
  expect((await queueTimesheet(SCOPE, day.id)).kind).toBe("locked");
  await runSync(SCOPE, identity);
  expect(sent).toEqual([]);
  expect(submissionStatusOf(SCOPE, day)).toMatchObject({ locked: true, canSend: false, actionNeeded: true });
});

test("RV2. (review) generation 2 in doubt, its record AND generation 1's seal lost: generation 2's surviving seal and marker are FOUND — the day stays locked and generation 2's bytes are replayed; generation 1 is never reused", async () => {
  const { day, second } = await secondGenerationUncertain();
  liveFile(SCOPE, day.id).delete();
  sealPath(day.id, 1).delete();

  expect(isDayLocked(SCOPE, day.id)).toBe(true);
  const current = await readCompletedShift(SCOPE, day.id);
  if (current === null) throw new Error("the day is gone");
  await expect(correct(SCOPE, current, "Third", "corr-2")).rejects.toBeInstanceOf(TimesheetLockedError);
  expect(await queueTimesheet(SCOPE, day.id)).toMatchObject({ kind: "queued", record: { generation: 2, uncertain: true } });

  const sent = server(replayed("TS-GEN20001"));
  await runSync(SCOPE, identity);
  expect(snapshotBytes(sent[0])).toBe(second);
  expect(readSeal(SCOPE, day.id, 1)).toBeNull();
  expect(sealPath(day.id, 1).exists).toBe(false);
});

test("RV3. (review) a sent-marker damaged to valid but EMPTY JSON is still evidence: the day stays locked and is restored from its seal as uncertain", async () => {
  server(OFFLINE);
  const day = await finishedDay(SCOPE, NORTHGATE);
  await queued(SCOPE, day);
  await runSync(SCOPE, identity);
  jest.restoreAllMocks();
  liveFile(SCOPE, day.id).delete();
  markerPath(day.id, 1).write("{}");

  expect(isDayLocked(SCOPE, day.id)).toBe(true);
  await expect(correct(SCOPE, day, "Changed")).rejects.toBeInstanceOf(TimesheetLockedError);
  expect(await queueTimesheet(SCOPE, day.id)).toMatchObject({ kind: "queued", record: { generation: 1, uncertain: true } });
});

test("RV4. a generation number is NEVER reused: behind a gap (generation 1's seal lost) an orphan generation-2 seal is still seen — the next snapshot is generation 3, and every seal stays as it was", async () => {
  server(refusal(400, "TIMESHEET_REJECTED"));
  const day = await finishedDay(SCOPE, NORTHGATE, "First");
  await queued(SCOPE, day);
  await runSync(SCOPE, identity);
  jest.restoreAllMocks();
  // Generation 2: sealed, then the app stopped before its record — never sent.
  const second = await correct(SCOPE, day, "Second");
  if (second === null) throw new Error("the correction was refused");
  failWriteMatching(/"state":"waiting"/);
  expect((await queueTimesheet(SCOPE, day.id)).kind).toBe("failed");
  jest.restoreAllMocks();
  const orphan = readSeal(SCOPE, day.id, 2)?.snapshotJson;
  expect(orphan).toContain("Second");
  sealPath(day.id, 1).delete();

  const third = await correct(SCOPE, second, "Third", "corr-2");
  if (third === null) throw new Error("the correction was refused");
  expect(await queued(SCOPE, third)).toMatchObject({ generation: 3 });
  expect(readSeal(SCOPE, day.id, 2)?.snapshotJson).toBe(orphan);
  expect(readSeal(SCOPE, day.id, 3)?.snapshotJson).toContain("Third");
});

test("RV5. (review) the STATUS agrees with the lock: a day whose record is gone but whose evidence survives is never shown as 'Not sent' or offered Save & Send", async () => {
  const { day } = await secondGenerationUncertain();
  liveFile(SCOPE, day.id).delete();

  expect(isDayLocked(SCOPE, day.id)).toBe(true);
  const status = submissionStatusOf(SCOPE, day);
  expect(status).toMatchObject({ locked: true, canSend: false });
  expect(status?.label).not.toBe("Not sent");
});

test("RV6. only a marker that EXPLICITLY names another account is set aside; everything else that cannot be read counts as evidence", async () => {
  const day = await finishedDay(SCOPE, NORTHGATE);
  const marker = markerPath(day.id, 1);
  marker.create({ overwrite: true });

  marker.write(JSON.stringify({ ownerUserId: "someone_else", dayId: day.id, generation: 1 }));
  expect(isDayLocked(SCOPE, day.id)).toBe(false);
  for (const damaged of ["{}", "[]", "null", "not json", JSON.stringify({ ownerUserId: SCOPE.userId })]) {
    marker.write(damaged);
    expect([damaged, isDayLocked(SCOPE, day.id)]).toEqual([damaged, true]);
  }
});

test("RV7. a STALE record (it still says generation 1 was rejected) beside a sent-marker for generation 2: newer evidence wins — locked, generation 2 restored from its seal and replayed, never a new snapshot", async () => {
  server(refusal(400, "TIMESHEET_REJECTED"), OFFLINE);
  const day = await finishedDay(SCOPE, NORTHGATE, "First");
  await queued(SCOPE, day);
  await runSync(SCOPE, identity);
  const stale = liveFile(SCOPE, day.id).textSync(); // generation 1, rejected
  const corrected = await correct(SCOPE, day, "Second");
  if (corrected === null) throw new Error("the correction was refused");
  await queued(SCOPE, corrected);
  await runSync(SCOPE, identity); // generation 2 left, no answer
  jest.restoreAllMocks();
  const second = readSeal(SCOPE, day.id, 2)?.snapshotJson;
  liveFile(SCOPE, day.id).write(stale);

  expect(isDayLocked(SCOPE, day.id)).toBe(true);
  expect(submissionStatusOf(SCOPE, day)).toMatchObject({ locked: true, canSend: false });
  expect(await queueTimesheet(SCOPE, day.id)).toMatchObject({ kind: "queued", record: { generation: 2, uncertain: true } });
  const sent = server(replayed("TS-GEN20002"));
  await runSync(SCOPE, identity);
  expect(snapshotBytes(sent[0])).toBe(second);
});

test("RV8. the same stale record, generation 2's seal ALSO lost: locked, nothing sent, and generation 2 is never written again with other bytes", async () => {
  server(refusal(400, "TIMESHEET_REJECTED"), OFFLINE);
  const day = await finishedDay(SCOPE, NORTHGATE, "First");
  await queued(SCOPE, day);
  await runSync(SCOPE, identity);
  const stale = liveFile(SCOPE, day.id).textSync();
  const corrected = await correct(SCOPE, day, "Second");
  if (corrected === null) throw new Error("the correction was refused");
  await queued(SCOPE, corrected);
  await runSync(SCOPE, identity);
  jest.restoreAllMocks();
  liveFile(SCOPE, day.id).write(stale);
  sealPath(day.id, 2).delete();

  const sent = server(accepted());
  expect(isDayLocked(SCOPE, day.id)).toBe(true);
  expect((await queueTimesheet(SCOPE, day.id)).kind).toBe("locked");
  await runSync(SCOPE, identity);
  expect(sent).toEqual([]);
  expect(sealPath(day.id, 2).exists).toBe(false);
});

// ═══════════════════════════════════════════════════════════════════════════
// Independent retest of S6 (2026-10-17): a STALE locking record must never
// stand in for newer evidence — not in the runner, not in the queue
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generation 1 queued (its WAITING record kept aside), rejected; the day
 * corrected; generation 2 sent with no answer; then the old generation-1
 * WAITING record put back in place of the current one.
 */
async function staleFirstOverUncertainSecond(): Promise<{ day: CompletedShift; second: string }> {
  server(refusal(400, "TIMESHEET_REJECTED"), OFFLINE);
  const day = await finishedDay(SCOPE, NORTHGATE, "First");
  await queued(SCOPE, day);
  const staleWaiting = liveFile(SCOPE, day.id).textSync();
  await runSync(SCOPE, identity);
  const corrected = await correct(SCOPE, day, "Second");
  if (corrected === null) throw new Error("the correction was refused");
  await queued(SCOPE, corrected);
  await runSync(SCOPE, identity);
  expect(recordOf(SCOPE, day.id)).toMatchObject({ generation: 2, uncertain: true });
  jest.restoreAllMocks();
  const second = readSeal(SCOPE, day.id, 2)?.snapshotJson ?? "";
  liveFile(SCOPE, day.id).write(staleWaiting);
  expect(recordOf(SCOPE, day.id)).toMatchObject({ generation: 1, state: SUBMISSION_STATE.waiting });
  return { day, second };
}

test("RT-A. stale generation-1 WAITING record, generation 2's seal MISSING, its marker kept: recovery is blocked — ZERO requests, the day locked, the status says so", async () => {
  const { day } = await staleFirstOverUncertainSecond();
  sealPath(day.id, 2).delete();
  const sent = server(accepted());

  await runSync(SCOPE, identity);

  expect(sent).toEqual([]);
  expect(isDayLocked(SCOPE, day.id)).toBe(true);
  expect(submissionStatusOf(SCOPE, day)).toMatchObject({ label: "Action needed — being checked", locked: true, canSend: false });
});

test("RT-B. the same with generation 2's seal DAMAGED: blocked — zero requests, never generation 1 instead", async () => {
  const { day } = await staleFirstOverUncertainSecond();
  sealPath(day.id, 2).write("{ damaged");
  const sent = server(accepted());

  await runSync(SCOPE, identity);

  expect(sent).toEqual([]);
  expect(isDayLocked(SCOPE, day.id)).toBe(true);
});

test("RT-C/F. stale generation-1 LOCKING record, generation 2's seal and marker intact: queueing recovers GENERATION 2 — never answers with the stale record — and only generation 2's exact sealed bytes are sent", async () => {
  const { day, second } = await staleFirstOverUncertainSecond();

  expect(await queueTimesheet(SCOPE, day.id)).toMatchObject({ kind: "queued", record: { generation: 2, uncertain: true } });

  const sent = server(replayed("TS-GEN20003"));
  await runSync(SCOPE, identity);
  expect(sent).toHaveLength(1);
  expect(snapshotBytes(sent[0])).toBe(second);
  expect(snapshotBytes(sent[0])).toContain("Second");
});

test("RT-C2. the RUNNER, with no queueing first, recovers generation 2 from the stale record and sends only its sealed bytes", async () => {
  const { day, second } = await staleFirstOverUncertainSecond();
  const sent = server(replayed("TS-GEN20004"));

  await runSync(SCOPE, identity);

  expect(sent).toHaveLength(1);
  expect(snapshotBytes(sent[0])).toBe(second);
  expect(recordOf(SCOPE, day.id)).toMatchObject({ generation: 2, state: SUBMISSION_STATE.submitted });
});

test("RT-D. queueTimesheet() called directly over a stale record with generation 2's seal missing: LOCKED — no generation 3, no reuse of 1 or 2, nothing written", async () => {
  const { day } = await staleFirstOverUncertainSecond();
  sealPath(day.id, 2).delete();
  const before = accountDirectoryOf(SCOPE).list().map(entry => entry.name).sort();

  expect((await queueTimesheet(SCOPE, day.id)).kind).toBe("locked");

  expect(readSeal(SCOPE, day.id, 3)).toBeNull();
  expect(sealPath(day.id, 2).exists).toBe(false);
  expect(accountDirectoryOf(SCOPE).list().map(entry => entry.name).sort()).toEqual(before);
  await expect(correct(SCOPE, (await readCompletedShift(SCOPE, day.id)) ?? day, "Third", "corr-2")).rejects.toBeInstanceOf(TimesheetLockedError);
});

test("RT-E. after a RESTART, with the stale record and newer evidence on disk: blocked sends nothing; recoverable sends only generation 2", async () => {
  const { day, second } = await staleFirstOverUncertainSecond();
  const sealTwo = sealPath(day.id, 2).textSync();
  sealPath(day.id, 2).delete();

  const blocked = server(accepted());
  await runInFreshProcess("user_send_1");
  expect(blocked).toEqual([]);
  jest.restoreAllMocks();

  // The seal comes back intact (restored from a backup, say): only generation 2 goes.
  sealPath(day.id, 2).create({ overwrite: true });
  sealPath(day.id, 2).write(sealTwo);
  const sent = server(replayed("TS-GEN20005"));
  await runInFreshProcess("user_send_1");
  expect(sent).toHaveLength(1);
  expect(snapshotBytes(sent[0])).toBe(second);
});
