/**
 * Every address this site links to, in one place, so a link and the thing it
 * points at cannot drift apart.
 *
 * `/register` and `/login` are the places D43 gives company registration and
 * login. Neither exists yet: both routes render a page that says so, and
 * nothing else — no form, no credential field (see `NotYetAvailablePage`).
 */
export const PATHS = {
  home: "/",
  register: "/register",
  login: "/login",
} as const;

/** The homepage sections an in-page link may target, by element id. */
export const SECTION = {
  howItWorks: "how-it-works",
  features: "features",
  forCompanies: "for-companies",
} as const;

export type SectionId = (typeof SECTION)[keyof typeof SECTION];

/** A link to a homepage section that works from any page on the site. */
export function sectionHref(id: SectionId): { pathname: string; hash: string } {
  return { pathname: PATHS.home, hash: `#${id}` };
}
