/**
 * Every address this site links to, in one place, so a link and the thing it
 * points at cannot drift apart.
 *
 * `/register` and `/login` are the places D43 gives company registration and
 * login. `/verify-email` and `/reset-password` are where the API's emailed
 * links point (`WEB_APP_URL` + path, token in the fragment) — renaming one
 * breaks every link already sent.
 */
export const PATHS = {
  home: "/",
  register: "/register",
  login: "/login",
  verifyEmail: "/verify-email",
  forgotPassword: "/forgot-password",
  resetPassword: "/reset-password",
  account: "/account",
  company: "/company",
} as const;

/** The homepage sections an in-page link may target, by element id. */
export const SECTION = {
  howItWorks: "how-it-works",
  features: "features",
  forCompanies: "for-companies",
  portalAndApp: "portal-and-app",
} as const;

/**
 * The other LogisticBay websites this site links to (BRAND.md § Navigation).
 * Separate products: links only — no shared sign-in, cookie or data.
 */
export const LOGISTICBAY = {
  home: "https://logisticbay.com",
  tms: "https://tms.logisticbay.com",
  support: "mailto:support@logisticbay.com",
} as const;

export type SectionId = (typeof SECTION)[keyof typeof SECTION];

/** A link to a homepage section that works from any page on the site. */
export function sectionHref(id: SectionId): { pathname: string; hash: string } {
  return { pathname: PATHS.home, hash: `#${id}` };
}
