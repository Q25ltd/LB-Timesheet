/**
 * Where the API lives. The smallest thing that works on every surface a
 * driver or a developer actually uses.
 *
 * `EXPO_PUBLIC_API_URL` wins when set — that is Expo's own mechanism for
 * build-time public configuration, and it is what a real deployment will use.
 * Without it, the default is chosen per platform because "localhost" means
 * different things in each emulator:
 *
 *   iOS simulator    localhost is the Mac
 *   Android emulator localhost is the EMULATOR; 10.0.2.2 is the host machine
 *   physical phone   neither works — set EXPO_PUBLIC_API_URL to the Mac's LAN address
 *
 * ONLY public configuration belongs in this file, and only ever the API's
 * base URL. A JWT secret, a database URL or any other server credential in
 * an `EXPO_PUBLIC_*` variable is shipped inside the app bundle and readable
 * by anyone who installs it.
 */
import { Platform } from "react-native";

const DEFAULT_PORT = 3000;

function defaultBaseUrl(): string {
  const host = Platform.OS === "android" ? "10.0.2.2" : "localhost";
  return `http://${host}:${String(DEFAULT_PORT)}`;
}

export function apiBaseUrl(): string {
  // `unknown`, then narrowed: Expo inlines EXPO_PUBLIC_* at build time and
  // the value is untyped, so treating it as a string without checking is an
  // assumption about the build, not a fact about the code.
  const configured: unknown = process.env["EXPO_PUBLIC_API_URL"];
  if (typeof configured !== "string" || configured.trim() === "") return defaultBaseUrl();
  return configured.trim();
}
