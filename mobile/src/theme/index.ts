/**
 * The LogisticBay Timesheets visual language, in one place.
 *
 * Derived from the supplied Login/Registration reference: a dark LogisticBay
 * blue for primary actions and headings, a lighter blue for secondary
 * branding, and white/near-white surfaces. Large type and large targets
 * because the reader is a driver at 5am, often in gloves, often in poor light.
 */
export const colors = {
  /** Primary actions, headings, the wordmark. */
  brandDark:   "#0B3C7A",
  brandDeep:   "#0A3468",
  /** Secondary branding — the "TIMESHEETS" lockup, accents, links. */
  brandLight:  "#2E8BE0",
  surface:     "#FFFFFF",
  background:  "#F5F8FC",
  border:      "#D4DEEA",
  borderFocus: "#2E8BE0",
  text:        "#12243A",
  textMuted:   "#5C7089",
  placeholder: "#8FA3B8",
  danger:      "#B3261E",
  dangerBg:    "#FDECEA",
  disabled:    "#9BB3CC",
  onBrand:     "#FFFFFF",
} as const;

export const spacing = {
  xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32,
} as const;

export const radius = { field: 12, button: 12, card: 16 } as const;

/**
 * 52pt fields and buttons. Well above the 44pt minimum touch target, because
 * the reference design's generous sizing is the point of the design — this is
 * a form filled with cold hands before dawn.
 */
export const sizing = { control: 52, minTouch: 44 } as const;

export const typography = {
  title:      { fontSize: 28, fontWeight: "700" as const, color: colors.brandDark },
  subtitle:   { fontSize: 16, fontWeight: "400" as const, color: colors.textMuted },
  wordmark:   { fontSize: 26, fontWeight: "800" as const, color: colors.brandDark, letterSpacing: -0.5 },
  lockup:     { fontSize: 13, fontWeight: "700" as const, color: colors.brandLight, letterSpacing: 2.5 },
  label:      { fontSize: 13, fontWeight: "600" as const, color: colors.textMuted },
  input:      { fontSize: 17, color: colors.text },
  button:     { fontSize: 18, fontWeight: "700" as const, color: colors.onBrand },
  helper:     { fontSize: 13, color: colors.textMuted },
  error:      { fontSize: 13, color: colors.danger },
} as const;
