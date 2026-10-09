import { Link } from "react-router";
import { ActiveShiftPhone } from "../../components/DriverPhone";
import { Icon } from "../../components/Icon";
import { PATHS, SECTION, sectionHref } from "../../paths";
import { PaperTimesheet } from "./PaperTimesheet";

/**
 * A centred, product-led hero: the promise, the two actions, then the day
 * itself on the brand stage — the paper it replaces on the left, the shift in
 * progress on the phone in the middle, and the end-of-day review on the
 * right. Both side pieces are decoration (hidden from assistive technology);
 * the phone is the one described image.
 */
export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="container hero__copy">
        <span className="status hero__status">Pre-release</span>
        <p className="hero__eyebrow">
          <span className="hero__product">LogisticBay Timesheets</span>
          <span className="hero__audience">For haulage and transport companies</span>
        </p>
        <h1 id="hero-title" className="hero__title">
          Driver timesheets <span className="hero__title-line">without the paperwork.</span>
        </h1>
        <p className="hero__lead">
          Your drivers record the working day on their phone instead of on a paper timesheet and check sheet — start
          and finish times, vehicles and trailers, walkaround checks, mileage, fuel and defects.
        </p>
        <div className="hero__actions">
          <Link className="button button--primary button--large" to={PATHS.register}>
            Register company
          </Link>
          <Link className="button button--secondary button--large" to={PATHS.login}>
            Sign in
          </Link>
        </div>
        <Link className="hero__more" to={sectionHref(SECTION.howItWorks)}>
          See how it works
        </Link>
      </div>

      <div className="hero__stage">
        <div className="container hero__visual">
          <PaperTimesheet />
          <ActiveShiftPhone />
          <div className="hero-review" aria-hidden="true">
            <span className="hero-review__title">Review</span>
            <span className="hero-review__row"><span>Started</span><b>06:00</b></span>
            <span className="hero-review__row"><span>Finished</span><b>16:30</b></span>
            <span className="hero-review__row"><span>Duration</span><b>10 h 30 min</b></span>
            <span className="hero-review__confirm">
              <span className="hero-review__box"><Icon name="check" /></span>
              I confirm all details are correct
            </span>
            <span className="hero-review__button">Save Timesheet</span>
          </div>
        </div>
      </div>
    </section>
  );
}
