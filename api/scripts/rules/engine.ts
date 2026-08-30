import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";


import {
  readsCompanyIdByMemberAccess,
  findRequestDestructures,
  passesRawRequestToCall,
  declaresCompanyIdInSchema,
} from "./tenantPatterns.js";


export interface Violation { id: string; file: string; line: number; text: string; why: string }

/**
 * Run every rule against an api-root-shaped directory (src/ + prisma/schema.prisma)
 * and return the violations. Pure with respect to the process: no printing, no
 * exit codes — the CLI wrapper owns those. Parameterised root so the fixture
 * tests can point it at known-good and known-bad trees.
 */
export function runRules(apiRoot: string): Violation[] {
  const API_ROOT = apiRoot;
  const SRC      = join(API_ROOT, "src");
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
  // AUTH.md: a Session is one authenticated device and SURVIVES company
  // switching, so it belongs to the User, not to a Company. Listed here before
  // the model exists, because otherwise this rule would flag it and the fastest
  // way to a green build would be to add companyId — silently breaking the
  // frozen contract. Do not "fix" Session by giving it a companyId.
  "Session",
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

// ── companyId never comes from the client ────────────────────────────────────
// AUTH.md: tenant authority comes from the verified token via AuthContext.
// ONLY companyId is banned — membershipId and userId legitimately arrive in a
// body (POST /auth/switch-company takes a membershipId by design). Those are
// validated against the authenticated user server-side, which tests enforce.
//
// Predicates live in ./rules/tenantPatterns.ts and each is independently tested.
// Applied to routes AND services: routes should never receive raw input past the
// boundary (see the next rule), but defence in depth costs nothing here.
const TENANT_SCANNED = (file: string) =>
  /[/\\](?:routes|services|repositories)[/\\]/.test(file) && !file.endsWith(".test.ts");

scan(
  "no-client-tenant",
  "companyId must come from AuthContext, never from request input. See AUTH.md.",
  line => readsCompanyIdByMemberAccess(line),
  TENANT_SCANNED,
);

// Destructuring needs whole-file brace matching — nested and multi-line forms
// are invisible to a per-line scan.
for (const file of files) {
  if (!TENANT_SCANNED(file)) continue;
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");
  for (const hit of findRequestDestructures(source)) {
    const raw = lines[hit.line - 1] ?? hit.text;
    if (raw.includes("rules-ignore: no-client-tenant")) continue;
    report(
      "no-client-tenant", file, hit.line - 1, hit.text,
      "companyId must come from AuthContext, never from request input. See AUTH.md.",
    );
  }
}

// ── No Zod DTO accepts companyId ─────────────────────────────────────────────
// A route may parse a body into a DTO and hand the DTO to a service. If the
// schema accepts companyId, client tenant identity crosses the boundary through
// an otherwise-compliant route. membershipId/userId stay legal (switch-company).
scan(
  "no-company-id-in-dto",
  "A request schema must not accept companyId — it comes from AuthContext. See AUTH.md.",
  line => declaresCompanyIdInSchema(line),
  file => !file.endsWith(".test.ts"),
);

// ── Raw request input never crosses into a service ───────────────────────────
// request -> route parses/validates -> service(AuthContext, DTO) -> repository.
// Handing `req.body` to a service defeats every rule above: routes are scanned,
// services hold the query, and the unvalidated object crosses between them.
// `Schema.parse(req.body)` is exempt — that is how a DTO is produced.
scan(
  "no-raw-request-past-route",
  "Parse request input into a DTO first; services take (AuthContext, DTO). See AUTH.md.",
  line => passesRawRequestToCall(line) !== null,
  file => /[/\\]routes[/\\]/.test(file) && !file.endsWith(".test.ts"),
);

// ── Services never touch request input ───────────────────────────────────────
// A service that reads .body/.query/.params has been handed a request object,
// which the boundary rule above forbids. Belt and braces on the same boundary.
scan(
  "no-request-in-services",
  "Services receive (AuthContext, validated DTO) — never a request object.",
  line => /\b(?:req|request)\b\s*\.\s*(?:body|query|params)\b|\breq(?:uest)?\s*[,)]/.test(
    line.replace(/\/\/.*$/, ""),
  ),
  file => /[/\\]services[/\\]/.test(file) && !file.endsWith(".test.ts"),
);

// ── Routes never touch Prisma directly ───────────────────────────────────────
// A route that can reach the database can also forget to scope the query.
// Routes call a service; the service takes AuthContext and owns the where clause.
// ── Tenant models are reached through the repository, nowhere else ───────────
// prisma.shift / prisma.shiftSegment / prisma.shiftSubmitJob outside
// src/repositories is an ID-only-query waiting to happen: the repository is
// where selectors get their companyId from TenantContext. Global models
// (user, company, companyMembership), $queryRaw, tests, seeds and the
// generated client itself stay unrestricted. Guardrail, not proof — the proof
// is src/tests/db/repositoryTenantBoundary.test.ts.
scan(
  "tenant-models-via-repository",
  "Shift/ShiftSegment/ShiftSubmitJob queries live in src/repositories — use shiftRepository with a TenantContext.",
  line => /\bprisma\s*\.\s*(?:shift|shiftSegment|shiftSubmitJob)\s*\./.test(line.replace(/\/\/.*$/, "")),
  file => !/[/\\](?:repositories|tests|generated)[/\\]/.test(file) && !file.endsWith(".test.ts"),
);

// ── TenantContext.trust is a liability, not a convenience ────────────────────
// The one constructor for trusted tenant identity. Legitimate call sites:
// the auth middleware (src/lib/auth*, src/plugins/*), tests and seeds. A
// route or service calling trust() is laundering client input into authority.
scan(
  "tenant-context-trust-sites",
  "TenantContext.trust() may only be called from auth middleware, tests or seeds. See tenantContext.ts.",
  line => /\bTenantContext\s*\.\s*trust\s*\(/.test(line.replace(/\/\/.*$/, "")),
  file => !/[/\\](?:tests|plugins)[/\\]|lib[/\\]auth|lib[/\\]tenantContext\.ts$|scripts[/\\]seed/.test(file)
       && !file.endsWith(".test.ts"),
);

scan(
  "no-prisma-in-routes",
  "Routes must not import Prisma. Go through a service that takes AuthContext. See AUTH.md.",
  line => {
    const code = line.replace(/\/\/.*$/, "");
    return /from\s+["'][^"']*generated\/client/.test(code)
        || /from\s+["']@prisma\/client["']/.test(code)
        || /\bnew\s+PrismaClient\b/.test(code);
  },
  file => /[/\\]routes[/\\]/.test(file) && !file.endsWith(".test.ts"),
);

// ── 9. Route files must actually be registered ───────────────────────────────
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

  return violations;
}
