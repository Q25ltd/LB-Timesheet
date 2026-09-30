import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom lays nothing out, so it implements no scrolling. React Router's
// ScrollRestoration calls these; they are given no-op bodies so a test
// exercises the site rather than jsdom's "not implemented" noise. Nothing
// here asserts on scrolling — that is verified in a real browser.
window.scrollTo = () => undefined;
Element.prototype.scrollIntoView = () => undefined;

// Vitest's globals are off, so Testing Library cannot register its own
// cleanup: each test starts from an empty document.
afterEach(() => {
  cleanup();
});
