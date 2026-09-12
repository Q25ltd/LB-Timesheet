/**
 * The authenticated app's destinations — the ONE place they are declared.
 *
 * The route-group layout builds its navigator from this list and the tab bar
 * draws its controls from it, so a destination cannot exist in one and not the
 * other. `name` is the route file's name under `app/(app)/`, which is what
 * makes the mapping checkable: a test imports each one and fails if the screen
 * is missing, rather than leaving a tab that opens a blank page.
 *
 * ORDER IS THE SCREEN ORDER, and the first entry is the default authenticated
 * tab. Home is first because it is the driver's daily landing screen.
 *
 * Two of these four are landing pages for features that are not built
 * (Timesheets, My Records). That is deliberate and is not the same thing as a
 * fake feature: each says plainly that it is being built and shows no specimen
 * data. See `TimesheetsScreen` / `RecordsScreen`.
 */
import type { TabIconName } from "../components/TabIcon";

export interface AppTab {
  /** The route file under `app/(app)/`, without its extension. */
  name: string;
  /** What the driver reads under the icon. */
  label: string;
  icon: TabIconName;
}

export const APP_TABS: readonly AppTab[] = [
  { name: "today",      label: "Home",       icon: "home" },
  { name: "timesheets", label: "Timesheets", icon: "document" },
  { name: "records",    label: "My Records", icon: "chart" },
  { name: "settings",   label: "Settings",   icon: "gear" },
] as const;
