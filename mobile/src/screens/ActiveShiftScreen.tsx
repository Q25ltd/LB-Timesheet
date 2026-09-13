/**
 * Active Shift — the driver's workspace for the rest of the day.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SCREEN IS FOR
 * ════════════════════════════════════════════════════════════════════════════
 *
 * A driver glances at this in a yard, in a cab, in the rain. It has to answer
 * four things before they have finished looking: the shift is running, who it
 * is being worked for, which asset they are on, and what to do next. Anything
 * that does not serve one of those is decoration this screen cannot afford.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE WORKSPACE IS BUILT; THE ACTIONS IN IT ARE NOT
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The owner asked to approve the whole composition before any operational
 * action is wired, so the actions are RENDERED and DISABLED: Vehicle Checks,
 * Add Vehicle, Change Vehicle/Unit, Fuel, AdBlue and Finish Shift. None of
 * them has an `onPress`. A control that answers a press by doing nothing
 * teaches a driver the app is broken, so each carries the platform's disabled
 * affordance and tells assistive technology the same thing the pixels do.
 *
 * Rank is therefore carried by SIZE, POSITION and GROUPING rather than by
 * colour — everything unbuilt shares one muted treatment, so the hierarchy the
 * owner is approving is the hierarchy the finished screen will have:
 *
 *   filled, full width   the one obvious next action
 *   bordered, full width the alternative to it
 *   two tiles            things wanted occasionally, mid-shift
 *   below a rule         the end of the day
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT IT REFUSES TO SAY
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Only `LocalShift` is rendered — declared start, working context, and the
 * vehicle as the driver entered it. There is no current mileage, no distance,
 * no driving time, no break, no fuel total and no defect count, because none
 * of those is recorded anywhere (CLAUDE.md — never read a field nothing
 * writes). There is no trailer either: Class 1 pulls one, but no trailer has
 * ever been captured, so inventing "Trailer: None" would state a fact nobody
 * established.
 *
 * Checks are shown as NOT COMPLETED, which is true and is the only check state
 * that exists. "Passed", "Roadworthy" and "Safe" are claims about an
 * inspection that has not happened, on a screen a driver might rely on.
 *
 * Choosing a company at Start Shift was an intention, not a transmission
 * (D28), so nothing here says synced, sent or received.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UNIT AND TRAILER ARE SEPARATE ASSETS, AND ALWAYS WILL BE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * A Class 1 unit and its trailer are checked independently, on separate
 * screens, and either can be swapped without touching the other's state. So
 * the asset section below is ONE self-contained block — heading, identity,
 * facts, then its own actions — and the trailer becomes a second block of the
 * same shape directly beneath it when trailer data exists. Nothing above or
 * below has to move, and no combined "vehicle & trailer checks" control is
 * introduced here, because that workflow is never going to exist.
 */
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TabIcon } from "../components/TabIcon";
import { PrimaryButton } from "../components/PrimaryButton";
import { VEHICLE_CLASSES, type LocalShift, type LocalVehicle, type VehicleClass } from "../shift/localShift";
import { colors, radius, sizing, spacing, typography } from "../theme/index";

/** Said to assistive technology by every control this increment has not wired. */
const NOT_YET_AVAILABLE = "Not available yet";

function classLabel(id: VehicleClass): string {
  return VEHICLE_CLASSES.find(option => option.id === id)?.label ?? id;
}

/** The declared start, as a plain clock time. */
function startedTime(iso: string): string {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/**
 * 184203 → "184,203".
 *
 * Grouped by hand rather than through `toLocaleString`, which would render
 * differently depending on the device's locale — a mileage the driver typed
 * should read back the same on every phone.
 */
function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * A Class 1 is a tractor UNIT pulling a separate trailer, and that is what
 * drivers call it. A Class 2 or a van is one vehicle, so calling it a unit
 * would be jargon adopted for internal consistency at the driver's expense.
 */
function assetWords(vehicleClass: VehicleClass | null) {
  const isUnit = vehicleClass === "class1";
  return {
    section: isUnit ? "CURRENT UNIT" : "CURRENT VEHICLE",
    change:  isUnit ? "Change Unit" : "Change Vehicle",
  };
}

export function ActiveShiftScreen({ shift }: { shift: LocalShift }) {
  const insets = useSafeAreaInsets();
  const { vehicle } = shift;
  const words = assetWords(vehicle?.vehicleClass ?? null);

  return (
    <View style={styles.screen}>
      <ScrollView
        testID="active-shift-scroll"
        style={styles.screen}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.xxl },
        ]}
      >
        <Text style={styles.title} testID="screen-title" accessibilityRole="header">Active Shift</Text>

        {/* The header's whole job: the day is running, since when, and for
            whom. Two facts side by side rather than a stack of labelled rows —
            there is no third fact, and a table of two looks like a form. */}
        <View style={styles.status} testID="shift-status">
          <View style={styles.statusHead}>
            <View style={styles.statusIcon}>
              <TabIcon name="clock" color={colors.brandDark} size={20} />
            </View>
            <Text style={styles.statusHeadline}>Shift active</Text>
          </View>

          <View style={styles.statusFacts}>
            <Fact label="Started" value={startedTime(shift.startedAt)} testID="shift-started-at" />
            <Fact
              label="Working for"
              value={shift.workingFor.kind === "personal" ? "Personal" : shift.workingFor.companyName}
              testID="shift-working-for"
            />
          </View>
        </View>

        <Text style={styles.sectionLabel} testID="current-asset-label">{words.section}</Text>
        <View style={styles.card}>
          {vehicle === null
            ? <NoVehicle />
            : <CurrentVehicle vehicle={vehicle} changeLabel={words.change} />}
        </View>

        {/* ── CURRENT TRAILER goes here ──────────────────────────────────────
            A second block of exactly the shape above: its own section label,
            its own card, its own Trailer Checks and Change Trailer actions,
            and its own independent check state. It is absent rather than empty
            because no trailer has ever been recorded. */}

        <Text style={styles.sectionLabel}>DURING THE SHIFT</Text>
        <View style={styles.tiles}>
          <Tile label="Fuel" testID="fuel" />
          <Tile label="AdBlue" testID="adblue" />
        </View>

        {/* The end of the day, held apart by a rule and a full gap so it is
            never the button a driver hits while reaching for another. */}
        <View style={styles.endOfDay}>
          <PendingAction label="Finish Shift" testID="finish-shift" />
        </View>
      </ScrollView>
    </View>
  );
}

/** A shift running without a vehicle is a complete state, not a half-start (D29). */
function NoVehicle() {
  return (
    <View style={styles.cardBody} testID="no-vehicle">
      <Text style={styles.absent}>No active vehicle</Text>
      {/* The obvious next thing to do, said by being the only filled control
          on the screen rather than by a sentence explaining itself. */}
      <PrimaryButton label="Add Vehicle" disabled testID="add-vehicle" />
    </View>
  );
}

function CurrentVehicle({ vehicle, changeLabel }: { vehicle: LocalVehicle; changeLabel: string }) {
  return (
    <View style={styles.cardBody} testID="active-vehicle">
      {/* The plate is what a driver checks they are in the right truck by, so
          it is the largest thing in the card and sits in its own panel. Held
          to one line and shrunk to fit rather than wrapped or clipped: plates
          are international and some are long. */}
      <View style={styles.platePanel}>
        <Text
          style={styles.plate}
          testID="vehicle-plate-value"
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.6}
        >
          {vehicle.numberPlate}
        </Text>
      </View>

      <Text style={styles.class} testID="vehicle-class-value">{classLabel(vehicle.vehicleClass)}</Text>

      <View style={styles.facts}>
        <FactRow label="Start mileage">
          <Text style={styles.factValue} testID="vehicle-mileage-value">
            {`${groupDigits(vehicle.startMileage)} mi`}
          </Text>
        </FactRow>
        <FactRow label="Vehicle checks">
          {/* The only check state that exists. Deliberately not a red or amber
              badge: nothing is wrong with a shift whose checks are still to be
              done, and a warning colour here would cry wolf every morning. */}
          <View style={styles.pill}>
            <Text style={styles.pillText} testID="vehicle-checks-state">Not completed</Text>
          </View>
        </FactRow>
      </View>

      <PrimaryButton label="Vehicle Checks" disabled testID="vehicle-checks" />
      <View style={styles.secondarySlot}>
        <PendingAction label={changeLabel} testID="change-vehicle" />
      </View>
    </View>
  );
}

/**
 * NO LINE CLAMP, deliberately.
 *
 * The company a day is worked for is identifying information, and
 * "Northgate Heavy Haulage & Logis…" identifies nothing — two operators can
 * share a prefix, and the driver has no other place in the app to read the
 * rest. So a long name wraps to as many lines as it needs and the card grows
 * a little, rather than the name being cut to hold a height. The type is not
 * shrunk to compensate either: a name too small to read at arm's length in a
 * cab fails for the same reason an ellipsis does.
 *
 * The two facts are separate columns of one row, so the taller one sets the
 * row's height and neither can push or overlap the other — `Started` stays
 * exactly where it is, at the top of its own half.
 */
function Fact({ label, value, testID }: { label: string; value: string; testID: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factStrong} testID={testID}>{value}</Text>
    </View>
  );
}

function FactRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.factRow}>
      <Text style={styles.factRowLabel}>{label}</Text>
      {children}
    </View>
  );
}

/**
 * A control whose screen does not exist yet.
 *
 * No `onPress` at all rather than an empty one: `Pressable` with `disabled`
 * reports itself correctly to assistive technology and cannot be made to look
 * like it handled a tap.
 */
function PendingAction({ label, testID }: { label: string; testID: string }) {
  return (
    <Pressable
      testID={testID}
      disabled
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: true }}
      accessibilityHint={NOT_YET_AVAILABLE}
      style={styles.pending}
    >
      <Text style={styles.pendingLabel}>{label}</Text>
    </Pressable>
  );
}

/** Wanted occasionally during the day, so a pair of tiles rather than a stack. */
function Tile({ label, testID }: { label: string; testID: string }) {
  return (
    <Pressable
      testID={testID}
      disabled
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: true }}
      accessibilityHint={NOT_YET_AVAILABLE}
      style={[styles.pending, styles.tile]}
    >
      <Text style={styles.pendingLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1, paddingHorizontal: spacing.xl },

  title: { ...typography.title, marginBottom: spacing.lg },

  status: {
    backgroundColor: colors.surfaceAccent,
    borderRadius: radius.card,
    padding: spacing.lg,
    marginBottom: spacing.xl,
  },
  statusHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  statusIcon: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: colors.surface,
    alignItems: "center", justifyContent: "center",
  },
  statusHeadline: { fontSize: 17, fontWeight: "700", color: colors.brandDark },
  // Two columns that share the width, so a long company name wraps inside its
  // own half instead of pushing the start time off the screen.
  // `flex-start` so the short fact stays at the top of its column while the
  // other grows downward; stretched columns would centre nothing but still
  // leave the two coupled in a way that is easy to break later.
  statusFacts: { flexDirection: "row", alignItems: "flex-start", gap: spacing.lg, marginTop: spacing.lg },
  fact: { flex: 1 },
  factLabel: { ...typography.helper, fontSize: 12 },
  factStrong: { fontSize: 17, fontWeight: "700", color: colors.text, marginTop: 2 },

  sectionLabel: {
    ...typography.label,
    letterSpacing: 1,
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.xl,
  },
  cardBody: { padding: spacing.lg },

  platePanel: {
    backgroundColor: colors.surfaceAccent,
    borderRadius: radius.field,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: "center",
  },
  plate: {
    fontSize: 30,
    fontWeight: "800",
    color: colors.brandDark,
    letterSpacing: 2,
  },
  class: {
    ...typography.subtitle,
    fontSize: 15,
    fontWeight: "600",
    color: colors.textMuted,
    textAlign: "center",
    marginTop: spacing.sm,
  },

  facts: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    marginTop: spacing.lg,
    marginBottom: spacing.lg,
  },
  factRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    minHeight: 44,
  },
  factRowLabel: { fontSize: 15, color: colors.textMuted },
  factValue: { flexShrink: 1, fontSize: 16, fontWeight: "700", color: colors.text, textAlign: "right" },
  pill: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    paddingVertical: 5,
    paddingHorizontal: spacing.md,
  },
  pillText: { fontSize: 13, fontWeight: "700", color: colors.textMuted },

  absent: {
    fontSize: 19,
    fontWeight: "700",
    color: colors.textMuted,
    textAlign: "center",
    paddingVertical: spacing.lg,
  },

  secondarySlot: { marginTop: spacing.md },
  pending: {
    minHeight: sizing.control,
    borderRadius: radius.button,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.md,
  },
  pendingLabel: { fontSize: 16, fontWeight: "700", color: colors.disabled },

  // Equal halves that shrink together; no fixed tile width to break on a
  // narrow phone.
  tiles: { flexDirection: "row", gap: spacing.md, marginBottom: spacing.xl },
  tile: { flex: 1 },

  // Pushed to the BOTTOM of the viewport whenever the content is shorter than
  // the screen — which is the no-vehicle day on a large phone, where a fixed
  // gap left a third of the screen empty below it. `marginTop: "auto"` eats
  // the slack instead, and contributes nothing once the content overflows, so
  // the vehicle day still scrolls normally. It also buys the end-of-day action
  // the widest separation from the mid-shift ones exactly when there is room,
  // which is the direction a reach-and-mis-tap should err in.
  endOfDay: {
    marginTop: "auto",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.xl,
  },
});
