/**
 * Vehicle checks as the phone stores them.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT MUST HOLD
 * ════════════════════════════════════════════════════════════════════════════
 *
 * A check is a record a driver may be asked for at the roadside, so the store
 * is strict in both directions. It writes only what was answered — never a
 * default, never an OK nobody gave — and it reads back only what it can read
 * as a check: a result it does not recognise is not an OK, and a "completed"
 * check with a gap in it is not completed.
 *
 * A check belongs to one USE of one vehicle in one day. It is stored inside
 * that vehicle, and a write names the day and the use it was begun on, so a
 * check can never land on a different day or a different vehicle, and a
 * registration seen again later does not inherit a check made earlier.
 */
import { File, Paths } from "expo-file-system";
import {
  OPEN_SHIFT_FILE,
  addVehicleToOpenShift,
  clearOpenShift,
  completeVehicleCheck,
  readOpenShift,
  saveVehicleCheckDraft,
  startLocalShift,
  type LocalShift,
  type VehicleCheckWrite,
  type VehicleDetails,
} from "../shift/localShift";
import { checklistFor, checklistItems } from "../shift/checklists";
import { checkStateOf, resultsOf, summarise, type CheckAnswer } from "../shift/vehicleCheck";

const STARTED_AT = new Date(2026, 8, 13, 5, 42);
const CHECK_STARTED = new Date(2026, 8, 13, 5, 50);
const CHECK_DONE = new Date(2026, 8, 13, 6, 2);
const UNIT = { vehicleClass: "class1" as const, numberPlate: "AB24 XYZ", startMileage: 184_203 };
/** The authenticated driver who certifies a check. */
const DRIVER = "user_1";

const storedFile = () => new File(Paths.document, OPEN_SHIFT_FILE);

async function dayWith(vehicle: VehicleDetails = UNIT): Promise<LocalShift> {
  return startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle });
}

function write(shift: LocalShift, answers: CheckAnswer[], checkId = "check-1"): VehicleCheckWrite {
  return { shiftId: shift.id, vehicleStartedAt: shift.vehicle?.startedAt ?? "", checkId, startedAt: CHECK_STARTED, answers };
}

const ok = (key: string): CheckAnswer => ({ key, result: "pass", note: "" });
const na = (key: string): CheckAnswer => ({ key, result: "na", note: "" });
const defect = (key: string, note: string): CheckAnswer => ({ key, result: "fail", note });

/** Every item of the class answered OK. */
function allOk(vehicleClass: "class1" | "class2" | "van" = "class1"): CheckAnswer[] {
  return checklistItems(checklistFor(vehicleClass)).map(entry => ok(entry.key));
}

beforeEach(async () => { await clearOpenShift(); });

// ═══════════════════════════════════════════════════════════════════════════
// Where checks live
// ═══════════════════════════════════════════════════════════════════════════

test("a vehicle starts with NO checks — not an empty draft, not a placeholder", async () => {
  await dayWith();
  expect((await readOpenShift())?.vehicle?.checks).toEqual([]);

  await clearOpenShift();
  await startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle: null });
  await addVehicleToOpenShift({ vehicle: UNIT, startedAt: CHECK_STARTED });
  expect((await readOpenShift())?.vehicle?.checks).toEqual([]);
});

test("a day saved BEFORE checks existed loads, with no checks rather than a guessed one", async () => {
  const file = storedFile();
  file.create({ overwrite: true });
  file.write(JSON.stringify({
    id: "11111111-2222-4333-8444-555555555555", workingFor: { kind: "personal" },
    startedAt: STARTED_AT.toISOString(), vehicle: { ...UNIT, startedAt: STARTED_AT.toISOString() },
    status: "open", createdAt: STARTED_AT.toISOString(),
  }));

  const shift = await readOpenShift();
  expect(shift?.vehicle?.checks).toEqual([]);
  expect(checkStateOf(shift?.vehicle?.checks ?? [])).toBe("not-started");
});

// ═══════════════════════════════════════════════════════════════════════════
// Drafts — saved as the driver answers
// ═══════════════════════════════════════════════════════════════════════════

test("a DRAFT holds only what the driver CHANGED — the defaults are not copied into it", async () => {
  const shift = await dayWith();
  // `front-view` starts OK and `hv-cut-off` starts N/A on a unit: neither is a
  // change. Only the two real changes are stored.
  const answers = [ok("front-view"), na("hv-cut-off"), na("horn"), defect("oil-leaks", "Oil drip")];

  const check = await saveVehicleCheckDraft(write(shift, answers));

  expect(check).toEqual({
    id: "check-1", checklist: "hgv-unit", checklistVersion: 1,
    startedAt: CHECK_STARTED.toISOString(), status: "draft", completedAt: null, completedBy: null,
    items: [
      { key: "horn", label: "Horn", result: "na", note: null },
      { key: "oil-leaks", label: "Oil leaks", result: "fail", note: "Oil drip" },
    ],
  });
  expect(checkStateOf((await readOpenShift())?.vehicle?.checks ?? [])).toBe("in-progress");
});

test("a row put BACK to its default drops out of the draft again", async () => {
  const shift = await dayWith();
  await saveVehicleCheckDraft(write(shift, [na("horn")]));
  expect((await readOpenShift())?.vehicle?.checks[0]?.items).toHaveLength(1);

  const back = await saveVehicleCheckDraft(write(shift, [ok("horn")]));

  expect(back?.items).toEqual([]);
});

test("the results shown are the class defaults with the driver's changes laid over them", async () => {
  const shift = await dayWith();
  await saveVehicleCheckDraft(write(shift, [defect("oil-leaks", "Oil drip"), ok("hv-cut-off")]));

  const stored = (await readOpenShift())?.vehicle?.checks[0] ?? null;
  const results = resultsOf(checklistFor("class1"), stored);

  expect(results.size).toBe(42);
  expect(results.get("front-view")?.result).toBe("pass");        // default, untouched
  expect(results.get("other-equipment")?.result).toBe("na");     // default, untouched
  expect(results.get("hv-cut-off")?.result).toBe("pass");        // N/A changed to OK
  expect(results.get("oil-leaks")).toEqual({ key: "oil-leaks", result: "fail", note: "Oil drip" });
});

test("a defect's description is kept exactly as typed while the check is a draft", async () => {
  const shift = await dayWith();

  await saveVehicleCheckDraft(write(shift, [defect("oil-leaks", "Oil drip under ")]));

  expect((await readOpenShift())?.vehicle?.checks[0]?.items).toEqual([
    { key: "oil-leaks", label: "Oil leaks", result: "fail", note: "Oil drip under " },
  ]);
});

test("a defect with nothing typed yet is stored as a defect with NO description, not an empty one", async () => {
  const shift = await dayWith();

  await saveVehicleCheckDraft(write(shift, [defect("horn", "")]));

  expect((await readOpenShift())?.vehicle?.checks[0]?.items[0]?.note).toBeNull();
});

test("switching DEFECT back leaves no description attached — and back to the default, no row at all", async () => {
  const shift = await dayWith();
  await saveVehicleCheckDraft(write(shift, [defect("horn", "Horn silent"), defect("steering", "Play")]));

  const check = await saveVehicleCheckDraft(write(shift, [ok("horn"), na("steering")]));

  // `horn` is back at its default and disappears; `steering` is N/A, which is
  // a change from its OK default, so it stays — with no description.
  expect(check?.items).toEqual([{ key: "steering", label: "Steering", result: "na", note: null }]);
});

test("later saves keep the check's ORIGINAL start time", async () => {
  const shift = await dayWith();
  await saveVehicleCheckDraft(write(shift, [ok("horn")]));

  const later = await saveVehicleCheckDraft({ ...write(shift, [ok("horn"), ok("steering")]), startedAt: CHECK_DONE });

  expect(later?.startedAt).toBe(CHECK_STARTED.toISOString());
});

test("changed items are stored in checklist order, whatever order they were changed in", async () => {
  const shift = await dayWith();

  const check = await saveVehicleCheckDraft(write(shift, [ok("other-equipment"), na("front-view"), na("battery")]));

  expect(check?.items.map(entry => entry.key)).toEqual(["front-view", "battery", "other-equipment"]);
});

test("an item that is not on this vehicle's checklist is REFUSED, and nothing is written", async () => {
  const shift = await dayWith();

  // `tow-bar` is a van item; this is a Class 1 unit.
  await expect(saveVehicleCheckDraft(write(shift, [ok("tow-bar")]))).rejects.toThrow();
  expect((await readOpenShift())?.vehicle?.checks).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Completion
// ═══════════════════════════════════════════════════════════════════════════

test("COMPLETING writes the full record — every row, defaults included, each with its section", async () => {
  const shift = await dayWith();
  // The driver changed one row and confirmed the rest as they stood.
  const answers = [...resultsOf(checklistFor("class1"), null).values()]
    .map(answer => (answer.key === "oil-leaks" ? defect("oil-leaks", "Oil level low.") : answer));

  const check = await completeVehicleCheck({ ...write(shift, answers), completedAt: CHECK_DONE, completedBy: DRIVER });

  expect(check?.items).toHaveLength(42);
  expect(check?.items.find(entry => entry.key === "front-view")).toEqual({
    key: "front-view", label: "Front view", section: { id: "cab", title: "CAB / DRIVER VIEW" }, result: "pass", note: null,
  });
  // Left at its default, and still written out in full.
  expect(check?.items.find(entry => entry.key === "other-equipment")).toEqual({
    key: "other-equipment", label: "Other equipment", section: { id: "load", title: "LOAD / EQUIPMENT" }, result: "na", note: null,
  });
  expect(check?.items.find(entry => entry.key === "oil-leaks")?.note).toBe("Oil level low.");

  // Every row, in the order met, under the section it was met in: the record
  // alone is enough to lay the check out again.
  const expected = checklistFor("class1").sections.flatMap(section =>
    section.items.map(entry => ({ key: entry.key, label: entry.label, section: { id: section.id, title: section.title } })));
  expect(check?.items.map(({ key, label, section }) => ({ key, label, section }))).toEqual(expected);
});

test("a completed record reads back EXACTLY as it was written — sections included", async () => {
  const shift = await dayWith();
  const answers = allOk().map(answer => (answer.key === "wipers" ? defect("wipers", "Blade split.") : answer));

  const written = await completeVehicleCheck({ ...write(shift, answers), completedAt: CHECK_DONE, completedBy: DRIVER });
  const read = (await readOpenShift())?.vehicle?.checks[0];

  expect(read).toEqual(written);
  expect(read?.items.every(entry => entry.section !== undefined)).toBe(true);
});

test("a DRAFT records no layout — it is read against the checklist it is being answered on", async () => {
  const shift = await dayWith();

  await saveVehicleCheckDraft(write(shift, [defect("wipers", "Blade split."), ok("hv-cut-off")]));

  const stored = (await readOpenShift())?.vehicle?.checks[0];
  expect(stored?.items).toEqual([
    { key: "wipers", label: "Windscreen wipers", result: "fail", note: "Blade split." },
    { key: "hv-cut-off", label: "High-voltage cut-off", result: "pass", note: null },
  ]);
  // Not merely empty: absent from what is on the phone.
  expect(await storedFile().text()).not.toContain("section");
});

test("completing stores every answer, the completion time, and trimmed descriptions", async () => {
  const shift = await dayWith();
  const answers = allOk().map(answer => (answer.key === "oil-leaks" ? defect("oil-leaks", "  Oil level low.  ") : answer));

  const check = await completeVehicleCheck({ ...write(shift, answers), completedAt: CHECK_DONE, completedBy: DRIVER });

  expect(check?.status).toBe("completed");
  expect(check?.completedAt).toBe(CHECK_DONE.toISOString());
  expect(check?.items).toHaveLength(checklistItems(checklistFor("class1")).length);
  expect(check?.items.find(entry => entry.key === "oil-leaks")?.note).toBe("Oil level low.");
  expect(checkStateOf((await readOpenShift())?.vehicle?.checks ?? [])).toBe("completed");
});

test("a check with ANY unanswered item cannot be completed", async () => {
  const shift = await dayWith();
  const allButOne = allOk().slice(1);

  await expect(completeVehicleCheck({ ...write(shift, allButOne), completedAt: CHECK_DONE, completedBy: DRIVER })).rejects.toThrow();
  expect((await readOpenShift())?.vehicle?.checks).toEqual([]);
});

test.each(["", "   "])("a defect described as %p cannot be completed", async note => {
  const shift = await dayWith();
  await saveVehicleCheckDraft(write(shift, [ok("horn")]));
  const answers = allOk().map(answer => (answer.key === "horn" ? defect("horn", note) : answer));

  await expect(completeVehicleCheck({ ...write(shift, answers), completedAt: CHECK_DONE, completedBy: DRIVER })).rejects.toThrow();
  // The draft is untouched by the refused completion.
  expect((await readOpenShift())?.vehicle?.checks[0]?.status).toBe("draft");
});

test("rapid repeated completion makes ONE completed check, and does not move its time", async () => {
  const shift = await dayWith();

  const results = await Promise.all([
    completeVehicleCheck({ ...write(shift, allOk()), completedAt: CHECK_DONE, completedBy: DRIVER }),
    completeVehicleCheck({ ...write(shift, allOk()), completedAt: new Date(2026, 8, 13, 6, 3), completedBy: DRIVER }),
    completeVehicleCheck({ ...write(shift, allOk()), completedAt: new Date(2026, 8, 13, 6, 4), completedBy: DRIVER }),
  ]);

  const checks = (await readOpenShift())?.vehicle?.checks ?? [];
  expect(checks).toHaveLength(1);
  expect(checks[0]?.completedAt).toBe(CHECK_DONE.toISOString());
  for (const result of results) expect(result).toEqual(checks[0]);
});

test("a late draft save cannot REOPEN a completed check", async () => {
  const shift = await dayWith();
  const completed = await completeVehicleCheck({ ...write(shift, allOk()), completedAt: CHECK_DONE, completedBy: DRIVER });

  const late = await saveVehicleCheckDraft(write(shift, [defect("horn", "changed my mind")]));

  expect(late).toEqual(completed);
  expect((await readOpenShift())?.vehicle?.checks).toEqual([completed]);
});

test("a second check is not started beside an existing one — repeat checks are not built yet", async () => {
  const shift = await dayWith();
  const completed = await completeVehicleCheck({ ...write(shift, allOk()), completedAt: CHECK_DONE, completedBy: DRIVER });

  const other = await saveVehicleCheckDraft(write(shift, [ok("horn")], "check-2"));

  expect(other).toEqual(completed);
  expect((await readOpenShift())?.vehicle?.checks).toHaveLength(1);
});

// ═══════════════════════════════════════════════════════════════════════════
// Completion is a declaration: when, and by whom
// ═══════════════════════════════════════════════════════════════════════════

test("a DRAFT is nobody's declaration — no completion time, no driver", async () => {
  const shift = await dayWith();

  const draft = await saveVehicleCheckDraft(write(shift, [defect("horn", "Horn silent")]));

  // `completedAt === null` is the whole answer to "has this walkaround been
  // certified?", whatever results the screen is showing.
  expect(draft?.status).toBe("draft");
  expect(draft?.completedAt).toBeNull();
  expect(draft?.completedBy).toBeNull();
  expect(checkStateOf((await readOpenShift())?.vehicle?.checks ?? [])).toBe("in-progress");
});

test("completing records WHO declared it, and the record is auditable back to them", async () => {
  const shift = await dayWith();

  const check = await completeVehicleCheck({ ...write(shift, allOk()), completedAt: CHECK_DONE, completedBy: DRIVER });

  expect(check?.completedBy).toBe(DRIVER);
  expect(check?.completedAt).toBe(CHECK_DONE.toISOString());
  expect((await readOpenShift())?.vehicle?.checks[0]?.completedBy).toBe(DRIVER);
});

test("a certification with no driver is REFUSED, not stored anonymously", async () => {
  const shift = await dayWith();

  await expect(completeVehicleCheck({ ...write(shift, allOk()), completedAt: CHECK_DONE, completedBy: "" }))
    .rejects.toThrow();

  expect((await readOpenShift())?.vehicle?.checks).toEqual([]);
});

test("REPLAYING the same completion event makes no second certificate", async () => {
  // The offline contract (D19): one logical event carries one stable client id
  // and may be replayed. A replay resolves to the record already written — it
  // never certifies twice, and never moves the time or the author.
  const shift = await dayWith();
  const first = await completeVehicleCheck({ ...write(shift, allOk()), completedAt: CHECK_DONE, completedBy: DRIVER });

  const replay = await completeVehicleCheck({
    ...write(shift, allOk()), completedAt: new Date(2026, 8, 13, 9, 30), completedBy: "someone-else",
  });

  expect(replay).toEqual(first);
  const checks = (await readOpenShift())?.vehicle?.checks ?? [];
  expect(checks).toHaveLength(1);
  expect(checks[0]?.completedAt).toBe(CHECK_DONE.toISOString());
  expect(checks[0]?.completedBy).toBe(DRIVER);
});

test("a stored 'completed' check with no driver cannot be read as a completed check", async () => {
  const { completedBy: _dropped, ...noDriver } = goodCompleted();
  storeWithChecks([noDriver]);

  // Unauditable: it claims a walkaround was certified but not by whom.
  expect((await readOpenShift())?.vehicle?.checks).toEqual([]);
});

test("tomorrow's checklist cannot add rows to yesterday's completed record", async () => {
  storeWithChecks([goodCompleted()]);
  const stored = (await readOpenShift())?.vehicle?.checks[0] ?? null;
  const today = checklistFor("class1");

  // A later version of the same checklist, with a row that did not exist when
  // this check was certified.
  const tomorrow = {
    ...today,
    version: 2,
    sections: [...today.sections, {
      id: "new", title: "NEW SECTION",
      items: [{ key: "brand-new-check", label: "Brand new check", defaultResult: "pass" as const, dvsa: [27] }],
    }],
  };

  const results = resultsOf(tomorrow, stored);
  expect(results.size).toBe(42);
  expect(results.has("brand-new-check")).toBe(false);
  expect(stored?.items).toHaveLength(42);
});

// ═══════════════════════════════════════════════════════════════════════════
// A check belongs to a use of a vehicle — never to a number plate
// ═══════════════════════════════════════════════════════════════════════════

test("a check is written only onto the day AND vehicle use it was begun on", async () => {
  const shift = await dayWith();

  expect(await saveVehicleCheckDraft({ ...write(shift, [ok("horn")]), shiftId: "another-day" })).toBeNull();
  expect(await saveVehicleCheckDraft({ ...write(shift, [ok("horn")]), vehicleStartedAt: CHECK_DONE.toISOString() })).toBeNull();
  expect((await readOpenShift())?.vehicle?.checks).toEqual([]);
});

test("the SAME registration on a new day inherits nothing — an old check proves nothing now", async () => {
  const first = await dayWith();
  await completeVehicleCheck({ ...write(first, allOk()), completedAt: CHECK_DONE, completedBy: DRIVER });

  await clearOpenShift();
  const second = await dayWith();

  expect(second.vehicle?.numberPlate).toBe(first.vehicle?.numberPlate);
  expect(second.vehicle?.checks).toEqual([]);
  expect(checkStateOf(second.vehicle?.checks ?? [])).toBe("not-started");
  // And the completed check from the first day cannot be written into it.
  expect(await completeVehicleCheck({ ...write(first, allOk()), completedAt: CHECK_DONE, completedBy: DRIVER })).toBeNull();
});

test("each class is checked against its own list — a van check refuses HGV items", async () => {
  const shift = await dayWith({ vehicleClass: "van", numberPlate: "KAT 123", startMileage: 640 });

  const check = await completeVehicleCheck({ ...write(shift, allOk("van")), completedAt: CHECK_DONE, completedBy: DRIVER });
  expect(check?.checklist).toBe("van");
  await clearOpenShift();

  const van = await dayWith({ vehicleClass: "van", numberPlate: "KAT 123", startMileage: 640 });
  await expect(saveVehicleCheckDraft(write(van, [ok("air-leaks")]))).rejects.toThrow();
});

// ═══════════════════════════════════════════════════════════════════════════
// Stored data that is not a check fails SAFELY
// ═══════════════════════════════════════════════════════════════════════════

function storeWithChecks(checks: unknown): void {
  const file = storedFile();
  file.create({ overwrite: true });
  file.write(JSON.stringify({
    id: "11111111-2222-4333-8444-555555555555", workingFor: { kind: "personal" },
    startedAt: STARTED_AT.toISOString(),
    vehicle: { ...UNIT, startedAt: STARTED_AT.toISOString(), checks },
    status: "open", createdAt: STARTED_AT.toISOString(),
  }));
}

const completeItems = () => checklistItems(checklistFor("class1"))
  .map(entry => ({ key: entry.key, label: entry.label, result: "pass", note: null }));
/**
 * A completed record as written BEFORE sections were stored: rows, labels and
 * results, no layout. It must go on loading.
 */
const goodCompleted = () => ({
  id: "good", checklist: "hgv-unit", checklistVersion: 1, startedAt: CHECK_STARTED.toISOString(),
  status: "completed", completedAt: CHECK_DONE.toISOString(), completedBy: DRIVER, items: completeItems(),
});
/** Every row as a completion writes it now: with the section it sat under. */
const sectionedItems = () => checklistFor("class1").sections.flatMap(section => section.items.map(entry =>
  ({ key: entry.key, label: entry.label, section: { id: section.id, title: section.title }, result: "pass", note: null })));

test.each([
  ["an unknown result",                    { ...goodCompleted(), items: [{ key: "horn", label: "Horn", result: "fine", note: null }] }],
  ["a completed check with a gap in it",   { ...goodCompleted(), items: completeItems().slice(1) }],
  ["a completed defect with no description", { ...goodCompleted(), items: completeItems().map(entry => (entry.key === "horn" ? { ...entry, result: "fail", note: " " } : entry)) }],
  ["'completed' with no completion time",  { ...goodCompleted(), completedAt: null }],
  ["a draft claiming a completion time",   { ...goodCompleted(), status: "draft" }],
  ["an item from another class's list",    { ...goodCompleted(), status: "draft", completedAt: null, items: [{ key: "tow-bar", label: "Tow bar & towing", result: "pass", note: null }] }],
  ["another class's checklist",            { ...goodCompleted(), checklist: "van" }],
  ["a DRAFT written for a checklist version this app does not know", { ...goodCompleted(), status: "draft", completedAt: null, checklistVersion: 99, items: [] }],
  ["a note on an OK item",                 { ...goodCompleted(), items: completeItems().map(entry => (entry.key === "horn" ? { ...entry, note: "hmm" } : entry)) }],
  ["a repeated item",                      { ...goodCompleted(), status: "draft", completedAt: null, items: [completeItems()[0], completeItems()[0]] }],
  ["a DRAFT row claiming a section",       { ...goodCompleted(), status: "draft", completedAt: null, completedBy: null, items: [{ key: "horn", label: "Horn", section: { id: "cab", title: "CAB / DRIVER VIEW" }, result: "na", note: null }] }],
  ["sections on SOME rows only",           { ...goodCompleted(), items: sectionedItems().map((entry, index) => (index === 5 ? { key: entry.key, label: entry.label, result: entry.result, note: entry.note } : entry)) }],
  ["a section with no title",              { ...goodCompleted(), items: sectionedItems().map(entry => ({ ...entry, section: { id: entry.section.id, title: "" } })) }],
  ["a section that is not a section",      { ...goodCompleted(), items: sectionedItems().map(entry => ({ ...entry, section: null })) }],
  ["one section split into two runs",      { ...goodCompleted(), items: [...sectionedItems().slice(1), sectionedItems()[0]] }],
  ["one section under two titles",         { ...goodCompleted(), items: sectionedItems().map((entry, index) => (index === 1 ? { ...entry, section: { ...entry.section, title: "RENAMED" } } : entry)) }],
])("%s is DROPPED — never read as a result — and the day still loads", async (_why, broken) => {
  storeWithChecks([broken]);

  const shift = await readOpenShift();

  // The day survives: a broken check is no reason to lose the driver's day.
  expect(shift?.id).toBe("11111111-2222-4333-8444-555555555555");
  // And the broken check claims nothing — the vehicle reads as unchecked.
  expect(shift?.vehicle?.checks).toEqual([]);
  expect(checkStateOf(shift?.vehicle?.checks ?? [])).toBe("not-started");
});

test("a broken check does not take a good one with it", async () => {
  storeWithChecks([{ junk: true }, goodCompleted()]);

  const checks = (await readOpenShift())?.vehicle?.checks ?? [];

  expect(checks.map(check => check.id)).toEqual(["good"]);
});

test("a COMPLETED record is read as it was written — later default changes cannot reinterpret it", async () => {
  // Written against an older checklist version, and recording results that
  // disagree with today's defaults: N/A where the app now starts at OK.
  const items = completeItems().map(entry => ({ ...entry, result: "na" as const }));
  storeWithChecks([{ ...goodCompleted(), checklistVersion: 1, items }]);

  const stored = (await readOpenShift())?.vehicle?.checks[0] ?? null;

  expect(stored?.status).toBe("completed");
  expect(stored?.items.every(entry => entry.result === "na")).toBe(true);
  // And what the screen shows for it is those results, not today's defaults.
  const results = resultsOf(checklistFor("class1"), stored);
  expect([...results.values()].every(answer => answer.result === "na")).toBe(true);
  expect(results.get("front-view")?.result).toBe("na");
});

test("a completed record with FEWER rows than today's list shows only what it recorded", async () => {
  // A record written when the checklist was shorter. Reading it must not fill
  // the rows it never had with today's defaults — that would put results into
  // a driver's finished record that the driver never gave.
  storeWithChecks([{ ...goodCompleted(), checklistVersion: 7, items: completeItems().slice(0, 40) }]);

  const stored = (await readOpenShift())?.vehicle?.checks[0] ?? null;
  const results = resultsOf(checklistFor("class1"), stored);

  expect(stored?.items).toHaveLength(40);
  expect(results.size).toBe(40);
  const missing = completeItems().slice(40).map(entry => entry.key);
  for (const key of missing) expect(results.has(key)).toBe(false);
});

test("a completed record from an OLDER checklist version still loads", async () => {
  storeWithChecks([{ ...goodCompleted(), checklistVersion: 1, items: completeItems().slice(0, 40) }]);
  expect((await readOpenShift())?.vehicle?.checks).toHaveLength(0);

  // A different VERSION is not a different meaning: its rows carry their own
  // labels and results, so it is kept as the record it is.
  storeWithChecks([{ ...goodCompleted(), checklistVersion: 7 }]);
  const kept = (await readOpenShift())?.vehicle?.checks[0];
  expect(kept?.checklistVersion).toBe(7);
  expect(kept?.items).toHaveLength(42);
});

test("a completed record from BEFORE sections were stored still loads — and is given none", async () => {
  storeWithChecks([goodCompleted()]);

  const kept = (await readOpenShift())?.vehicle?.checks[0];

  expect(kept?.status).toBe("completed");
  expect(kept?.items).toHaveLength(42);
  expect(kept?.items[0]).toEqual({ key: "front-view", label: "Front view", result: "pass", note: null });
  // Nothing borrowed from today's checklist to fill the gap.
  expect(kept?.items.some(entry => entry.section !== undefined)).toBe(false);
});

test("`checks` that is not a list at all reads as no checks", async () => {
  storeWithChecks("everything passed");

  expect((await readOpenShift())?.vehicle?.checks).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// The summary counts, and the network
// ═══════════════════════════════════════════════════════════════════════════

test("the summary counts come from the answers themselves", () => {
  const unit = checklistFor("class1");
  const answers = new Map<string, CheckAnswer>([
    ["front-view", ok("front-view")],
    ["horn", ok("horn")],
    ["adblue", na("adblue")],
    ["oil-leaks", defect("oil-leaks", "Oil level low.")],
    ["steering", defect("steering", "  ")],
  ]);

  expect(summarise(unit, answers)).toEqual({
    total: 5, ok: 2, notApplicable: 1, defects: 2, undescribedDefects: 1, canComplete: false,
  });
  const full = new Map(allOk().map(answer => [answer.key, answer]));
  expect(summarise(unit, full)).toMatchObject({ total: 42, ok: 42, canComplete: true });
  full.set("horn", defect("horn", ""));
  expect(summarise(unit, full)).toMatchObject({ total: 42, defects: 1, undescribedDefects: 1, canComplete: false });
});

test("a completed check is counted as it was signed, not against today's checklist", () => {
  const unit = checklistFor("class1");
  // What a certificate written against an EARLIER checklist reads back as: its
  // own rows, one of them since retired, and none of today's later additions.
  const asSigned = new Map<string, CheckAnswer>([
    ["front-view", ok("front-view")],
    ["horn", ok("horn")],
    ["retired-row", ok("retired-row")],
  ]);

  const summary = summarise(unit, asSigned);

  // Three rows were signed for, so three are reported — not 42, and the
  // retired row is still one of the three.
  expect(summary.total).toBe(3);
  expect(summary.ok).toBe(3);
  // It can never be re-certified: today's rows are not all answered.
  expect(summary.canComplete).toBe(false);
});

test("saving and completing a check make NO request", async () => {
  const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(() => Promise.reject(new Error("offline")));
  const shift = await dayWith();

  await saveVehicleCheckDraft(write(shift, [ok("horn")]));
  await completeVehicleCheck({ ...write(shift, allOk()), completedAt: CHECK_DONE, completedBy: DRIVER });

  expect(checkStateOf((await readOpenShift())?.vehicle?.checks ?? [])).toBe("completed");
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});
