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
 * action is wired, so the one unbuilt action is RENDERED and DISABLED:
 * Finish Shift, which has no `onPress`. The rest are live: Discard Shift,
 * Add Vehicle, Vehicle Checks, Change Unit / Change Vehicle, Fuel and AdBlue,
 * and each used vehicle. A control that answers a press by doing nothing
 * teaches a driver the app is broken, so the unbuilt one carries the
 * platform's disabled affordance and tells assistive technology the same
 * thing the pixels do.
 *
 * Rank is therefore carried by SIZE, POSITION and GROUPING rather than by
 * colour, in the order a driver needs them (owner decision, 2026-09-27):
 *
 *   the current vehicle   its plate, its facts, and every action on it —
 *                         checks, change, and Fuel / AdBlue as two tiles
 *                         INSIDE its card, because they are things done to
 *                         the vehicle in use and nothing else
 *   (the current trailer) its own card, directly below, when trailers exist
 *   used this shift       compact rows, one per ENDED use; history, never
 *                         the workspace, so it sits below every live action
 *   below a rule          the end of the day
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT IT REFUSES TO SAY
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Only `LocalShift` is rendered — declared start, working context, the
 * vehicle as the driver entered it, and the vehicles used earlier in the day.
 * There is no current mileage, no distance, no driving time, no break and no
 * defect count, because none of those is recorded anywhere (CLAUDE.md —
 * never read a field nothing writes). The fuel and AdBlue tiles DO carry a
 * total for the vehicle in use, because the driver entered one: litres they
 * gave, beside a count of the fills whose amount nobody knows. An unknown
 * amount is never shown as 0 L and never joins the litres. There is no
 * trailer either: a Class 1 pulls a semi-trailer and a Class 2 may pull a
 * drawbar, but no trailer has ever been captured, so inventing
 * "Trailer: None" would state a fact nobody established.
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
import { useState } from "react";
import { View, Text, ScrollView, Pressable, Alert, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TabIcon } from "../components/TabIcon";
import { PrimaryButton } from "../components/PrimaryButton";
import type { EndedVehicle, LocalShift, LocalVehicle, VehicleClass } from "../shift/localShift";
import { checkStateOf } from "../shift/vehicleCheck";
import { FILL_TYPES, summariseFills, type FillSummary, type FillType } from "../shift/vehicleFill";
import { usageDistance, usageHistory } from "../shift/usedVehicles";
import { colors, radius, sizing, spacing, typography } from "../theme/index";
import { CHECK_STATE_LABEL, classLabel, fillSummaryText, formatClockTime, formatMileage, formatMileageRange } from "./format";

/** Said to assistive technology by every control this increment has not wired. */
const NOT_YET_AVAILABLE = "Not available yet";

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
  /** Record fuel or AdBlue on the vehicle in use — named by its use's `startedAt`. */
  onFill: (type: FillType, usageStartedAt: string) => void;
  /** Open one ended use — named by its `startedAt`, never by plate — to read or correct. */
  onOpenUsage: (usageStartedAt: string) => void;
}

export function ActiveShiftScreen({ shift, onDiscard, onAddVehicle, onVehicleChecks, onChangeVehicle, onFill, onOpenUsage }: ActiveShiftScreenProps) {
  const insets = useSafeAreaInsets();
  const { vehicle } = shift;
  const words = assetWords(vehicle?.vehicleClass ?? null);
  /**
   * Which vehicle USE the driver has folded the card away for, if any — screen
   * state only, never written to the day (D33). Named by the use, so a NEW
   * vehicle is never folded: its card opens with its details and checks.
   */
  const [foldedUse, setFoldedUse] = useState<string | null>(null);
  const expanded = vehicle !== null && foldedUse !== vehicle.startedAt;

  /**
   * Focus moving to ANOTHER section of the screen folds the current vehicle
   * card, so what the driver turned to is not pushed down by it (D33). The
   * card's own actions never call this.
   */
  function focusElsewhere() {
    if (vehicle !== null) setFoldedUse(vehicle.startedAt);
  }
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
        <View
          testID="current-vehicle-card"
          style={[
            styles.card,
            // Folded, the card's whole field says whether THIS use's checks
            // are done — subtly, as the design's own error / success grounds.
            vehicle !== null && !expanded
              ? [styles.clipped, checkStateOf(vehicle.checks) === "completed" ? styles.cardChecksDone : styles.cardChecksToDo]
              : null,
          ]}
        >
          {vehicle === null
            ? <NoVehicle stillOnShift={shift.previousVehicles.length > 0} onAddVehicle={onAddVehicle} />
            : (
              <CurrentVehicle
                vehicle={vehicle}
                expanded={expanded}
                onToggle={() => { setFoldedUse(expanded ? vehicle.startedAt : null); }}
                changeLabel={words.change}
                onVehicleChecks={onVehicleChecks}
                onChangeVehicle={onChangeVehicle}
                onFill={type => { onFill(type, vehicle.startedAt); }}
              />
            )}
        </View>

        {/* ── CURRENT TRAILER goes here ──────────────────────────────────────
            A second block of exactly the shape above: its own section label,
            its own card, its own Trailer Checks and Change Trailer actions,
            and its own independent check state. It is absent rather than empty
            because no trailer has ever been recorded. */}

        <UsedThisShift
          usages={usageHistory(shift)}
          onOpenUsage={usage => { focusElsewhere(); onOpenUsage(usage); }}
        />

        {/* The end of the day, held apart by a rule and a full gap so it is
            never the button a driver hits while reaching for another. When it
            is built it is another section, and pressing it folds the vehicle
            card like any other (D33); while it is disabled it takes no press. */}
        <View style={styles.endOfDay}>
          <PendingAction label="Finish Shift" testID="finish-shift" />
        </View>
      </ScrollView>
    </View>
  );
}

/**
 * A shift running without a vehicle is a complete state, not a half-start —
 * booked on without one (D29), or carrying on after handing one back (D32).
 * No Fuel or AdBlue here: there is nothing to put them into. A used vehicle's
 * own entries are still correctable from its row below.
 */
function NoVehicle({ stillOnShift, onAddVehicle }: { stillOnShift: boolean; onAddVehicle: () => void }) {
  return (
    <View style={styles.cardBody} testID="no-vehicle">
      <Text style={[styles.absent, stillOnShift ? styles.absentWithNote : null]}>No active vehicle</Text>
      {/* Only once a vehicle has been handed back, when a driver may wonder
          whether giving it up ended the day. It did not. */}
      {stillOnShift ? <Text style={styles.absentNote} testID="still-on-shift">You are still on shift.</Text> : null}
      {/* The obvious next thing to do, said by being the only filled control
          on the screen rather than by a sentence explaining itself. */}
      <PrimaryButton label="Add Vehicle" onPress={onAddVehicle} testID="add-vehicle" />
    </View>
  );
}

function CurrentVehicle({ vehicle, expanded, onToggle, changeLabel, onVehicleChecks, onChangeVehicle, onFill }: {
  vehicle: LocalVehicle;
  expanded: boolean;
  /** The plate header: open a folded card, fold an open one. */
  onToggle: () => void;
  changeLabel: string;
  onVehicleChecks: () => void;
  onChangeVehicle: () => void;
  onFill: (type: FillType) => void;
}) {
  /**
   * COLLAPSIBLE, and OPEN by default. Opened, the card is the driver's
   * workspace: checks and every action on the vehicle. Collapsed, it is one
   * row — the plate and a chevron — so what sits below it (the trailer, when
   * trailers exist, and the day's history) is reachable without scrolling.
   *
   * Screen state only, held by the screen (D33): it is never written to the
   * day, and a remount opens the card again.
   */
  const checkState = checkStateOf(vehicle.checks);

  if (!expanded) {
    // The WHOLE card is the target, not the plate or the chevron. The plate
    // and the check line are centred on the CARD: equal padding both sides,
    // with the chevron laid over the right-hand padding rather than beside
    // the text, so it cannot pull the plate off centre.
    const done = checkState === "completed";
    const status = done ? "Checks completed" : "Checks not completed";
    return (
      <Pressable
        testID="current-vehicle-toggle"
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={`${vehicle.numberPlate}. ${status}`}
        accessibilityHint="Shows this vehicle's checks and actions"
        accessibilityState={{ expanded: false }}
        style={({ pressed }) => [styles.collapsed, pressed ? styles.collapsedPressed : null]}
      >
        <Text style={styles.collapsedPlate} testID="vehicle-plate-value" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
          {vehicle.numberPlate}
        </Text>
        <View style={styles.collapsedStatus}>
          {done ? <View style={styles.pillTick} /> : null}
          <Text style={[styles.collapsedStatusText, done ? styles.pillTextDone : styles.collapsedStatusToDo]} testID="collapsed-checks-state">
            {status}
          </Text>
        </View>
        <View style={[styles.disclosure, styles.disclosureClosed]} testID="current-vehicle-chevron" />
      </Pressable>
    );
  }

  return (
    <View style={styles.cardBody} testID="active-vehicle">
      {/* The plate is what a driver checks they are in the right truck by, so
          it is the largest thing in the card and sits in its own panel. Held
          to one line and shrunk to fit rather than wrapped or clipped: plates
          are international and some are long. The panel is also the card's
          disclosure: pressing it folds the card away. The actions below are
          NOT inside it, so pressing one never collapses anything. */}
      <Pressable
        testID="current-vehicle-toggle"
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={vehicle.numberPlate}
        accessibilityHint="Hides this vehicle's checks and actions"
        accessibilityState={{ expanded: true }}
        style={({ pressed }) => [styles.platePanel, pressed ? styles.tilePressed : null]}
      >
        <Text
          style={styles.plate}
          testID="vehicle-plate-value"
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.6}
        >
          {vehicle.numberPlate}
        </Text>
        <View style={[styles.disclosure, styles.disclosureOpen]} />
      </Pressable>

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
      {/* Things put INTO this vehicle, so they live in its card — below the
          actions that decide whether the driver is in it at all. */}
      <View style={styles.tiles}>
        {FILL_TYPES.map(entry => (
          <FillTile
            key={entry.id}
            testID={entry.id}
            label={entry.label}
            summary={summariseFills(vehicle.fills, entry.id)}
            onPress={() => { onFill(entry.id); }}
          />
        ))}
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
 * Each vehicle use that has ENDED, as one compact row — history, not the
 * workspace, so it never stands between the vehicle in use and its actions.
 *
 * ONE ROW PER USE, NEWEST ENDED FIRST, NEVER GROUPED BY PLATE. A driver who
 * took AB12 CDE twice reads two rows with two sets of mileages. Merging them
 * by registration would invent a journey nobody drove. The row says only what
 * identifies the use at a glance — plate, class, its mileages — and opens THAT
 * use, by its `startedAt`, where its checks, fuel and AdBlue are shown and
 * corrected. Every number is stored or subtracted from two stored numbers.
 *
 * Openable whether or not a vehicle is in use now (D31).
 */
function UsedThisShift({ usages, onOpenUsage }: {
  usages: readonly EndedVehicle[];
  onOpenUsage: (usageStartedAt: string) => void;
}) {
  if (usages.length === 0) return null;
  return (
    <>
      <Text style={styles.sectionLabel} testID="used-this-shift-label">USED THIS SHIFT</Text>
      <View testID="used-this-shift" style={[styles.card, styles.clipped]}>
        {usages.map((use, index) => (
          <UsedRow
            key={use.startedAt}
            use={use}
            last={index === usages.length - 1}
            onPress={() => { onOpenUsage(use.startedAt); }}
          />
        ))}
      </View>
    </>
  );
}

function UsedRow({ use, last, onPress }: { use: EndedVehicle; last: boolean; onPress: () => void }) {
  const mileage = `${formatMileageRange(use.startMileage, use.endMileage)} mi · ${formatMileage(usageDistance(use))}`;
  return (
    <Pressable
      testID={`usage-${use.startedAt}`}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${use.numberPlate}, ${classLabel(use.vehicleClass)}. ${mileage}`}
      accessibilityHint="Opens this vehicle use"
      style={({ pressed }) => [styles.usedRow, last ? null : styles.usedDivided, pressed ? styles.tilePressed : null]}
    >
      <View style={styles.usedText}>
        <Text style={styles.usedTitle} numberOfLines={1} testID={`usage-title-${use.startedAt}`}>
          <Text style={styles.usedPlate}>{use.numberPlate}</Text>
          {` · ${classLabel(use.vehicleClass)}`}
        </Text>
        <Text style={styles.usedMeta} testID={`usage-mileage-${use.startedAt}`}>{mileage}</Text>
      </View>
      <View style={styles.usedChevron} />
    </Pressable>
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

/**
 * Fuel or AdBlue on the vehicle in use: what this use has had, and the way to
 * add more.
 *
 * Wanted occasionally during the day, so a pair of tiles rather than a stack.
 * The summary is this use's own arithmetic and nothing else — litres that were
 * given, and a COUNT of the fills whose quantity nobody knows. An unknown
 * amount is never shown as 0 L and never joins the total (`fillSummaryText`).
 */
function FillTile({ testID, label, summary, onPress }: {
  testID: string; label: string; summary: FillSummary; onPress: () => void;
}) {
  const total = fillSummaryText(summary);
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={total === null ? label : `${label}. ${total.amount}, ${total.detail}`}
      style={({ pressed }) => [styles.tile, styles.tileLive, pressed ? styles.tilePressed : null]}
    >
      <Text style={styles.tileLabel}>{label}</Text>
      {total === null ? null : (
        <>
          <Text style={styles.tileAmount} testID={`${testID}-amount`}>{total.amount}</Text>
          <Text style={styles.tileDetail} testID={`${testID}-detail`}>{total.detail}</Text>
        </>
      )}
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
  // A pressed row's tint stays inside the card's rounded corners.
  clipped: { overflow: "hidden" },

  // The plate stays centred; the chevron sits at the panel's right edge.
  platePanel: {
    backgroundColor: colors.surfaceAccent,
    borderRadius: radius.field,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xxl,
    alignItems: "center",
    justifyContent: "center",
  },
  // Equal padding left and right, wide enough for the chevron laid over the
  // right-hand side, so the plate and its check line centre on the card.
  collapsed: {
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    minHeight: 68,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xxl + spacing.md,
    borderRadius: radius.card,
  },
  collapsedPressed: { opacity: 0.7 },
  // The plate stays in the brand's dark ink whatever the checks say.
  collapsedPlate: { fontSize: 24, fontWeight: "800", color: colors.brandDark, letterSpacing: 1.5, textAlign: "center" },
  collapsedStatus: { flexDirection: "row", alignItems: "center", gap: 6 },
  collapsedStatusText: { fontSize: 13, fontWeight: "700" },
  collapsedStatusToDo: { color: colors.danger },
  cardChecksToDo: { backgroundColor: colors.dangerBg, borderColor: colors.danger },
  cardChecksDone: { backgroundColor: colors.successBg, borderColor: colors.success },
  disclosure: {
    width: 10,
    height: 10,
    borderRightWidth: 2.5,
    borderTopWidth: 2.5,
    borderColor: colors.textMuted,
  },
  // Closed: points right, "there is more". Open: points up, "fold this away".
  disclosureClosed: { position: "absolute", right: spacing.lg, top: "50%", marginTop: -5, transform: [{ rotate: "45deg" }] },
  disclosureOpen: { position: "absolute", right: spacing.lg, top: "50%", marginTop: -3, transform: [{ rotate: "-45deg" }] },
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

  // One row per ended use: two short lines and a chevron, 60pt or so, so a
  // day of many changes stays a list rather than a wall.
  usedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 60,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  usedDivided: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  usedText: { flex: 1, gap: 2 },
  usedTitle: { fontSize: 15, color: colors.textMuted },
  usedPlate: { fontSize: 17, fontWeight: "800", color: colors.text, letterSpacing: 0.5 },
  usedMeta: { fontSize: 14, color: colors.textMuted },
  usedChevron: {
    width: 9,
    height: 9,
    borderRightWidth: 2.5,
    borderTopWidth: 2.5,
    borderColor: colors.textMuted,
    transform: [{ rotate: "45deg" }],
  },
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
  absentWithNote: { paddingBottom: spacing.xs },
  absentNote: { ...typography.subtitle, textAlign: "center", marginBottom: spacing.lg },

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
  tiles: { flexDirection: "row", gap: spacing.md, marginTop: spacing.md },
  tile: { flex: 1 },
  tileLive: {
    minHeight: sizing.control,
    borderRadius: radius.button,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.md,
    gap: 2,
  },
  tilePressed: { backgroundColor: colors.surfaceAccent },
  tileLabel: { fontSize: 16, fontWeight: "700", color: colors.brandDark },
  tileAmount: { fontSize: 18, fontWeight: "800", color: colors.text },
  tileDetail: { fontSize: 13, color: colors.textMuted },

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
