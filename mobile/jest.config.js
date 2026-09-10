/**
 * jest-expo is the supported preset for a React Native app: it wires the RN
 * transformer, the platform mocks and babel-preset-expo, none of which
 * `node --test` (the API's runner) can provide for JSX and native modules.
 *
 * The API workspace keeps node:test. Two runners, one per runtime, both
 * reached through the root `npm run check` — not two independent pipelines.
 */
module.exports = {
  preset: "jest-expo",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  testMatch: ["<rootDir>/src/**/*.test.tsx", "<rootDir>/src/**/*.test.ts"],
  collectCoverage: false,
};
