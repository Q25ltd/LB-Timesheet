/**
 * Detects `companyId` being read out of client-supplied request input.
 *
 * Scope: ONLY `companyId`. `membershipId` and `userId` legitimately arrive in a
 * body — `POST /auth/switch-company` takes a `membershipId` by design (AUTH.md).
 * Those must be validated against the authenticated user server-side; that
 * guarantee rests on the contract tests, not on pattern matching.
 *
 * History: an earlier version used a single "companyId and a request source on
 * the same line" catch-all. It blocked ordinary correct code — including
 * `svc.list(auth.companyId, req.query.status)` and the switch-company handler
 * itself — and its tests could not distinguish the specific patterns because the
 * catch-all matched everything. Each mechanism below is now independent and
 * independently tested.
 */

/** `body`, `query` or `params`, optionally reached through any receiver name. */
const INPUT_PROPERTY = String.raw`(?:[A-Za-z_$][\w$]*\s*\??\.\s*)?(?:body|query|params)`;

/**
 * Member access: `req.body.companyId`, `r.query.companyId`, `body.companyId`,
 * `req.body["companyId"]`, `request.params['companyId']`.
 *
 * The receiver name is deliberately unconstrained — a Fastify handler parameter
 * is often named something other than `req`, and the shape `.body.companyId` is
 * the signal regardless of what it hangs off.
 */
export const MEMBER_ACCESS = new RegExp(
  String.raw`\b${INPUT_PROPERTY}\s*(?:\??\.\s*companyId\b|\[\s*["'\`]companyId["'\`]\s*\])`,
);

/** Right-hand side of a destructuring assignment that reads request input. */
const DESTRUCTURE_SOURCE = new RegExp(String.raw`^\s*=\s*(?:await\s+)?${INPUT_PROPERTY}\b`);

/** Strip `//` comments, but not a `//` that is part of a URL or inside quotes. */
export function stripComments(line: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? "";
    const next = line[i + 1] ?? "";
    if (quote) {
      out += ch;
      if (ch === "\\") { out += next; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; out += ch; continue; }
    if (ch === "/" && next === "/") break;              // line comment
    if (ch === "/" && next === "*") {                    // block comment
      const end = line.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** True when this line reads companyId from request input by member access. */
export function readsCompanyIdByMemberAccess(line: string): boolean {
  return MEMBER_ACCESS.test(stripComments(line));
}

interface DestructureHit { line: number; text: string; multiline: boolean }

/**
 * Finds `const { … companyId … } = <request input>` anywhere in a file,
 * including multi-line and NESTED destructuring such as:
 *
 *   const {
 *     filters: { companyId },
 *   } = req.body;
 *
 * Brace matching rather than a regex, because a regex cannot balance braces —
 * the previous `[^{}]*` version silently missed every nested case.
 */
export function findRequestDestructures(source: string): DestructureHit[] {
  const code = stripBlockAndLineComments(source);
  const hits: DestructureHit[] = [];

  for (let i = 0; i < code.length; i += 1) {
    if (code[i] !== "}") continue;

    // Does an assignment from request input follow this closing brace?
    if (!DESTRUCTURE_SOURCE.test(code.slice(i + 1, i + 80))) continue;

    // Walk back to the matching opening brace.
    let depth = 0;
    let start = -1;
    for (let j = i; j >= 0; j -= 1) {
      const ch = code[j];
      if (ch === "}") depth += 1;
      else if (ch === "{") {
        depth -= 1;
        if (depth === 0) { start = j; break; }
      }
    }
    if (start === -1) continue;

    const block = code.slice(start, i + 1);
    if (!/\bcompanyId\b/.test(block)) continue;

    hits.push({
      line: code.slice(0, start).split("\n").length,
      text: block.replace(/\s+/g, " ").trim(),
      multiline: block.includes("\n"),
    });
  }
  return hits;
}

/** Comment stripping across a whole file, quote-aware (see stripComments). */
function stripBlockAndLineComments(source: string): string {
  return source.split("\n").map(stripComments).join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Route → service trust boundary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A raw request object, or one of its client-controlled input bags, passed as a
 * whole into another function.
 *
 * The architecture is:
 *   request → route parses/validates → service(AuthContext, validated DTO) → repository
 *
 * If a route hands `req.body` straight to a service, the tenant rules stop
 * meaning anything: routes are scanned, services carry the query, and the
 * unvalidated object crosses the boundary between them.
 *
 * Parsing is the one legitimate destination — `Schema.parse(req.body)` is
 * exactly how a route is supposed to turn input into a DTO.
 */
// Deliberately requires a receiver (`req.body`, `r.query`) or a bare request
// object — a bare identifier like `body` is NOT matched, because legitimate
// code passes locals named body/params around constantly (reply.send(body),
// mailer.send(to, subject, body)) and a rule that fires on those gets
// disabled. Cost: `const b = req.body; svc.f(b)` escapes — the repository
// boundary and the A/B tests are what actually hold there.
const RAW_REQUEST_ARGUMENT = /^(?:await\s+)?[A-Za-z_$][\w$]*\s*\??\.\s*(?:body|query|params)$|^(?:req|request|_req|_request)$/;
const PARSE_CALLEES = /\.(?:safeParseAsync|parseAsync|safeParse|parse)$/;

/** Returns the callee name when a line hands raw request input to a call. */
export function passesRawRequestToCall(line: string): string | null {
  const code = stripComments(line);
  for (const match of code.matchAll(/([A-Za-z_$][\w$.]*)\s*\(([^()]*)\)/g)) {
    const callee = match[1] ?? "";
    const args = match[2] ?? "";
    if (PARSE_CALLEES.test(callee)) continue;
    for (const arg of args.split(",")) {
      if (RAW_REQUEST_ARGUMENT.test(arg.trim())) return callee;
    }
  }
  return null;
}

/**
 * A Zod schema declaring a `companyId` field.
 *
 * Closes the last route→service path for client-supplied tenant identity: a
 * route may legitimately do `Schema.parse(req.body)` and pass the resulting DTO
 * to a service, so if the schema itself accepts `companyId`, client data reaches
 * the service through an otherwise-compliant route.
 *
 * `membershipId` and `userId` are deliberately NOT banned here — switch-company
 * needs a membershipId in the body.
 */
export function declaresCompanyIdInSchema(line: string): boolean {
  return /\bcompanyId\s*:\s*z\s*\./.test(stripComments(line));
}
