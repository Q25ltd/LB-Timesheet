/**
 * The paper the app replaces, drawn behind the phone in the hero: a driver's
 * daily timesheet, filled in by hand with the same day the phone shows.
 *
 * Pure illustration — hidden from assistive technology. The hero's own words
 * already say what it shows (paper, replaced by the phone), so it adds no
 * claim of its own.
 */
const ROWS: readonly (readonly [string, string])[] = [
  ["Start", "06:00"],
  ["Finish", "16:30"],
  ["Registration", "AB12 CDE"],
  ["Trailer", "C123 / C827"],
  ["Start mileage", "100,000"],
  ["Fuel", "180 L"],
];

export function PaperTimesheet() {
  return (
    <div className="paper-sheet" aria-hidden="true">
      <span className="paper-sheet__title">Daily timesheet</span>
      <span className="paper-sheet__meta">Driver ______________ Date __ / __ / __</span>
      {ROWS.map(([label, value]) => (
        <span key={label} className="paper-sheet__row">
          <span className="paper-sheet__label">{label}</span>
          <span className="paper-sheet__hand">{value}</span>
        </span>
      ))}
      <span className="paper-sheet__row paper-sheet__row--tall">
        <span className="paper-sheet__label">Defects</span>
        <span className="paper-sheet__hand">brake pedal — long travel?</span>
      </span>
    </div>
  );
}
