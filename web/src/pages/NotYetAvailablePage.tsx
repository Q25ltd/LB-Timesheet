import { Link } from "react-router";
import { SECTION, sectionHref, PATHS } from "../paths";
import { usePageTitle } from "../usePageTitle";

/**
 * Where "Get started", "Log in" and "Company login" lead until company
 * accounts exist (D43 gives them these addresses; STATUS.md says they are
 * not built).
 *
 * It says so, and does nothing else. It has no form, no field and no button
 * that submits anything, because an account form with nothing behind it would
 * pretend registration and login exist. The tests hold that: a form or a
 * credential field appearing here fails them. `noindex` keeps a search engine
 * from listing a page whose only message is "not yet".
 */
const COPY = {
  registration: {
    title: "Company registration is not open yet",
    body: "Company accounts for LogisticBay Timesheets are the next stage of development. Registration will open at this address when they are ready.",
  },
  login: {
    title: "Company login is not available yet",
    body: "There are no company accounts yet, so there is nothing to sign in to. Company login will open at this address when accounts are ready.",
  },
} as const;

export function NotYetAvailablePage({ feature }: { feature: keyof typeof COPY }) {
  const copy = COPY[feature];
  usePageTitle(copy.title);
  return (
    <section className="notice" aria-labelledby="notice-title">
      <meta name="robots" content="noindex" />
      <div className="container notice__inner">
        <p className="eyebrow">Not available yet</p>
        <h1 id="notice-title" className="notice__title">
          {copy.title}
        </h1>
        <p className="notice__body">{copy.body}</p>
        <div className="notice__actions">
          <Link className="button button--primary" to={PATHS.home}>
            Back to the homepage
          </Link>
          <Link className="button button--secondary" to={sectionHref(SECTION.howItWorks)}>
            See how it works
          </Link>
        </div>
      </div>
    </section>
  );
}
