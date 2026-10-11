/**
 * The start-receipt queue (D66, stage S3) — one small file per receipt in the
 * signed-in account's own directory (F-31), so it survives a crash, a
 * restart and a sign-out, and another driver on the phone never sees or
 * sends it.
 *
 * A receipt says: this company's day existed now. It is queued when a
 * company's day starts — or a day is made a company's — and sent when there
 * is a connection; it never blocks starting work. Its payload is fixed when
 * it is queued and never changed: every retry is the same request, and the
 * server answers a replay with the receipt it already kept.
 */
import { Directory, File } from "expo-file-system";
import { accountDirectory, type AccountScope } from "../shift/accountScope";

export const RECEIPT_FILE_PREFIX = "logisticbay-receipt-";

/** Where a queued receipt stands. One registry, no magic strings. */
export const RECEIPT_STATE = {
  /** Not yet answered by the server. Sent at the next chance. */
  waiting: "waiting",
  /** The server kept it (or already had it). Done. */
  received: "received",
  /** The server will not give one — the membership was not active, or is not this driver's. Final. */
  refused: "refused",
} as const;

type ReceiptState = (typeof RECEIPT_STATE)[keyof typeof RECEIPT_STATE];

export interface QueuedReceipt {
  /** The day's id — the server's `clientEventId`. */
  dayId: string;
  membershipId: string;
  /** The declared start as it was when queued — never changed afterwards. */
  startedAt: string;
  queuedAt: string;
  state: ReceiptState;
  attempts: number;
  lastAttemptAt: string | null;
  /** The SERVER's time of receipt — the evidence — once it has one. */
  receivedAt: string | null;
}

function receiptFile(scope: AccountScope, dayId: string, membershipId: string): File {
  return new File(accountDirectory(scope), `${RECEIPT_FILE_PREFIX}${dayId}-${membershipId}.json`);
}

function isQueuedReceipt(value: unknown): value is QueuedReceipt {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r["dayId"] === "string" && typeof r["membershipId"] === "string" && typeof r["startedAt"] === "string"
    && typeof r["queuedAt"] === "string" && Object.values(RECEIPT_STATE).some(state => state === r["state"])
    && typeof r["attempts"] === "number" && (r["lastAttemptAt"] === null || typeof r["lastAttemptAt"] === "string")
    && (r["receivedAt"] === null || typeof r["receivedAt"] === "string");
}

/** Written in full and read back; throws when it could not be. */
function write(file: File, receipt: QueuedReceipt): void {
  const serialised = JSON.stringify(receipt);
  file.create({ overwrite: true });
  file.write(serialised);
  if (file.textSync() !== serialised) throw new Error("The start receipt was not saved in full");
}

/**
 * Queue a receipt for this day and company — once. A receipt already queued
 * for the same day and company is left exactly as it is.
 */
export function queueStartReceipt(scope: AccountScope, receipt: { dayId: string; membershipId: string; startedAt: string }, now: Date = new Date()): void {
  const file = receiptFile(scope, receipt.dayId, receipt.membershipId);
  if (file.exists) return;
  write(file, { ...receipt, queuedAt: now.toISOString(), state: RECEIPT_STATE.waiting, attempts: 0, lastAttemptAt: null, receivedAt: null });
}

/** Every receipt this account has queued. One that cannot be read is left alone, never repaired or sent. */
export function listReceipts(scope: AccountScope): QueuedReceipt[] {
  const directory: Directory = accountDirectory(scope);
  const receipts: QueuedReceipt[] = [];
  for (const entry of directory.list()) {
    if (!(entry instanceof File) || !entry.name.startsWith(RECEIPT_FILE_PREFIX)) continue;
    try {
      const parsed: unknown = JSON.parse(entry.textSync());
      if (isQueuedReceipt(parsed)) receipts.push(parsed);
    } catch {
      // Unreadable: kept on disk as it is, and not sent — a guess is never sent.
    }
  }
  return receipts.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

export function saveReceipt(scope: AccountScope, receipt: QueuedReceipt): void {
  write(receiptFile(scope, receipt.dayId, receipt.membershipId), receipt);
}
