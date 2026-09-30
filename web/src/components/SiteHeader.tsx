import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { PATHS, SECTION, sectionHref } from "../paths";
import { BrandLockup } from "./BrandLockup";

const NAV_ITEMS = [
  { label: "How it works", to: sectionHref(SECTION.howItWorks) },
  { label: "Features", to: sectionHref(SECTION.features) },
  { label: "For companies", to: sectionHref(SECTION.forCompanies) },
] as const;

/**
 * One navigation, not a desktop copy and a mobile copy: on a narrow screen
 * the same links collapse behind a Menu button (a disclosure — `aria-expanded`
 * on the button, the panel it controls). Escape closes it and returns focus
 * to the button; following any link closes it.
 */
export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();

  // Any navigation — a section link or another page — closes the menu.
  useEffect(() => {
    setOpen(false);
  }, [location.key]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <header className="site-header" data-menu-open={open}>
      <div className="container site-header__bar">
        <Link to={PATHS.home} className="site-header__brand" aria-label="LogisticBay Timesheets home">
          <BrandLockup />
        </Link>

        <button
          ref={toggleRef}
          type="button"
          className="site-header__toggle"
          aria-expanded={open}
          aria-controls="site-menu"
          onClick={() => setOpen(value => !value)}
        >
          <span className="site-header__toggle-icon" aria-hidden="true" />
          <span className="site-header__toggle-label">{open ? "Close" : "Menu"}</span>
        </button>

        <div id="site-menu" className="site-header__menu">
          <nav aria-label="Main">
            <ul className="site-nav">
              {NAV_ITEMS.map(item => (
                <li key={item.label}>
                  <Link className="site-nav__link" to={item.to}>
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="site-header__actions">
            <Link className="site-header__login" to={PATHS.login}>
              Log in
            </Link>
            <Link className="button button--primary" to={PATHS.register}>
              Get started
            </Link>
          </div>
        </div>
      </div>
    </header>
  );
}
