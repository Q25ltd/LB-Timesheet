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
 * A VEHICLE CHECK COVERS THE VEHICLE ONLY — NEVER A TRAILER
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
 * A Class 2 is missing the same items for the same reason, not because a rigid
 * never tows: a rigid MAY pull a drawbar trailer (D30 — the V1
 * trailer-capable classes are Class 1 and Class 2, not a van). Wherever a
 * trailer is checked it is checked as its own asset, on its own list, so a
 * towing vehicle's own list is the same list either way.
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
 * ════════════════════════════════════════════════════════════════════════════
 * THE TRAILER CHECK — ITS OWN LIST, FOR EACH TRAILER USE (D35)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Also based on the HGV guidance above (re-read 27 September 2026, still last
 * updated 21 September 2023), with DVSA's roadworthiness guide — "Where
 * trailers are changed on multiple occasions, a check should be made on each
 * trailer being used", and the check "should cover the whole vehicle or
 * combination" — and its load-securing guidance
 * (https://www.gov.uk/guidance/securing-loads-on-hgvs-and-goods-vehicles:
 * before loading, check the load platform, bodywork, anchorage points and twist
 * locks where fitted; check equipment is in a usable condition).
 *
 * Every row names the DVSA check it comes from. It takes the trailer's share of
 * checks 10, 12, 18, 19 and 23–27, all of 20 (brake lines and trailer parking
 * brake), 21 (electrical couplings and wiring) and 22 (coupling security), and
 * the COMBINATION part a driver can only confirm with this trailer attached:
 * 6 (the service brake works the trailer brakes too). Coupling is here although half of it is on the
 * tractor, because it is taking THIS trailer that makes it true or false.
 *
 * Check 7 (the height marker) also changes with the trailer and its load, but
 * the marker itself is in the cab, so it stays where it is answered — on the
 * towing vehicle's own list — and is not repeated here.
 *
 * Nothing tractor-only is on it — 1–5, 8, 9, 11 and 13–17 are cab, engine and
 * power checks of the towing vehicle and live on its own list.
 *
 * REFRIGERATED differs in ONE default only. DVSA prescribes no fridge-specific
 * walkaround item; check 27 ("other items specific to the vehicle, for example
 * loading or specialised equipment") is the only hook, and a fridge trailer
 * certainly carries specialised equipment. So that row starts OK on a
 * refrigerated trailer and N/A on a standard one. No temperature, set point,
 * hours or service row is invented.
 *
 * KEYS ARE PERMANENT. A stored check records each item's key and label; a
 * key's meaning must never change. Rewording a label is safe. Changing what an
 * item means needs a new key and a new `version`.
 */
import type { VehicleClass } from "./localShift";
import type { TrailerType } from "./trailer";
import type { CheckResult } from "./vehicleCheck";

export type ChecklistId = "hgv-unit" | "hgv-rigid" | "van" | "trailer-standard" | "trailer-refrigerated";

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
        item("number-plate",      "Registration plate",           24),
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
        item("adblue",        "AdBlue / DEF level",      14),
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
        item("number-plate", "Registration plates", 17),
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
        optional("adblue",   "AdBlue / DEF level",      14),
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

/**
 * The trailer's own walkaround, per trailer type. Each row's default is
 * decided on its own (owner review, 2026-09-27):
 *
 *   OK   what every road trailer has — including landing legs, standard on
 *        the common semi-trailer (a drawbar driver sets N/A), and the load
 *        bed, anchor points and headboard, checked before any load
 *   N/A  equipment many trailers lack — spray suppression (DVSA: "if
 *        required", as on the towing vehicle's list), curtains and sheets,
 *        twist locks ("where fitted") and specialised equipment
 *   N/A  what is only true WITH A LOAD on board — the load secure, what
 *        secures it, and hazard panels (dangerous goods only). An empty
 *        trailer is normal; the driver sets these OK once checked.
 *
 * Refrigerated differs only in specialised equipment, which it carries.
 */
function trailerSections(specialisedEquipment: ChecklistItem): ChecklistSection[] {
  return [
    {
      id: "coupling", title: "COUPLING", items: [
        item("coupling-located", "Trailer located in fifth wheel / coupling", 22),
        item("secondary-lock",   "Secondary locking device in position",      22),
      ],
    },
    {
      id: "brakes", title: "BRAKES / AIR", items: [
        item("brake-couplings",       "Air line couplings clean & in place",   20),
        item("brake-lines",           "Brake lines — no damage, wear or leaks", 20),
        item("trailer-brakes-apply",  "Service brake works trailer brakes",   6),
        item("trailer-parking-brake", "Trailer parking brake",                20),
      ],
    },
    {
      id: "lights", title: "LIGHTS / ELECTRICAL", items: [
        item("electrical-couplings", "Electrical couplings connected (incl. EBS)", 21),
        item("wiring",               "Visible wiring & cables",                    21),
        item("lights",               "Lights & lenses",                            10),
        item("indicators",           "Indicators",                                 10),
        item("stop-lamps",           "Stop lamps",                                 10),
        item("marker-lights",        "Marker lights",                              10),
      ],
    },
    {
      id: "body", title: "BODY / EXTERIOR", items: [
        item("body",                  "Body panels & wings",          12),
        item("doors",                 "Doors & fastenings",           12),
        item("landing-legs",          "Landing legs",                 12),
        item("guards",                "Side & rear under-run guards", 12),
        optional("spray-suppression", "Spray suppression",            18),
        item("number-plate",          "Registration plate",           24),
        item("reflectors",            "Reflectors (incl. side)",      25),
        item("markings",              "Markings & conspicuity",       26),
        optional("hazard-panels",     "Hazard warning panels",        26),
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
      id: "load", title: "LOAD / EQUIPMENT", items: [
        // Needs a load on board: N/A on an empty trailer, and the driver sets
        // OK once they have checked the load and what secures it.
        optional("load-security",      "Load secure — not moving",             23),
        optional("securing-equipment", "Straps, chains & nets securing load",  23),
        // Fitted to some trailers only — curtainsiders and sheeted bodies.
        optional("curtains-sheets",    "Curtains & sheets",                    12, 23),
        // Permanent structure every load-carrying trailer has, checked before
        // loading whether or not a load is on board (load-securing guidance).
        item("load-bed",               "Load bed, anchor points & headboard",  23),
        optional("twist-locks",        "Twist locks",                          23),
        specialisedEquipment,
      ],
    },
  ];
}

const TRAILER_STANDARD: Checklist = {
  id: "trailer-standard",
  version: 1,
  sections: trailerSections(optional("specialised-equipment", "Specialised equipment (e.g. fridge unit, tail lift)", 27)),
};

const TRAILER_REFRIGERATED: Checklist = {
  id: "trailer-refrigerated",
  version: 1,
  // A fridge unit IS specialised equipment, and it is fitted.
  sections: trailerSections(item("specialised-equipment", "Specialised equipment (e.g. fridge unit, tail lift)", 27)),
};

const BY_ID: Record<ChecklistId, Checklist> = {
  "hgv-unit": HGV_UNIT,
  "hgv-rigid": HGV_RIGID,
  van: VAN,
  "trailer-standard": TRAILER_STANDARD,
  "trailer-refrigerated": TRAILER_REFRIGERATED,
};

const BY_CLASS: Record<VehicleClass, ChecklistId> = { class1: "hgv-unit", class2: "hgv-rigid", van: "van" };

/** The checklist a vehicle of this class is checked against. */
export function checklistFor(vehicleClass: VehicleClass): Checklist {
  return BY_ID[BY_CLASS[vehicleClass]];
}

const BY_TRAILER_TYPE: Record<TrailerType, ChecklistId> = { standard: "trailer-standard", refrigerated: "trailer-refrigerated" };

/** The checklist a trailer of this type is checked against — never a vehicle's. */
export function trailerChecklistFor(trailerType: TrailerType): Checklist {
  return BY_ID[BY_TRAILER_TYPE[trailerType]];
}

/** Every item of a checklist, in the order the driver meets them. */
export function checklistItems(checklist: Checklist): ChecklistItem[] {
  return checklist.sections.flatMap(section => section.items);
}
