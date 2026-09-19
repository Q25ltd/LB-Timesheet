/**
 * The daily walkaround checklists, per vehicle class.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * SOURCE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Based on DVSA walkaround guidance, as published on GOV.UK:
 *
 *   HGV  https://www.gov.uk/guidance/carry-out-daily-heavy-goods-vehicle-hgv-walkaround-checks
 *        "Carry out HGV daily walkaround checks", 27 numbered checks,
 *        last updated 21 September 2023
 *   Van  https://www.gov.uk/guidance/carry-out-van-daily-walkaround-checks
 *        "Carry out van daily walkaround checks", 19 numbered checks,
 *        last updated 8 October 2013
 *
 * Both retrieved 15 September 2026. The checklists are BASED ON that guidance;
 * they are not approved or endorsed by DVSA, and nothing in the app may say so.
 * `dvsa` on each item names the numbered check(s) it comes from, so every row
 * can be traced to its source and a later change to the guidance can be
 * reconciled item by item.
 *
 * Where DVSA combines several things under one number — "Lights and
 * indicators", "Tyres and wheel fixing" — a driver answers them as separate
 * rows, so a defect is recorded against the thing that is actually wrong.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CLASS 1 IS THE UNIT ONLY
 * ════════════════════════════════════════════════════════════════════════════
 *
 * A Class 1 check covers the tractor unit, and nothing here claims the trailer
 * was checked. DVSA check 20 (brake lines and trailer parking brake) and check
 * 22 (coupling security — the trailer located in the fifth wheel, secondary
 * locking devices) exist only with a trailer attached, and belong to the
 * separate Trailer Check. From check 6 the unit keeps its own brakes; the
 * trailer brakes are the trailer's. From check 12 it keeps its own body, doors
 * and guards; trailer doors, trailer panels and landing legs are the trailer's.
 * From check 21 it keeps its own wiring and switches; trailer electrical
 * couplings are the trailer's.
 *
 * A Class 2 is a rigid vehicle with no trailer, so the same trailer-dependent
 * items are absent from it too.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * EVERY ITEM DECLARES ITS STARTING RESULT
 * ════════════════════════════════════════════════════════════════════════════
 *
 * A driver walks the same round every morning and, on most mornings, finds
 * nothing wrong. So each item starts at the result that is normal for that
 * class — `pass` for equipment the class always has, `na` for equipment it may
 * not (a high-voltage system, alternative fuel, spray suppression, towing
 * gear, "other equipment"). The driver walks round, changes whatever differs,
 * and confirms.
 *
 * THE DEFAULT IS DECLARED HERE, PER CLASS — never guessed at runtime from the
 * plate, the mileage or anything else the app cannot know. Where a class
 * genuinely differs, the same key carries a different default: a tractor unit
 * carries no load, so Load security starts `na` for a unit and `pass` for a
 * rigid that does.
 *
 * A DEFAULT IS NOT A CHECK. It is the result the driver is offered, and it
 * means nothing until they press Complete Check — which is the moment they
 * confirm the walkaround happened and these are its results. Nothing here
 * completes anything.
 *
 * KEYS ARE PERMANENT. A stored check records each item's key and label; a
 * key's meaning must never change. Rewording a label is safe. Changing what an
 * item means needs a new key and a new `version`.
 */
import type { VehicleClass } from "./localShift";
import type { CheckResult } from "./vehicleCheck";

export type ChecklistId = "hgv-unit" | "hgv-rigid" | "van";

export interface ChecklistItem {
  /** Stable identity, stored with every answer. */
  key: string;
  /** What the driver sees. */
  label: string;
  /**
   * Where this row starts for this class: `pass` for what the class normally
   * has, `na` for what it may not. Declared, never inferred.
   */
  defaultResult: CheckResult;
  /** The numbered DVSA check(s) this row comes from. */
  dvsa: readonly number[];
}

interface ChecklistSection {
  id: string;
  title: string;
  items: readonly ChecklistItem[];
}

export interface Checklist {
  id: ChecklistId;
  version: number;
  sections: readonly ChecklistSection[];
}

/** An item that starts OK: equipment this class always has. */
const item = (key: string, label: string, ...dvsa: number[]): ChecklistItem =>
  ({ key, label, defaultResult: "pass", dvsa });

/** An item that starts N/A: equipment this class may not have at all. */
const optional = (key: string, label: string, ...dvsa: number[]): ChecklistItem =>
  ({ key, label, defaultResult: "na", dvsa });

/**
 * Everything the unit and the rigid share. Only the parking-brake and body
 * rows differ between them, and they are passed in rather than duplicated.
 */
function hgvSections(parkingBrake: ChecklistItem, body: ChecklistItem, loadSecurity: ChecklistItem): ChecklistSection[] {
  return [
    {
      id: "cab", title: "CAB / DRIVER VIEW", items: [
        item("front-view",       "Front view",              1),
        item("mirrors-cameras",  "Mirrors & cameras",       1),
        item("windscreen-glass", "Windscreen & windows",    1),
        item("wipers",           "Windscreen wipers",       2),
        item("washers",          "Windscreen washers",      2),
        item("dashboard",        "Warning lights & gauges", 3),
        item("steering",         "Steering",                4),
        item("horn",             "Horn",                    5),
        item("height-marker",    "Vehicle height marker",   7),
        item("seatbelts",        "Seatbelts",               8),
        item("cab-doors-steps",  "Cab, doors & steps",      9),
      ],
    },
    {
      id: "brakes", title: "BRAKES", items: [
        item("air-build-up",  "Air build-up & warning", 6),
        item("air-leaks",     "Air leaks",              6),
        item("footwell",      "Footwell clear",         6),
        item("service-brake", "Service brake & pedal",  6),
        parkingBrake,
      ],
    },
    {
      id: "lights", title: "LIGHTS / ELECTRICAL", items: [
        item("lights",        "Lights & lenses",   10),
        item("indicators",    "Indicators",        10),
        item("stop-lamps",    "Stop lamps",        10),
        item("marker-lights", "Marker lights",     10),
        item("wiring",        "Wiring & switches", 21),
      ],
    },
    {
      id: "body", title: "BODY / EXTERIOR", items: [
        body,
        item("guards",            "Side & rear under-run guards", 12),
        optional("spray-suppression", "Spray suppression",        18),
        item("number-plate",      "Number plate",                 24),
        item("reflectors",        "Reflectors",                   25),
        item("markings",          "Markings & warning plates",    26),
      ],
    },
    {
      id: "tyres", title: "TYRES / WHEELS", items: [
        item("tyre-condition",    "Tyre condition",             19),
        item("tread-depth",       "Tread depth (min 1mm)",      19),
        item("tyre-inflation",    "Tyre inflation",             19),
        item("wheel-security",    "Wheel security",             19),
        item("wheel-nuts",        "Wheel nuts & indicators",    19),
        item("twin-wheel-debris", "Debris between twin wheels", 19),
      ],
    },
    {
      id: "fluids", title: "FLUIDS / EMISSIONS", items: [
        item("fuel-leaks",    "Fuel leaks & filler cap", 11),
        item("oil-leaks",     "Oil leaks",               11),
        item("adblue",        "AdBlue level",            14),
        item("exhaust-smoke", "Exhaust smoke",           15),
      ],
    },
    {
      id: "power", title: "POWER / FUEL SYSTEMS", items: [
        item("battery",          "Battery",                 13),
        optional("hv-cut-off",       "High-voltage cut-off",    16),
        optional("alternative-fuel", "Alternative fuel system", 17),
      ],
    },
    {
      id: "load", title: "LOAD / EQUIPMENT", items: [
        loadSecurity,
        optional("other-equipment", "Other equipment", 27),
      ],
    },
  ];
}

const HGV_UNIT: Checklist = {
  id: "hgv-unit",
  version: 1,
  sections: hgvSections(
    item("parking-brake", "Tractor parking brake", 6),
    item("body",          "Body panels & wings",   12),
    // A tractor unit carries no load of its own; a load on the trailer is the
    // trailer's check. The driver sets OK if this unit does carry something.
    optional("load-security", "Load security", 23),
  ),
};

const HGV_RIGID: Checklist = {
  id: "hgv-rigid",
  version: 1,
  sections: hgvSections(
    item("parking-brake", "Parking brake",       6),
    item("body",          "Body, doors & wings", 12),
    // A rigid carries its own load.
    item("load-security", "Load security", 23),
  ),
};

const VAN: Checklist = {
  id: "van",
  version: 1,
  sections: [
    {
      id: "cab", title: "CAB / DRIVER VIEW", items: [
        item("front-view",       "Front view",         1),
        item("mirrors",          "Mirrors",            1),
        optional("cameras",      "Cameras",            1),
        item("windscreen-glass", "Windscreen & glass", 1),
        item("washers-wipers",   "Washers & wipers",   2),
        item("dashboard",        "Warning lights",     3),
        item("steering",         "Steering",           4),
        item("horn",             "Horn",               5),
        item("seats",            "Seats",              7),
        item("seatbelts",        "Seatbelts",          7),
      ],
    },
    {
      id: "brakes", title: "BRAKES", items: [
        item("footwell",      "Footwell clear", 6),
        item("service-brake", "Service brake",  6),
        item("parking-brake", "Parking brake",  6),
      ],
    },
    {
      id: "lights", title: "LIGHTS / ELECTRICAL", items: [
        item("lights",        "Lights & lenses", 8),
        item("indicators",    "Indicators",      8),
        item("stop-lamps",    "Stop lamps",      8),
        optional("marker-lights", "Marker lights",  8),
      ],
    },
    {
      id: "body", title: "BODY / EXTERIOR", items: [
        item("bodywork",     "Bodywork",      11),
        item("doors",        "Doors",         11),
        item("number-plate", "Number plates", 17),
      ],
    },
    {
      id: "tyres", title: "TYRES / WHEELS", items: [
        item("tyres",  "Tyres",            12),
        item("wheels", "Wheels & fixings", 12),
      ],
    },
    {
      id: "fluids", title: "FLUIDS / EMISSIONS", items: [
        item("fluid-levels", "Fluid levels",            9),
        item("leaks",        "Leaks & fuel filler cap", 9),
        optional("adblue",   "AdBlue level",            14),
        item("exhaust",      "Exhaust",                 15),
      ],
    },
    {
      id: "power", title: "POWER / FUEL SYSTEMS", items: [
        item("battery",              "Battery",                 10),
        optional("alternative-fuel", "Alternative fuel system", 16),
      ],
    },
    {
      id: "load", title: "LOAD / EQUIPMENT", items: [
        item("load-security",       "Load security",               13),
        optional("tow-bar",         "Tow bar & towing",            18),
        optional("other-equipment", "Other equipment & tail lift", 19),
      ],
    },
  ],
};

const BY_ID: Record<ChecklistId, Checklist> = { "hgv-unit": HGV_UNIT, "hgv-rigid": HGV_RIGID, van: VAN };

const BY_CLASS: Record<VehicleClass, ChecklistId> = { class1: "hgv-unit", class2: "hgv-rigid", van: "van" };

/** The checklist a vehicle of this class is checked against. */
export function checklistFor(vehicleClass: VehicleClass): Checklist {
  return BY_ID[BY_CLASS[vehicleClass]];
}

/** Every item of a checklist, in the order the driver meets them. */
export function checklistItems(checklist: Checklist): ChecklistItem[] {
  return checklist.sections.flatMap(section => section.items);
}
