/**
 * Driver registration — the real screen, against the real API (D21–D24).
 *
 * Four fields go to the server and nothing else: no company, no phone, no
 * licence, no invite code. Registration creates an ACCOUNT; a company is a
 * separate, later relationship the driver may never have (D21). The fifth
 * box on screen — confirm password — never leaves the device.
 *
 * LAYOUT CONTRACT
 *
 *   - At rest the whole screen fits, on every phone, with NO scrolling in
 *     either direction. The container is `flexGrow: 1` with scrolling
 *     disabled, so there is nothing to scroll even by a pixel.
 *   - Scrolling is enabled ONLY while the keyboard is up. A five-field form
 *     plus a keyboard genuinely does not fit a small phone, and the
 *     alternative to scrolling there is fields the driver cannot reach.
 *   - Horizontal scrolling is off unconditionally. Nothing is wider than the
 *     screen, and bounce is disabled so an edge cannot be dragged past.
 *   - The hero is a sibling of the padded form, edge to edge, and yields its
 *     space first: it shrinks on a short screen and is removed entirely when
 *     the keyboard is up.
 *
 * Three things the reference design shows are deliberately absent: the
 * three-rule password checklist (superseded by D23), and any biometric or
 * "keep me signed in" control (no contract exists for either).
 */
import { useEffect, useState } from "react";
import {
  View, Text, ScrollView, KeyboardAvoidingView, Keyboard, Platform, Pressable, StyleSheet,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BrandHero, BrandLockup } from "../components/Brand";
import { Field } from "../components/Field";
import { PrimaryButton } from "../components/PrimaryButton";
import { colors, spacing, typography } from "../theme/index";
import { PASSWORD_RULE_TEXT } from "../auth/passwordPolicy";
import { EMAIL_IN_USE, registerAccount, type RegistrationResponse } from "../api/registration";
import {
  fieldErrorsFromServer, validateRegistration, type FieldErrors, type RegisterFields,
} from "./registerValidation";

interface RegisterScreenProps {
  /** Called with the server's response once registration succeeds. */
  onRegistered: (response: RegistrationResponse) => Promise<void> | void;
  /** Navigate to sign-in. Login is the NEXT increment — see app/(auth)/sign-in. */
  onSignIn: () => void;
}

const EMPTY: RegisterFields = {
  firstName: "", lastName: "", email: "", password: "", confirmPassword: "",
};

/**
 * Below this window height the form alone (~605pt) leaves the hero so little
 * room that it renders as a squashed band — which reads as a broken image
 * rather than as branding. On those screens it is dropped entirely: the form
 * still fits without scrolling, which is what actually matters. An iPhone SE
 * is 667pt; an iPhone 14 is 844pt.
 */
const MIN_HEIGHT_FOR_HERO = 720;

/**
 * Whether the keyboard is currently covering part of the screen.
 *
 * Drives two things: the hero is dropped to give the form its space back,
 * and scrolling is turned on so every field stays reachable.
 */
function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // iOS reports will-show/will-hide, which animate in step with the
    // keyboard; Android only reports did-show/did-hide.
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const shown  = Keyboard.addListener(showEvent, () => { setVisible(true); });
    const hidden = Keyboard.addListener(hideEvent, () => { setVisible(false); });
    return () => { shown.remove(); hidden.remove(); };
  }, []);

  return visible;
}

export function RegisterScreen({ onRegistered, onSignIn }: RegisterScreenProps) {
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const { height } = useWindowDimensions();
  // The hero is the first thing to go: it is decoration, and the form is not.
  const showHero = !keyboardVisible && height >= MIN_HEIGHT_FOR_HERO;
  const [fields, setFields] = useState<RegisterFields>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function update(name: keyof RegisterFields, value: string) {
    setFields(current => ({ ...current, [name]: value }));
    // Clear only the field being corrected. Wiping every error on the first
    // keystroke hides the other problems the driver still has to fix.
    setErrors(current => ({ ...current, [name]: undefined }));
    setFormError(null);
  }

  async function submit() {
    if (submitting) return; // a double tap is one registration, not two

    const found = validateRegistration(fields);
    if (Object.values(found).some(message => message !== undefined)) {
      setErrors(found);
      setFormError(null);
      return;
    }

    setSubmitting(true);
    setErrors({});
    setFormError(null);

    // Built field by field, NEVER by spreading `fields`. The DTO is
    // `.strict()`, so a spread would send `confirmPassword` and the server
    // would refuse the whole registration (D21).
    const result = await registerAccount({
      firstName: fields.firstName.trim(),
      lastName:  fields.lastName.trim(),
      email:     fields.email.trim(),
      // NOT trimmed. Whitespace is part of the credential (D23).
      password:  fields.password,
    });

    if (result.kind === "ok") {
      // The screen does not decide what happens next; it hands the response
      // to whoever owns the session. Kept awaited so a storage failure is
      // not silently swallowed while the UI moves on.
      await onRegistered(result.value);
      setSubmitting(false);
      return;
    }

    setSubmitting(false);

    if (result.kind === "network") {
      // Never dressed up as a server answer. The request never arrived.
      //
      // The driver-facing sentence is unchanged. In DEVELOPMENT the address
      // that failed is appended, because a connection failure on a developer
      // machine is nearly always a wrong API host — and "check your signal"
      // sends the reader to look at the network instead of the config.
      // `result.detail` is null in a production build.
      setFormError(
        result.detail === null
          ? "No connection. Check your signal and try again."
          : `No connection. Check your signal and try again.\n\n${result.detail}`,
      );
      return;
    }

    if (result.body.code === EMAIL_IN_USE) {
      setErrors({ email: "That email address is already registered" });
      return;
    }

    const serverFields = fieldErrorsFromServer(result.body.details);
    if (Object.keys(serverFields).length > 0) {
      setErrors(serverFields);
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
        testID="register-scroll"
        style={styles.flex}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.md }]}
        // The no-scroll contract. At rest the content exactly fills the
        // screen and scrolling is off, so there is nothing to drag. With the
        // keyboard up the form is taller than the space left, and scrolling
        // is the only thing that keeps the lower fields reachable.
        scrollEnabled={keyboardVisible}
        bounces={false}
        alwaysBounceVertical={false}
        alwaysBounceHorizontal={false}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <View style={styles.form}>
          <BrandLockup />

          <View style={styles.heading}>
            <Text style={[typography.title, styles.centred]}>Create your account</Text>
            <Text style={[typography.subtitle, styles.centred]}>It only takes a minute</Text>
          </View>

          {formError !== null ? (
            <View style={styles.formError} accessibilityLiveRegion="polite" testID="form-error">
              <Text style={[typography.error, styles.centred]}>{formError}</Text>
            </View>
          ) : null}

          <Field
            label="First name"
            placeholder="First name"
            value={fields.firstName}
            onChangeText={value => { update("firstName", value); }}
            error={errors.firstName}
            autoComplete="given-name"
            textContentType="givenName"
            autoCapitalize="words"
            returnKeyType="next"
            editable={!submitting}
          />
          <Field
            label="Last name"
            placeholder="Last name"
            value={fields.lastName}
            onChangeText={value => { update("lastName", value); }}
            error={errors.lastName}
            autoComplete="family-name"
            textContentType="familyName"
            autoCapitalize="words"
            returnKeyType="next"
            editable={!submitting}
          />
          <Field
            label="Email address"
            placeholder="Email address"
            value={fields.email}
            onChangeText={value => { update("email", value); }}
            error={errors.email}
            autoComplete="email"
            textContentType="emailAddress"
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
            helper={PASSWORD_RULE_TEXT}
            secure
            revealTestID="toggle-password-visibility"
            controlTestID="password-field"
            autoComplete="new-password"
            textContentType="newPassword"
            autoCapitalize="none"
            returnKeyType="next"
            editable={!submitting}
          />
          <Field
            label="Repeat password"
            placeholder="Repeat password"
            value={fields.confirmPassword}
            onChangeText={value => { update("confirmPassword", value); }}
            error={errors.confirmPassword}
            secure
            revealTestID="toggle-confirm-password-visibility"
            autoComplete="new-password"
            textContentType="newPassword"
            autoCapitalize="none"
            returnKeyType="done"
            onSubmitEditing={() => { void submit(); }}
            editable={!submitting}
          />

          <PrimaryButton
            label="Create account"
            onPress={() => { void submit(); }}
            submitting={submitting}
            testID="create-account"
          />

          <View style={styles.footer}>
            <Text style={typography.helper}>Already have an account? </Text>
            <Pressable onPress={onSignIn} accessibilityRole="link" testID="go-to-sign-in" hitSlop={8}>
              <Text style={styles.link}>Sign in</Text>
            </Pressable>
          </View>
        </View>

        {/* Outside `form`, so it is edge to edge with no padding to cancel.
            Dropped when the keyboard is up or the screen is short — the form
            needs the room more than the brand does. */}
        {showHero ? <BrandHero /> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.surface },
  // `flexGrow: 1` is what makes "no scrolling" true rather than merely
  // usually true: the content is never shorter than the screen, so there is
  // no slack, and never wider, so there is nothing to pan sideways to.
  content: { flexGrow: 1 },
  // The padded column. The hero is its sibling and gets no padding.
  //
  // `flex: 1` is what pins the hero to the BOTTOM edge: the form absorbs
  // whatever vertical slack a tall screen has, instead of the slack landing
  // below the hero and leaving a strip of background under the photograph.
  form: { flex: 1, paddingHorizontal: spacing.xl },
  heading: { marginTop: spacing.lg, marginBottom: spacing.lg },
  centred: { textAlign: "center" },
  formError: {
    backgroundColor: colors.dangerBg,
    borderRadius: spacing.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: spacing.lg,
  },
  link: { color: colors.brandLight, fontWeight: "700", fontSize: 15 },
});
