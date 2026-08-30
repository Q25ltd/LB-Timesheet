/**
 * check-rules — makes the mandatory rules in CLAUDE.md fail the build.
 *
 * A written rule is a suggestion; an executable one is a rule. Every check here
 * exists because the same class of problem cost real time in the LogisticBay TMS.
 *
 * Run: npm run check:rules
 *
 * Escape hatch: put `// rules-ignore: <id>` on the offending line, and say why.
 * If you are reaching for it often, the rule is wrong — change the rule.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC      = join(API_ROOT, "src");

// ── 0. Node version ──────────────────────────────────────────────────────────
// Prisma 7 breaks on Node 20, and `node --test` only expands globs from Node 22.
// Both failures surface far from their cause, so say it plainly up front.
const REQUIRED_NODE_MAJOR = 22;
const REQUIRED_NODE_MINOR = 12;
{
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < REQUIRED_NODE_MAJOR || (major === REQUIRED_NODE_MAJOR && minor < REQUIRED_NODE_MINOR)) {
    console.error(
      `\n\u2717 Node ${process.versions.node} is too old \u2014 this repo needs ` +
      `${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}+.\n\n` +
      `  Run:  nvm use\n\n` +
      `  It reverts in every new terminal. To fix permanently, add nvm's\n` +
      `  directory hook to ~/.zshrc so .nvmrc is applied on cd.\n`,
    );
    process.exit(1);
  }
}

interface Violation { id: string; file: string; line: number; text: string; why: string }
const violations: Violation[] = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "generated" || entry === "node_modules") continue;
      walk(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC);

function report(id: string, file: string, index: number, text: string, why: string) {
  violations.push({ id, file: relative(API_ROOT, file), line: index + 1, text: text.trim(), why });
}

/** Per-line scan shared by most checks. */
function scan(
  id: string,
  why: string,
  predicate: (line: string, file: string) => boolean,
  fileFilter: (file: string) => boolean = () => true,
) {
  for (const file of files) {
    if (!fileFilter(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.includes(`rules-ignore: ${id}`)) return;
      if (predicate(line, file)) report(id, file, i, line, why);
    });
  }
}

// ── 1. No `any` ──────────────────────────────────────────────────────────────
scan(
  "no-any",
  "`any` disables the type system. Use `unknown` and narrow it.",
  line => {
    const code = line.replace(/\/\/.*$/, "");
    return /(:\s*any\b)|(\bas\s+any\b)|(<any>)|(\bany\[\])/.test(code);
  },
);

// ── 2. No console.* in src (the Fastify logger is the log) ───────────────────
scan(
  "no-console",
  "Use the Fastify logger (app.log / request.log), not console.",
  line => /\bconsole\.(log|info|warn|error|debug)\s*\(/.test(line.replace(/\/\/.*$/, "")),
  file => !file.endsWith("env.ts"), // env fails before a logger exists
);

// ── 3. One error envelope ────────────────────────────────────────────────────
scan(
  "error-envelope",
  "Send errors through src/lib/errors.ts, never inline.",
  line => /reply\s*\.\s*status\s*\(\s*[45]\d\d\s*\)/.test(line),
  file => !file.endsWith("errors.ts"),
);

// ── 4. JWT verification lives in one place ───────────────────────────────────
scan(
  "jwt-centralised",
  "Verify tokens only in the auth middleware / token helpers.",
  line => /\bjwt\.verify\s*\(|\bjsonwebtoken\b/.test(line),
  file => !/lib[/\\](auth|tokens)\.ts$/.test(file),
);

// ── 5. Every zod string is bounded ───────────────────────────────────────────
scan(
  "zod-max",
  "Every z.string() needs a .max() — unbounded input is a denial-of-service.",
  line => {
    const code = line.replace(/\/\/.*$/, "");
    if (!/z\s*\.\s*string\s*\(\s*\)/.test(code)) return false;
    return !/\.max\s*\(/.test(code);
  },
);

// ── 6. Floating promises are silent failures ─────────────────────────────────
scan(
  "no-empty-catch",
  "An empty catch swallows the failure. Log it or handle it.",
  line => /\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(line),
);

// ── 7. Schema: optional means nullable, not empty string ─────────────────────
const schemaPath = join(API_ROOT, "prisma", "schema.prisma");
const schemaText = readFileSync(schemaPath, "utf8");

schemaText.split("\n").forEach((line, i) => {
  if (line.includes("rules-ignore: schema-nullable")) return;
  if (line.trim().startsWith("//")) return; // a comment about the rule is not a breach of it
  if (/@default\s*\(\s*""\s*\)/.test(line)) {
    report(
      "schema-nullable", schemaPath, i, line,
      'Optional strings are `String?`, never `String @default("")`. ' +
      "The TMS shift models got this wrong and every read now needs a truthiness check.",
    );
  }
});

// ── 8. Tenant data carries companyId ─────────────────────────────────────────
/** Models that legitimately have no companyId. Add deliberately, with a reason. */
const GLOBAL_MODELS = new Set([
  "User",     // global person identity — a driver spans companies (D12)
  "Company",  // is the tenant
]);

for (const match of schemaText.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
  const name = match[1] ?? "";
  const body = match[2] ?? "";
  if (GLOBAL_MODELS.has(name)) continue;
  if (!/^\s*companyId\s+/m.test(body)) {
    const line = schemaText.slice(0, match.index ?? 0).split("\n").length;
    report(
      "tenant-scoped", schemaPath, line - 1, `model ${name}`,
      "Every tenant-owned model needs companyId so reads and writes can be scoped. " +
      "Add it, or allowlist the model in GLOBAL_MODELS with a reason.",
    );
  }
}

// ── 9. Tenant identity never comes from the client ───────────────────────────
// AUTH.md: a companyId/membershipId/userId in a request body, query or params is
// never authority. The value comes from the verified token via AuthContext.
scan(
  "no-client-tenant",
  "Tenant identity must come from AuthContext, never from the request. See AUTH.md.",
  line => {
    const code = line.replace(/\/\/.*$/, "");
    return /\b(req|request)\s*\.\s*(body|query|params)\b[^;]*\b(companyId|membershipId|userId)\b/.test(code)
        || /\b(body|query|params)\s*\.\s*(companyId|membershipId|userId)\b/.test(code);
  },
  file => /[/\\]routes[/\\]/.test(file) && !file.endsWith(".test.ts"),
);

// ── 10. Route files must actually be registered ──────────────────────────────
const routesDir = join(SRC, "routes");
let routeFiles: string[] = [];
try {
  routeFiles = readdirSync(routesDir).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"));
} catch {
  routeFiles = []; // no routes yet
}

if (routeFiles.length > 0) {
  const appText = readFileSync(join(SRC, "app.ts"), "utf8");
  for (const file of routeFiles) {
    const base = file.replace(/\.ts$/, "");
    if (!appText.includes(`routes/${base}`)) {
      report(
        "route-registered", join(routesDir, file), 0, base,
        "Written but never registered in app.ts. Register it, or delete the file.",
      );
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
if (violations.length === 0) {
  console.log("✓ check-rules: clean");
  process.exit(0);
}

const byRule = new Map<string, Violation[]>();
for (const v of violations) {
  const list = byRule.get(v.id) ?? [];
  list.push(v);
  byRule.set(v.id, list);
}

console.error(`\n✗ check-rules: ${violations.length} violation(s)\n`);
for (const [id, list] of byRule) {
  console.error(`  [${id}] ${list[0]?.why ?? ""}`);
  for (const v of list) console.error(`      ${v.file}:${v.line}  ${v.text.slice(0, 100)}`);
  console.error("");
}
console.error("Fix them, or add `// rules-ignore: <id>` on the line with a reason.\n");
process.exit(1);
