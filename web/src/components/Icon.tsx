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
  tap: "M9 11V5.5a1.5 1.5 0 0 1 3 0V10m0-.5a1.5 1.5 0 0 1 3 0v1m0-.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-.6a6 6 0 0 1-4.7-2.3L3.9 15.3a1.5 1.5 0 0 1 2.3-2L9 16",
  records: "M8 4h8a2 2 0 0 1 2 2v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2Zm1 5h6m-6 4h6m-6 4h3",
  restore: "M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4M12 8v4l2.5 1.5",
  keyboard: "M3 7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Zm4 3h.01M11 10h.01M15 10h.01M7 14h10",
  truck: "M3 6h11v10H3zM14 10h4l3 3v3h-7M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  clipboard: "M9 4h6v3H9zM9 5.5H6.5a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1H15M9 12l2 2 4-4M9 17h6",
  noSignal: "M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 4.3-2.6M19 13a10 10 0 0 0-3-2.1M2 9.5a15 15 0 0 1 4.2-2.6M22 9.5A15 15 0 0 0 11 5.6M12 20h.01",
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
