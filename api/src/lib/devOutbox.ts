/**
 * Reading the DEVELOPMENT outbox (`lib/mailer.ts`, development without a
 * provider key): find the verification link a message to `to` carries whose
 * token is the one stored as `tokenHash`.
 *
 * It reads what the mailer WROTE — the same file a developer could open — so
 * the link handed out is byte-for-byte the link the email contains, and its
 * token is the real one. Matching on the stored digest is what makes it the
 * account's own, current link: a superseded or spent token matches nothing,
 * and a message to the same address for another account (a driver and a
 * company may share one, D51) carries another account's token.
 *
 * Only ever called by `routes/devEmail.ts`, which exists only when the
 * outbox is the transport.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { hashAccountToken } from "./accountToken.js";

const VERIFICATION_LINK = /(\S+\/verify-email#token=([A-Za-z0-9_-]{1,64}))/;

function textField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" ? field : null;
}

export async function findVerificationLink(directory: string, to: string, tokenHash: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    // No outbox yet: nothing has been sent.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  // Newest first: the file names begin with the time they were written.
  for (const name of names.filter(n => n.endsWith(".json")).sort().reverse()) {
    let message: unknown;
    try {
      message = JSON.parse(await readFile(join(directory, name), "utf8"));
    } catch {
      continue;   // a file being written, or not a message: not ours to read
    }
    if (textField(message, "to")?.toLowerCase() !== to.toLowerCase()) continue;
    const match = VERIFICATION_LINK.exec(textField(message, "text") ?? "");
    if (match?.[1] !== undefined && match[2] !== undefined && hashAccountToken(match[2]) === tokenHash) return match[1];
  }
  return null;
}
