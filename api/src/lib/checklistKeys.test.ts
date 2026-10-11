/**
 * The API's copy of the checklist keys (D66) is the PHONE's — every id,
 * version and key, in order. A new checklist version on the phone fails this
 * until the copy gains it too, so a check made against it is never refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKLIST_FOR_TRAILER, CHECKLIST_FOR_VEHICLE, checklistKeys } from "./checklistKeys.js";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function phoneChecklists(): { id: string; version: number; keys: string[] }[] {
  const output = execFileSync(resolve(API_ROOT, "node_modules/.bin/tsx"), [resolve(API_ROOT, "scripts/phoneChecklistKeys.ts")], { encoding: "utf8" });
  return output.trim().split("\n").map(line => JSON.parse(line) as { id: string; version: number; keys: string[] });
}

test("the API's checklist keys are exactly the phone's", () => {
  const phone = phoneChecklists();
  assert.equal(phone.length, 5);
  for (const list of phone) {
    assert.deepEqual(checklistKeys(list.id, list.version), list.keys, `${list.id} v${String(list.version)}`);
  }
});

test("each vehicle class and trailer type is checked against the checklist the phone uses", () => {
  assert.deepEqual(CHECKLIST_FOR_VEHICLE, { class1: "hgv-unit", class2: "hgv-rigid", van: "van" });
  assert.deepEqual(CHECKLIST_FOR_TRAILER, { standard: "trailer-standard", refrigerated: "trailer-refrigerated" });
  assert.equal(checklistKeys("hgv-unit", 2), null, "a version the phone never had is not one");
});
