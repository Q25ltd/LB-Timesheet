/**
 * How a mileage, a clock time, a quantity of fuel, a vehicle class and a
 * check's state are shown, wherever the app shows them — and what a failed
 * save tells the driver.
 */
import { IdentifierTooLongError, SafeSaveFailedError, TimesheetLockedError, VEHICLE_CLASSES, type VehicleClass } from "../shift/localShift";
import { checkStateOf, isCorrected, latestCheck, type VehicleCheck, type VehicleCheckState } from "../shift/vehicleCheck";
import { fillAmount, type FillRecord, type FillSummary } from "../shift/vehicleFill";
import { distanceShort, volumeShort, type DistanceUnit, type VolumeUnit } from "../shift/units";

/** "class1" → "Articulated truck". */
export function classLabel(id: VehicleClass): string {
  return VEHICLE_CLASSES.find(option => option.id === id)?.label ?? id;
}

/**
 * What a use's checks say — taken from the stored checks, never assumed. A
 * check the driver has opened but not answered is still not started, and
 * nothing here says "Passed", "Roadworthy" or "Safe".
 */
export const CHECK_STATE_LABEL: Record<VehicleCheckState, string> = {
  "not-started": "Not completed",
  "in-progress": "In progress",
  completed:     "Completed",
};

/**
 * An odometer reading in the unit it was RECORDED in (D66): 184203, km →
 * "184,203 km". A reading recorded before units existed has none, and is
 * shown as the bare number — never labelled after the fact.
 *
 * Grouped by hand rather than through `toLocaleString`, which would render
 * differently depending on the device's locale — a reading the driver typed
 * should read back the same on every phone.
 */
export function formatOdometer(value: number, unit: DistanceUnit | undefined): string {
  return unit === undefined ? grouped(value) : `${grouped(value)} ${distanceShort(unit)}`;
}

/** A distance travelled, in the unit its readings were recorded in — or none (D66). */
export function formatDistance(value: number, unit: DistanceUnit | undefined): string {
  return formatOdometer(value, unit);
}

/** 100000, 100120 → "100,000 → 100,120". The unit belongs to the line below it. */
export function formatMileageRange(from: number, to: number): string {
  return `${grouped(from)} → ${grouped(to)}`;
}

/** 100000, 100120, km → "100,000 → 100,120 km" — or the bare readings when no unit was recorded. */
export function formatOdometerRange(from: number, to: number, unit: DistanceUnit | undefined): string {
  return unit === undefined ? formatMileageRange(from, to) : `${formatMileageRange(from, to)} ${distanceShort(unit)}`;
}

function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * The time between two instants, in whole minutes: "8 min", "1 h 05 min",
 * "3 h". Minutes are rounded down — the use lasted at least this long.
 */
export function formatDuration(fromIso: string, toIso: string): string {
  const minutes = Math.max(0, Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${String(rest)} min`;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest).padStart(2, "0")} min`;
}

/**
 * A use's check on a FINISHED day, in the three words that matter there. A
 * draft is not a check: it says not completed, and that it was started.
 */
export function finishedCheckLabel(checks: readonly VehicleCheck[]): string {
  const state = checkStateOf(checks);
  if (state === "completed") return isCorrected(latestCheck(checks)) ? "Checks completed · corrected" : "Checks completed";
  return state === "in-progress" ? "Check not completed · started" : "Check not completed";
}

/**
 * A use's check state for a DETAIL screen: as `CHECK_STATE_LABEL`, and a
 * completed check that has been corrected says so (D36). Active Shift's cards
 * keep the plain "Checks completed" — revision history is not theirs to show.
 */
export function checkDetailLabel(checks: readonly VehicleCheck[]): string {
  const state = checkStateOf(checks);
  return state === "completed" && isCorrected(latestCheck(checks)) ? "Completed · corrected" : CHECK_STATE_LABEL[state];
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * An instant's local calendar day: "Mon 28 Sep 2026". Built by hand, as
 * mileages are, so it reads the same on every phone whatever its locale.
 */
export function formatDate(iso: string): string {
  const at = new Date(iso);
  return `${WEEKDAYS[at.getDay()] ?? ""} ${String(at.getDate())} ${MONTHS[at.getMonth()] ?? ""} ${String(at.getFullYear())}`;
}

/** "Mon 28 Sep 2026, 17:40". */
export function formatDateTime(iso: string): string {
  return `${formatDate(iso)}, ${formatClockTime(iso)}`;
}

/** Whole calendar days from one instant's local date to another's: 0 on the same day. */
export function calendarDaysBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  return Math.round(
    (new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime()
      - new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime()) / 86_400_000,
  );
}

/**
 * A finish with its date, and — when it is not the start's day — how many
 * days after it: "Sun 20 Sep 2026, 06:00 (next day)". The line a
 * cross-midnight mistake shows up on.
 */
export function formatFinish(startedAt: string, endedAt: string): string {
  const days = calendarDaysBetween(startedAt, endedAt);
  if (days <= 0) return formatDateTime(endedAt);
  return `${formatDateTime(endedAt)} (${days === 1 ? "next day" : `${String(days)} days later`})`;
}

/** A day's hours on one line: "05:00 → 17:00", or "22:00 → 06:00 (+1 day)". */
export function formatShiftHours(startedAt: string, endedAt: string): string {
  const days = calendarDaysBetween(startedAt, endedAt);
  const range = `${formatClockTime(startedAt)} → ${formatClockTime(endedAt)}`;
  return days <= 0 ? range : `${range} (+${String(days)} ${days === 1 ? "day" : "days"})`;
}

/** An instant, as a plain local clock time: "05:42". */
export function formatClockTime(iso: string): string {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/**
 * A quantity in the unit it was recorded in: 350, litre → "350 L"; 12.5,
 * us_gallon → "12.5 US gal"; 1200.05 → "1,200.05 …". A quantity recorded with
 * no unit set says so rather than borrowing one (D66).
 *
 * Trailing zeros are dropped: a driver who typed 12.50 read "twelve and a
 * half" off the pump, and 12.5 is how they would write it down.
 */
export function formatQuantity(quantity: number, unit: VolumeUnit | null): string {
  const [whole = "0", decimals] = quantity.toFixed(2).split(".");
  const trimmed = (decimals ?? "").replace(/0+$/, "");
  const number = `${grouped(Number(whole))}${trimmed === "" ? "" : `.${trimmed}`}`;
  return unit === null ? `${number} (no unit set)` : `${number} ${volumeShort(unit)}`;
}

/** One fill's amount as recorded: "350 L", "12.5 US gal" — or "Amount unknown". */
export function formatFillAmount(fill: FillRecord): string {
  const { quantity, unit } = fillAmount(fill);
  return quantity === null ? "Amount unknown" : formatQuantity(quantity, unit);
}

/** "1 entry" / "4 entries", and the same for fills and unknown amounts. */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The two lines that describe a use's fuel or AdBlue, or `null` when there is
 * nothing to describe.
 *
 * THE UNKNOWN ONES ARE NEVER VALUED. A quantity nobody knows is reported as
 * missing, beside the quantities that ARE known — never folded into the total
 * as a zero, and never estimated. Known quantities are totalled PER UNIT and
 * never converted: "350 L + 20 US gal" when a day's units changed. Four
 * shapes, and each says exactly what the day holds:
 *
 *   all known    "350 L"         "2 entries"
 *   mixed        "350 L known"   "1 amount unknown"
 *   all unknown  "1 fill"        "Amount unknown"
 *   none         (nothing)
 */
export function fillSummaryText(summary: FillSummary): { amount: string; detail: string } | null {
  if (summary.count === 0) return null;
  const known = summary.known.map(sum => formatQuantity(sum.total, sum.unit)).join(" + ");
  if (summary.unknownCount === 0) {
    return { amount: known, detail: plural(summary.count, "entry", "entries") };
  }
  if (summary.unknownCount === summary.count) {
    return { amount: plural(summary.count, "fill", "fills"), detail: "Amount unknown" };
  }
  return {
    amount: `${known} known`,
    detail: plural(summary.unknownCount, "amount unknown", "amounts unknown"),
  };
}

/** What most failed saves honestly say. */
const NOTHING_CHANGED = "Nothing was changed. Please try again.";

/** What a save that failed on the disk says (`SafeSaveFailedError`). Never "nothing was changed". */
export const SAFE_SAVE_FAILED = "The change could not be saved safely. Your shift data has been preserved. Try again.";

/**
 * The body of a failed save's alert. `usual` is what that screen says when a
 * refusal left the day untouched; a failure of the save itself says
 * `SAFE_SAVE_FAILED` instead, because the old day file may already be gone.
 * Decided by the error's type, never its text.
 */
export function saveFailureMessage(error: unknown, usual: string = NOTHING_CHANGED): string {
  if (error instanceof TimesheetLockedError) return LOCKED_BY_SENDING;
  if (error instanceof IdentifierTooLongError) return `${error.what === "registration" ? "A registration" : "A trailer number"} can be at most ${String(error.limit)} characters. Nothing was changed.`;
  return error instanceof SafeSaveFailedError ? SAFE_SAVE_FAILED : usual;
}

/** A sent timesheet is changed by an amendment, never in place (D66). */
const LOCKED_BY_SENDING = "This timesheet has been sent to the company, so it can't be changed here. Nothing was changed.";
