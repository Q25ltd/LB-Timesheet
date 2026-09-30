import { Link } from "react-router";
import { PATHS, SECTION, sectionHref } from "../paths";
import { BrandLockup } from "./BrandLockup";

/**
 * Only what exists: the product, the page's own sections and the company that
 * owns LogisticBay (D11). No address, social account, certification or legal
 * page is linked, because none exists yet.
 */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container site-footer__inner">
        <div className="site-footer__brand">
          <Link to={PATHS.home} aria-label="LogisticBay Timesheets home">
            <BrandLockup className="brand-lockup--small" />
          </Link>
          <p className="site-footer__tagline">Driver timesheets and vehicle checks, on the phone instead of paper.</p>
        </div>
        <nav aria-label="Footer">
          <ul className="site-footer__links">
            <li>
              <Link to={sectionHref(SECTION.howItWorks)}>How it works</Link>
            </li>
            <li>
              <Link to={sectionHref(SECTION.features)}>Features</Link>
            </li>
            <li>
              <Link to={sectionHref(SECTION.forCompanies)}>For companies</Link>
            </li>
          </ul>
        </nav>
      </div>
      <div className="container site-footer__legal">
        <p>© {new Date().getFullYear()} Q25 Ltd. LogisticBay Timesheets.</p>
      </div>
    </footer>
  );
}
