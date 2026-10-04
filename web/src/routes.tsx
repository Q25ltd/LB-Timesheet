import type { RouteObject } from "react-router";
import { Layout } from "./components/Layout";
import { HomePage } from "./pages/HomePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { AccountPage } from "./pages/account/AccountPage";
import { ForgotPasswordPage } from "./pages/account/ForgotPasswordPage";
import { LoginPage } from "./pages/account/LoginPage";
import { RegisterPage } from "./pages/account/RegisterPage";
import { RequireAccount } from "./pages/account/RequireAccount";
import { ResetPasswordPage } from "./pages/account/ResetPasswordPage";
import { VerifyEmailPage } from "./pages/account/VerifyEmailPage";
import { CompanyHome } from "./pages/company/CompanyHome";
import { CompanyShell } from "./pages/company/CompanyShell";
import "./styles/auth.css";

/**
 * The site's routes. Exported as data so the tests render exactly these,
 * through a memory router, rather than a copy that could disagree.
 *
 * `RequireAccount` is presentation only: what a signed-in page may DO is
 * decided by the API on every request (D44, D45).
 *
 * Two frames: the public site and account pages (`Layout`), and the company
 * workspace (`CompanyShell` — its own header and navigation). `/company` is
 * the workspace's Home; its later areas become children of that route.
 */
export const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "register", element: <RegisterPage /> },
      { path: "login", element: <LoginPage /> },
      { path: "verify-email", element: <VerifyEmailPage /> },
      { path: "forgot-password", element: <ForgotPasswordPage /> },
      { path: "reset-password", element: <ResetPasswordPage /> },
      { path: "account", element: <RequireAccount><AccountPage /></RequireAccount> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
  {
    path: "company",
    element: <CompanyShell />,
    children: [
      { index: true, element: <CompanyHome /> },
    ],
  },
];
