/**
 * Vehicle Check / Unit Check — the daily walkaround, answered item by item.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * DEFECT-FIRST: THE DRIVER CHANGES WHAT DIFFERS, THEN CONFIRMS
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Every row starts at the result declared for that vehicle class — OK for
 * equipment the class always has, N/A for equipment it may not (see
 * `checklists.ts`). The driver walks round, changes anything that differs, and
 * presses Complete Check.
 *
 * A DEFAULT IS NOT A CHECK, and the screen never says otherwise. Opening it
 * stores nothing and completes nothing; there is no "42 of 42 completed"
 * counter, because a full set of defaults is not 42 things the driver did.
 * The status says what the driver has done, live: "Not confirmed" while every
 * row stands at its default — on opening, or after every change was put back
 * — and "In progress" the moment any row differs, the same line the saved
 * draft draws (`hasOverrides`). The footer counts are the results that STAND,
 * not work done. Pressing Complete Check is the driver confirming they
 * performed the walkaround and that these are its results; only then does it
 * read "Completed".
 *
 * A DEFECT needs its description. The field appears under the row the moment
 * DEFECT is chosen and takes the cursor, so the driver can type straight away.
 * The WHOLE description box — field, text, counter — is kept in view: clear of
 * the fixed footer, and once the keyboard has risen, clear of the keyboard
 * too, as the box grows line by line. The space is measured, never assumed,
 * so it holds on every screen size (`visibleArea`, `bringIntoView`). The
 * check cannot be completed while any defect is undescribed. Choosing OK or
 * N/A instead removes the description with it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * NOTHING IS LOST, AND NOTHING IS CLAIMED EARLY
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Each answer is saved as it is given, on the phone, with no network, so a
 * closed app or a flat battery loses nothing. That is why BACK IS THE ONLY WAY
 * OUT: a "Save & Exit" beside it would imply that Back is the one that loses
 * work, and neither does. Merely opening the screen saves nothing, so Active
 * Shift does not claim a check is in progress until the driver has actually
 * answered something.
 *
 * Complete Check stays unavailable until every row is answered and every
 * defect is described. Once completed, the check cannot be edited, and it is
 * shown from its own record alone — its rows, labels, sections, order and
 * results as the driver confirmed them — never re-read through the checklist
 * the app carries today (`sectionsOf`).
 *
 * COLOUR. The app avoids traffic-light colour, and this control is the one
 * exception, because here the colour IS the result: restrained green for OK,
 * neutral for N/A, red for a defect. Outside the check, only the small tick
 * that marks a completed check on Active Shift uses the same green.
 */
import { createRef, useEffect, useRef, useState, type RefObject } from "react";
import { View, Text, TextInput, ScrollView, Pressable, ActivityIndicator, StyleSheet, Keyboard, type KeyboardEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { LocalVehicle } from "../shift/localShift";
import type { Checklist } from "../shift/checklists";
import {
  CHECK_RESULT,
  CHECK_STATUS,
  DEFECT_NOTE_MAX_LENGTH,
  hasOverrides,
  resultsOf,
  sectionsOf,
  summarise,
  type CheckAnswer,
  type CheckResult,
  type VehicleCheck,
} from "../shift/vehicleCheck";
import { keyboardSafeScrollProps } from "./vehicleForm";
import { formatClockTime, formatMileage } from "./format";
import { colors, radius, sizing, spacing } from "../theme/index";

interface VehicleCheckScreenProps {
  vehicle: LocalVehicle;
  checklist: Checklist;
  /** The check being resumed or shown, or `null` for a fresh one. */
  check: VehicleCheck | null;
  /** Store the answers so far. Rejects if they could not be stored. */
  onSave: (answers: CheckAnswer[]) => Promise<void>;
  /** Store the finished check. Rejects if it could not be completed. */
  onComplete: (answers: CheckAnswer[]) => Promise<void>;
  onExit: () => void;
}

const CHOICES: readonly { result: CheckResult; label: string }[] = [
  { result: CHECK_RESULT.ok,            label: "OK" },
  { result: CHECK_RESULT.notApplicable, label: "N/A" },
  { result: CHECK_RESULT.defect,        label: "DEFECT" },
];

export function VehicleCheckScreen({ vehicle, checklist, check, onSave, onComplete, onExit }: VehicleCheckScreenProps) {
  const insets = useSafeAreaInsets();
  const completed = check?.status === CHECK_STATUS.completed;
  const [answers, setAnswers] = useState(() => resultsOf(checklist, check));
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  /** The most recent save. Leaving waits for it, so the last answer is on disk first. */
  const pending = useRef<Promise<void>>(Promise.resolve());
  /** One completion, however many taps — set synchronously, before any re-render. */
  const inFlight = useRef(false);
  /** What a defect description must fit inside, measured. Stable for the screen's life. */
  const [viewport] = useState<Viewport>(() => ({
    scroll: createRef<ScrollView>(),
    topBar: createRef<View>(),
    footer: createRef<View>(),
    scrollY: { current: 0 },
    keyboardTop: { current: null },
  }));
  /** The row just set to DEFECT, whose description is still to be brought into view. */
  const [revealing, setRevealing] = useState<string | null>(null);
  /** The description the driver is typing in — kept in view as the keyboard and the text move. */
  const typing = useRef<{ box: View; field: TextInput } | null>(null);

  useEffect(() => {
    // The keyboard's final frame is known only once it has finished moving.
    // The list's own keyboard handling stops at the focused field's edge, so
    // the rest of the box — its counter, its bottom — is refitted here.
    function follow(event: KeyboardEvent) {
      viewport.keyboardTop.current = event.endCoordinates.screenY;
      const active = typing.current;
      if (active !== null && active.field.isFocused()) void bringIntoView(viewport, active.box);
    }
    const subscriptions = [
      Keyboard.addListener("keyboardDidShow", follow),
      Keyboard.addListener("keyboardDidChangeFrame", follow),
      Keyboard.addListener("keyboardDidHide", () => { viewport.keyboardTop.current = null; }),
    ];
    return () => { for (const subscription of subscriptions) subscription.remove(); };
  }, [viewport]);

  const summary = summarise(checklist, answers);
  const shown = sectionsOf(checklist, check);
  const isUnit = vehicle.vehicleClass === "class1";
  const title = isUnit ? "Unit Check" : "Vehicle Check";

  function persist(next: Map<string, CheckAnswer>) {
    setAnswers(next);
    // A failed save is reported by the route; the answer stays on screen and
    // the next change tries again. Leaving still waits for this attempt.
    pending.current = onSave([...next.values()]).then(undefined, () => undefined);
  }

  function choose(key: string, result: CheckResult) {
    if (completed) return;
    const current = answers.get(key);
    if (current?.result === result) return;
    const next = new Map(answers);
    // A description belongs to a defect only; choosing OK or N/A drops it.
    next.set(key, { key, result, note: result === CHECK_RESULT.defect ? (current?.note ?? "") : "" });
    persist(next);
    if (result === CHECK_RESULT.defect) setRevealing(key);
  }

  /**
   * Bring a newly opened defect description into view and put the cursor in
   * it. Called once its box has laid out, so the measurements are real.
   *
   * The list moves only as far as it must: not at all if the box is already
   * clear. Focusing raises the keyboard; once it has settled, the box is
   * refitted above it (the effect above).
   */
  function reveal(box: View, field: TextInput) {
    setRevealing(null);
    typing.current = { box, field };
    void bringIntoView(viewport, box).then(() => { field.focus(); });
  }

  /** A defect's box has laid out: newly opened, or grown as the driver types. */
  function defectLaidOut(key: string, box: View, field: TextInput) {
    if (revealing === key) { reveal(box, field); return; }
    // Another line of text makes the box taller; keep all of it in view.
    // A saved defect laying out on opening is not being typed in, and moves nothing.
    if (field.isFocused()) void bringIntoView(viewport, box);
  }

  /** The driver is in this description, however they got there. */
  function defectFocused(box: View, field: TextInput) {
    typing.current = { box, field };
    // Moving from one description to another with the keyboard already up
    // raises no keyboard event; fit the new one now.
    if (viewport.keyboardTop.current !== null) void bringIntoView(viewport, box);
  }

  function describe(key: string, note: string) {
    const current = answers.get(key);
    if (completed || current?.result !== CHECK_RESULT.defect) return;
    const next = new Map(answers);
    next.set(key, { ...current, note: note.slice(0, DEFECT_NOTE_MAX_LENGTH) });
    persist(next);
  }

  function leave() {
    void pending.current.then(onExit);
  }

  function complete() {
    if (!summary.canComplete || completed || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    const final = [...answers.values()];
    void pending.current
      .then(() => onComplete(final))
      .then(undefined, () => {
        inFlight.current = false;
        setSubmitting(false);
      });
  }

  function toggleSection(id: string) {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id); else next.add(id);
    setCollapsed(next);
  }

  const status = completed ? "Completed" : hasOverrides(checklist, answers) ? "In progress" : "Not confirmed";

  return (
    <View style={styles.screen}>
      <View ref={viewport.topBar} style={[styles.topBar, { paddingTop: insets.top }]} testID="check-top-bar">
        <View style={styles.topBarRow}>
          <Pressable
            testID="vehicle-check-back"
            onPress={leave}
            accessibilityRole="button"
            accessibilityLabel="Back to shift"
            hitSlop={12}
            style={styles.topSide}
          >
            <View style={styles.backChevron} />
          </Pressable>
          <Text style={styles.topTitle} testID="screen-title" accessibilityRole="header" numberOfLines={1}>{title}</Text>
          {/* Balances the back control so the title sits centred on the screen. */}
          <View style={styles.topSide} />
        </View>
      </View>

      <ScrollView
        ref={viewport.scroll}
        testID="vehicle-check-scroll"
        // Every scroll is reported — the keyboard's own adjustment included —
        // so a refit starts from where the list really is.
        onScroll={event => { viewport.scrollY.current = event.nativeEvent.contentOffset.y; }}
        scrollEventThrottle={16}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        // A defect description is typed near the bottom of a long list; the
        // keyboard must not sit on it. See `keyboardSafeScrollProps`.
        {...keyboardSafeScrollProps}
      >
        <View style={styles.identity}>
          <View style={styles.identityText}>
            <Text style={styles.plate} testID="check-plate" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
              {vehicle.numberPlate}
            </Text>
            <Text style={styles.mileage} testID="check-mileage">{`Start mileage: ${formatMileage(vehicle.startMileage)}`}</Text>
          </View>
          <View style={[styles.statusPill, completed ? styles.statusPillDone : null]}>
            <Text style={styles.statusText} testID="check-status">{status}</Text>
          </View>
        </View>

        {completed ? null : (
          <View style={styles.info}>
            <View style={styles.infoIcon}><Text style={styles.infoIconText}>i</Text></View>
            <Text style={styles.infoText}>
              Each item starts at its usual result. Walk round the vehicle and change anything
              that differs — tap DEFECT if you find a problem — then press Complete Check.
            </Text>
          </View>
        )}

        {shown.map(section => {
          const open = !collapsed.has(section.id);
          // A record from before sections were stored has none to show; its
          // rows are listed as they were recorded, under no borrowed heading.
          const heading = section.title ?? "ALL CHECKS";
          return (
            <View key={section.id} style={styles.section} testID={`check-section-${section.id}`}>
              <Pressable
                onPress={() => { toggleSection(section.id); }}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                accessibilityLabel={`${heading}, ${String(section.rows.length)} checks`}
                style={[styles.sectionHeader, open ? styles.sectionHeaderOpen : null]}
                testID={`check-section-toggle-${section.id}`}
              >
                <Text style={styles.sectionTitle} testID={`check-section-title-${section.id}`}>{heading}</Text>
                <Text style={styles.sectionCount}>{`${String(section.rows.length)} checks`}</Text>
                <View style={[styles.chevron, open ? styles.chevronUp : styles.chevronDown]} />
              </Pressable>
              {open ? section.rows.map((entry, index) => (
                <CheckRow
                  key={entry.key}
                  entry={entry}
                  answer={answers.get(entry.key)}
                  last={index === section.rows.length - 1}
                  readOnly={completed}
                  onDefectLayout={completed ? undefined : (box, field) => { defectLaidOut(entry.key, box, field); }}
                  onDefectFocus={completed ? undefined : defectFocused}
                  onChoose={result => { choose(entry.key, result); }}
                  onDescribe={note => { describe(entry.key, note); }}
                />
              )) : null}
            </View>
          );
        })}
      </ScrollView>

      <View ref={viewport.footer} style={[styles.footer, { paddingBottom: insets.bottom + spacing.sm }]} testID="check-footer">
        <View style={styles.summaryRow}>
          <View style={styles.summaryCounts}>
            <View style={styles.summaryItem}>
              <View style={[styles.dot, styles.dotOk]}><View style={styles.dotTick} /></View>
              <Text style={styles.summaryText} testID="summary-ok">{`${String(summary.ok)} OK`}</Text>
            </View>
            <View style={styles.summaryItem}>
              <View style={[styles.dot, styles.dotNa]} />
              <Text style={styles.summaryText} testID="summary-na">{`${String(summary.notApplicable)} N/A`}</Text>
            </View>
            <View style={styles.summaryItem}>
              <View style={styles.warn}><Text style={styles.warnMark}>!</Text></View>
              <Text style={styles.summaryText} testID="summary-defects">
                {`${String(summary.defects)} ${summary.defects === 1 ? "Defect" : "Defects"}`}
              </Text>
            </View>
          </View>
          {/* The size of the list, not a count of work done: with defaults,
              "42 of 42 answered" would have read as a finished walkaround from
              the moment the screen opened. */}
          <Text style={styles.answered} testID="summary-total">{`${String(summary.total)} checks`}</Text>
        </View>

        {completed && check?.completedAt ? (
          <View style={styles.doneBanner} testID="check-completed-at">
            <Text style={styles.doneText}>{`Check completed at ${formatClockTime(check.completedAt)}`}</Text>
          </View>
        ) : (
          <>
            {summary.undescribedDefects > 0 ? (
              <Text style={styles.blocker} testID="check-blocker">
                {summary.undescribedDefects === 1 ? "Describe the defect to complete the check" : `Describe all ${String(summary.undescribedDefects)} defects to complete the check`}
              </Text>
            ) : null}
            <Pressable
              testID="complete-check"
              onPress={complete}
              disabled={!summary.canComplete || submitting}
              accessibilityRole="button"
              accessibilityLabel="Complete check. Finish and return to shift"
              accessibilityState={{ disabled: !summary.canComplete || submitting, busy: submitting }}
              style={({ pressed }) => [
                styles.complete,
                !summary.canComplete ? styles.completeDisabled : null,
                pressed && summary.canComplete ? styles.completePressed : null,
              ]}
            >
              {submitting ? <ActivityIndicator color={colors.onBrand} /> : (
                <>
                  <View style={styles.completeIcon}><View style={styles.completeTick} /></View>
                  <View>
                    <Text style={styles.completeTitle}>COMPLETE CHECK</Text>
                    <Text style={styles.completeSub}>Finish and return to shift</Text>
                  </View>
                </>
              )}
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

function CheckRow({ entry, answer, last, readOnly, onDefectLayout, onDefectFocus, onChoose, onDescribe }: {
  entry: { key: string; label: string };
  answer: CheckAnswer | undefined;
  last: boolean;
  readOnly: boolean;
  /** The defect box has laid out — the screen decides whether that moves anything. */
  onDefectLayout: ((box: View, field: TextInput) => void) | undefined;
  /** The driver has put the cursor in this description. */
  onDefectFocus: ((box: View, field: TextInput) => void) | undefined;
  onChoose: (result: CheckResult) => void;
  onDescribe: (note: string) => void;
}) {
  const box = useRef<View>(null);
  const field = useRef<TextInput>(null);
  const isDefect = answer?.result === CHECK_RESULT.defect;
  const undescribed = isDefect && answer.note.trim() === "";
  return (
    <View style={[styles.row, last && !isDefect ? null : styles.rowDivided]} testID={`check-row-${entry.key}`}>
      <View style={styles.rowMain}>
        <Text style={styles.rowLabel}>{entry.label}</Text>
        <View style={styles.choices} accessibilityRole="radiogroup" accessibilityLabel={entry.label}>
          {CHOICES.map(choice => {
            const selected = answer?.result === choice.result;
            return (
              <Pressable
                key={choice.result}
                testID={`check-${entry.key}-${choice.result}`}
                onPress={() => { onChoose(choice.result); }}
                disabled={readOnly}
                accessibilityRole="radio"
                accessibilityLabel={`${entry.label}: ${choice.label}`}
                accessibilityState={{ selected, disabled: readOnly }}
                hitSlop={{ top: 4, bottom: 4 }}
                style={[
                  styles.choice,
                  selected && choice.result === CHECK_RESULT.ok ? styles.choiceOk : null,
                  selected && choice.result === CHECK_RESULT.notApplicable ? styles.choiceNa : null,
                  selected && choice.result === CHECK_RESULT.defect ? styles.choiceDefect : null,
                ]}
              >
                <Text
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.7}
                  style={[
                    styles.choiceText,
                    selected && choice.result === CHECK_RESULT.ok ? styles.choiceTextOk : null,
                    selected && choice.result === CHECK_RESULT.notApplicable ? styles.choiceTextNa : null,
                    selected && choice.result === CHECK_RESULT.defect ? styles.choiceTextDefect : null,
                  ]}
                >
                  {choice.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {isDefect ? (
        <View
          ref={box}
          style={styles.defectBox}
          testID={`check-defect-${entry.key}`}
          // The box has its real size and place only once laid out — and lays
          // out again each time a new line of text makes it taller.
          onLayout={onDefectLayout === undefined ? undefined : () => {
            if (box.current !== null && field.current !== null) onDefectLayout(box.current, field.current);
          }}
        >
          {/* An instruction while the check is open; on a completed check it is
              simply what the driver recorded. */}
          <Text style={styles.defectLabel}>{readOnly ? "Defect" : "Describe the defect *"}</Text>
          {readOnly ? (
            <Text style={styles.defectReadOnly} testID={`check-note-${entry.key}`}>{answer.note}</Text>
          ) : (
            <View style={[styles.defectField, undescribed ? styles.defectFieldEmpty : null]}>
              <TextInput
                ref={field}
                testID={`check-note-${entry.key}`}
                onFocus={onDefectFocus === undefined ? undefined : () => {
                  if (box.current !== null && field.current !== null) onDefectFocus(box.current, field.current);
                }}
                value={answer.note}
                onChangeText={onDescribe}
                multiline
                maxLength={DEFECT_NOTE_MAX_LENGTH}
                placeholder="What is wrong?"
                placeholderTextColor={colors.placeholder}
                accessibilityLabel={`Describe the defect: ${entry.label}`}
                style={styles.defectInput}
              />
              <Text style={styles.counter}>{`${String(answer.note.length)}/${String(DEFECT_NOTE_MAX_LENGTH)}`}</Text>
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}

/** The parts of the screen a defect description is fitted between. */
interface Viewport {
  scroll: RefObject<ScrollView | null>;
  topBar: RefObject<View | null>;
  footer: RefObject<View | null>;
  /** Where the list is scrolled to. */
  scrollY: { current: number };
  /** The top of the software keyboard, in window coordinates; `null` while it is down. */
  keyboardTop: { current: number | null };
}

/**
 * Where the list can show a field, in window coordinates: below the fixed top
 * bar, and above whichever reaches higher — the fixed footer, or the software
 * keyboard. With the keyboard up that is what is left above it; the footer
 * sits behind the keyboard. A keyboard lower than the footer (a hardware
 * keyboard's slim bar) leaves the footer as the limit.
 */
export function visibleArea(topBarBottom: number, footerTop: number, keyboardTop: number | null): { top: number; bottom: number } {
  return { top: topBarBottom, bottom: keyboardTop === null ? footerTop : Math.min(footerTop, keyboardTop) };
}

/**
 * Scroll just far enough that `box` sits wholly inside the visible area, with
 * room to spare below it — or not at all when it already does. Everything is
 * measured at the moment of asking, so it is right for any screen and any
 * keyboard.
 */
function bringIntoView(viewport: Viewport, box: View): Promise<void> {
  const scroll = viewport.scroll.current;
  const topBar = viewport.topBar.current;
  const footer = viewport.footer.current;
  if (scroll === null || topBar === null || footer === null) return Promise.resolve();
  return Promise.all([frameOf(box), frameOf(topBar), frameOf(footer)]).then(([boxFrame, topBarFrame, footerFrame]) => {
    const area = visibleArea(topBarFrame.bottom, footerFrame.top, viewport.keyboardTop.current);
    const target = revealOffset(viewport.scrollY.current, boxFrame, area, spacing.md);
    if (target !== null) scroll.scrollTo({ y: target, animated: true });
  });
}

/** Where a view sits on screen, top and bottom, in window coordinates. */
function frameOf(node: View): Promise<{ top: number; bottom: number }> {
  return new Promise(resolve => {
    node.measureInWindow((_x, y, _width, height) => { resolve({ top: y, bottom: y + height }); });
  });
}

/**
 * How far to scroll so a box sits wholly inside the visible list, with
 * `margin` to spare — or `null` when it already does. Never further than
 * needed: a box below the fold is brought up until its bottom clears the
 * footer, a box above is brought down until its top clears the header, and a
 * box taller than the list is aligned by its top, where typing starts.
 *
 * `offset` is the current scroll position; the rest are window coordinates.
 */
export function revealOffset(
  offset: number,
  box: { top: number; bottom: number },
  list: { top: number; bottom: number },
  margin: number,
): number | null {
  const top = list.top + margin;
  const bottom = list.bottom - margin;
  if (box.top >= top && box.bottom <= bottom) return null;
  const delta = box.top < top ? box.top - top : Math.min(box.bottom - bottom, box.top - top);
  return Math.max(0, offset + delta);
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },

  topBar: {
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  topBarRow: { flexDirection: "row", alignItems: "center", minHeight: 52, paddingHorizontal: spacing.lg },
  // Equal side slots keep the title centred on the screen.
  topSide: { width: 56, minHeight: sizing.minTouch, justifyContent: "center" },
  backChevron: {
    width: 13, height: 13,
    borderLeftWidth: 2.5, borderBottomWidth: 2.5,
    borderColor: colors.text,
    transform: [{ rotate: "45deg" }],
    marginLeft: 4,
  },
  topTitle: { flex: 1, textAlign: "center", fontSize: 19, fontWeight: "700", color: colors.text },

  scroll: { flex: 1 },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.xl },

  identity: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md, paddingHorizontal: spacing.xs },
  identityText: { flex: 1 },
  plate: { fontSize: 26, fontWeight: "800", color: colors.text, letterSpacing: 0.5 },
  mileage: { fontSize: 15, color: colors.textMuted, marginTop: 2 },
  statusPill: {
    backgroundColor: colors.surfaceAccent,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.field,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    marginTop: 2,
  },
  statusPillDone: { backgroundColor: colors.surface },
  statusText: { fontSize: 14, fontWeight: "600", color: colors.brandDark },

  info: {
    marginTop: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surfaceAccent,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.card,
    padding: spacing.md,
  },
  infoIcon: {
    width: 30, height: 30, borderRadius: 15,
    borderWidth: 2, borderColor: colors.brandLight,
    alignItems: "center", justifyContent: "center",
  },
  infoIconText: { fontSize: 15, fontWeight: "700", color: colors.brandLight },
  infoText: { flex: 1, fontSize: 14, lineHeight: 19, color: colors.textMuted },

  section: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: spacing.lg,
    overflow: "hidden",
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 52,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.background,
  },
  sectionHeaderOpen: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  sectionTitle: { flex: 1, fontSize: 15, fontWeight: "700", color: colors.text, letterSpacing: 0.3 },
  sectionCount: { fontSize: 13, color: colors.textMuted },
  chevron: {
    width: 10, height: 10,
    borderLeftWidth: 2, borderTopWidth: 2,
    borderColor: colors.text,
    marginLeft: spacing.xs,
  },
  chevronUp: { transform: [{ rotate: "45deg" }], marginTop: 4 },
  chevronDown: { transform: [{ rotate: "225deg" }], marginTop: -4 },

  row: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  rowDivided: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowMain: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 48 },
  // Wraps rather than shrinking the answer buttons: long item names and large
  // text sizes grow the row taller, never push a button off the screen.
  rowLabel: { flex: 1, fontSize: 16, color: colors.text },
  choices: { flexDirection: "row", gap: 6 },
  choice: {
    width: 62,
    minHeight: sizing.minTouch,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  choiceOk: { borderColor: colors.success, borderWidth: 2 },
  choiceNa: { backgroundColor: colors.neutralSelected, borderColor: colors.placeholder },
  choiceDefect: { backgroundColor: colors.danger, borderColor: colors.danger },
  choiceText: { fontSize: 14, fontWeight: "600", color: colors.textMuted },
  choiceTextOk: { color: colors.success, fontWeight: "800" },
  choiceTextNa: { color: colors.text, fontWeight: "700" },
  choiceTextDefect: { color: colors.onBrand, fontWeight: "800" },

  defectBox: {
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: 10,
    padding: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  defectLabel: { fontSize: 13, fontWeight: "600", color: colors.danger, marginBottom: spacing.sm },
  defectField: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.field,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  defectFieldEmpty: { borderColor: colors.danger },
  defectInput: { minHeight: 44, fontSize: 16, color: colors.text, textAlignVertical: "top", padding: 0 },
  defectReadOnly: { fontSize: 16, color: colors.text },
  counter: { alignSelf: "flex-end", fontSize: 12, color: colors.textMuted },

  footer: {
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  summaryRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: spacing.md,
    rowGap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  summaryCounts: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  summaryItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  summaryText: { fontSize: 14, color: colors.text },
  dot: { width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  dotOk: { backgroundColor: colors.success },
  dotTick: {
    width: 9, height: 5,
    borderLeftWidth: 2, borderBottomWidth: 2,
    borderColor: colors.onBrand,
    transform: [{ rotate: "-45deg" }],
    marginTop: -2,
  },
  dotNa: { borderWidth: 2, borderColor: colors.textMuted },
  warn: {
    width: 20, height: 20, borderRadius: 4,
    borderWidth: 2, borderColor: colors.danger,
    alignItems: "center", justifyContent: "center",
  },
  warnMark: { fontSize: 13, fontWeight: "800", color: colors.danger, lineHeight: 15 },
  answered: { fontSize: 14, color: colors.textMuted },
  blocker: { fontSize: 13, color: colors.danger, textAlign: "center", marginBottom: spacing.xs },

  complete: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    minHeight: 60,
    borderRadius: radius.button,
    backgroundColor: colors.brandDark,
    marginTop: spacing.xs,
  },
  completeDisabled: { backgroundColor: colors.disabled },
  completePressed: { backgroundColor: colors.brandDeep },
  completeIcon: {
    width: 30, height: 30, borderRadius: 15,
    borderWidth: 2, borderColor: colors.onBrand,
    alignItems: "center", justifyContent: "center",
  },
  completeTick: {
    width: 13, height: 7,
    borderLeftWidth: 2.5, borderBottomWidth: 2.5,
    borderColor: colors.onBrand,
    transform: [{ rotate: "-45deg" }],
    marginTop: -3,
  },
  completeTitle: { fontSize: 17, fontWeight: "800", color: colors.onBrand, letterSpacing: 0.5 },
  completeSub: { fontSize: 13, color: colors.onBrand, opacity: 0.9 },

  doneBanner: {
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.button,
    backgroundColor: colors.background,
    marginTop: spacing.xs,
  },
  doneText: { fontSize: 16, fontWeight: "700", color: colors.text },
});
