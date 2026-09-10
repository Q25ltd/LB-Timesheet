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
    // node:test's test() returns a promise that is not meant to be awaited at
    // the top level. This is the API's design, not a floating-promise bug.
    files: ["**/*.test.ts"],
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
