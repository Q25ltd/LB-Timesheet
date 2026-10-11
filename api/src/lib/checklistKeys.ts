/**
 * The walkaround checklists a submitted check may name (D66) — their ids,
 * versions and item KEYS, copied by hand from the phone
 * (`mobile/src/shift/checklists.ts`; the workspaces share no code). Labels
 * are not here: a submitted check carries the labels the driver saw, and
 * those are kept as they were (D52).
 *
 * A new checklist version on the phone means a new entry here, never an
 * edit of an existing one: a version is what earlier checks were made
 * against. `checklistKeys.test.ts` compares this copy with the phone's.
 */

const CHECKLIST_KEYS: Readonly<Record<string, Readonly<Record<number, readonly string[]>>>> = {
  "hgv-unit": {
    1: ["front-view", "mirrors-cameras", "windscreen-glass", "wipers", "washers", "dashboard", "steering", "horn", "height-marker", "seatbelts", "cab-doors-steps", "air-build-up", "air-leaks", "footwell", "service-brake", "parking-brake", "lights", "indicators", "stop-lamps", "marker-lights", "wiring", "body", "guards", "spray-suppression", "number-plate", "reflectors", "markings", "tyre-condition", "tread-depth", "tyre-inflation", "wheel-security", "wheel-nuts", "twin-wheel-debris", "fuel-leaks", "oil-leaks", "adblue", "exhaust-smoke", "battery", "hv-cut-off", "alternative-fuel", "load-security", "other-equipment"],
  },
  "hgv-rigid": {
    1: ["front-view", "mirrors-cameras", "windscreen-glass", "wipers", "washers", "dashboard", "steering", "horn", "height-marker", "seatbelts", "cab-doors-steps", "air-build-up", "air-leaks", "footwell", "service-brake", "parking-brake", "lights", "indicators", "stop-lamps", "marker-lights", "wiring", "body", "guards", "spray-suppression", "number-plate", "reflectors", "markings", "tyre-condition", "tread-depth", "tyre-inflation", "wheel-security", "wheel-nuts", "twin-wheel-debris", "fuel-leaks", "oil-leaks", "adblue", "exhaust-smoke", "battery", "hv-cut-off", "alternative-fuel", "load-security", "other-equipment"],
  },
  "van": {
    1: ["front-view", "mirrors", "cameras", "windscreen-glass", "washers-wipers", "dashboard", "steering", "horn", "seats", "seatbelts", "footwell", "service-brake", "parking-brake", "lights", "indicators", "stop-lamps", "marker-lights", "bodywork", "doors", "number-plate", "tyres", "wheels", "fluid-levels", "leaks", "adblue", "exhaust", "battery", "alternative-fuel", "load-security", "tow-bar", "other-equipment"],
  },
  "trailer-standard": {
    1: ["coupling-located", "secondary-lock", "brake-couplings", "brake-lines", "trailer-brakes-apply", "trailer-parking-brake", "electrical-couplings", "wiring", "lights", "indicators", "stop-lamps", "marker-lights", "body", "doors", "landing-legs", "guards", "spray-suppression", "number-plate", "reflectors", "markings", "hazard-panels", "tyre-condition", "tread-depth", "tyre-inflation", "wheel-security", "wheel-nuts", "twin-wheel-debris", "load-security", "securing-equipment", "curtains-sheets", "load-bed", "twist-locks", "specialised-equipment"],
  },
  "trailer-refrigerated": {
    1: ["coupling-located", "secondary-lock", "brake-couplings", "brake-lines", "trailer-brakes-apply", "trailer-parking-brake", "electrical-couplings", "wiring", "lights", "indicators", "stop-lamps", "marker-lights", "body", "doors", "landing-legs", "guards", "spray-suppression", "number-plate", "reflectors", "markings", "hazard-panels", "tyre-condition", "tread-depth", "tyre-inflation", "wheel-security", "wheel-nuts", "twin-wheel-debris", "load-security", "securing-equipment", "curtains-sheets", "load-bed", "twist-locks", "specialised-equipment"],
  },
};

/** Which checklist a vehicle class or trailer type is checked against (as on the phone). */
export const CHECKLIST_FOR_VEHICLE: Readonly<Record<string, string>> = { class1: "hgv-unit", class2: "hgv-rigid", van: "van" };
export const CHECKLIST_FOR_TRAILER: Readonly<Record<string, string>> = { standard: "trailer-standard", refrigerated: "trailer-refrigerated" };

/** The item keys of one checklist version — or null when the app never had that checklist or version. */
export function checklistKeys(checklist: string, version: number): readonly string[] | null {
  return CHECKLIST_KEYS[checklist]?.[version] ?? null;
}
