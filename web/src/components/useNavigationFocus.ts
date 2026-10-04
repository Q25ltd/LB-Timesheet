import { useEffect, useRef, type RefObject } from "react";
import { useLocation } from "react-router";

/**
 * A client-side navigation does not move keyboard focus by itself, so a
 * keyboard or screen-reader user would be left on the link they pressed while
 * the page changed underneath them. After every navigation except the first
 * load, focus moves to what the navigation was for — the section a hash
 * names, or else the page's main content. Scrolling is React Router's
 * (`ScrollRestoration`); this only moves focus, and never scrolls.
 *
 * Shared by every frame that holds a `<main>`: the public site (`Layout`)
 * and the company workspace (`CompanyShell`).
 */
export function useNavigationFocus(mainRef: RefObject<HTMLElement | null>): void {
  const location = useLocation();
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const target = location.hash === "" ? null : document.getElementById(location.hash.slice(1));
    (target ?? mainRef.current)?.focus({ preventScroll: true });
  }, [location.key, location.hash, mainRef]);
}
