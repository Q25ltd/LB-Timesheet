/**
 * Home — the first screen a signed-in driver sees, and the app's daily
 * operational landing.
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
 * sentence is a claim about server state. Checking it needs a TENANT token; a
 * tenant token is memory-only and is discarded on every restore (D25), so
 * after any app restart Home would have to call `POST /auth/switch-company` to
 * get one — which for a driver with several companies means choosing an
 * employer, on Home, before they have asked to start anything. That would turn
 * Home into a permanent work-context selector, which the frozen Start Shift
 * flow explicitly puts AFTER the driver presses Start Shift.
 *
 * The Recent Timesheets SECTION is present, because the owner approved the
 * full Home composition — but it holds one honest line and no rows. There is
 * no history endpoint, nothing can be finished or submitted yet, and a
 * specimen row would be believed. The frame is real; the data is absent and
 * says so.
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
 * increment switches on.
 */
import { View, Text, Image, ScrollView, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BrandLockup } from "../components/Brand";
import { TabIcon } from "../components/TabIcon";
import { BiometricOptIn } from "../components/BiometricOptIn";
import { PrimaryButton } from "../components/PrimaryButton";
import { HOME_CARD_IMAGE } from "./homeCardImage";
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
  /** Opens Settings — the identity badge's one real destination. */
  onOpenAccount: () => void;
}

/**
 * The driver's initials — "Nerijus Kuizinas" → "NK".
 *
 * `Array.from` rather than `charAt`, so a name beginning with a character
 * outside the basic plane yields that character and not half of it. Both names
 * are non-empty server-side (registration requires `min(1)` after trimming),
 * and an empty string here would produce a shorter badge rather than an
 * invented letter.
 */
function initialsOf(user: AccountUser): string {
  const first = Array.from(user.firstName)[0] ?? "";
  const last = Array.from(user.lastName)[0] ?? "";
  return `${first}${last}`.toUpperCase();
}

export function HomeScreen({
  user, biometrics, biometricUnlockEnabled, onEnableBiometrics, onOpenAccount,
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
        { paddingTop: insets.top + spacing.md, paddingBottom: spacing.xxl },
      ]}
    >
      <View style={styles.header}>
        {/* The lockup the owner approved on a physical phone for Login and
            Registration, reused verbatim and centred on the CONTENT width. */}
        <BrandLockup />

        {/* Overlaid rather than laid out beside the lockup. In a flex row the
            badge's width would push the brand left by half of it, so the brand
            would be centred in the space BESIDE the badge rather than on the
            screen. Taken out of flow, it costs the brand no width at all, and
            the two cannot collide: the lockup is ~160pt wide and the badge 44pt
            at the right margin, which stays clear even on a 320pt phone. */}
        <View style={styles.badgeSlot} pointerEvents="box-none">
          <Pressable
            testID="identity-badge-container"
            onPress={onOpenAccount}
            accessibilityRole="button"
            accessibilityLabel={`Account and settings for ${user.firstName} ${user.lastName}`}
            hitSlop={8}
            style={({ pressed }) => [styles.badge, pressed ? styles.badgePressed : null]}
          >
            <Text style={styles.badgeText} testID="identity-badge">{initialsOf(user)}</Text>
          </Pressable>
        </View>
      </View>

      {/* Two lines, as the approved design has them, but one phrase to a
          screen reader — "Good morning, Nerijus" read as two separate nodes is
          two announcements of half a sentence each. */}
      <View
        style={styles.greeting}
        accessible
        accessibilityRole="header"
        accessibilityLabel={`${salutation}, ${user.firstName}`}
      >
        <Text style={styles.salutation} testID="greeting-salutation">{`${salutation},`}</Text>
        <Text style={styles.name} testID="greeting-name" numberOfLines={1} adjustsFontSizeToFit>
          {user.firstName}
        </Text>
      </View>

      <Text style={styles.date} testID="today-date">{formatHomeDate(now)}</Text>

      <View style={styles.shiftCard} testID="shift-card">
        {/* The photograph is the card's BACKGROUND, not a band above it: the
            approved design puts the copy on top of it, with the truck entering
            from the right. The asset carries its own left-to-right fade to
            transparency, so the copy side is the card's own surface colour and
            nothing is layered over the text to keep it legible. See
            `homeCardImage.ts` for how the fade is produced and why it lives in
            the asset rather than in a gradient dependency. */}
        <Image
          source={HOME_CARD_IMAGE}
          style={styles.shiftImage}
          resizeMode="cover"
          accessible={false}
          testID="shift-card-image"
        />

        <View style={styles.shiftBody}>
          <View style={styles.shiftIcon}>
            <TabIcon name="clock" color={colors.brandDark} size={26} />
          </View>

          {/* Held to the quiet side of the image. The fade reaches full
              opacity around the truck's nose, so the copy never crosses it. */}
          <View style={styles.shiftText}>
            <Text style={styles.shiftTitle}>Ready to start your day?</Text>
            <Text style={styles.shiftCopy}>Checks, hours and your timesheet start here.</Text>
          </View>

          <View style={styles.shiftAction}>
            <PrimaryButton label="Start Shift" disabled testID="start-shift" />
          </View>
        </View>
      </View>

      <View style={styles.recent} testID="recent-timesheets">
        <Text style={styles.sectionTitle}>Recent Timesheets</Text>
        {/* The section frame the approved design calls for, holding the one
            true thing that can be said about it. No rows, no dates, no
            distances, no statuses — see this file's header. */}
        <View style={styles.recentEmpty} testID="recent-timesheets-empty">
          <Text style={styles.recentEmptyText}>No timesheets yet</Text>
        </View>
      </View>

      {/* Unchanged: offered once, and only where it can work — hardware
          present, a biometric enrolled, and not already on. Declining is final
          for this session and costs nothing (D26). Settings owns the permanent
          control; this is the one-time offer. */}
      {biometrics.available && !biometricUnlockEnabled ? (
        <BiometricOptIn label={biometrics.label} onEnable={onEnableBiometrics} />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  // `flexGrow: 1` so a short screen still fills, while anything taller than
  // the phone scrolls normally. No fixed heights and no breakpoint — the
  // compactness below comes from type scale and padding, not from measuring
  // the device.
  content: { flexGrow: 1, paddingHorizontal: spacing.xl },

  // Three groups with matching gaps between them — brand, then the greeting
  // block, then the primary action — so the top of the screen reads as
  // deliberate rather than as a stack of left-aligned lines.
  header: {
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.xl,
  },
  // Fills the header's height so the badge sits on the lockup's optical
  // middle without being told a pixel offset.
  badgeSlot: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: "center",
  },
  badge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surfaceAccent,
    alignItems: "center",
    justifyContent: "center",
  },
  badgePressed: { backgroundColor: colors.border },
  badgeText: { fontSize: 15, fontWeight: "700", color: colors.brandDark, letterSpacing: 0.5 },

  greeting: { alignItems: "center", gap: 0 },
  salutation: { ...typography.subtitle, fontSize: 16, textAlign: "center" },
  name: { ...typography.title, fontSize: 27, lineHeight: 33, textAlign: "center" },
  // Tight to the name it belongs with, then the full group gap before the card.
  date: {
    ...typography.subtitle,
    fontSize: 14,
    textAlign: "center",
    marginTop: spacing.xs,
    marginBottom: spacing.xl,
  },

  shiftCard: {
    backgroundColor: colors.surfaceAccent,
    borderRadius: radius.card,
    // The photograph bleeds to the card's edges and is clipped by its corners.
    overflow: "hidden",
    marginBottom: spacing.lg,
  },
  // Absolutely filling the card rather than sitting above it: the card's
  // height comes from its CONTENT, and the image covers whatever that is. No
  // aspect ratio to keep in step with the copy.
  shiftImage: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, width: "100%", height: "100%" },
  shiftBody: { padding: spacing.lg },
  shiftIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  // A share of the width, not a fixed one, so the copy holds the same
  // proportion of the card on every phone.
  shiftText: { width: "56%" },
  shiftTitle: { fontSize: 19, fontWeight: "700", color: colors.brandDark, lineHeight: 24 },
  shiftCopy: { ...typography.helper, fontSize: 14, lineHeight: 19, marginTop: spacing.xs },
  shiftAction: { marginTop: spacing.lg },

  recent: { marginBottom: spacing.lg },
  sectionTitle: { fontSize: 17, fontWeight: "700", color: colors.brandDark, marginBottom: spacing.sm },
  // Tall enough to read as a section that will hold rows, short enough not to
  // spend a screen saying "nothing".
  recentEmpty: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.xl,
  },
  recentEmptyText: { ...typography.helper, fontSize: 14 },
});
