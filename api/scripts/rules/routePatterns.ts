import { stripComments } from "./tenantPatterns.js";

/**
 * Finds Fastify route registrations that don't declare an explicit
 * `public: true|false` (F-04's `route-declares-auth`).
 *
 * This is a guardrail, not the security boundary -- the boundary is the
 * default-deny `onRequest` hook in app.ts, which protects a route whether or
 * not this rule ever sees it. This rule only forces the posture to be
 * written down, so a reviewer (and the next engineer) sees it without having
 * to know the hook's default by heart.
 *
 * Paren-matching rather than a single-line regex, because a route's options
 * object routinely spans multiple lines:
 *
 *   app.post("/timesheets", {
 *     config: { public: false },
 *     schema: { ... },
 *   }, handler);
 *
 * Honest limitation: this checks for a literal `public: true|false` anywhere
 * within the matched call's parentheses, not specifically nested under
 * `config`. That is a deliberately loose, cheap check -- a call that somehow
 * contains an unrelated `public:` key would not be caught. The runtime hook
 * does not have this gap: it reads `request.routeOptions.config.public`
 * precisely, so a stray unrelated key elsewhere changes nothing about who
 * actually gets through.
 */
const ROUTE_CALL = /\b[A-Za-z_$][\w$]*\s*\.\s*(?:get|post|put|patch|delete|route)\s*\(/g;
const PUBLIC_KEY = /\bpublic\s*:\s*(?:true|false)\b/;

export interface RouteRegistrationHit { line: number; text: string }

export function findUndeclaredRouteRegistrations(source: string): RouteRegistrationHit[] {
  const code = source.split("\n").map(stripComments).join("\n");
  const hits: RouteRegistrationHit[] = [];

  for (const match of code.matchAll(ROUTE_CALL)) {
    const start = match.index;
    const openParen = start + match[0].length - 1;

    let depth = 1;
    let end = openParen + 1;
    while (end < code.length && depth > 0) {
      if (code[end] === "(") depth += 1;
      else if (code[end] === ")") depth -= 1;
      end += 1;
    }
    if (depth !== 0) continue; // unbalanced -- not a call we can span safely

    const span = code.slice(start, end);
    if (PUBLIC_KEY.test(span)) continue;

    hits.push({
      line: code.slice(0, start).split("\n").length,
      text: span.replace(/\s+/g, " ").trim(),
    });
  }
  return hits;
}
