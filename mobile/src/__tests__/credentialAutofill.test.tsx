/**
 * Platform credential AutoFill — the props the OS password manager reads.
 *
 * WHY THIS FILE EXISTS SEPARATELY. AutoFill is not our behaviour; it is iOS's
 * and Android's, driven entirely by hints on the native text input. There is
 * nothing of ours to assert except that the correct hints are present and
 * correctly paired — so that is exactly what is asserted, on the rendered
 * elements rather than on the screens' source.
 *
 * These cases CANNOT prove AutoFill works. They prove the app asks for it
 * properly. Whether the keyboard offers a saved credential depends on the OS,
 * on the user's Passwords settings, and on a real device — and that is stated
 * plainly rather than implied by a green suite.
 *
 * THE PAIRING THAT MATTERS, and the defect this file was written for:
 * iOS recognises a CREDENTIAL from a `username` field next to a `password`
 * (sign-in) or `newPassword` (sign-up) field. Registration previously used
 * `emailAddress` on its email box, which is a CONTACT hint — iOS would fill an
 * address into it but never treat it as the account name of a credential, so a
 * password saved from that form had no username to pair with and Login had
 * nothing to suggest.
 */
import { render, fireEvent } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { ReactElement } from "react";
import * as secureStoreModule from "../auth/secureStore";
import { SignInScreen } from "../screens/SignInScreen";
import { RegisterScreen } from "../screens/RegisterScreen";

const METRICS = {
  frame:  { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

type View = Awaited<ReturnType<typeof render>>;

function wrap(node: ReactElement): Promise<View> {
  return render(<SafeAreaProvider initialMetrics={METRICS}>{node}</SafeAreaProvider>);
}

const noop = () => { /* navigation is not under test here */ };

/** The autofill-relevant props of one rendered input, by its placeholder. */
function hints(view: View, placeholder: string): Record<string, unknown> {
  const input = view.getByPlaceholderText(placeholder);
  const props = input.props as Record<string, unknown>;
  return {
    textContentType:       props["textContentType"],
    autoComplete:          props["autoComplete"],
    importantForAutofill:  props["importantForAutofill"],
    keyboardType:          props["keyboardType"],
    autoCapitalize:        props["autoCapitalize"],
    autoCorrect:           props["autoCorrect"],
    spellCheck:            props["spellCheck"],
    secureTextEntry:       props["secureTextEntry"],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Login
// ═══════════════════════════════════════════════════════════════════════════

test("LOGIN email is declared as the credential's ACCOUNT field, on both platforms", async () => {
  const view = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);

  expect(hints(view, "Email address")).toMatchObject({
    // iOS. `username` — NOT `emailAddress`, which is a contact hint and does
    // not pair with a password.
    textContentType:      "username",
    // Android (RN maps this to `android:autofillHints`).
    autoComplete:         "email",
    // Explicit rather than relying on Android's `auto` default.
    importantForAutofill: "yes",
    keyboardType:         "email-address",
    // A capitalised or autocorrected address is a wrong address the driver
    // will not notice, and it defeats a match against a saved credential.
    autoCapitalize:       "none",
    autoCorrect:          false,
    spellCheck:           false,
  });
});

test("LOGIN password is declared as an EXISTING credential, not a new one", async () => {
  const view = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);

  expect(hints(view, "Password")).toMatchObject({
    // `password`, not `newPassword`: this field must make the platform OFFER a
    // saved credential, not generate a fresh one.
    textContentType:      "password",
    autoComplete:         "current-password",
    importantForAutofill: "yes",
    // Obscured by default, which is also what marks it as a password field.
    secureTextEntry:      true,
    autoCapitalize:       "none",
    autoCorrect:          false,
  });
});

test("Show/Hide still works, and the field returns to being a password field", async () => {
  // Revealing necessarily clears `secureTextEntry`, so while revealed the
  // platform sees a plain text field. That is the cost of a control the owner
  // approved; what must not happen is the field staying non-secure.
  const view = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);

  expect(hints(view, "Password")["secureTextEntry"]).toBe(true);
  await fireEvent.press(view.getByTestId("toggle-password-visibility"));
  expect(hints(view, "Password")["secureTextEntry"]).toBe(false);
  // The credential hints are UNCHANGED while revealed, so the association
  // survives the toggle.
  expect(hints(view, "Password")).toMatchObject({
    textContentType: "password",
    autoComplete:    "current-password",
  });
  await fireEvent.press(view.getByTestId("toggle-password-visibility"));
  expect(hints(view, "Password")["secureTextEntry"]).toBe(true);
});

// ═══════════════════════════════════════════════════════════════════════════
// Registration — new-account semantics
// ═══════════════════════════════════════════════════════════════════════════

test("REGISTRATION email is the credential's ACCOUNT field too — this was the defect", async () => {
  const view = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);

  expect(hints(view, "Email address")).toMatchObject({
    // The fix. `emailAddress` here meant iOS never had a username to pair
    // with the password it was asked to save, so Login had nothing to offer.
    textContentType:      "username",
    autoComplete:         "email",
    importantForAutofill: "yes",
    keyboardType:         "email-address",
    autoCapitalize:       "none",
  });
  // And the same hint as Login's account field, so the two forms describe ONE
  // credential rather than two unrelated things.
  const signIn = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);
  expect(hints(view, "Email address")["textContentType"])
    .toBe(hints(signIn, "Email address")["textContentType"]);
});

test("REGISTRATION password and Repeat password both use NEW-password semantics", async () => {
  const view = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);

  for (const placeholder of ["Password", "Repeat password"]) {
    expect(hints(view, placeholder)).toMatchObject({
      // `newPassword` is what makes iOS offer a generated strong password and
      // then offer to SAVE the pair. The confirmation field takes the same
      // hint so the platform fills both halves instead of leaving one empty.
      textContentType:      "newPassword",
      autoComplete:         "new-password",
      importantForAutofill: "yes",
      secureTextEntry:      true,
      autoCapitalize:       "none",
    });
  }
});

test("the two forms do not contradict each other: sign-in asks for existing, sign-up for new", async () => {
  const signIn   = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);
  const register = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);

  expect(hints(signIn, "Password")["textContentType"]).toBe("password");
  expect(hints(register, "Password")["textContentType"]).toBe("newPassword");
  // A sign-in form that asked for `newPassword` would prompt the driver to
  // invent a second password for an account they already have.
  expect(hints(signIn, "Password")["textContentType"]).not.toBe("newPassword");
});

// ═══════════════════════════════════════════════════════════════════════════
// The security half: the OS may remember the password; WE must not
// ═══════════════════════════════════════════════════════════════════════════

test("no screen carries a remember-me control, and none is offered", async () => {
  // AutoFill is the OS password manager's job. Our own "remember password"
  // would mean persisting a credential we have no business holding.
  for (const screen of [
    <SignInScreen onSignedIn={noop} onCreateAccount={noop} />,
    <RegisterScreen onRegistered={noop} onSignIn={noop} />,
  ]) {
    const view = await wrap(screen);
    expect(view.queryByText(/remember/i)).toBeNull();
    expect(view.queryByText(/keep me signed in/i)).toBeNull();
    expect(view.queryByText(/save (my )?password/i)).toBeNull();
  }
});

test("the app's OWN storage module cannot store a password — it has no such export", () => {
  // The structural half of "we never persist the password": there is no API
  // through which a password could be written. `secureStore.ts` names every
  // item it stores, and none of them is a credential the user typed.
  const names = Object.keys(secureStoreModule).sort();

  expect(names).toEqual([
    "clearBiometricOptIn", "clearRefreshToken", "readBiometricOptIn",
    "readRefreshToken", "storeBiometricOptIn", "storeRefreshToken",
  ]);
  // Nothing password-shaped, and no generic setter to smuggle one through.
  for (const name of names) {
    expect(name.toLowerCase()).not.toContain("password");
    expect(name.toLowerCase()).not.toContain("credential");
  }
  expect(names).not.toContain("setItem");
});
