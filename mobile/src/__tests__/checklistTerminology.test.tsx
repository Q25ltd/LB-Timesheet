/**
 * Worldwide checklist wording and the registration example (D52, 2026-10-03).
 *
 *   "Number plate(s)" → "Registration plate(s)" — still the PHYSICAL plate
 *                        on the body: present, secure, readable
 *   "AdBlue level"    → "AdBlue / DEF level"
 *   the registration field's example "AB24 XYZ" (a UK-looking plate) →
 *                        the neutral instruction "Registration number"
 *
 * WORDING ONLY. Keys stay (they are what every stored answer is filed under)
 * and the checklist versions stay (a new version would orphan every draft
 * begun on the old one). The checklist itself says so: "Rewording a label is
 * safe. Changing what an item means needs a new key and a new version."
 *
 * HISTORY KEEPS ITS WORDS. A completed check stores the label of every row
 * it certified and is always shown from itself, so a check completed before
 * this change still reads "Number plate" / "AdBlue level". And a CORRECTION
 * of such a check records that check's own wording — the words the driver
 * sees on screen while correcting it — not today's (owner decision,
 * 2026-10-03). Only new checks use the new words.
 */
import { File } from "expo-file-system";
import { render } from "@testing-library/react-native";
import {
  OPEN_SHIFT_FILE,
  USAGE_STATE,
  clearOpenShift,
  readOpenShift,
  reviseVehicleCheck,
} from "../shift/localShift";
import { checklistFor, checklistItems, trailerChecklistFor } from "../shift/checklists";
import { TRAILER_TYPE } from "../shift/trailer";
import { CHECK_RESULT, effectiveItems, readChecksFor, sectionsOf, type CheckAnswer } from "../shift/vehicleCheck";
import { VehicleFields } from "../screens/vehicleForm";
import { accountDirectoryOf, scopeFor } from "./testScope";

/** The signed-in driver's records — F-31: every store call names its account. */
const SCOPE = scopeFor("user_1");

const ALL_CHECKLISTS = [
  checklistFor("class1"), checklistFor("class2"), checklistFor("van"),
  trailerChecklistFor(TRAILER_TYPE.standard), trailerChecklistFor(TRAILER_TYPE.refrigerated),
];

/** What a NEW check shows the driver, row by row (the layout the screen renders). */
function shownLabels(checklist: ReturnType<typeof checklistFor>): Map<string, string> {
  return new Map(sectionsOf(checklist, null).flatMap(section => section.rows).map(row => [row.key, row.label]));
}

describe("the registration example", () => {
  test("is the neutral instruction 'Registration number', not a UK-looking plate", async () => {
    const noop = (): void => undefined;
    const view = await render(
      <VehicleFields vehicleClass={null} onVehicleClass={noop} numberPlate="" onNumberPlate={noop} mileage="" onMileage={noop} />,
    );
    expect(view.queryByPlaceholderText("AB24 XYZ")).toBeNull();
    expect(view.getByPlaceholderText("Registration number")).toBeTruthy();
  });
});

describe("what a new check shows", () => {
  test.each([
    ["Articulated truck", checklistFor("class1"), "Registration plate"],
    ["Rigid truck",       checklistFor("class2"), "Registration plate"],
    ["Van",               checklistFor("van"),    "Registration plates"],
    ["standard trailer",  trailerChecklistFor(TRAILER_TYPE.standard), "Registration plate"],
  ] as const)("%s: the plate row is the registration plate — same key, same body section", (_what, checklist, label) => {
    expect(shownLabels(checklist).get("number-plate")).toBe(label);
    const section = sectionsOf(checklist, null).find(entry => entry.rows.some(row => row.key === "number-plate"));
    expect(section?.id).toBe("body");
  });

  test.each([
    ["Articulated truck", checklistFor("class1")],
    ["Rigid truck",       checklistFor("class2")],
    ["Van",               checklistFor("van")],
  ] as const)("%s: the fluid row says 'AdBlue / DEF level' — same key", (_what, checklist) => {
    expect(shownLabels(checklist).get("adblue")).toBe("AdBlue / DEF level");
  });

  test("no checklist anywhere still shows 'number plate' or a bare 'AdBlue level'", () => {
    for (const checklist of ALL_CHECKLISTS) {
      for (const label of shownLabels(checklist).values()) {
        expect(label).not.toMatch(/number plate/i);
        expect(label).not.toMatch(/^AdBlue level$/);
      }
    }
  });

  test("only WORDING changed: every key, default, order and version is as before", () => {
    // The versions a draft is read against (a change would orphan drafts).
    expect(ALL_CHECKLISTS.map(checklist => checklist.version)).toEqual([1, 1, 1, 1, 1]);
    // The two reworded rows keep their keys and defaults.
    expect(checklistItems(checklistFor("class1")).find(entry => entry.key === "number-plate")?.defaultResult).toBe("pass");
    expect(checklistItems(checklistFor("class1")).find(entry => entry.key === "adblue")?.defaultResult).toBe("pass");
    expect(checklistItems(checklistFor("van")).find(entry => entry.key === "adblue")?.defaultResult).toBe("na");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// History keeps the words it was written with
// ═══════════════════════════════════════════════════════════════════════════

const STARTED_AT = new Date(2026, 8, 13, 5, 42);
const CHECK_DONE = new Date(2026, 8, 13, 6, 2);
const SHIFT_ID = "11111111-2222-4333-8444-555555555555";
const OLD_WORDS: Record<string, string> = { "number-plate": "Number plate", adblue: "AdBlue level" };

/**
 * A unit check completed BEFORE the rewording: every row as it was certified
 * then — today's rows, with the old words on the two reworded ones.
 */
function completedBeforeTheChange() {
  return {
    id: "old-check", checklist: "hgv-unit", checklistVersion: 1,
    startedAt: STARTED_AT.toISOString(), status: "completed",
    completedAt: CHECK_DONE.toISOString(), completedBy: "user_1",
    items: checklistFor("class1").sections.flatMap(section => section.items.map(entry => ({
      key: entry.key, label: OLD_WORDS[entry.key] ?? entry.label,
      section: { id: section.id, title: section.title }, result: "pass", note: null,
    }))),
  };
}

function storeOpenDayWith(check: unknown): void {
  const file = new File(accountDirectoryOf(SCOPE), OPEN_SHIFT_FILE);
  file.create({ overwrite: true });
  file.write(JSON.stringify({
    ownerUserId: SCOPE.userId, id: SHIFT_ID, workingFor: { kind: "personal" }, startedAt: STARTED_AT.toISOString(),
    vehicle: {
      vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000,
      startedAt: STARTED_AT.toISOString(), checks: [check],
    },
    status: "open", createdAt: STARTED_AT.toISOString(),
  }));
}

function answers(overrides: Record<string, CheckAnswer> = {}): CheckAnswer[] {
  return checklistItems(checklistFor("class1")).map(entry => overrides[entry.key] ?? { key: entry.key, result: "pass", note: "" });
}

beforeEach(async () => { await clearOpenShift(SCOPE); });

describe("a check completed before the change", () => {
  test("still loads, under the same keys, and still reads in its OWN words", () => {
    const [check] = readChecksFor([completedBeforeTheChange()], checklistFor("class1"));
    expect(check?.id).toBe("old-check");
    const rows = new Map(sectionsOf(checklistFor("class1"), check ?? null).flatMap(section => section.rows).map(row => [row.key, row.label]));
    expect(rows.get("number-plate")).toBe("Number plate");
    expect(rows.get("adblue")).toBe("AdBlue level");
  });

  test("a CORRECTION of it records the words that check shows — not today's", async () => {
    storeOpenDayWith(completedBeforeTheChange());
    const open = await readOpenShift(SCOPE);
    const useId = open?.vehicle?.useId ?? "";

    const revised = await reviseVehicleCheck(SCOPE, {
      shiftId: SHIFT_ID, useId, usageState: USAGE_STATE.inUse, checkId: "old-check", revisionId: "rev-1",
      answers: answers({ "number-plate": { key: "number-plate", result: CHECK_RESULT.defect, note: "Rear plate cracked" } }),
      revisedAt: new Date(2026, 8, 13, 7, 0), revisedBy: "user_1",
    });

    expect(revised?.revisions).toHaveLength(1);
    const corrected = new Map(effectiveItems(revised ?? completedBeforeTheChange() as never).map(item => [item.key, item]));
    expect(corrected.get("number-plate")?.label).toBe("Number plate");
    expect(corrected.get("number-plate")?.result).toBe(CHECK_RESULT.defect);
    expect(corrected.get("adblue")?.label).toBe("AdBlue level");
    // The original certificate is untouched.
    expect(revised?.items.find(item => item.key === "number-plate")).toMatchObject({ label: "Number plate", result: "pass" });
  });

  test("saving a correction that changes NO answer adds no correction — wording alone is not a change", async () => {
    storeOpenDayWith(completedBeforeTheChange());
    const open = await readOpenShift(SCOPE);

    const revised = await reviseVehicleCheck(SCOPE, {
      shiftId: SHIFT_ID, useId: open?.vehicle?.useId ?? "", usageState: USAGE_STATE.inUse, checkId: "old-check", revisionId: "rev-1",
      answers: answers(), revisedAt: new Date(2026, 8, 13, 7, 0), revisedBy: "user_1",
    });

    expect(revised?.revisions ?? []).toHaveLength(0);
  });
});
