/**
 * The walkaround checklists — what a driver is asked, per vehicle class.
 *
 * These cases pin the lists EXACTLY, item by item, because a checklist that
 * quietly gains, loses or renames a row changes what a driver attests to. A
 * change here should be deliberate, reviewed against the DVSA guidance the
 * lists are based on, and visible in this file's diff.
 */
import { checklistFor, checklistItems, type Checklist } from "../shift/checklists";

const keys = (checklist: Checklist) => checklistItems(checklist).map(entry => entry.key);
const labels = (checklist: Checklist) => checklistItems(checklist).map(entry => entry.label);
const sources = (checklist: Checklist) => new Set(checklistItems(checklist).flatMap(entry => entry.dvsa));

const HGV_SECTIONS = [
  "CAB / DRIVER VIEW", "BRAKES", "LIGHTS / ELECTRICAL", "BODY / EXTERIOR",
  "TYRES / WHEELS", "FLUIDS / EMISSIONS", "POWER / FUEL SYSTEMS", "LOAD / EQUIPMENT",
];

test("Class 1 is checked as a UNIT, against the unit checklist — exactly these rows", () => {
  const unit = checklistFor("class1");

  expect(unit.id).toBe("hgv-unit");
  expect(unit.sections.map(section => section.title)).toEqual(HGV_SECTIONS);
  expect(labels(unit)).toEqual([
    "Front view", "Mirrors & cameras", "Windscreen & windows", "Windscreen wipers", "Windscreen washers",
    "Warning lights & gauges", "Steering", "Horn", "Vehicle height marker", "Seatbelts", "Cab, doors & steps",
    "Air build-up & warning", "Air leaks", "Footwell clear", "Service brake & pedal", "Tractor parking brake",
    "Lights & lenses", "Indicators", "Stop lamps", "Marker lights", "Wiring & switches",
    "Body panels & wings", "Side & rear under-run guards", "Spray suppression", "Number plate", "Reflectors",
    "Markings & warning plates",
    "Tyre condition", "Tread depth (min 1mm)", "Tyre inflation", "Wheel security", "Wheel nuts & indicators",
    "Debris between twin wheels",
    "Fuel leaks & filler cap", "Oil leaks", "AdBlue level", "Exhaust smoke",
    "Battery", "High-voltage cut-off", "Alternative fuel system",
    "Load security", "Other equipment",
  ]);
});

test("Class 2 is a RIGID, and differs from the unit only where a rigid genuinely differs", () => {
  const unit = checklistFor("class1");
  const rigid = checklistFor("class2");

  expect(rigid.id).toBe("hgv-rigid");
  expect(rigid.sections.map(section => section.title)).toEqual(HGV_SECTIONS);
  // Same items, same order — a rigid is checked for everything a unit is.
  expect(keys(rigid)).toEqual(keys(unit));
  // Only two rows are worded differently: a rigid's parking brake is not a
  // tractor's, and a rigid's body carries its own load doors.
  const differing = checklistItems(rigid)
    .map((entry, index) => [entry.label, checklistItems(unit)[index]?.label])
    .filter(([a, b]) => a !== b);
  expect(differing).toEqual([
    ["Parking brake", "Tractor parking brake"],
    ["Body, doors & wings", "Body panels & wings"],
  ]);
});

test("a Van gets the VAN checklist, not the HGV one — exactly these rows", () => {
  const van = checklistFor("van");

  expect(van.id).toBe("van");
  expect(van.sections.map(section => section.title)).toEqual(HGV_SECTIONS);
  expect(labels(van)).toEqual([
    "Front view", "Mirrors", "Cameras", "Windscreen & glass", "Washers & wipers", "Warning lights",
    "Steering", "Horn", "Seats", "Seatbelts",
    "Footwell clear", "Service brake", "Parking brake",
    "Lights & lenses", "Indicators", "Stop lamps", "Marker lights",
    "Bodywork", "Doors", "Number plates",
    "Tyres", "Wheels & fixings",
    "Fluid levels", "Leaks & fuel filler cap", "AdBlue level", "Exhaust",
    "Battery", "Alternative fuel system",
    "Load security", "Tow bar & towing", "Other equipment & tail lift",
  ]);
  // HGV-only equipment is not asked of a van.
  for (const hgvOnly of ["air-build-up", "air-leaks", "height-marker", "hv-cut-off", "spray-suppression", "twin-wheel-debris"]) {
    expect(keys(van)).not.toContain(hgvOnly);
  }
});

test.each(["class1", "class2"] as const)("%s carries NO trailer-only check", vehicleClass => {
  const checklist = checklistFor(vehicleClass);

  // DVSA 20 (brake lines and trailer parking brake) and 22 (coupling security)
  // exist only with a trailer attached: they belong to the Trailer Check.
  expect(sources(checklist).has(20)).toBe(false);
  expect(sources(checklist).has(22)).toBe(false);
  for (const label of labels(checklist)) {
    expect(label).not.toMatch(/trailer|landing leg|coupling|brake line|fifth wheel|suzie/i);
  }
});

test.each(["class1", "class2"] as const)("%s covers every DVSA HGV check that applies without a trailer", vehicleClass => {
  const applicable = Array.from({ length: 27 }, (_, index) => index + 1).filter(number => number !== 20 && number !== 22);

  expect([...sources(checklistFor(vehicleClass))].sort((a, b) => a - b)).toEqual(applicable);
});

test("the van covers every one of DVSA's 19 van checks", () => {
  expect([...sources(checklistFor("van"))].sort((a, b) => a - b)).toEqual(Array.from({ length: 19 }, (_, index) => index + 1));
});

test.each(["class1", "class2", "van"] as const)("%s: keys are unique, and every row declares its start", vehicleClass => {
  const checklist = checklistFor(vehicleClass);
  const all = checklistItems(checklist);

  expect(new Set(keys(checklist)).size).toBe(all.length);
  expect(checklist.version).toBe(1);
  // A row is a question plus the result it starts at — declared here, never
  // inferred at runtime from the plate, the mileage or anything else.
  for (const entry of all) {
    expect(Object.keys(entry).sort()).toEqual(["defaultResult", "dvsa", "key", "label"]);
    expect(["pass", "na"]).toContain(entry.defaultResult);
  }
});

/**
 * The defaults, listed in full.
 *
 * These decide what a driver is shown before they touch anything, so a change
 * to one is a change to what most drivers will confirm on most mornings. Each
 * list is pinned exactly; adding or removing an N/A must be deliberate.
 */
const STARTS_NA: Record<"class1" | "class2" | "van", string[]> = {
  // A tractor unit carries no load of its own — the load is the trailer's.
  class1: ["spray-suppression", "hv-cut-off", "alternative-fuel", "load-security", "other-equipment"],
  // A rigid carries its own load, so load security starts OK.
  class2: ["spray-suppression", "hv-cut-off", "alternative-fuel", "other-equipment"],
  van: ["cameras", "marker-lights", "adblue", "alternative-fuel", "tow-bar", "other-equipment"],
};

test.each(["class1", "class2", "van"] as const)("%s: exactly these rows start N/A, and every other row starts OK", vehicleClass => {
  const items = checklistItems(checklistFor(vehicleClass));

  expect(items.filter(entry => entry.defaultResult === "na").map(entry => entry.key)).toEqual(STARTS_NA[vehicleClass]);
  expect(items.filter(entry => entry.defaultResult === "pass")).toHaveLength(items.length - STARTS_NA[vehicleClass].length);
});

test.each([
  ["class1", 37, 5],
  ["class2", 38, 4],
  ["van",    25, 6],
] as const)("%s opens showing %i OK and %i N/A", (vehicleClass, ok, na) => {
  const items = checklistItems(checklistFor(vehicleClass));

  expect(items.filter(entry => entry.defaultResult === "pass")).toHaveLength(ok);
  expect(items.filter(entry => entry.defaultResult === "na")).toHaveLength(na);
});

test.each(["class1", "class2", "van"] as const)("%s: the everyday items start OK — a driver confirms them, never hunts for them", vehicleClass => {
  const byKey = new Map(checklistItems(checklistFor(vehicleClass)).map(entry => [entry.key, entry]));

  // Equipment every vehicle of the class has: brakes, lights, tyres, glass.
  const everyday = ["steering", "horn", "service-brake", "parking-brake", "lights", "indicators",
    "number-plate", "battery", "front-view", "seatbelts"];
  for (const key of everyday) expect(byKey.get(key)?.defaultResult).toBe("pass");
  const tyres = vehicleClass === "van" ? ["tyres", "wheels"] : ["tyre-condition", "tread-depth", "wheel-security"];
  for (const key of tyres) expect(byKey.get(key)?.defaultResult).toBe("pass");
});

test("equipment a vehicle may simply not have starts N/A — never assumed present", () => {
  const unit = new Map(checklistItems(checklistFor("class1")).map(entry => [entry.key, entry]));
  const van = new Map(checklistItems(checklistFor("van")).map(entry => [entry.key, entry]));

  for (const key of ["hv-cut-off", "alternative-fuel", "other-equipment"]) {
    expect(unit.get(key)?.defaultResult).toBe("na");
  }
  expect(van.get("tow-bar")?.defaultResult).toBe("na");
  // AdBlue: standard on a modern Euro VI HGV, far from standard on a van.
  expect(unit.get("adblue")?.defaultResult).toBe("pass");
  expect(van.get("adblue")?.defaultResult).toBe("na");
});

test("nothing in any checklist claims DVSA approval", () => {
  for (const vehicleClass of ["class1", "class2", "van"] as const) {
    for (const label of labels(checklistFor(vehicleClass))) expect(label).not.toMatch(/approved|dvsa/i);
  }
});
