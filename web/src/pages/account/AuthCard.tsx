import type { ReactNode } from "react";
import { usePageTitle } from "../../usePageTitle";

/**
 * The frame of the company sign-in and registration pages, in the
 * homepage's language: the product line, a large centred headline and a
 * short intro on the light page, then the form on a card rising out of the
 * same ruled brand-blue stage the homepage's phone stands on.
 *
 * The page's identity is centred; the form inside the card stays
 * left-aligned, because labels and fields are read, not looked at.
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
      <header className="container auth-head">
        <p className="auth-head__eyebrow">
          <span className="auth-head__product">LogisticBay Timesheets</span>
          <span className="visually-hidden">, </span>
          <span className="auth-head__kind">Company account</span>
        </p>
        <h1 id="auth-title" className="auth-head__title">{title}</h1>
        <p className="auth-head__intro">{intro}</p>
        {note}
      </header>
      <div className="auth-band">
        <div className="container">
          <div className={wide ? "auth-card auth-card--wide" : "auth-card"}>
            <div className="auth-card__body">{children}</div>
            <footer className="auth-card__foot">{footer}</footer>
          </div>
        </div>
      </div>
    </section>
  );
}
