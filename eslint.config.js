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
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
