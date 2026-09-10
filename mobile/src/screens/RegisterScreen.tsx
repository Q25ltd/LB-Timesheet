/**
 * Driver registration — the real screen, against the real API (D21–D24).
 *
 * Four fields and nothing else: no company, no phone, no licence, no invite
 * code. Registration creates an ACCOUNT; a company is a separate, later
 * relationship the driver may never have (D21).
 *
 * The layout follows the supplied reference — wordmark, title and subtitle,
 * four large fields, a large primary action, a "Sign in" footer, and a brand
 * area at the bottom. Three things the reference shows are deliberately
 * absent: the three-rule password checklist (superseded by D23), and any
 * biometric or "keep me signed in" control (no contract exists for either).
 */
import { useState } from "react";
import {
  View, Text, ScrollView, KeyboardAvoidingView, Platform, Pressable, StyleSheet,
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

const EMPTY: RegisterFields = { firstName: "", lastName: "", email: "", password: "" };

export function RegisterScreen({ onRegistered, onSignIn }: RegisterScreenProps) {
  const insets = useSafeAreaInsets();
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
      setFormError("No connection. Check your signal and try again.");
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
      // The whole reason the hero can be pushed off-screen: on iOS the
      // keyboard overlays the view, on Android it resizes it.
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + spacing.xl },
        ]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <BrandLockup />

        <Text style={typography.title}>Create your account</Text>
        <Text style={[typography.subtitle, styles.subtitle]}>It only takes a minute</Text>

        {formError !== null ? (
          <View style={styles.formError} accessibilityLiveRegion="polite" testID="form-error">
            <Text style={typography.error}>{formError}</Text>
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

        <BrandHero />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: spacing.xl },
  subtitle: { marginBottom: spacing.xl },
  formError: {
    backgroundColor: colors.dangerBg,
    borderRadius: spacing.md,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    marginTop: spacing.xl,
  },
  link: { color: colors.brandLight, fontWeight: "700", fontSize: 15 },
});
