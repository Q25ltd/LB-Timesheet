import { Link } from "react-router";
import { ActiveShiftPhone } from "../../components/DriverPhone";
import { PATHS, SECTION, sectionHref } from "../../paths";

export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="container hero__inner">
        <div className="hero__copy">
          <p className="eyebrow">For UK haulage and transport companies</p>
          <h1 id="hero-title" className="hero__title">
            Driver timesheets without the paperwork.
          </h1>
          <p className="hero__lead">
            Drivers record their working day on their phone — start and finish times, vehicles and trailers,
            walkaround checks, mileage, fuel and defects — instead of on paper forms.
          </p>
          <div className="hero__actions">
            <Link className="button button--primary button--large" to={PATHS.register}>
              Register company
            </Link>
            <Link className="button button--secondary button--large" to={sectionHref(SECTION.howItWorks)}>
              See how it works
            </Link>
          </div>
          <p className="hero__signin">
            Already registered? <Link to={PATHS.login}>Sign in</Link>
          </p>
        </div>
        <div className="hero__visual">
          <ActiveShiftPhone />
        </div>
      </div>
    </section>
  );
}
