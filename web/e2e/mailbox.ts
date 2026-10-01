import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * The e2e API writes each account email as JSON under `api/.mail-outbox/`
 * (development mailer, lib/mailer.ts). This reads the newest link of one
 * kind sent to one address, waiting briefly — delivery runs after the reply.
 */
const OUTBOX = fileURLToPath(new URL("../../api/.mail-outbox/", import.meta.url));

interface Message { to: string; text: string }

function isMessage(value: unknown): value is Message {
  return typeof value === "object" && value !== null
    && "to" in value && typeof value.to === "string"
    && "text" in value && typeof value.text === "string";
}

export async function linkSentTo(to: string, kind: "verify-email" | "reset-password", nth = 0): Promise<string> {
  const pattern = new RegExp(`(http://localhost:4175/${kind}#token=[A-Za-z0-9_-]+)`);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const names = await readdir(OUTBOX).catch(() => [] as string[]);
    const links: string[] = [];
    for (const name of names.sort()) {
      const parsed: unknown = JSON.parse(await readFile(`${OUTBOX}${name}`, "utf8"));
      if (!isMessage(parsed) || parsed.to !== to) continue;
      const match = pattern.exec(parsed.text);
      if (match?.[1] !== undefined) links.push(match[1]);
    }
    const link = links[nth];
    if (link !== undefined) return link;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`no ${kind} link #${String(nth)} was sent to ${to}`);
}
