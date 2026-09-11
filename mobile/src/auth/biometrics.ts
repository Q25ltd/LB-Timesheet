/**
 * Biometric LOCAL DEVICE authentication — the whole of it, in one module.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE SECURITY CONTRACT — read this before touching anything here
 * ════════════════════════════════════════════════════════════════════════════
 *
 * A biometric success UNLOCKS PERMISSION TO USE the refresh credential this
 * device already holds. It is NOT authentication.
 *
 *   Face ID success
 *     → the app may read the SecureStore refresh secret
 *     → POST /auth/refresh
 *     → the SERVER validates the Session and issues fresh material
 *     → only THEN is the app authenticated
 *
 * It must never:
 *   - set an authenticated flag;
 *   - mint or fabricate an identity or tenant token;
 *   - create company authority;
 *   - bypass Session validation or `/auth/refresh`;
 *   - reach the authenticated app without a server round trip.
 *
 * Which is why this module returns a `boolean` and holds no tokens, no user,
 * no session and no API client. It cannot authenticate anyone: it has nothing
 * to authenticate with. The only caller is `AuthContext`, which treats a
 * `true` as permission to attempt a refresh and nothing more.
 *
 * NO biometric data, template or score is sent anywhere. There is no backend
 * biometric endpoint and no biometric column in the database — the OS answers
 * yes or no, on the device, and that answer never leaves it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE TRADE-OFF, stated honestly for the auditor
 * ════════════════════════════════════════════════════════════════════════════
 *
 * This is an APPLICATION-LEVEL gate in front of a SecureStore-protected
 * credential. It is NOT a hardware biometric-bound encryption key: the refresh
 * secret is stored WITHOUT `requireAuthentication`, so it is protected by the
 * keychain/keystore and the app sandbox, not by the biometric itself.
 *
 * On a fully compromised device — jailbroken, rooted, or with the app's
 * keychain otherwise readable — the secret can be read without presenting a
 * face or finger, and this gate does not prevent that. It is not claimed to.
 *
 * `requireAuthentication: true` was considered and rejected for measured
 * reasons (owner decision, 2026-09-11), all from the installed
 * `expo-secure-store@57.0.3` typings:
 *   - "Keys are invalidated by the system when biometrics change… it becomes
 *     impossible to read its value" — adding a fingerprint would permanently
 *     destroy a VALID server session;
 *   - on Android "user authentication is required for all operations", so
 *     biometrics could not stay optional;
 *   - "not supported in Expo Go when biometric authentication is available",
 *     which would break development;
 *   - it "would not work in tandem with the keychainService value used for
 *     the others non-authenticated operations".
 */
import { AppState } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";

/** What the device can actually do, and therefore what the UI may offer. */
export interface BiometricCapability {
  /** Hardware present AND a biometric enrolled. Anything less is unusable. */
  available: boolean;
  /**
   * Platform-appropriate wording for a control — "Face ID", "Touch ID" or
   * the generic "biometrics". Derived from what the OS reports, never
   * hard-coded: an Android phone must not be offered Face ID, and an iPhone
   * with a fingerprint reader must not be offered Face ID either.
   */
  label: string;
}

const UNAVAILABLE: BiometricCapability = { available: false, label: "biometrics" };

/**
 * The label for the enrolled method.
 *
 * iOS names its two systems and drivers know them by name, so using the
 * generic word there would read as a different, lesser feature. Android
 * fragments across fingerprint, face and iris with vendor-specific names, so
 * the generic word is the honest one.
 */
function describe(types: LocalAuthentication.AuthenticationType[], ios: boolean): string {
  if (!ios) return "biometrics";
  if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) return "Face ID";
  if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) return "Touch ID";
  return "biometrics";
}

/**
 * What this device offers right now.
 *
 * Re-read every time rather than cached: a driver can enrol or remove a
 * biometric while the app is backgrounded, and a stale "available" would
 * offer a control that cannot work.
 *
 * Every failure path answers "unavailable". A phone that cannot tell us about
 * its hardware is a phone whose biometrics we must not offer — and never a
 * reason to fail a sign-in, because email and password always remain.
 */
export async function biometricCapability(isIos: boolean): Promise<BiometricCapability> {
  try {
    const [hardware, enrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    // BOTH are required. Hardware without enrolment is the common case on a
    // fresh phone, and prompting there shows the driver a dialog they cannot
    // satisfy.
    if (!hardware || !enrolled) return UNAVAILABLE;

    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    return { available: true, label: describe(types, isIos) };
  } catch {
    // The native module is missing (Expo Go without the config plugin), or
    // the platform refused to answer. Not an error the driver should see.
    return UNAVAILABLE;
  }
}

/**
 * Wait until the app is genuinely FOREGROUND-ACTIVE.
 *
 * This exists because of a physical-device failure mode that no simulator and
 * no Jest run reproduces. Session restoration starts from a mount effect on
 * cold launch, which can fire while iOS still reports the app as `inactive` —
 * the window is up but not yet frontmost. Presenting `LAContext` then is
 * refused by the OS and comes back as `system_cancel` / `app_cancel`, which
 * this module (correctly) collapses to "false". The driver sees the sign-in
 * form and no Face ID prompt at all, and nothing in the logs says why.
 *
 * So the prompt is deferred until `active`. Bounded: if the state never
 * settles — the app was launched straight into the background, or the launch
 * is being cancelled — it gives up and the caller falls back to the password
 * form, which is the same safe answer as a declined prompt.
 */
const ACTIVE_WAIT_MS = 3000;

/**
 * States the OS reports when it is NOT ready for a modal prompt. Anything
 * else — including `null` and the platforms' "unknown" — is treated as ready.
 *
 * Deliberately an allow-by-default check on a DENY list, which is the
 * opposite of this codebase's usual polarity, and the reason is specific: the
 * cost of waiting when we did not need to is a driver staring at a spinner
 * for three seconds, while the cost of not waiting is the bug this function
 * exists for. Only the two states that genuinely mean "not frontmost" defer.
 */
const NOT_READY: readonly string[] = ["inactive", "background"];

async function waitUntilActive(): Promise<boolean> {
  if (!NOT_READY.includes(String(AppState.currentState))) return true;

  return new Promise<boolean>(resolve => {
    let settled = false;
    const finish = (active: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription.remove();
      resolve(active);
    };
    const timer = setTimeout(() => { finish(false); }, ACTIVE_WAIT_MS);
    const subscription = AppState.addEventListener("change", state => {
      if (state === "active") finish(true);
    });
    // Re-checked after subscribing, so a transition between the check above
    // and the listener being attached cannot be missed.
    if (AppState.currentState === "active") finish(true);
  });
}

/**
 * Ask the OS to authenticate the person holding the phone.
 *
 * Returns true ONLY on an explicit platform success. Cancel, failure,
 * lockout, a missing enrolment, a changed enrolment and every error code
 * collapse to false, because the app's response to all of them is identical:
 * do not use the stored credential, and show email/password instead.
 *
 * `disableDeviceFallback` is false, so the OS may offer the device passcode
 * after failed biometric attempts. That is deliberate — the passcode is the
 * same "this is the device's owner" assertion, it is what the platform's own
 * apps do, and refusing it would strand a driver with a wet or gloved hand.
 */
export async function authenticateLocally(label: string): Promise<boolean> {
  // Never prompt before the app is frontmost — see `waitUntilActive`.
  if (!await waitUntilActive()) return false;

  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage:         `Sign in with ${label}`,
      // Named so the driver can see the way out, rather than guessing.
      cancelLabel:           "Use password",
      disableDeviceFallback: false,
    });
    // `success: true` and nothing else. Reading any other field as approval
    // would be reading a failure as a pass.
    return result.success;
  } catch {
    // A throwing native module is not an approval.
    return false;
  }
}
