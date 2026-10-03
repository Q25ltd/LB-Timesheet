/**
 * The handful of line icons this site uses, drawn inline on one 24px grid so
 * no icon library is needed. Every icon is decorative: the text beside it
 * carries the meaning, so each is hidden from assistive technology.
 */
const PATHS = {
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  check: "m5 12.5 4.5 4.5L19 7.5",
  checkCircle: "m8 12.5 2.8 2.8L16.5 9.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  swap: "M7 7h12m0 0-3.5-3.5M19 7l-3.5 3.5M17 17H5m0 0 3.5 3.5M5 17l3.5-3.5",
  fuel: "M4 20V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15M3 20h12M14 9h2.5a1.5 1.5 0 0 1 1.5 1.5V16a1.5 1.5 0 0 0 3 0V8.5L18 6M7 7h4",
  drop: "M12 3.5s6 6.4 6 10.5a6 6 0 0 1-12 0c0-4.1 6-10.5 6-10.5Z",
  alert: "M12 9v4m0 3.5v.01M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z",
  chevron: "m9 6 6 6-6 6",
  arrowRight: "M5 12h14m-5-5 5 5-5 5",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`icon ${className}`.trim()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
