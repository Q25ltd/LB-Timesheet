/**
 * How the app decides WHERE the API is.
 *
 * This exists because of a real failure: on a physical phone the default was
 * `http://localhost:3000`, which on a phone is the phone. The request never
 * left the device, and the UI reported it as a connection problem — sending
 * the reader to inspect the network rather than the address.
 */
const mockConstants: { expoConfig: { hostUri?: string } | null } = { expoConfig: null };

jest.mock("expo-constants", () => ({
  __esModule: true,
  get default() { return mockConstants; },
}));

// react-native is deliberately NOT mocked. A wholesale module mock leaks
// into other suites sharing this Jest worker — jest-expo then re-resolves
// Expo's lazy `fetch` global during teardown and logs after the run, which
// Jest fails the entire run for — and `requireActual` eagerly pulls in
// TurboModules that do not exist under Jest. Replacing the one property on
// the real object avoids both.
import { Platform } from "react-native";
import { apiBaseUrl, describeApiResolution } from "../api/config";

function setPlatform(os: "ios" | "android"): void {
  jest.replaceProperty(Platform, "OS", os);
}

// `unknown`, then narrowed — the same discipline config.ts uses. Under the
// repo's type-aware lint `process.env` indexes to `any`, and an annotated
// capture would launder that straight through the restore below.
const RAW_ENV: unknown = process.env["EXPO_PUBLIC_API_URL"];
const ORIGINAL_ENV = typeof RAW_ENV === "string" ? RAW_ENV : undefined;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env["EXPO_PUBLIC_API_URL"];
  else process.env["EXPO_PUBLIC_API_URL"] = ORIGINAL_ENV;
  mockConstants.expoConfig = null;
  jest.restoreAllMocks();
});

test("an explicit EXPO_PUBLIC_API_URL wins over everything else", () => {
  process.env["EXPO_PUBLIC_API_URL"] = "https://api.example.com";
  mockConstants.expoConfig = { hostUri: "192.168.0.235:8081" };

  expect(apiBaseUrl()).toBe("https://api.example.com");
  expect(describeApiResolution()).toContain("EXPO_PUBLIC_API_URL");
});

test("a surrounding-whitespace or empty override is ignored rather than used verbatim", () => {
  mockConstants.expoConfig = { hostUri: "192.168.0.235:8081" };

  process.env["EXPO_PUBLIC_API_URL"] = "   ";
  expect(apiBaseUrl()).toBe("http://192.168.0.235:3000");

  process.env["EXPO_PUBLIC_API_URL"] = "  https://api.example.com  ";
  expect(apiBaseUrl()).toBe("https://api.example.com");
});

test("the API host is derived from the Metro host — the physical-phone case", () => {
  // The device downloaded the bundle from this host, so by construction it
  // can reach it. THIS is the fix: `localhost` would be the phone itself.
  delete process.env["EXPO_PUBLIC_API_URL"];
  mockConstants.expoConfig = { hostUri: "192.168.0.235:8081" };

  expect(apiBaseUrl()).toBe("http://192.168.0.235:3000");
  expect(apiBaseUrl()).not.toContain("localhost");
  expect(describeApiResolution()).toContain("192.168.0.235");
});

test("the Metro host is used on a simulator too, so one rule covers every runtime", () => {
  delete process.env["EXPO_PUBLIC_API_URL"];
  mockConstants.expoConfig = { hostUri: "localhost:8081" };
  expect(apiBaseUrl()).toBe("http://localhost:3000");
});

test("with no Metro host the platform guess applies, and Android does not use localhost", () => {
  // A production build has no hostUri. The guess is a last resort and is
  // still wrong for a physical device — which is what the description says.
  delete process.env["EXPO_PUBLIC_API_URL"];
  mockConstants.expoConfig = null;

  setPlatform("ios");
  expect(apiBaseUrl()).toBe("http://localhost:3000");

  // On an Android EMULATOR the host machine is 10.0.2.2, never localhost.
  setPlatform("android");
  expect(apiBaseUrl()).toBe("http://10.0.2.2:3000");
  expect(describeApiResolution()).toContain("EXPO_PUBLIC_API_URL");
});

test("a malformed hostUri falls back rather than producing a broken URL", () => {
  delete process.env["EXPO_PUBLIC_API_URL"];
  mockConstants.expoConfig = { hostUri: "" };
  expect(apiBaseUrl()).toBe("http://localhost:3000");
});
