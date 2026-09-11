/**
 * Where the API lives.
 *
 * The failure this file exists to prevent: on a PHYSICAL PHONE, `localhost`
 * is the phone, not the Mac. A default of `http://localhost:3000` therefore
 * never leaves the device, the fetch fails to connect, and the UI reports a
 * connection problem that looks like bad signal — when nothing is wrong with
 * the network and everything is wrong with the address.
 *
 * Resolution order:
 *
 *   1. `EXPO_PUBLIC_API_URL` — explicit, wins always. This is what a real
 *      deployment sets, and the escape hatch when the guess below is wrong.
 *   2. The Metro dev-server host, in development. The app was downloaded
 *      from that host, so by construction the device can reach it: if Metro
 *      is on 192.168.0.235:8081, the API is on 192.168.0.235:3000. This is
 *      what makes a physical phone work with no per-machine configuration,
 *      and it is equally correct on both simulators.
 *   3. A per-platform guess, only if neither is available.
 *
 * ONLY public configuration belongs here, and only ever the API's base URL.
 * A JWT secret or a database URL in an `EXPO_PUBLIC_*` variable ships inside
 * the app bundle and is readable by anyone who installs it.
 */
import { Platform } from "react-native";
import Constants from "expo-constants";

/** The API's port. Metro's is 8081; only the host is shared. */
const API_PORT = 3000;

/**
 * The host Metro is being served from, e.g. `192.168.0.235` or `localhost`.
 *
 * `hostUri` is `host:port` and is present in development (Expo Go and dev
 * builds) and absent in a production build — which is correct, because a
 * production build must be told its API explicitly rather than guessing.
 */
function metroHost(): string | null {
  const hostUri: unknown = Constants.expoConfig?.hostUri;
  if (typeof hostUri !== "string" || hostUri.trim() === "") return null;
  const host = hostUri.split(":")[0]?.trim();
  return host === undefined || host === "" ? null : host;
}

/**
 * Last resort, and deliberately still wrong for a physical phone — there is
 * no correct guess for one. `EXPO_PUBLIC_API_URL` is the answer in that case,
 * and `describeApiResolution()` below says so out loud in development.
 */
function platformGuess(): string {
  // On an Android EMULATOR the host machine is 10.0.2.2; `localhost` is the
  // emulator itself. On an iOS simulator `localhost` really is the Mac.
  const host = Platform.OS === "android" ? "10.0.2.2" : "localhost";
  return `http://${host}:${String(API_PORT)}`;
}

export function apiBaseUrl(): string {
  // `unknown`, then narrowed: Expo inlines EXPO_PUBLIC_* at build time and
  // the value is untyped, so treating it as a string without checking is an
  // assumption about the build, not a fact about the code.
  const configured: unknown = process.env["EXPO_PUBLIC_API_URL"];
  if (typeof configured === "string" && configured.trim() !== "") return configured.trim();

  const host = metroHost();
  if (host !== null) return `http://${host}:${String(API_PORT)}`;

  return platformGuess();
}

/**
 * How the URL above was chosen, for DEVELOPMENT diagnostics only.
 *
 * A connection failure during development is almost always a wrong address,
 * not a wrong network — and "check your signal" sends the reader to look at
 * the wrong thing entirely. Callers must gate this on `__DEV__`: an end user
 * has no use for an internal hostname, and a production build should not
 * put one on screen.
 */
export function describeApiResolution(): string {
  const configured: unknown = process.env["EXPO_PUBLIC_API_URL"];
  if (typeof configured === "string" && configured.trim() !== "") {
    return `EXPO_PUBLIC_API_URL=${configured.trim()}`;
  }
  const host = metroHost();
  if (host !== null) return `derived from the Metro host (${host})`;
  return `platform guess for ${Platform.OS} — set EXPO_PUBLIC_API_URL if this is a physical device`;
}
