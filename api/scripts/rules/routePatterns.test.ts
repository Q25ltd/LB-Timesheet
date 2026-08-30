import { test } from "node:test";
import assert from "node:assert/strict";
import { findUndeclaredRouteRegistrations } from "./routePatterns.js";

test("flags a route registered with no options object at all", () => {
  const hits = findUndeclaredRouteRegistrations('app.get("/leaky", handler);');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.line, 1);
});

test("flags a route whose options object omits public entirely", () => {
  const source = 'app.post("/timesheets", { schema: { body: {} } }, handler);';
  assert.equal(findUndeclaredRouteRegistrations(source).length, 1);
});

test("does not flag a route explicitly marked public: true", () => {
  const source = 'app.get("/health", { config: { public: true } }, handler);';
  assert.equal(findUndeclaredRouteRegistrations(source).length, 0);
});

test("does not flag a route explicitly marked public: false", () => {
  const source = 'app.post("/timesheets", { config: { public: false } }, handler);';
  assert.equal(findUndeclaredRouteRegistrations(source).length, 0);
});

test("handles a multi-line options object", () => {
  const source = [
    'app.post("/timesheets", {',
    "  config: { public: false },",
    "  schema: { body: {} },",
    "}, handler);",
  ].join("\n");
  assert.equal(findUndeclaredRouteRegistrations(source).length, 0);
});

test("reports the line the call starts on, not where public would be", () => {
  const source = [
    "// a comment above",
    'app.get("/thing", {',
    "  schema: {},",
    "}, handler);",
  ].join("\n");
  const hits = findUndeclaredRouteRegistrations(source);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.line, 2);
});

test("ignores an unrelated .get( call with no route-shaped receiver", () => {
  // Same regex shape by construction -- the file-scoping in engine.ts (only
  // app.ts and routes/) is what keeps this rule meaningful, not this
  // predicate distinguishing a Map from a Fastify instance.
  const hits = findUndeclaredRouteRegistrations("const v = cache.get(key);");
  assert.equal(hits.length, 1, "documents the known false-positive shape -- see file-scoping in engine.ts");
});

test("a comment mentioning public: true does not suppress a real violation", () => {
  const source = [
    "// public: true was the old behavior, now removed",
    'app.get("/thing", handler);',
  ].join("\n");
  const hits = findUndeclaredRouteRegistrations(source);
  assert.equal(hits.length, 1);
});
