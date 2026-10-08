import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "api/src/generated/**",
      "**/__fixtures__/**",
      "**/*.config.js",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Silent failure in async Fastify handlers is the single most likely
      // production bug class here. tsc does not catch either of these.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",

      // A new status string added to a union should break every switch on it.
      "@typescript-eslint/switch-exhaustiveness-check": "error",

      // Shadowing companyId/userId in a nested scope is exactly how tenant
      // leaks get written without anyone noticing.
      "no-shadow": "off",
      "@typescript-eslint/no-shadow": "error",

      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],

      "no-console": "off", // check-rules owns this, with its own exemptions
    },
  },

  {
    // Operations scripts' tests (ops/backup/) are plain ES modules run with
    // `node --test`. ops/tsconfig.json type-checks them against Node's types;
    // the same rules otherwise.
    files: ["ops/**/*.mjs"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: `${import.meta.dirname}/ops` },
    },
  },

  {
    // node:test's test() returns a promise that is not meant to be awaited at
    // the top level. This is the API's design, not a floating-promise bug.
    files: ["**/*.test.ts", "ops/**/*.test.mjs"],
    rules: { "@typescript-eslint/no-floating-promises": "off" },
  },

  {
    // The mobile workspace has its own tsconfig, so type-aware linting needs
    // its own root. Same rules otherwise -- one lint pass over both
    // workspaces, not a second, laxer standard for the app.
    files: ["mobile/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: `${import.meta.dirname}/mobile` },
    },
  },

  {
    // The web workspace, on the same footing: its own tsconfig root, the same
    // rules -- plus the web tier's own guardrails. check-rules scans the API
    // only, so what it enforces there that also matters in a browser is
    // enforced here instead.
    files: ["web/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: `${import.meta.dirname}/web` },
    },
    rules: {
      // CLAUDE.md: no console.* in src.
      "no-console": "error",

      // D45: in a browser no credential is ever persisted where JavaScript
      // can read it. Nothing in web/ needs browser storage today, so all of
      // it is closed; a genuine non-credential use is a reviewed exception
      // (`eslint-disable-next-line` with a reason), not a quiet default.
      "no-restricted-globals": [
        "error",
        { name: "localStorage", message: "D45: no browser persistence in web/ without a reviewed exception." },
        { name: "sessionStorage", message: "D45: no browser persistence in web/ without a reviewed exception." },
        { name: "indexedDB", message: "D45: no browser persistence in web/ without a reviewed exception." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "window", property: "localStorage", message: "D45: no browser persistence in web/ without a reviewed exception." },
        { object: "window", property: "sessionStorage", message: "D45: no browser persistence in web/ without a reviewed exception." },
        { object: "window", property: "indexedDB", message: "D45: no browser persistence in web/ without a reviewed exception." },
        { object: "document", property: "cookie", message: "D45: the refresh credential is an HttpOnly cookie the page never reads." },
      ],

      // XSS is the web tier's main exposure (D45 keeps tokens in memory, so
      // injected script is what could reach them). React escapes everything
      // it renders; this is the one way around that.
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "Raw HTML bypasses React's escaping -- the web tier's XSS guard. Render elements instead.",
        },
      ],
    },
  },

  {
    // Jest supplies these as globals; unlike node:test they are not imported.
    files: ["mobile/jest.setup.js", "mobile/**/*.test.{ts,tsx}"],
    languageOptions: {
      globals: {
        jest: "readonly", expect: "readonly", test: "readonly", describe: "readonly",
        beforeEach: "readonly", afterEach: "readonly", beforeAll: "readonly", afterAll: "readonly",
      },
    },
  },

  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
