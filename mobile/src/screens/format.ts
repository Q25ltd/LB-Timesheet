/**
 * How a mileage and a clock time are shown, wherever the app shows them.
 */

/**
 * 184203 → "184,203 mi".
 *
 * Grouped by hand rather than through `toLocaleString`, which would render
 * differently depending on the device's locale — a mileage the driver typed
 * should read back the same on every phone.
 */
export function formatMileage(miles: number): string {
  return `${String(miles).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} mi`;
}

/** An instant, as a plain local clock time: "05:42". */
export function formatClockTime(iso: string): string {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}
