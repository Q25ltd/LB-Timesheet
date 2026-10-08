/**
 * start-smoke — the PRODUCTION start, proven (F-17, D57).
 *
 * Run after `npm run build`. Asserts, against the real compiled output:
 *
 *   1. `npm start` is plain `node dist/server.js` — no `tsx`, no TypeScript
 *   2. nothing in `dist/` imports a package outside `dependencies`: a
 *      production install (`npm ci --omit=dev`) has everything it needs
 *   3. a PRODUCTION process with email explicitly disabled, behind the
 *      Railway edge (`CLIENT_IP_SOURCE=x-real-ip`) and with NO AWS
 *      credentials starts; /health/live and /health answer; an unknown route
 *      answers in the one error envelope; SIGTERM shuts it down cleanly
 *   4. the same process with MAIL_TRANSPORT unset REFUSES to start
 *
 * The server runs from a temporary working directory, so `dotenv` finds no
 * `.env` there: what it sees is exactly what is set below, plus
 * DATABASE_URL — the database the check runs against (readiness only reads
 * `SELECT 1`).
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { config } from "dotenv";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(API_ROOT, "dist");
// For DATABASE_URL only, as the other scripts do; the SERVER below does not
// see this file — it runs from an empty directory with an explicit env.
config({ path: resolve(API_ROOT, ".env"), quiet: true });

function fail(message: string): never {
  console.error(`start-smoke: ${message}`);
  process.exit(1);
}

const databaseUrl = process.env["DATABASE_URL"];
if (databaseUrl === undefined || databaseUrl === "") fail("DATABASE_URL must be set (the database the readiness check reads)");

// ── 1. The start command ─────────────────────────────────────────────────────
const pkg: unknown = JSON.parse(await readFile(join(API_ROOT, "package.json"), "utf8"));
const scripts = typeof pkg === "object" && pkg !== null ? Reflect.get(pkg, "scripts") as unknown : undefined;
const start = typeof scripts === "object" && scripts !== null ? Reflect.get(scripts, "start") as unknown : undefined;
if (start !== "node dist/server.js") fail(`npm start must be "node dist/server.js", is ${JSON.stringify(start)}`);
const declared = typeof pkg === "object" && pkg !== null ? Reflect.get(pkg, "dependencies") as unknown : undefined;
const dependencies = new Set(typeof declared === "object" && declared !== null ? Object.keys(declared) : []);
if (dependencies.size === 0) fail("package.json declares no dependencies — cannot judge the build's imports");

// ── 2. Every package the build imports is a runtime dependency ──────────────
async function jsFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => fail("dist/ is missing — run `npm run build` first"));
  const nested = await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return jsFiles(path);
    return Promise.resolve(entry.name.endsWith(".js") ? [path] : []);
  }));
  return nested.flat();
}

const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);
// Statements as tsc emits them — at the start of a line — so a comment that
// happens to contain the word "from" is not mistaken for an import.
const specifiers = /^\s*(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"'./][^"']*)["']|^\s*import\s*["']([^"'./][^"']*)["']|\bimport\(\s*["']([^"'./][^"']*)["']\s*\)/gm;
const outside = new Set<string>();
for (const file of await jsFiles(DIST)) {
  for (const match of (await readFile(file, "utf8")).matchAll(specifiers)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? "";
    if (builtins.has(specifier) || builtins.has(specifier.split("/")[0] ?? "")) continue;
    const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0] ?? "";
    if (!dependencies.has(name)) outside.add(`${name} (in ${file.slice(DIST.length + 1)})`);
  }
}
if (outside.size > 0) fail(`dist/ imports packages that are not runtime dependencies: ${[...outside].join(", ")}`);

// ── 3 and 4. Start it ────────────────────────────────────────────────────────
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => { if (typeof address === "object" && address !== null) resolvePort(address.port); else reject(new Error("no port")); });
    });
  });
}

const workdir = await mkdtemp(join(tmpdir(), "lbts-start-smoke-"));
const baseEnv: Record<string, string> = {
  PATH:             process.env["PATH"] ?? "",
  DATABASE_URL:     databaseUrl,
  NODE_ENV:         "production",
  JWT_SECRET:       randomBytes(32).toString("hex"),
  WEB_ORIGIN:       "https://timesheets.logisticbay.com",
  WEB_APP_URL:      "https://timesheets.logisticbay.com",
  CLIENT_IP_SOURCE: "x-real-ip",
};

function run(env: Record<string, string>) {
  const child = spawn(process.execPath, [join(DIST, "server.js")], { cwd: workdir, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const exited = new Promise<number | null>(resolveExit => child.on("exit", code => resolveExit(code)));
  return { child, exited, output: () => output };
}

async function get(port: number, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`);
  return { status: response.status, body: await response.json() };
}

try {
  // 4 first: unset transport is refused.
  const refused = run({ ...baseEnv, PORT: String(await freePort()) });
  const refusedCode = await Promise.race([refused.exited, new Promise<"running">(r => setTimeout(() => r("running"), 15_000))]);
  if (refusedCode === "running") { refused.child.kill("SIGKILL"); fail("production with MAIL_TRANSPORT unset STARTED — it must refuse"); }
  if (refusedCode === 0 || !refused.output().includes("MAIL_TRANSPORT must be set explicitly")) {
    fail(`production with MAIL_TRANSPORT unset must exit non-zero naming MAIL_TRANSPORT (exit ${String(refusedCode)})`);
  }

  // 3: explicitly disabled, no AWS credentials — starts.
  const port = await freePort();
  const server = run({ ...baseEnv, PORT: String(port), MAIL_TRANSPORT: "disabled" });
  let live: { status: number; body: unknown } | null = null;
  for (let attempt = 0; attempt < 100 && live === null; attempt += 1) {
    await new Promise(r => setTimeout(r, 200));
    live = await get(port, "/health/live").catch(() => null);
  }
  if (live === null) { server.child.kill("SIGKILL"); fail(`the compiled server did not start:\n${server.output()}`); }
  if (live.status !== 200) fail(`/health/live answered ${String(live.status)}`);
  const ready = await get(port, "/health");
  if (ready.status !== 200) fail(`/health answered ${String(ready.status)} — is DATABASE_URL reachable?`);
  const unknown = await get(port, "/no-such-route");
  if (unknown.status !== 404 || JSON.stringify(unknown.body) !== JSON.stringify({ error: "Not found", code: "NOT_FOUND" })) {
    fail(`an unknown route answered ${String(unknown.status)} ${JSON.stringify(unknown.body)}`);
  }
  if (!server.output().includes("MAIL_TRANSPORT is disabled")) fail("a deployment with email disabled must say so at startup");

  server.child.kill("SIGTERM");
  const code = await Promise.race([server.exited, new Promise<"hung">(r => setTimeout(() => r("hung"), 10_000))]);
  if (code === "hung") { server.child.kill("SIGKILL"); fail("SIGTERM did not stop the server"); }
  if (code !== 0) fail(`SIGTERM exit code ${String(code)}`);

  console.log("start-smoke: ✓ node dist/server.js · runtime dependencies only · production starts with email disabled and no AWS credentials · refuses with MAIL_TRANSPORT unset · /health/live, /health, 404 envelope · clean SIGTERM");
} finally {
  await rm(workdir, { recursive: true, force: true });
}
