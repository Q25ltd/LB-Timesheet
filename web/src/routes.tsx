import type { RouteObject } from "react-router";
import { Layout } from "./components/Layout";
import { HomePage } from "./pages/HomePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { NotYetAvailablePage } from "./pages/NotYetAvailablePage";

/**
 * The site's routes. Exported as data so the tests render exactly these,
 * through a memory router, rather than a copy that could disagree.
 */
export const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "register", element: <NotYetAvailablePage feature="registration" /> },
      { path: "login", element: <NotYetAvailablePage feature="login" /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];
