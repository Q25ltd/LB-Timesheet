/**
 * Security review R1 (2026-10-17) — a CERTIFIED walkaround must be a whole
 * certificate: every row of its checklist version, each defect described; so
 * must every correction of it. A draft stays a draft: partial, and a defect
 * may still await its description. The history is kept whole.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { checklistKeys } from "./checklistKeys.js";
import { snapshotProblems, TimesheetSnapshotV1, type TimesheetSnapshot } from "./timesheetSnapshot.js";

const USER = "user_1";
const START = "2026-10-11T04:00:00.000Z";
const END = "2026-10-11T14:00:00.000Z";
const KEYS = checklistKeys("hgv-unit", 1) ?? [];

type Item = { key: string; label: string; section: null; result: "pass" | "na" | "fail"; note: string | null };

/** Every row of hgv-unit v1, passed — with `over` per key. */
function allRows(over: Record<string, Partial<Item>> = {}): Item[] {
  return KEYS.map(key => ({ key, label: key, section: null, result: "pass" as const, note: null, ...over[key] }));
}

function check(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "c1", checklist: "hgv-unit", checklistVersion: 1, status: "completed",
    startedAt: START, completedAt: "2026-10-11T04:10:00.000Z", completedBy: USER,
    items: allRows(), revisions: [], ...over,
  };
}

function problemsWith(checkValue: Record<string, unknown>): string[] {
  const snapshot: TimesheetSnapshot = TimesheetSnapshotV1.parse({
    schemaVersion: 1,
    day: { startedAt: START, endedAt: END, nightOut: false, notes: null },
    vehicles: [{
      useId: "u1", startedAt: START, endedAt: END, endedBy: "finish", vehicleClass: "class1", registration: "LY12 ABC",
      odometerStart: 1, odometerEnd: 2, odometerUnit: "kilometre", fills: [], checks: [checkValue],
    }],
    trailers: [],
    declaration: { version: "v1", declaredAt: END },
  });
  return snapshotProblems(snapshot, USER);
}

const FIRST = KEYS[0] ?? "";
const SECOND = KEYS[1] ?? "";

test("SN0. the checklist under test is real and has several rows", () => {
  assert.ok(KEYS.length > 5);
});

test("SN1. a VALID completed check — every row, each defect described — holds", () => {
  assert.deepEqual(problemsWith(check({ items: allRows({ [FIRST]: { result: "fail", note: "Cracked lens" } }) })), []);
});

test("SN2. an INCOMPLETE certificate is refused: a missing row, or no rows past the first", () => {
  assert.ok(problemsWith(check({ items: allRows().slice(1) })).some(problem => problem.includes("every item")));
  assert.ok(problemsWith(check({ items: allRows().slice(0, 1) })).some(problem => problem.includes("every item")));
});

test("SN3. a certified DEFECT must be described: none, or nothing visible, is refused", () => {
  assert.ok(problemsWith(check({ items: allRows({ [FIRST]: { result: "fail", note: null } }) })).some(problem => problem.includes("without a description")));
  assert.ok(problemsWith(check({ items: allRows({ [FIRST]: { result: "fail", note: "​" } }) })).some(problem => problem.includes("without a description")));
});

test("SN4. a CORRECTION is a whole certificate too: every row, each defect described", () => {
  const revision = (items: Item[]) => ({ id: "r1", revisedAt: "2026-10-11T05:00:00.000Z", revisedBy: USER, items });
  assert.deepEqual(problemsWith(check({ revisions: [revision(allRows({ [SECOND]: { result: "fail", note: "Split" } }))] })), []);
  assert.ok(problemsWith(check({ revisions: [revision(allRows().slice(2))] })).some(problem => problem.includes("every item")));
  assert.ok(problemsWith(check({ revisions: [revision(allRows({ [SECOND]: { result: "fail", note: null } }))] })).some(problem => problem.includes("without a description")));
});

test("SN5. a correction that drops a row cannot silently erase its DEFECT", () => {
  const original = allRows({ [FIRST]: { result: "fail", note: "Cracked lens" } });
  const withoutTheDefect = allRows().filter(item => item.key !== FIRST);
  const problems = problemsWith(check({ items: original, revisions: [{ id: "r1", revisedAt: "2026-10-11T05:00:00.000Z", revisedBy: USER, items: withoutTheDefect }] }));
  assert.ok(problems.length > 0);
});

test("SN6. a DRAFT stays a draft: partial rows, and a defect still awaiting its description, are kept as they are", () => {
  const draft = check({ status: "draft", completedAt: null, completedBy: null, items: allRows({ [FIRST]: { result: "fail", note: null } }).slice(0, 3) });
  assert.deepEqual(problemsWith(draft), []);
  assert.deepEqual(problemsWith(check({ status: "draft", completedAt: null, completedBy: null, items: [] })), []);
});

test("SN7. a row this checklist version does not have is still refused, certified or not", () => {
  assert.ok(problemsWith(check({ items: [...allRows(), { key: "made-up", label: "x", section: null, result: "pass", note: null }] })).length > 0);
  assert.ok(problemsWith(check({ status: "draft", completedAt: null, completedBy: null, items: [{ key: "made-up", label: "x", section: null, result: "pass", note: null }] })).length > 0);
});
