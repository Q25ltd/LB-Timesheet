import { useEffect, useRef } from "react";
import { Outlet, ScrollRestoration, useLocation } from "react-router";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";
import "../styles/site.css";

/**
 * The frame every page shares: skip link, header, the page, footer.
 *
 * A client-side navigation does not move keyboard focus by itself, so a
 * keyboard or screen-reader user would be left on the link they pressed while
 * the page changed underneath them. After every navigation except the first
 * load, focus moves to what the navigation was for — the section a hash
 * names, or else the new page's main content. Scrolling is React Router's
 * (`ScrollRestoration`); this only moves focus, and never scrolls.
 */
export function Layout() {
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const target = location.hash === "" ? null : document.getElementById(location.hash.slice(1));
    (target ?? mainRef.current)?.focus({ preventScroll: true });
  }, [location.key, location.hash]);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <SiteHeader />
      <main id="main" ref={mainRef} tabIndex={-1}>
        <Outlet />
      </main>
      <SiteFooter />
      <ScrollRestoration />
    </>
  );
}
