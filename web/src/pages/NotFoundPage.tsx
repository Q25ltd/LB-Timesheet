import { Link } from "react-router";
import { PATHS } from "../paths";
import { usePageTitle } from "../usePageTitle";

export function NotFoundPage() {
  usePageTitle("Page not found");
  return (
    <section className="notice" aria-labelledby="notice-title">
      <meta name="robots" content="noindex" />
      <div className="container notice__inner">
        <h1 id="notice-title" className="notice__title">
          Page not found
        </h1>
        <p className="notice__body">There is nothing at this address.</p>
        <div className="notice__actions">
          <Link className="button button--primary" to={PATHS.home}>
            Back to the homepage
          </Link>
        </div>
      </div>
    </section>
  );
}
