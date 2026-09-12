/**
 * Driver sign-in — the real screen, against the real API (AUTH.md "Login
 * flow", D17, D21).
 *
 * Registration's sibling, deliberately and visibly: the same brand lockup,
 * the same `Field`, the same `PrimaryButton`, the same padded column, and the
 * same hero under the same rules — all from `./authLayout`, so the two
 * screens cannot drift apart. Two fields instead of five is the only
 * difference, and the spacing is NOT stretched to compensate: every gap is
 * the theme's, unchanged.
 *
 * VERTICAL CENTRING (owner correction, physical phone, 2026-09-11)
 *
 * The shared `authStyles.form` is `flex: 1`, so it absorbs whatever vertical
 * slack the screen has. On Registration the five-field form nearly fills that
 * space and the slack is invisible. On Sign-in three controls leave ~200pt
 * over, and because a flex column defaults to `justifyContent: "flex-start"`
 * ALL of it collected UNDER the footer — a large white gap between "Create
 * account" and the hero, with the form riding high.
 *
 * The fix is one flex property, `justifyContent: "center"`, applied to the
 * Sign-in form container only. The same slack is then split above and below
 * the content block instead of being dumped at the bottom. It is responsive
 * by construction: there is no height, no offset, no `position: absolute`, no
 * `translateY` and no device measurement anywhere — the free space is
 * whatever the screen has left after the hero, and it is halved.
 *
 * It is deliberately NOT applied while the keyboard is up. There the hero is
 * already gone and the space is contested rather than spare; centring content
 * that may be taller than its container pushes the top of the form out of
 * reach inside a ScrollView, which is a worse bug than a high form. With the
 * keyboard up the layout stays exactly Registration's proven top-aligned
 * behaviour, with scrolling on.
 *
 * `authStyles` is untouched, so Registration's approved appearance is
 * unaffected — this rule exists in this file and applies to this screen.
 *
 * WHAT IS DELIBERATELY ABSENT, and why:
 *
 *   - the password rule ("At least 10 characters"). That is guidance for
 *     CHOOSING a password; on sign-in the driver already has one, and
 *     showing a rule their existing password may not satisfy is alarming and
 *     wrong. The server does not apply the policy here either.
 *   - "Forgot password". Password recovery does not exist, and a control
 *     that looks real and does nothing teaches a driver that sign-in is
 *     broken rather than that recovery is unbuilt.
 *   - "Keep me signed in" and Face ID / Touch ID. The reference design shows
 *     both; neither has a contract (D25), and no biometric control ships
 *     before its security contract does.
 *   - a company field or selector. Login proves WHO the driver is; which
 *     company they are working for is a separate, later security event, and
 *     a client never names a company as authority (AUTH.md).
 *
 * THE FAILURE MESSAGE is generic on purpose. The server answers an unknown
 * email and a wrong password identically (D17), and this screen must not
 * undo that by guessing which one it was.
 */
import { useState } from "react";
import { View, Text, ScrollView, KeyboardAvoidingView, Platform, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BrandHero, BrandLockup } from "../components/Brand";
import { Field } from "../components/Field";
import { PrimaryButton } from "../components/PrimaryButton";
import { authScrollProps, authStyles as styles, useAuthLayout } from "./authLayout";
import { colors, radius, sizing, spacing, typography } from "../theme/index";
import type { AuthenticatedAccount } from "../api/account";
import { signIn } from "../api/account";
import { validateSignIn, type SignInFieldErrors, type SignInFields } from "./signInValidation";

interface SignInScreenProps {
  /** Called with the server's response once sign-in succeeds. */
  onSignedIn: (account: AuthenticatedAccount) => Promise<void> | void;
  /** Navigate to registration. */
  onCreateAccount: () => void;
  /**
   * The biometric unlock action, when this device is ELIGIBLE for one — a
   * stored credential exists, the driver opted in, and the hardware can still
   * do it. Absent otherwise, and the control is then not rendered at all: a
   * "Sign in with Face ID" button on a phone that has never been signed in
   * cannot work, and offering it teaches the driver the app is broken.
   *
   * Resolves false on cancel, failure or a refused credential; the form stays
   * exactly where it is, so email and password remain available.
   */
  biometricUnlock?: { label: string; unlock: () => Promise<boolean> };
}

const EMPTY: SignInFields = { email: "", password: "" };

/**
 * The one thing a failed sign-in says.
 *
 * It covers "no such account", "wrong password" and "that account's stored
 * credential is unreadable" alike, because the server answers all three with
 * the identical `401 { error: "Not authenticated", code: "UNAUTHENTICATED" }`
 * and telling them apart here would rebuild the account-existence oracle the
 * server exists to deny.
 */
const CREDENTIALS_REJECTED = "Email address or password is incorrect.";

export function SignInScreen({ onSignedIn, onCreateAccount, biometricUnlock }: SignInScreenProps) {
  const insets = useSafeAreaInsets();
  // The hero is the first thing to go: it is decoration, and the form is not.
  const { keyboardVisible, showHero } = useAuthLayout();
  const [fields, setFields] = useState<SignInFields>(EMPTY);
  const [errors, setErrors] = useState<SignInFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [unlocking, setUnlocking] = useState(false);

  /**
   * The biometric path. Note what it does NOT do: it never sets an
   * authenticated state and never touches a token. It asks the provider to
   * gate on the OS, redeem the stored credential and let the SERVER decide
   * (D26) — this screen only reports the failure.
   */
  async function tryBiometricUnlock() {
    if (biometricUnlock === undefined || unlocking || submitting) return;
    setUnlocking(true);
    setFormError(null);
    const unlocked = await biometricUnlock.unlock();
    setUnlocking(false);
    if (!unlocked) {
      // Cancel, failure and a refused credential are one message. The driver
      // does not need to know which, and the answer is the same: type it in.
      setFormError(`${biometricUnlock.label} didn't work. Enter your email and password.`);
    }
  }

  function update(name: keyof SignInFields, value: string) {
    setFields(current => ({ ...current, [name]: value }));
    // Clear only the field being corrected. Wiping every error on the first
    // keystroke hides the other problems the driver still has to fix.
    setErrors(current => ({ ...current, [name]: undefined }));
    setFormError(null);
  }

  async function submit() {
    if (submitting) return; // a double tap is one sign-in, not two

    const found = validateSignIn(fields);
    if (Object.values(found).some(message => message !== undefined)) {
      setErrors(found);
      setFormError(null);
      return;
    }

    setSubmitting(true);
    setErrors({});
    setFormError(null);

    // Built field by field, NEVER by spreading `fields`. The DTO is
    // `.strict()`, so any extra key would be refused outright — and building
    // it explicitly is what guarantees no company, membership or role ever
    // leaves this screen.
    const result = await signIn({
      email:    fields.email.trim(),
      // NOT trimmed. Whitespace is part of the credential (D23).
      password: fields.password,
    });

    if (result.kind === "ok") {
      // The screen does not decide what happens next; it hands the response
      // to whoever owns the session. Kept awaited so a storage failure is
      // not silently swallowed while the UI moves on.
      await onSignedIn(result.value);
      setSubmitting(false);
      return;
    }

    setSubmitting(false);

    if (result.kind === "network") {
      // Never dressed up as a server answer. The request never arrived — and
      // a driver in a yard with no signal must not be told their password is
      // wrong. `result.detail` is development-only and null in a production
      // build.
      setFormError(
        result.detail === null
          ? "No connection. Check your signal and try again."
          : `No connection. Check your signal and try again.\n\n${result.detail}`,
      );
      return;
    }

    // Every authentication failure is one message. The status is checked
    // rather than the code so that a 401 with an unexpected body still reads
    // as "those credentials were refused" and never as a crash.
    if (result.status === 401) {
      setFormError(CREDENTIALS_REJECTED);
      return;
    }

    setFormError(result.body.error);
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      // On iOS the keyboard overlays the view; on Android it resizes it.
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        testID="sign-in-scroll"
        style={styles.flex}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.md }]}
        // The no-scroll contract, shared with Registration: at rest the
        // content exactly fills the screen and scrolling is off. With the
        // keyboard up, scrolling is what keeps the fields reachable.
        scrollEnabled={keyboardVisible}
        {...authScrollProps}
      >
        {/* OUTSIDE the centred container, so the lockup sits at the top of the
            white area exactly as it does on Registration.

            It used to be the first child of the centred form, which pushed it
            down by half the block's free space. Hoisting it here is also why
            nothing else moves: the form keeps `flex: 1`, so it now occupies
            the white area MINUS the lockup, and centring its remaining
            content inside that smaller area puts every one of those elements
            at the same absolute position as before. Only the lockup moves. */}
        <View style={signInStyles.lockupAtTop}>
          <BrandLockup />
        </View>

        <View
          testID="sign-in-form"
          // Centred ONLY when there is genuine slack to share — see the note
          // at the top of this file. With the keyboard up the array's second
          // entry is `null`, so the style resolves to exactly Registration's.
          style={[styles.form, keyboardVisible ? null : signInStyles.centredInWhiteArea]}
        >
          <View style={styles.heading}>
            <Text style={[typography.title, styles.centred]}>Welcome back</Text>
            <Text style={[typography.subtitle, styles.centred]}>Sign in to your account</Text>
          </View>

          {formError !== null ? (
            <View style={styles.formError} accessibilityLiveRegion="polite" testID="form-error">
              <Text style={[typography.error, styles.centred]}>{formError}</Text>
            </View>
          ) : null}

          <Field
            label="Email address"
            placeholder="Email address"
            value={fields.email}
            onChangeText={value => { update("email", value); }}
            error={errors.email}
            // iOS reads `textContentType`; Android reads `autoComplete`
            // (RN maps it to `android:autofillHints`). BOTH are needed, and
            // `username` — not `emailAddress` — is what makes iOS treat this
            // as the ACCOUNT field of a credential pair rather than as a
            // contact detail. `emailAddress` is a contact hint: it fills an
            // address but does not pair with a password.
            autoComplete="email"
            textContentType="username"
            // Explicit rather than relying on Android's `auto` default: a view
            // the framework does not consider important is never offered.
            importantForAutofill="yes"
            keyboardType="email-address"
            autoCapitalize="none"
            returnKeyType="next"
            editable={!submitting}
          />
          <Field
            label="Password"
            placeholder="Password"
            value={fields.password}
            onChangeText={value => { update("password", value); }}
            error={errors.password}
            // No `helper`: the password RULE belongs to choosing a password,
            // not to typing one the driver already has.
            secure
            revealTestID="toggle-password-visibility"
            controlTestID="password-field"
            // `current-password` / `password` is the EXISTING-credential pair,
            // which is what tells the platform to offer a saved password here
            // rather than to generate a new one.
            autoComplete="current-password"
            textContentType="password"
            importantForAutofill="yes"
            autoCapitalize="none"
            returnKeyType="done"
            onSubmitEditing={() => { void submit(); }}
            editable={!submitting}
          />

          <PrimaryButton
            label="Sign in"
            onPress={() => { void submit(); }}
            submitting={submitting}
            testID="sign-in"
          />

          {biometricUnlock === undefined ? null : (
            // SECONDARY by construction: a bordered text button, not a second
            // primary. Email and password remain the route that always works.
            <Pressable
              onPress={() => { void tryBiometricUnlock(); }}
              disabled={unlocking || submitting}
              accessibilityRole="button"
              accessibilityLabel={`Sign in with ${biometricUnlock.label}`}
              accessibilityState={{ disabled: unlocking || submitting, busy: unlocking }}
              testID="biometric-unlock"
              style={signInStyles.biometric}
            >
              <Text style={signInStyles.biometricLabel}>
                {unlocking ? "Waiting…" : `Sign in with ${biometricUnlock.label}`}
              </Text>
            </Pressable>
          )}

          <View style={styles.footer}>
            <Text style={typography.helper}>Don&apos;t have an account? </Text>
            <Pressable onPress={onCreateAccount} accessibilityRole="link" testID="go-to-register" hitSlop={8}>
              <Text style={styles.link}>Create account</Text>
            </Pressable>
          </View>
        </View>

        {/* Outside `form`, so it is edge to edge with no padding to cancel.
            Dropped when the keyboard is up or the screen is short — exactly
            as on Registration, from the same rule. */}
        {showHero ? <BrandHero /> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/**
 * The ONLY style this screen adds to the shared auth layout.
 *
 * One property. It changes where the shared `form` container's existing free
 * space goes — split above and below the content instead of all below it —
 * and nothing about the content's own size, padding or spacing.
 */
const signInStyles = StyleSheet.create({
  centredInWhiteArea: { justifyContent: "center" },
  /**
   * The brand lockup's own wrapper, carrying the ONE thing it loses by moving
   * out of the form: that container's horizontal padding. Nothing else — no
   * height, no margin, no offset — so the lockup lands wherever the scroll
   * content's `paddingTop` puts it, which is exactly where Registration's is.
   */
  lockupAtTop: { paddingHorizontal: spacing.xl },
  /**
   * The secondary action, from the same theme as everything else: the control
   * height the design uses, the field's radius and border colour, the brand's
   * link blue. Nothing invented, and nothing that changes the form's own
   * spacing — it sits in the flow above the footer.
   */
  biometric: {
    minHeight: sizing.control,
    marginTop: spacing.md,
    borderRadius: radius.button,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  biometricLabel: { color: colors.brandLight, fontWeight: "700", fontSize: 16 },
});
