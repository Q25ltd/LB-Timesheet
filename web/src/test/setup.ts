import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { installFakeApi } from "./fakeApi";

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

// No test reaches a real network. Every test starts with a fake API that
// answers everything with the canonical 401 (an anonymous visitor); a test
// that needs more scripts its own with `installFakeApi()`.
beforeEach(() => {
  installFakeApi();
});
afterEach(() => {
  vi.unstubAllGlobals();
});
