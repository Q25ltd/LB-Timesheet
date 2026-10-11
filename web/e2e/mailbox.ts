import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * The e2e API writes each account email as JSON under `api/.mail-outbox/`
 * (development mailer, lib/mailer.ts). This reads the first password-reset
 * link sent to one address, waiting briefly — delivery runs after the reply.
 *
 * A company's verification link is NOT read here: the suite takes it from
 * Check your email's Development email section, the supported local
 * workflow. A DRIVER's is (D65's spec): the driver is the phone app, which
 * has no such section, so its confirmation token is read from the outbox.
 */
const OUTBOX = fileURLToPath(new URL("../../api/.mail-outbox/", import.meta.url));

interface Message { to: string; text: string }

function isMessage(value: unknown): value is Message {
  return typeof value === "object" && value !== null
    && "to" in value && typeof value.to === "string"
    && "text" in value && typeof value.text === "string";
}

export async function resetLinkSentTo(to: string): Promise<string> {
  const pattern = /(http:\/\/localhost:4175\/reset-password#token=[A-Za-z0-9_-]+)/;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const names = await readdir(OUTBOX).catch(() => [] as string[]);
    const links: string[] = [];
    for (const name of names.sort()) {
      const parsed: unknown = JSON.parse(await readFile(`${OUTBOX}${name}`, "utf8"));
      if (!isMessage(parsed) || parsed.to !== to) continue;
      const match = pattern.exec(parsed.text);
      if (match?.[1] !== undefined) links.push(match[1]);
    }
    const link = links[0];
    if (link !== undefined) return link;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`no reset-password link was sent to ${to}`);
}

/** The token in the first email-verification link sent to one address. */
export async function verificationTokenSentTo(to: string): Promise<string> {
  const pattern = /\/verify-email#token=([A-Za-z0-9_-]+)/;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const names = await readdir(OUTBOX).catch(() => [] as string[]);
    for (const name of names.sort()) {
      const parsed: unknown = JSON.parse(await readFile(`${OUTBOX}${name}`, "utf8"));
      if (!isMessage(parsed) || parsed.to !== to) continue;
      const token = pattern.exec(parsed.text)?.[1];
      if (token !== undefined) return token;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`no email-verification link was sent to ${to}`);
}
