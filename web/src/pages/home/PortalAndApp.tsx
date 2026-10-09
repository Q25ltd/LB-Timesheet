import portal1200 from "../../assets/screens/portal-company-1200.webp";
import portal2000 from "../../assets/screens/portal-company-2000.webp";
import { Icon } from "../../components/Icon";
import { StartShiftPhone } from "../../components/DriverPhone";
import { PATHS, SECTION } from "../../paths";
import { Link } from "react-router";

/**
 * Two interfaces, two kinds of user — said plainly, because the difference
 * matters: company registration creates COMPANY access in the web portal; it
 * never creates a driver account. Drivers make their own account in the app
 * (D21). How the two will be connected is not built, so that sentence lives
 * only inside the `data-status="planned"` note, which says so.
 *
 * Both pictures are real captures with fictional data ("Example Haulage",
 * driver "Sam Taylor").
 */
const PORTAL = [
  "Register your company and the administrator who manages it",
  "Your company's own workspace, separate from every other company",
  "Used in the office, on a computer",
] as const;

const APP = [
  "Each driver makes their own account in the app",
  "Start and finish times, vehicles and trailers, checks, mileage, fuel and AdBlue / DEF",
  "Keeps working without signal",
] as const;

export function PortalAndApp() {
  return (
    <section id={SECTION.portalAndApp} className="section section--tinted parts" aria-labelledby="parts-title" tabIndex={-1}>
      <div className="container">
        <div className="parts__header">
          <p className="eyebrow">Company portal and driver app</p>
          <h2 id="parts-title" className="section-heading">
            Two parts, <span className="parts__heading-line">for two kinds of user.</span>
          </h2>
          <p className="section-intro">
            The office uses the company portal on the web. Drivers use the Timesheets app on their phone. Registering a
            company does not create driver accounts.
          </p>
        </div>

        <div className="parts__grid">
          <article className="part" aria-labelledby="part-portal-title">
            <div className="part__copy">
              <span className="part__icon"><Icon name="building" /></span>
              <h3 id="part-portal-title" className="part__title">Company portal</h3>
              <p className="part__where">On the web, for the office</p>
              <ul className="part__list">
                {PORTAL.map(item => (
                  <li key={item}>
                    <Icon name="check" className="part__tick" />
                    {item}
                  </li>
                ))}
              </ul>
              <Link className="part__link" to={PATHS.register}>Register company</Link>
            </div>
            <figure className="part__screen part__screen--browser">
              <div className="browser" aria-hidden="true">
                <span className="browser__dots"><i /><i /><i /></span>
                <span className="browser__address">timesheets.logisticbay.com/company</span>
              </div>
              <img
                src={portal1200}
                srcSet={`${portal1200} 1200w, ${portal2000} 2000w`}
                sizes="(max-width: 899px) 92vw, 560px"
                width={1200}
                height={750}
                loading="lazy"
                decoding="async"
                alt="The company workspace for Example Haulage: a getting-started checklist with the company created, and the later steps marked as not available yet."
              />
            </figure>
          </article>

          <article className="part" aria-labelledby="part-app-title">
            <div className="part__copy">
              <span className="part__icon"><Icon name="phone" /></span>
              <h3 id="part-app-title" className="part__title">Driver app</h3>
              <p className="part__where">On the phone, for the driver</p>
              <ul className="part__list">
                {APP.map(item => (
                  <li key={item}>
                    <Icon name="check" className="part__tick" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="part__screen part__screen--phone">
              <StartShiftPhone />
            </div>
          </article>
        </div>

        <p className="parts__caption">Real interfaces, fictional demonstration data.</p>

        <p className="parts__planned" data-status="planned">
          <span className="status">Pre-release</span>
          Connecting a driver&apos;s app to their company is in development — not available yet.
        </p>
      </div>
    </section>
  );
}
