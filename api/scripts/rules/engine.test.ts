/**
 * Fixture tests for the REAL rule engine (F-08).
 *
 * The predicate unit tests prove the regexes; these prove the WIRING — that
 * every rule is actually connected to the scanner, applied to the right
 * directories, and silent on legitimate code. Deleting or un-wiring any rule
 * in engine.ts changes the expected set below and turns this file red, which
 * is precisely the regression the earlier reviews showed was undetectable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runRules } from "./engine.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

function report(tree: "bad" | "good"): string[] {
  return runRules(resolve(FIXTURES, tree))
    .map(violation => `${violation.id}  ${violation.file.replaceAll("\\", "/")}:${String(violation.line)}`)
    .sort();
}

/** The complete, exact output on the known-bad tree. Update DELIBERATELY. */
const EXPECTED_BAD = [
  "error-envelope  src/routes/leaky.ts:6",
  "error-envelope  src/routes/leaky.ts:16",
  "jwt-centralised  src/routes/leaky.ts:8",
  "no-any  src/routes/leaky.ts:3",
  "no-client-tenant  src/routes/leaky.ts:11",
  "no-client-tenant  src/routes/leaky.ts:13",
  "no-client-tenant  src/routes/leaky.ts:4",
  "no-client-tenant  src/services/svc.ts:2",
  // Two locations on purpose: a route-local DTO, and one defined in a shared
  // module a route would import. The second is what proves the rule was NOT
  // narrowed to routes/ + services/ when its false positive was corrected.
  "no-company-id-in-dto  src/routes/leaky.ts:2",
  "no-company-id-in-dto  src/lib/dto.ts:6",
  "no-console  src/routes/leaky.ts:5",
  "no-empty-catch  src/routes/leaky.ts:10",
  "no-prisma-in-routes  src/routes/leaky.ts:1",
  "no-raw-request-past-route  src/routes/leaky.ts:7",
  "no-request-in-services  src/services/svc.ts:1",
  "no-request-in-services  src/services/svc.ts:2",
  "route-declares-auth  src/routes/leaky.ts:17",
  "route-registered  src/routes/leaky.ts:1",
  "schema-nullable  prisma/schema.prisma:3",
  "tenant-context-trust-sites  src/services/svc.ts:4",
  "tenant-models-via-repository  src/routes/leaky.ts:9",
  "tenant-models-via-repository  src/services/svc.ts:5",
  "tenant-scoped  prisma/schema.prisma:1",
  "zod-max  src/routes/leaky.ts:2",
].sort();

test("the bad fixture tree produces exactly the expected violations", () => {
  assert.deepEqual(report("bad"), EXPECTED_BAD);
});

test("every rule in the engine fires at least once on the bad tree", () => {
  const firedIds = new Set(EXPECTED_BAD.map(entry => entry.split("  ")[0]));
  // The complete rule roster. A new rule must be added HERE and to the bad
  // fixture in the same change — that is the point.
  const ROSTER = [
    "no-any", "no-console", "error-envelope", "jwt-centralised", "zod-max",
    "no-empty-catch", "schema-nullable", "tenant-scoped", "no-client-tenant",
    "no-company-id-in-dto", "no-raw-request-past-route", "no-request-in-services",
    "tenant-models-via-repository", "tenant-context-trust-sites",
    "no-prisma-in-routes", "route-registered", "route-declares-auth",
  ];
  for (const id of ROSTER) {
    assert.ok(firedIds.has(id), `rule "${id}" never fires on the bad fixture — unwired or fixture gap`);
  }
  assert.equal(firedIds.size, ROSTER.length, "unknown rule id in the expected set");
});

test("the good fixture tree — realistic legitimate code — is completely clean", () => {
  assert.deepEqual(report("good"), []);
});
