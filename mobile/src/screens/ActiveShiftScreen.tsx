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
 * action is wired, so the unbuilt actions are RENDERED and DISABLED: Fuel,
 * AdBlue and Finish Shift. None of them has an `onPress`. Four are live:
 * Discard Shift, Add Vehicle, Vehicle Checks, and Change Unit / Change
 * Vehicle. A control that answers a press by doing nothing teaches a driver
 * the app is broken, so each carries the platform's disabled affordance and
 * tells assistive technology the same thing the pixels do.
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
 * Only `LocalShift` is rendered — declared start, working context, the
 * vehicle as the driver entered it, and the vehicles used earlier in the day.
 * There is no current mileage, no distance, no driving time, no break, no
 * fuel total and no defect count, because none of those is recorded anywhere
 * (CLAUDE.md — never read a field nothing writes). There is no trailer either: a Class 1 pulls a semi-trailer and a
 * Class 2 may pull a drawbar, but no trailer has ever been captured, so
 * inventing "Trailer: None" would state a fact nobody established.
 *
 * Checks are shown as the stored checks say — Not completed, In progress or
 * Completed — and never more. "Passed", "Roadworthy" and "Safe" are claims
 * about an inspection, on a screen a driver might rely on.
 *
 * Choosing a company at Start Shift was an intention, not a transmission
 * (D28), so nothing here says synced, sent or received.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * VEHICLE AND TRAILER ARE SEPARATE ASSETS, AND ALWAYS WILL BE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * A towing vehicle and its trailer are checked independently, on separate
 * screens, and either can be swapped without touching the other's state. So
 * the asset section below is ONE self-contained block — heading, identity,
 * facts, then its own actions — and the trailer becomes a second block of the
 * same shape directly beneath it when trailer data exists. Nothing above or
 * below has to move, and no combined "vehicle & trailer checks" control is
 * introduced here, because that workflow is never going to exist.
 *
 * WHICH vehicle is towing does not change that shape. A Class 1 pulls a
 * semi-trailer and a Class 2 may pull a drawbar — both are trailer-capable in
 * V1, a van is not (D30) — and the block below is the
 * vehicle in use, whatever class it is, with the trailer block beneath it.
 */
import { View, Text, ScrollView, Pressable, Alert, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TabIcon } from "../components/TabIcon";
import { PrimaryButton } from "../components/PrimaryButton";
import { VEHICLE_CLASSES, type LocalShift, type LocalVehicle, type VehicleClass } from "../shift/localShift";
import { checkStateOf, type VehicleCheckState } from "../shift/vehicleCheck";
import { usedThisShift, type UsedVehicle } from "../shift/usedVehicles";
import { colors, radius, sizing, spacing, typography } from "../theme/index";
import { formatClockTime, formatMileage } from "./format";

/** Said to assistive technology by every control this increment has not wired. */
const NOT_YET_AVAILABLE = "Not available yet";

function classLabel(id: VehicleClass): string {
  return VEHICLE_CLASSES.find(option => option.id === id)?.label ?? id;
}

/**
 * A Class 1 is a tractor UNIT pulling a separate trailer, and that is what
 * drivers call it. A Class 2 or a van is one vehicle, so calling it a unit
 * would be jargon adopted for internal consistency at the driver's expense.
 * A rigid towing a drawbar is still called a vehicle — this is what the thing
 * is called, not what it may tow.
 *
 * It follows the vehicle IN USE, not the day: a driver who changes a unit for
 * a van is in a vehicle from that moment, and reads "Current Vehicle".
 */
function assetWords(vehicleClass: VehicleClass | null) {
  const isUnit = vehicleClass === "class1";
  return {
    section: isUnit ? "CURRENT UNIT" : "CURRENT VEHICLE",
    change:  isUnit ? "Change Unit" : "Change Vehicle",
  };
}

interface ActiveShiftScreenProps {
  shift: LocalShift;
  /** Abandon the day. Called ONLY after the driver confirms. */
  onDiscard: () => void;
  /** Open the flow that puts a first vehicle into a day that has none. */
  onAddVehicle: () => void;
  /** Open, resume or show the walkaround check for the current vehicle. */
  onVehicleChecks: () => void;
  /** Open the flow that ends the current vehicle and takes the next. */
  onChangeVehicle: () => void;
}

/**
 * What the Vehicle checks row says — taken from the stored checks, never
 * assumed. A check the driver has opened but not answered is still not started.
 */
const CHECK_STATE_LABEL: Record<VehicleCheckState, string> = {
  "not-started": "Not completed",
  "in-progress": "In progress",
  completed:     "Completed",
};

export function ActiveShiftScreen({ shift, onDiscard, onAddVehicle, onVehicleChecks, onChangeVehicle }: ActiveShiftScreenProps) {
  const insets = useSafeAreaInsets();
  const { vehicle } = shift;
  const words = assetWords(vehicle?.vehicleClass ?? null);
  const startedAt = formatClockTime(shift.startedAt);

  /**
   * DISCARD ASKS BEFORE IT ACTS, and this is the whole safety of the feature.
   *
   * It is the only irreversible thing in the app: the shift is local, nothing
   * has been sent anywhere (D28), so there is no copy to recover it from. A
   * driver in a cab with cold hands must not be able to delete a working day
   * with one press, so the control raises this and does nothing else.
   *
   * The question names the shift by its start time rather than saying "this
   * shift", so someone who opened the app confused about which day they are
   * looking at is told. The destructive button is marked as such, leaving the
   * platform to render it as the dangerous choice and Keep as the safe one.
   */
  function askToDiscard() {
    Alert.alert(
      "Discard this shift?",
      `The shift you started at ${startedAt} will be deleted from this phone. This cannot be undone.`,
      [
        { text: "Keep shift", style: "cancel" },
        { text: "Discard",    style: "destructive", onPress: onDiscard },
      ],
    );
  }

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
        {/* Discard sits up here, as far from Finish Shift as the screen
            allows. They are the two ways a day ends and they must never be
            neighbours: one files the driver's work, the other destroys it,
            and a cold thumb reaching for the bottom of the screen should not
            be able to find the wrong one. Quiet by design — findable when
            wanted, never competing with the work. */}
        <View style={styles.header}>
          <Text style={styles.title} testID="screen-title" accessibilityRole="header">Active Shift</Text>
          <Pressable
            testID="discard-shift"
            onPress={askToDiscard}
            accessibilityRole="button"
            accessibilityLabel="Discard shift"
            accessibilityHint="Asks you to confirm before deleting this shift"
            hitSlop={10}
            style={({ pressed }) => [styles.discard, pressed ? styles.discardPressed : null]}
          >
            <Text style={styles.discardLabel}>Discard</Text>
          </Pressable>
        </View>

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
            <Fact label="Started" value={startedAt} testID="shift-started-at" />
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
            ? <NoVehicle onAddVehicle={onAddVehicle} />
            : (
              <CurrentVehicle
                vehicle={vehicle}
                changeLabel={words.change}
                onVehicleChecks={onVehicleChecks}
                onChangeVehicle={onChangeVehicle}
              />
            )}
        </View>

        {/* ── CURRENT TRAILER goes here ──────────────────────────────────────
            A second block of exactly the shape above: its own section label,
            its own card, its own Trailer Checks and Change Trailer actions,
            and its own independent check state. It is absent rather than empty
            because no trailer has ever been recorded. */}

        <UsedThisShift vehicles={usedThisShift(shift)} />

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
function NoVehicle({ onAddVehicle }: { onAddVehicle: () => void }) {
  return (
    <View style={styles.cardBody} testID="no-vehicle">
      <Text style={styles.absent}>No active vehicle</Text>
      {/* The obvious next thing to do, said by being the only filled control
          on the screen rather than by a sentence explaining itself. */}
      <PrimaryButton label="Add Vehicle" onPress={onAddVehicle} testID="add-vehicle" />
    </View>
  );
}

function CurrentVehicle({ vehicle, changeLabel, onVehicleChecks, onChangeVehicle }: {
  vehicle: LocalVehicle; changeLabel: string; onVehicleChecks: () => void; onChangeVehicle: () => void;
}) {
  const checkState = checkStateOf(vehicle.checks);
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
            {formatMileage(vehicle.startMileage)}
          </Text>
        </FactRow>
        <FactRow label="Vehicle checks">
          {/* Read from the stored checks. Neutral while the check is still to
              do: nothing is wrong with a shift whose checks are still to be
              done, and a warning colour here would cry wolf every morning. Only
              a completed check is marked — by a small tick in the check's own
              restrained green. */}
          <View style={[styles.pill, checkState === "completed" ? styles.pillDone : null]}>
            {checkState === "completed" ? <View style={styles.pillTick} /> : null}
            <Text
              style={[styles.pillText, checkState === "completed" ? styles.pillTextDone : null]}
              testID="vehicle-checks-state"
            >
              {CHECK_STATE_LABEL[checkState]}
            </Text>
          </View>
        </FactRow>
      </View>

      {/* Once the check is done it is no longer what to do next, so it stops
          being the filled action — but it stays reachable, because the record
          it opens is the driver's evidence of the walkaround. */}
      {checkState === "completed"
        ? <SecondaryAction label="Vehicle Checks" onPress={onVehicleChecks} testID="vehicle-checks" />
        : <PrimaryButton label="Vehicle Checks" onPress={onVehicleChecks} testID="vehicle-checks" />}
      <View style={styles.secondarySlot}>
        <SecondaryAction label={changeLabel} onPress={onChangeVehicle} testID="change-vehicle" />
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
 * A live control that is not the next thing to do — Change Unit, or a
 * completed check still worth opening.
 *
 * Bordered rather than filled, and with the brand's own text rather than the
 * muted grey of the unbuilt controls — so it reads as something the driver
 * may open, not as something they cannot.
 */
function SecondaryAction({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: false }}
      style={({ pressed }) => [styles.pending, styles.secondary, pressed ? styles.secondaryPressed : null]}
    >
      <Text style={[styles.pendingLabel, styles.secondaryLabel]}>{label}</Text>
    </Pressable>
  );
}

/**
 * The vehicles used earlier in the day — one line per vehicle, most recently
 * used first. Only a vehicle's identity and when it was last used: this is a
 * reminder of the day, not a log of it. Each USE is still kept separately in
 * the day (`usedThisShift` groups for the screen only).
 */
function UsedThisShift({ vehicles }: { vehicles: readonly UsedVehicle[] }) {
  if (vehicles.length === 0) return null;
  return (
    <>
      <Text style={styles.sectionLabel} testID="used-this-shift-label">USED THIS SHIFT</Text>
      <View style={styles.card} testID="used-this-shift">
        {vehicles.map((used, index) => (
          <View
            key={`${used.vehicleClass}-${used.numberPlate}`}
            style={[styles.usedRow, index === vehicles.length - 1 ? null : styles.usedDivided]}
            testID={`used-${used.numberPlate}`}
          >
            <Text style={styles.usedPlate}>{used.numberPlate}</Text>
            <Text style={styles.usedMeta}>
              {`${classLabel(used.vehicleClass)} · last used ${formatClockTime(used.lastEndedAt)}`}
            </Text>
          </View>
        ))}
      </View>
    </>
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

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  title: { ...typography.title, flexShrink: 1 },
  // Its own touch target, pulled flush with the content margin so the label
  // lines up with the card edges below rather than floating inside padding.
  discard: {
    minHeight: sizing.minTouch,
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
    marginRight: -spacing.sm,
  },
  discardPressed: { opacity: 0.5 },
  discardLabel: { fontSize: 15, fontWeight: "700", color: colors.textMuted },

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
  // A completed check is marked by one small tick in the check's own green,
  // and nothing louder: the row is a status, not a result.
  pillDone: { flexDirection: "row", alignItems: "center", gap: 6, borderColor: colors.success },
  pillTick: {
    width: 9, height: 5,
    borderLeftWidth: 2, borderBottomWidth: 2,
    borderColor: colors.success,
    transform: [{ rotate: "-45deg" }],
    marginTop: -3,
  },
  pillTextDone: { color: colors.success },
  secondary: { borderColor: colors.border, backgroundColor: colors.surface },
  secondaryPressed: { backgroundColor: colors.surfaceAccent },
  secondaryLabel: { color: colors.brandDark },

  usedRow: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg, gap: 2 },
  usedDivided: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  usedPlate: { fontSize: 18, fontWeight: "800", color: colors.text, letterSpacing: 0.5 },
  usedMeta: { fontSize: 14, color: colors.textMuted },
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
