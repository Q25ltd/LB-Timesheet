/**
 * Home — the first screen a signed-in driver sees.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SCREEN KNOWS, AND WHAT IT THEREFORE REFUSES TO SAY
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Home makes NO network request. That is a design property, not an omission,
 * and it decides most of what follows: a screen that asks nobody anything
 * cannot honestly report whether a shift is open, what has been submitted, or
 * how far the driver has driven.
 *
 * So the approved mock-up's "No active shift" is deliberately NOT here. That
 * sentence is a claim about server state. Checking it needs a TENANT token;
 * a tenant token is memory-only and is discarded on every restore (D25), so
 * after any app restart Home would have to call `POST /auth/switch-company`
 * to get one — which for a driver with several companies means choosing an
 * employer, on Home, before they have asked to start anything. That would turn
 * Home into a permanent work-context selector, which the frozen Start Shift
 * flow explicitly puts AFTER the driver presses Start Shift. Active-shift
 * detection belongs to that increment; the card below therefore describes what
 * this screen is FOR, and asserts nothing about what is happening.
 *
 * For the same reason there is no Recent Timesheets section: no history
 * endpoint exists, no shift can yet be submitted, and a heading over an empty
 * list would claim a feature the product does not have. The mock-up is visual
 * direction; it is not evidence that a data source exists.
 *
 * Home is also COMPANY-NEUTRAL. `account.memberships` is available and is
 * deliberately not rendered: naming an employer here would be the first step
 * of a work-context selector, and a driver may work for several companies
 * whose existence must not be advertised to each other (D12, CLAUDE.md's
 * privacy boundary).
 *
 * THE START SHIFT BUTTON IS REAL AND DISABLED. It carries no handler at all —
 * not an empty one — because a control that responds to a press by doing
 * nothing teaches a driver the app is broken. The same button is what the next
 * increment switches on. This is the same reasoning `SignInScreen` records for
 * leaving "Forgot password" out.
 */
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BrandLockup } from "../components/Brand";
import { BiometricOptIn } from "../components/BiometricOptIn";
import { PrimaryButton } from "../components/PrimaryButton";
import { formatHomeDate, salutationFor } from "./homeGreeting";
import type { AccountUser } from "../api/account";
import type { BiometricCapability } from "../auth/biometrics";
import { colors, radius, spacing, typography } from "../theme/index";

interface HomeScreenProps {
  /** The authenticated driver. The route narrows this; Home never guesses. */
  user: AccountUser;
  biometrics: BiometricCapability;
  biometricUnlockEnabled: boolean;
  onEnableBiometrics: () => Promise<boolean>;
  onSignOut: () => void;
}

/**
 * The driver's initials — "Nerijus Kuizinas" → "NK".
 *
 * `Array.from` rather than `charAt`, so a name beginning with a character
 * outside the basic plane yields that character and not half of it. Both
 * names are non-empty server-side (registration requires `min(1)` after
 * trimming), and an empty string here would simply produce a shorter badge
 * rather than an invented letter.
 */
function initialsOf(user: AccountUser): string {
  const first = Array.from(user.firstName)[0] ?? "";
  const last = Array.from(user.lastName)[0] ?? "";
  return `${first}${last}`.toUpperCase();
}

export function HomeScreen({
  user, biometrics, biometricUnlockEnabled, onEnableBiometrics, onSignOut,
}: HomeScreenProps) {
  const insets = useSafeAreaInsets();

  // Read once per render, from the DEVICE clock. Not the company timezone,
  // and not related to `Shift.shiftDate` — see `./homeGreeting`.
  const now = new Date();
  const salutation = salutationFor(now);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + spacing.xl },
      ]}
    >
      <View style={styles.header}>
        <BrandLockup />
        {/* An identity BADGE, not a control. There is no profile or settings
            screen for it to open, and a circle that looks tappable and is not
            is worse than a circle that plainly is not. It gets no press
            handler, no button role and no chevron. */}
        <View style={styles.badge} testID="identity-badge-container" accessibilityRole="image" accessibilityLabel={`Signed in as ${user.firstName} ${user.lastName}`}>
          <Text style={styles.badgeText} testID="identity-badge">{initialsOf(user)}</Text>
        </View>
      </View>

      {/* Two lines, as the approved design has them, but one phrase to a
          screen reader — "Good morning, Nerijus" read as two separate nodes
          is two announcements of half a sentence each. */}
      <View
        style={styles.greeting}
        accessible
        accessibilityRole="header"
        accessibilityLabel={`${salutation}, ${user.firstName}`}
      >
        <Text style={styles.salutation} testID="greeting-salutation">{`${salutation},`}</Text>
        <Text style={styles.name} testID="greeting-name">{user.firstName}</Text>
      </View>

      <Text style={styles.date} testID="today-date">{formatHomeDate(now)}</Text>

      <View style={styles.shiftCard} testID="shift-card">
        <Text style={styles.shiftTitle}>Your working day starts here</Text>
        <Text style={styles.shiftBody}>
          Booking on, truck and trailer checks, and your daily timesheet will all
          begin from this card.
        </Text>

        <View style={styles.shiftAction}>
          <PrimaryButton label="Start Shift" disabled testID="start-shift" />
        </View>

        {/* Says WHY it cannot be pressed. A disabled control with no
            explanation reads as a bug in the app rather than as a feature
            that has not arrived. */}
        <Text style={styles.shiftNote}>Not available yet.</Text>
      </View>

      {/* Unchanged from the previous screen: offered once, and only where it
          can work — hardware present, a biometric enrolled, and not already
          on. Declining is final for this session and costs nothing (D26). */}
      {biometrics.available && !biometricUnlockEnabled ? (
        <BiometricOptIn label={biometrics.label} onEnable={onEnableBiometrics} />
      ) : null}

      <Pressable onPress={onSignOut} accessibilityRole="button" testID="sign-out" hitSlop={8} style={styles.signOut}>
        <Text style={styles.signOutLabel}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  // `flexGrow: 1` so a short screen still fills, while anything taller than
  // the phone scrolls normally. No fixed heights and no breakpoint: the
  // content here is short enough that it does not need one.
  content: { flexGrow: 1, paddingHorizontal: spacing.xl },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.xl,
  },
  badge: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { fontSize: 16, fontWeight: "700", color: colors.brandDark, letterSpacing: 0.5 },

  greeting: { gap: spacing.xs },
  salutation: { ...typography.subtitle, fontSize: 20 },
  name: { ...typography.title, fontSize: 34 },
  date: { ...typography.subtitle, marginTop: spacing.sm, marginBottom: spacing.xl },

  shiftCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
    marginBottom: spacing.lg,
  },
  shiftTitle: { fontSize: 22, fontWeight: "700", color: colors.brandDark },
  shiftBody: { ...typography.helper, fontSize: 15, lineHeight: 21, marginTop: spacing.sm },
  shiftAction: { marginTop: spacing.xl },
  shiftNote: { ...typography.helper, textAlign: "center", marginTop: spacing.md },

  signOut: { alignSelf: "center", marginTop: spacing.lg, paddingVertical: spacing.sm },
  signOutLabel: { color: colors.brandLight, fontWeight: "700", fontSize: 16 },
});
