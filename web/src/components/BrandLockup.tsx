import logo from "../assets/logisticbay-logo.png";

/** The logo file's own proportions (640 × 162), so the browser reserves its space before it loads. */
const LOGO_WIDTH = 640;
const LOGO_HEIGHT = 162;

/**
 * LogisticBay, then the product it is showing.
 *
 * The approved mark already says "LogisticBay", so the product sits beside it
 * after a rule — the umbrella brand first, the product second. The app sets
 * TIMESHEETS under the wordmark; a web header is a row, and "LogisticBay |
 * Timesheets" is a pattern any later LogisticBay product can repeat without
 * the Timesheets identity changing.
 *
 * The image is decorative here (`alt=""`): whatever wraps the lockup names
 * it, once, so a screen reader does not hear the brand twice.
 */
export function BrandLockup({ className = "" }: { className?: string }) {
  return (
    <span className={`brand-lockup ${className}`.trim()}>
      <img className="brand-lockup__logo" src={logo} alt="" width={LOGO_WIDTH} height={LOGO_HEIGHT} />
      <span className="brand-lockup__rule" aria-hidden="true" />
      <span className="brand-lockup__product">Timesheets</span>
    </span>
  );
}
