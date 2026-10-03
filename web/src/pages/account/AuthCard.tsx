import type { ReactNode } from "react";
import { usePageTitle } from "../../usePageTitle";

/**
 * The frame of the company sign-in and registration pages: one card, centred
 * on the page over a band of the brand blue. The card's head says whose page
 * this is — LogisticBay Timesheets, a company account — so the product, the
 * page title and the form read as one piece rather than three stacked ones.
 *
 * `wide` is for a form whose groups sit beside their descriptions on a large
 * screen (registration); sign-in stays narrow.
 */
export function AuthCard({
  title,
  intro,
  note,
  wide = false,
  footer,
  children,
}: {
  title: string;
  intro: string;
  note?: ReactNode;
  wide?: boolean;
  footer: ReactNode;
  children: ReactNode;
}) {
  usePageTitle(title);
  return (
    <section className="auth-stage" aria-labelledby="auth-title">
      <meta name="robots" content="noindex" />
      <div className={wide ? "auth-card auth-card--wide" : "auth-card"}>
        <header className="auth-card__head">
          <p className="auth-card__eyebrow">
            LogisticBay Timesheets
            <span className="auth-card__eyebrow-rule" aria-hidden="true" />
            <span className="visually-hidden">, </span>
            <span className="auth-card__eyebrow-kind">Company account</span>
          </p>
          <h1 id="auth-title" className="auth-card__title">{title}</h1>
          <p className="auth-card__intro">{intro}</p>
          {note}
        </header>
        <div className="auth-card__body">{children}</div>
        <footer className="auth-card__foot">{footer}</footer>
      </div>
    </section>
  );
}
