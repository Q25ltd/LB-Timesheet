/**
 * Submitted timesheets on the phone (D66 stage S6) — one record per finished
 * company day, in the signed-in account's own directory (F-31), so it
 * survives a crash, a restart and a sign-out, and no other account on the
 * phone ever reads or sends it.
 *
 * A record holds the day's FROZEN snapshot: built once from the version the
 * driver declared, never rebuilt, so every retry is the same request under
 * the same identity — the day's id (the server's `clientEventId`) and
 * revision 1. Only its state, attempts and result change between writes.
 *
 * THE RECORD IS THE LOCK. A finished day is locked exactly while its record
 * is in a locking state (`isLocking`) — or cannot be read (fail safe). There
 * is no second flag that could disagree with it: a queued day can never be
 * editable, and a locked day always has its record.
 *
 * CRASH SAFETY. Every write goes to `<record>.next.json`, is read back, and
 * only then moved over the record. Expo's overwriting move is two steps
 * (delete, then rename), so a crash can leave only the verified next copy:
 * the reader promotes it — safe, because every copy of a record carries the
 * same snapshot except after a definitive rejection, and `seq` orders them.
 * A next copy that cannot be read was never verified, so it never replaced
 * anything: it is discarded, and the record it was meant to follow stands.
 *
 * THE SEAL. When a snapshot is frozen, its exact bytes are also written ONCE
 * to a seal file of their own (`<prefix>seal-<day>-g<generation>.json`) that
 * is never rewritten. Every send takes its payload from the seal and refuses
 * to send when the record's copy differs from it; a record the disk damaged is
 * restored from its seal, byte for byte. Nothing is ever REBUILT from the day:
 * a later app version could build a different snapshot, and a different
 * snapshot must never travel under an identity already sent. When the seal
 * cannot be read either, the day stays locked and nothing is sent. A seal is
 * NEVER overwritten: a later snapshot is a later generation, beside it.
 *
 * THE SENT-MARKER. Before a generation's first request leaves, a write-once
 * marker says so (`<prefix>seal-<day>-g<generation>.sent.json`). It is what
 * tells "never transmitted" from "may have reached the server" when the
 * record itself is gone: with a marker the day stays locked and is restored
 * from its seal and replayed; with none, nothing was ever sent.
 */
import { Directory, File } from "expo-file-system";
import { accountDirectory, type AccountScope } from "../shift/accountScope";

export const SUBMISSION_FILE_PREFIX = "logisticbay-submission-";
const NEXT_SUFFIX = ".next.json";
const RECOVERY_INFIX = "unreadable-";
const SEAL_INFIX = "seal-";

/** Where a submitted timesheet stands on the phone. One registry, no magic strings. */
export const SUBMISSION_STATE = {
  /** Queued, not yet answered. Sent at the next chance. */
  waiting:         "waiting",
  /** A request is (or was, when the app stopped) on its way: its outcome is not known. Sent again — the server replays. */
  sending:         "sending",
  /** The company has it, accepted. */
  submitted:       "submitted",
  /** The company has it; it waits for the company's review (D66). */
  pendingReview:   "pending-review",
  /** The server refused this snapshot and stored nothing: correct the day and send again. */
  needsCorrection: "needs-correction",
  /** The server will not take it for this company — the membership is not the driver's to use. Stored nothing. */
  refused:         "refused",
  /** The server already holds a DIFFERENT version of this day: it stays locked for an amendment (S9). */
  conflict:        "conflict",
} as const;

export type SubmissionState = (typeof SUBMISSION_STATE)[keyof typeof SUBMISSION_STATE];

const STATES: readonly SubmissionState[] = Object.values(SUBMISSION_STATE);

/** States in which the day may not be changed: it is on its way, or the company has it. */
export function isLocking(state: SubmissionState): boolean {
  return state !== SUBMISSION_STATE.needsCorrection && state !== SUBMISSION_STATE.refused;
}

/** States the runner sends from. */
export function isSendable(state: SubmissionState): boolean {
  return state === SUBMISSION_STATE.waiting || state === SUBMISSION_STATE.sending;
}

interface SubmissionResult {
  reference: string;
  revision: number;
  standing: string;
  verification: string;
  /** The SERVER's time of receipt. */
  receivedAt: string;
}

/** Why the last attempt did not land — the server's own words and code, never guessed. */
export interface SubmissionProblem {
  /** What kind of failure it was (`submissionErrors.ts`). */
  kind: string;
  status: number | null;
  code: string | null;
  message: string;
  details: { path: string; message: string }[];
}

/** A snapshot the server refused, kept when the driver corrected the day and sent again. */
interface EarlierSnapshot {
  generation: number;
  snapshot: unknown;
  declaredVersion: string;
  refusedAt: string;
  state: SubmissionState;
  problem: SubmissionProblem | null;
}

export interface TimesheetSubmissionRecord {
  ownerUserId: string;
  /** The day's id: the server's `clientEventId`. */
  dayId: string;
  membershipId: string;
  companyName: string;
  revision: 1;
  /** The frozen snapshot — sent exactly as it is, every time. */
  snapshot: unknown;
  /** The declaration version the snapshot was built from (D42). */
  declaredVersion: string;
  /** 1 when first queued; one more each time a refused day is corrected and queued again. */
  generation: number;
  /** One more on every write: orders the record and its next copy. */
  seq: number;
  queuedAt: string;
  state: SubmissionState;
  attempts: number;
  lastAttemptAt: string | null;
  result: SubmissionResult | null;
  problem: SubmissionProblem | null;
  /**
   * A transmission of THIS generation may have reached the server without
   * the phone learning the outcome (no answer, a server fault, an answer it
   * could not read, or the app stopped while sending). Never cleared: from
   * then on only the server's proof that nothing is kept may unlock the day.
   */
  uncertain: boolean;
  earlier: EarlierSnapshot[];
}

export type ReadSubmission =
  | { kind: "none" }
  | { kind: "ok"; record: TimesheetSubmissionRecord }
  /** A record is there but cannot be read: the day stays locked and nothing is sent until it is recovered. */
  | { kind: "unreadable" };

/** Thrown when a record could not be written; whether the previous one still stands is for the reader to say. */
export class SubmissionSaveError extends Error {
  constructor(cause: unknown) {
    super("The submission could not be saved", { cause });
    this.name = "SubmissionSaveError";
  }
}

const DAY_ID = /^[0-9A-Za-z-]{1,64}$/;

function recordFile(scope: AccountScope, dayId: string): File {
  if (!DAY_ID.test(dayId)) throw new Error("Refusing a submission under an id that cannot name a file");
  return new File(accountDirectory(scope), `${SUBMISSION_FILE_PREFIX}${dayId}.json`);
}

function nextFile(scope: AccountScope, dayId: string): File {
  if (!DAY_ID.test(dayId)) throw new Error("Refusing a submission under an id that cannot name a file");
  return new File(accountDirectory(scope), `${SUBMISSION_FILE_PREFIX}${dayId}${NEXT_SUFFIX}`);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isState(value: unknown): value is SubmissionState {
  return STATES.some(state => state === value);
}

function isProblem(value: unknown): value is SubmissionProblem | null {
  if (value === null) return true;
  const p = record(value);
  return p !== null && typeof p["kind"] === "string" && (p["status"] === null || typeof p["status"] === "number")
    && (p["code"] === null || typeof p["code"] === "string") && typeof p["message"] === "string" && Array.isArray(p["details"]);
}

function isResult(value: unknown): value is SubmissionResult | null {
  if (value === null) return true;
  const r = record(value);
  return r !== null && typeof r["reference"] === "string" && typeof r["revision"] === "number" && typeof r["standing"] === "string"
    && typeof r["verification"] === "string" && typeof r["receivedAt"] === "string";
}

/** Narrow stored data to a record of THIS account and day — or refuse it. */
function asRecord(value: unknown, scope: AccountScope, dayId: string): TimesheetSubmissionRecord | null {
  const r = record(value);
  if (r === null) return null;
  const ok = r["ownerUserId"] === scope.userId && r["dayId"] === dayId
    && typeof r["membershipId"] === "string" && r["membershipId"] !== "" && typeof r["companyName"] === "string"
    && r["revision"] === 1 && record(r["snapshot"]) !== null && typeof r["declaredVersion"] === "string"
    && typeof r["generation"] === "number" && r["generation"] >= 1 && typeof r["seq"] === "number"
    && typeof r["queuedAt"] === "string" && isState(r["state"]) && typeof r["attempts"] === "number"
    && (r["lastAttemptAt"] === null || typeof r["lastAttemptAt"] === "string")
    && isResult(r["result"]) && isProblem(r["problem"]) && typeof r["uncertain"] === "boolean" && Array.isArray(r["earlier"]);
  return ok ? (value as TimesheetSubmissionRecord) : null;
}

function readCopy(file: File, scope: AccountScope, dayId: string): TimesheetSubmissionRecord | null | "absent" {
  if (!file.exists) return "absent";
  try {
    return asRecord(JSON.parse(file.textSync()), scope, dayId);
  } catch {
    return null;
  }
}

/**
 * This account's record of a day — settling a write a crash interrupted:
 *   the record only                    → the record
 *   a readable next copy, newer        → the next copy, moved into place
 *   a next copy that cannot be read    → discarded: it was never verified, so it replaced nothing
 *   a record that cannot be read       → `unreadable` (the day stays locked)
 */
export function readSubmission(scope: AccountScope, dayId: string): ReadSubmission {
  const live = recordFile(scope, dayId);
  const next = nextFile(scope, dayId);
  const current = readCopy(live, scope, dayId);
  const pending = readCopy(next, scope, dayId);

  if (pending === null) {
    // Never verified, so never moved over anything: worth nothing.
    next.delete();
    return current === "absent" ? { kind: "none" } : current === null ? { kind: "unreadable" } : { kind: "ok", record: current };
  }
  if (pending === "absent") {
    return current === "absent" ? { kind: "none" } : current === null ? { kind: "unreadable" } : { kind: "ok", record: current };
  }
  // A verified next copy: the newest state, unless the record already moved past it.
  if (current !== "absent" && current !== null && current.seq >= pending.seq) {
    next.delete();
    return { kind: "ok", record: current };
  }
  try {
    next.moveSync(live, { overwrite: true });
  } catch {
    // Promoted on a later read; the copy itself is complete and verified.
  }
  return { kind: "ok", record: pending };
}

/**
 * Whether the day may be changed: not while a record of it is on its way or
 * held by the company — or cannot be read (fail safe).
 */
export function isDayLocked(scope: AccountScope, dayId: string): boolean {
  if (!DAY_ID.test(dayId)) return false;
  const read = readSubmission(scope, dayId);
  if (read.kind === "unreadable") return true;
  const sent = highestSentGeneration(scope, dayId);
  // The record is gone — or older than a generation that may have left — while a request may
  // be on its way: newer evidence wins; locked until restored (`submissionQueue.ts`).
  if (read.kind === "none") return sent !== null;
  return isLocking(read.record.state) || (sent !== null && sent > read.record.generation);
}

/** Write a record: in full to its next copy, read back, then moved into place. */
export function writeSubmission(scope: AccountScope, next: TimesheetSubmissionRecord): void {
  if (next.ownerUserId !== scope.userId) throw new Error("Refusing to store another account's submission");
  const serialised = JSON.stringify(next);
  if (asRecord(JSON.parse(serialised), scope, next.dayId) === null) throw new Error("Refusing to store a submission the reader would refuse");
  const staged = nextFile(scope, next.dayId);
  try {
    staged.create({ overwrite: true });
    staged.write(serialised);
    if (staged.textSync() !== serialised) throw new Error("The submission was not written in full");
  } catch (error: unknown) {
    // Not verified: worthless, and must never be promoted.
    try { if (staged.exists) staged.delete(); } catch { /* the reader discards an unreadable copy */ }
    throw new SubmissionSaveError(error);
  }
  try {
    staged.moveSync(recordFile(scope, next.dayId), { overwrite: true });
  } catch (error: unknown) {
    // The verified copy stays: the reader promotes it.
    throw new SubmissionSaveError(error);
  }
}

/**
 * Move an unreadable record aside, byte for byte, so it is never sent and
 * never lost — before the day's record is rebuilt (`submissionQueue.ts`).
 */
export function setAsideUnreadable(scope: AccountScope, dayId: string, now: Date): void {
  const live = recordFile(scope, dayId);
  const aside = new File(accountDirectory(scope), `${SUBMISSION_FILE_PREFIX}${RECOVERY_INFIX}${dayId}-${String(now.getTime())}.json`);
  if (aside.exists) throw new Error("Refusing to overwrite a set-aside submission");
  live.moveSync(aside, { overwrite: false });
}

/** The days this account has records for — a record, or a next copy a crash left. */
export function submissionDayIds(scope: AccountScope): string[] {
  const directory: Directory = accountDirectory(scope);
  const ids = new Set<string>();
  for (const entry of directory.list()) {
    if (!(entry instanceof File) || !entry.name.startsWith(SUBMISSION_FILE_PREFIX)) continue;
    const rest = entry.name.slice(SUBMISSION_FILE_PREFIX.length);
    if (rest.startsWith(RECOVERY_INFIX)) continue;
    if (rest.startsWith(SEAL_INFIX)) {
      // A seal or a sent-marker: its day may have lost its record (`submissionQueue.ts` restores it).
      const sealed = /^seal-(.+)-g\d+(?:\.sent)?\.json$/.exec(rest);
      if (sealed?.[1] !== undefined && DAY_ID.test(sealed[1])) ids.add(sealed[1]);
      continue;
    }
    const id = rest.endsWith(NEXT_SUFFIX) ? rest.slice(0, -NEXT_SUFFIX.length) : rest.endsWith(".json") ? rest.slice(0, -".json".length) : null;
    if (id !== null && DAY_ID.test(id)) ids.add(id);
  }
  return [...ids].sort();
}

// ── The seal: a frozen snapshot's exact bytes, written once ─────────────────

export interface SubmissionSeal {
  ownerUserId: string;
  dayId: string;
  generation: number;
  membershipId: string;
  companyName: string;
  declaredVersion: string;
  /** The snapshot exactly as frozen — the bytes every send carries. */
  snapshotJson: string;
}

function sealFile(scope: AccountScope, dayId: string, generation: number): File {
  if (!DAY_ID.test(dayId) || !Number.isSafeInteger(generation) || generation < 1) throw new Error("Refusing a seal that cannot name a file");
  return new File(accountDirectory(scope), `${SUBMISSION_FILE_PREFIX}${SEAL_INFIX}${dayId}-g${String(generation)}.json`);
}

function asSeal(value: unknown, scope: AccountScope, dayId: string, generation: number): SubmissionSeal | null {
  const r = record(value);
  if (r === null || r["ownerUserId"] !== scope.userId || r["dayId"] !== dayId || r["generation"] !== generation) return null;
  if (typeof r["membershipId"] !== "string" || typeof r["companyName"] !== "string" || typeof r["declaredVersion"] !== "string" || typeof r["snapshotJson"] !== "string") return null;
  try {
    if (record(JSON.parse(r["snapshotJson"])) === null) return null;
  } catch {
    return null;
  }
  return value as SubmissionSeal;
}

/** A generation's seal — `null` when there is none or it cannot be read. */
export function readSeal(scope: AccountScope, dayId: string, generation: number): SubmissionSeal | null {
  const file = sealFile(scope, dayId, generation);
  if (!file.exists) return null;
  try {
    return asSeal(JSON.parse(file.textSync()), scope, dayId, generation);
  } catch {
    return null;
  }
}

/** Whether a seal file exists for the generation, readable or not. */
export function sealExists(scope: AccountScope, dayId: string, generation: number): boolean {
  return sealFile(scope, dayId, generation).exists;
}

/** Write a generation's seal — verified, then moved into place. Never over an existing one. */
export function writeSeal(scope: AccountScope, seal: SubmissionSeal): void {
  if (seal.ownerUserId !== scope.userId) throw new Error("Refusing to seal another account's submission");
  const serialised = JSON.stringify(seal);
  if (asSeal(JSON.parse(serialised), scope, seal.dayId, seal.generation) === null) throw new Error("Refusing a seal the reader would refuse");
  const target = sealFile(scope, seal.dayId, seal.generation);
  const staged = new File(accountDirectory(scope), `${SUBMISSION_FILE_PREFIX}${SEAL_INFIX}${seal.dayId}-g${String(seal.generation)}${NEXT_SUFFIX}`);
  try {
    staged.create({ overwrite: true });
    staged.write(serialised);
    if (staged.textSync() !== serialised) throw new Error("The seal was not written in full");
    if (target.exists) throw new Error("Refusing to overwrite a seal");
    staged.moveSync(target, { overwrite: false });
  } catch (error: unknown) {
    try { if (staged.exists) staged.delete(); } catch { /* an unverified copy is never read */ }
    throw new SubmissionSaveError(error);
  }
}

/**
 * Every generation a day has ANY evidence of — a seal, a seal's staged copy,
 * a sent-marker — found by listing the account's directory, never by counting
 * up from 1: a lost seal leaves a gap, and evidence beyond it still counts
 * (independent S6 review, 2026-10-17).
 */
function evidenceOf(scope: AccountScope, dayId: string): { seals: Set<number>; markers: Set<number>; all: Set<number> } {
  const seals = new Set<number>();
  const markers = new Set<number>();
  const all = new Set<number>();
  if (!DAY_ID.test(dayId)) return { seals, markers, all };
  const name = new RegExp(`^${SUBMISSION_FILE_PREFIX}${SEAL_INFIX}${dayId.replace(/-/g, "\\-")}-g(\\d+)(\\.sent|\\.next)?\\.json$`);
  for (const entry of accountDirectory(scope).list()) {
    if (!(entry instanceof File)) continue;
    const found = name.exec(entry.name);
    const generation = Number(found?.[1] ?? "0");
    if (found === null || !Number.isSafeInteger(generation) || generation < 1) continue;
    all.add(generation);
    if (found[2] === ".sent") markers.add(generation);
    else if (found[2] === undefined) seals.add(generation);
  }
  return { seals, markers, all };
}

/** The highest generation with any evidence — seal, staged seal or marker: a new snapshot takes one past it, never one already used. */
export function highestEvidenceGeneration(scope: AccountScope, dayId: string): number {
  return Math.max(0, ...evidenceOf(scope, dayId).all);
}

/** The highest generation that has a seal file (readable or not) — `0` when none. */
export function highestSealGeneration(scope: AccountScope, dayId: string): number {
  return Math.max(0, ...evidenceOf(scope, dayId).seals);
}

// ── The sent-marker: "a request of this generation may have left" ───────────

function sentFile(scope: AccountScope, dayId: string, generation: number): File {
  if (!DAY_ID.test(dayId) || !Number.isSafeInteger(generation) || generation < 1) throw new Error("Refusing a marker that cannot name a file");
  return new File(accountDirectory(scope), `${SUBMISSION_FILE_PREFIX}${SEAL_INFIX}${dayId}-g${String(generation)}.sent.json`);
}

/**
 * Whether a request of this generation may have left. CONSERVATIVE: a marker
 * file is evidence unless it is readable and EXPLICITLY names another account
 * — empty, malformed, partial or unreadable, it still says a request may have
 * left (independent S6 review, 2026-10-17).
 */
function mayHaveBeenSent(scope: AccountScope, dayId: string, generation: number): boolean {
  const file = sentFile(scope, dayId, generation);
  if (!file.exists) return false;
  try {
    const r = record(JSON.parse(file.textSync()));
    const owner = r?.["ownerUserId"];
    return !(typeof owner === "string" && owner !== "" && owner !== scope.userId);
  } catch {
    return true;
  }
}

/** Written ONCE, before a generation's first request leaves; never removed. Throws when it could not be — then nothing is sent. */
export function markSent(scope: AccountScope, dayId: string, generation: number): void {
  if (mayHaveBeenSent(scope, dayId, generation)) return;
  const file = sentFile(scope, dayId, generation);
  const serialised = JSON.stringify({ ownerUserId: scope.userId, dayId, generation });
  file.create({ overwrite: true });
  file.write(serialised);
  if (file.textSync() !== serialised) throw new Error("The sent-marker was not written in full");
}

/** The highest generation that may have been sent — whatever gaps lie below it; `null` when none. */
export function highestSentGeneration(scope: AccountScope, dayId: string): number | null {
  const sent = [...evidenceOf(scope, dayId).markers].filter(generation => mayHaveBeenSent(scope, dayId, generation));
  return sent.length === 0 ? null : Math.max(...sent);
}
