import { useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";

/**
 * DEVELOPMENT ONLY — rendered by the page only when `import.meta.env.DEV`,
 * so a production build contains none of it, and the API route it asks has
 * no existence in production either (`api/src/routes/devEmail.ts`).
 *
 * In development email is not delivered; the API writes each message to
 * `api/.mail-outbox/`. This shows the verification link that message
 * contains — the same URL and the same single-use token a real email would
 * carry — so opening it runs the NORMAL confirmation. Nothing is verified or
 * created here. `revision` changes after a resend, and the page then shows
 * the NEW link: the API hands out only the account's current one.
 *
 * Only a link to THIS site's verification page is ever offered.
 */
export function DevelopmentEmail({ revision }: { revision: number }) {
  const { developmentVerificationLink } = useAuth();
  const [link, setLink] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let current = true;
    setLink(undefined);
    void developmentVerificationLink().then(found => {
      if (current) setLink(found !== null && isOwnVerificationPage(found) ? found : null);
    });
    return () => { current = false; };
  }, [developmentVerificationLink, revision]);

  return (
    <section className="dev-email" aria-labelledby="dev-email-title">
      <h2 id="dev-email-title" className="dev-email__title">Development email</h2>
      <p className="dev-email__line">
        Email is not sent in development — it is saved in <code>api/.mail-outbox</code>.
        {link ? " This is the link the confirmation email contains:" : null}
      </p>
      {link === undefined ? <p className="dev-email__line" role="status">Looking for the email…</p> : null}
      {link === null ? (
        <p className="dev-email__line">No verification email for this account is in the outbox. Use Send a new link.</p>
      ) : null}
      {typeof link === "string" ? (
        <a className="button button--primary button--large dev-email__open" href={link}>Open verification link</a>
      ) : null}
    </section>
  );
}

function isOwnVerificationPage(link: string): boolean {
  try {
    const url = new URL(link);
    return url.origin === window.location.origin && url.pathname === "/verify-email" && /^#token=[A-Za-z0-9_-]{1,64}$/.test(url.hash);
  } catch {
    return false;
  }
}
