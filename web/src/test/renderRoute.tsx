import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { AuthProvider } from "../auth/AuthProvider";
import { routes } from "../routes";

/**
 * Renders the site's REAL route table (`routes.tsx`) at one address, through
 * a memory router, so a test sees exactly what a visitor to that address
 * would — not a component rendered in isolation.
 */
export function renderRoute(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return { router, ...render(<AuthProvider><RouterProvider router={router} /></AuthProvider>) };
}
