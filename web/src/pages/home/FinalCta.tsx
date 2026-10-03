import { Link } from "react-router";
import { PATHS } from "../../paths";

export function FinalCta() {
  return (
    <section className="final-cta" aria-labelledby="final-cta-title">
      <div className="container final-cta__inner">
        <h2 id="final-cta-title" className="final-cta__title">
          Ready to leave the paper timesheet behind?
        </h2>
        <p className="final-cta__body">Company accounts are not open yet. When they are, this is where you will start.</p>
        <div className="final-cta__actions">
          <Link className="button button--on-dark button--large" to={PATHS.register}>
            Register company
          </Link>
          <Link className="button button--outline-on-dark button--large" to={PATHS.login}>
            Sign in
          </Link>
        </div>
      </div>
    </section>
  );
}
