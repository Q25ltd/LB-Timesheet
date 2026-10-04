import { useRef } from "react";
import { Outlet, ScrollRestoration } from "react-router";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";
import { useNavigationFocus } from "./useNavigationFocus";
import "../styles/site.css";

/**
 * The frame every public and account page shares: skip link, header, the
 * page, footer. Focus follows navigation (`useNavigationFocus`).
 */
export function Layout() {
  const mainRef = useRef<HTMLElement>(null);
  useNavigationFocus(mainRef);

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
