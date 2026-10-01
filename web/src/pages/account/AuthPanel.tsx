import type { ReactNode } from "react";
import { usePageTitle } from "../../usePageTitle";

/** The frame every account page shares: one h1, one narrow column. */
export function AuthPanel({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) {
  usePageTitle(title);
  return (
    <section className="auth" aria-labelledby="auth-title">
      <meta name="robots" content="noindex" />
      <div className="container auth__inner">
        <h1 id="auth-title" className="auth__title">{title}</h1>
        {intro === undefined ? null : <p className="auth__intro">{intro}</p>}
        {children}
      </div>
    </section>
  );
}
