/**
 * The time zones a company may choose at registration (D53), from THIS
 * browser's own IANA database — no list is kept here, and none is downloaded.
 *
 * A company is somewhere (owner decision, 2026-10-03), so only PLACES are
 * offered: Area/Location identifiers, never UTC, an Etc/ fixed-offset zone or
 * an abbreviation. The rule mirrors the API's `isCompanyTimeZone`, which is
 * the authority the future registration endpoint will check against; the two
 * workspaces share no code (D1, D6), so it is stated again here.
 *
 * The value is the IANA identifier exactly as this browser names it — stored
 * as chosen, never rewritten. The label is for people: the place, the zone's
 * name and its offset TODAY ("London — United Kingdom Time (GMT+1)").
 */
const PLACE_SHAPE = /^[A-Z][A-Za-z]*(?:\/[A-Z][A-Za-z0-9_+-]*)+$/;

interface TimeZoneOption {
  /** The IANA identifier — what is stored. */
  value: string;
  /** What a person reads. */
  label: string;
}

export interface TimeZoneGroup {
  region: string;
  zones: TimeZoneOption[];
}

function isPlace(zone: string): boolean {
  return PLACE_SHAPE.test(zone) && !zone.startsWith("Etc/");
}

function zoneName(zone: string, style: "longGeneric" | "shortOffset"): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: style })
    .formatToParts(new Date())
    .find(part => part.type === "timeZoneName")?.value ?? "";
}

/** "America/Argentina/Buenos_Aires" → "Buenos Aires, Argentina". */
function placeName(zone: string): string {
  const [, ...rest] = zone.split("/");
  const words = rest.map(part => part.replace(/_/g, " "));
  const city = words.pop() ?? zone;
  return words.length === 0 ? city : `${city}, ${words.join(", ")}`;
}

function supportedZones(): string[] {
  try {
    return typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  } catch {
    return [];
  }
}

/**
 * Every place this browser knows, grouped by region and sorted by name. Built
 * once per visit to the page (the page memoises it), not on every keystroke.
 */
export function timeZoneGroups(): TimeZoneGroup[] {
  const byRegion = new Map<string, TimeZoneOption[]>();
  for (const zone of supportedZones()) {
    if (!isPlace(zone)) continue;
    const region = zone.split("/")[0] ?? zone;
    const generic = zoneName(zone, "longGeneric");
    const offset = zoneName(zone, "shortOffset");
    const label = `${placeName(zone)} — ${generic}${offset === "" ? "" : ` (${offset})`}`;
    const zones = byRegion.get(region) ?? [];
    zones.push({ value: zone, label });
    byRegion.set(region, zones);
  }
  return [...byRegion.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([region, zones]) => ({ region, zones: zones.sort((a, b) => a.label.localeCompare(b.label)) }));
}

/** True when `zone` is one of the places offered. */
export function isOfferedTimeZone(zone: string, groups: readonly TimeZoneGroup[]): boolean {
  return groups.some(group => group.zones.some(option => option.value === zone));
}

/**
 * This device's zone, when it is one of the places offered — a SUGGESTION
 * only: the company may change it, and nothing is fixed by it. When the
 * device reports none, or something that is not a place (UTC, an Etc/ zone),
 * there is no suggestion and the company chooses. Never a guessed default.
 */
export function suggestedTimeZone(groups: readonly TimeZoneGroup[]): string | null {
  let zone: unknown;
  try {
    zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return typeof zone === "string" && isOfferedTimeZone(zone, groups) ? zone : null;
}
