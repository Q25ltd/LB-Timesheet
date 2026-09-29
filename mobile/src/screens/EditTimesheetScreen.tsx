/**
 * Edit Timesheet — correct a finished day's own facts (D39).
 *
 * Who it was worked for, when it started and finished (date and time, each
 * explicit), Night Out and notes: what a real day may have got wrong. Uses,
 * fills and checks are corrected on each use's own page, never here.
 *
 * The form opens on what the day says NOW. Saving APPENDS a correction — the
 * day as finished and every earlier correction stay as they were — and a
 * form that changes nothing has nothing to save.
 *
 * The same rules the store applies are said here as the driver types, never
 * worked round: the finish may not be before the start, the start may not be
 * after any use of the day began, and the finish may not be before any use
 * ended — except one the day's finish itself ended, which moves with it (D40)
 * and may not be left before its own start. No time is moved for the driver.
 * A finish may be later than now; a CHANGED finish more than 15 minutes ahead
 * of the clock at the press is confirmed, never refused (`confirmFinishAhead`).
 *
 * Working For offers Personal and the driver's companies as the app knows
 * them, by their membership — never a typed name — and keeps the company the
 * day already names even when it is no longer among them.
 *
 * A COMPANY'S TIMESHEET IS NEVER AN ORDINARY SAVE (D41, D42). Nothing is
 * sent; but the driver declared a company's timesheet correct, so ANY change
 * to one — notes, Night Out, a time, who it is for, even making it Personal —
 * and any change that makes a day a company's, first shows the corrected
 * timesheet in full, and is saved only through the same declaration and final
 * action as Finish Shift's Review. The declaration is stored bound to exactly
 * that version. A company's day with no valid declaration, or changed
 * elsewhere since it was declared (a use's fill, mileage, check or times),
 * opens here unchanged, to be reviewed and declared (`startInReview`). A Personal day's correction is an
 * ordinary save.
 */
import { useRef, useState } from "react";
import { View, Text, TextInput, ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PrimaryButton } from "../components/PrimaryButton";
import type { AccountMembership } from "../api/account";
import {
  SHIFT_NOTES_MAX_LENGTH,
  boundsProblem,
  declarationState,
  effectiveFacts,
  effectiveUses,
  timesheetVersion,
  type CompletedShift,
  type ShiftFacts,
  type TimesheetBoundsProblem,
  type WorkingContext,
} from "../shift/localShift";
import { formatDateTime } from "./format";
import { DayStepper, TimeOfDayFields, useTimeOfDay } from "./timeOfDay";
import { confirmFinishAhead } from "./confirmFinishAhead";
import { FinalDeclaration } from "./FinalDeclaration";
import { TimesheetSummary } from "./TimesheetSummary";
import { workingForLabel } from "./TimesheetRow";
import { BackButton, Choice, FormSection, formStyles, keyboardSafeScrollProps } from "./vehicleForm";
import { colors, spacing, typography } from "../theme/index";

/** A day's facts as the form holds them. */
export interface TimesheetEdit {
  workingFor: WorkingContext;
  startedAt: Date;
  endedAt: Date;
  nightOut: boolean;
  notes: string;
}

interface EditTimesheetScreenProps {
  shift: CompletedShift;
  /** The driver's companies, as the signed-in account holds them. */
  memberships: readonly AccountMembership[];
  /** The device's time now — read at every check, never kept. */
  now?: () => Date;
  onLeave: () => void;
  /**
   * Save the correction — declared as `version` (`timesheetVersion`) when it
   * went through the Review, `null` for a Personal day's ordinary save.
   * Rejects if it could not be saved; the form stays open.
   */
  onSave: (edit: TimesheetEdit, version: string | null) => Promise<void>;
  /** Open straight on the Review — a company's day to be declared again. */
  startInReview?: boolean;
}

/** Personal, each company the driver belongs to, and the company the day already names. */
export function workingForOptions(current: WorkingContext, memberships: readonly AccountMembership[]): WorkingContext[] {
  const companies: WorkingContext[] = memberships.map(membership => ({
    kind: "company", membershipId: membership.membershipId, companyId: membership.companyId, companyName: membership.companyName,
  }));
  const named = current.kind === "company" && !memberships.some(membership => membership.membershipId === current.membershipId);
  return [{ kind: "personal" }, ...(named ? [current] : []), ...companies];
}

export const keyOf = (context: WorkingContext) => (context.kind === "personal" ? "personal" : context.membershipId);

/** Midnight of an instant's local day, moved by whole days. */
function dayOf(iso: string, offset: number): Date {
  const at = new Date(iso);
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  day.setDate(day.getDate() + offset);
  return day;
}

function problemText(problem: TimesheetBoundsProblem): string {
  switch (problem.kind) {
    case "finish-before-start": return "The finish can't be before the start.";
    case "start-after-use":     return `The start can't be after ${problem.name} began, ${formatDateTime(problem.at)}.`;
    case "finish-before-use":   return `The finish can't be before ${problem.name} ended, ${formatDateTime(problem.at)}.`;
    case "finish-before-use-start": return `The finish can't be before ${problem.name} started, ${formatDateTime(problem.at)}.`;
  }
}

export function EditTimesheetScreen({ shift, memberships, now = () => new Date(), onLeave, onSave, startInReview = false }: EditTimesheetScreenProps) {
  const insets = useSafeAreaInsets();
  const facts = effectiveFacts(shift);
  const options = workingForOptions(facts.workingFor, memberships);

  const [workingFor, setWorkingFor] = useState<WorkingContext>(facts.workingFor);
  const [startOffset, setStartOffset] = useState(0);
  const [endOffset, setEndOffset] = useState(0);
  const startTime = useTimeOfDay(() => new Date(facts.startedAt));
  const endTime = useTimeOfDay(() => new Date(facts.endedAt));
  const [nightOut, setNightOut] = useState(facts.nightOut);
  const [notes, setNotes] = useState(facts.notes ?? "");
  const [submitting, setSubmitting] = useState(false);
  /** ONE save, however many taps — set synchronously, before any re-render. */
  const inFlight = useRef(false);
  /** Showing the corrected timesheet for the company declaration (D41). */
  const [declaring, setDeclaring] = useState(startInReview);
  /** The version declared correct — see `FinishShiftScreen`; cleared on leaving it. */
  const [declaredFor, setDeclaredFor] = useState<string | null>(null);

  const startDay = dayOf(facts.startedAt, startOffset);
  const endDay = dayOf(facts.endedAt, endOffset);
  const startedAt = startTime.at(startDay);
  const endedAt = endTime.at(endDay);
  const clock = now();

  let problem: string | null = null;
  if (startedAt !== null && endedAt !== null) {
    const bounds = boundsProblem(shift, { startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString() });
    if (bounds !== null) problem = problemText(bounds);
  }

  const edit: TimesheetEdit | null = startedAt !== null && endedAt !== null && problem === null
    ? { workingFor, startedAt, endedAt, nightOut, notes }
    : null;
  // Seconds are not on the form: a time left as it was keeps its own.
  const sameMinute = (typed: Date, stored: string) => Math.floor(typed.getTime() / 60_000) === Math.floor(Date.parse(stored) / 60_000);
  const unchanged = edit !== null
    && keyOf(edit.workingFor) === keyOf(facts.workingFor)
    && sameMinute(edit.startedAt, facts.startedAt)
    && sameMinute(edit.endedAt, facts.endedAt)
    && edit.nightOut === facts.nightOut
    && (edit.notes.trim() === "" ? null : edit.notes.trim()) === facts.notes;

  // A company's day, or one becoming a company's: reviewed and declared, never simply saved.
  const declared = edit !== null && (facts.workingFor.kind === "company" || edit.workingFor.kind === "company");
  // A company's day changed since it was declared may be declared again, unchanged.
  const standing = declarationState(shift);
  const undeclared = standing === "unconfirmed" || standing === "changed";
  const canSave = edit !== null && (!unchanged || undeclared);

  /** The corrected day in full, as it will then read — for the declaration. */
  function preview(entered: TimesheetEdit): CompletedShift {
    const written = entered.notes.trim();
    const corrected: ShiftFacts = {
      workingFor: entered.workingFor,
      startedAt: entered.startedAt.toISOString(),
      endedAt: entered.endedAt.toISOString(),
      nightOut: entered.nightOut,
      notes: written === "" ? null : written,
    };
    const uses = effectiveUses({ ...shift, corrections: [...(shift.corrections ?? []), { id: "preview", correctedAt: corrected.endedAt, correctedBy: "preview", ...corrected }] });
    return { ...shift, ...corrected, ...uses, corrections: undefined };
  }

  function save() {
    if (edit === null || !canSave || inFlight.current) return;
    inFlight.current = true;
    const kept: TimesheetEdit = {
      ...edit,
      // An unchanged time is sent exactly as stored, never re-rounded to the minute.
      startedAt: sameMinute(edit.startedAt, facts.startedAt) ? new Date(facts.startedAt) : edit.startedAt,
      endedAt: sameMinute(edit.endedAt, facts.endedAt) ? new Date(facts.endedAt) : edit.endedAt,
    };
    const release = () => { inFlight.current = false; };
    const proceed = () => {
      setSubmitting(true);
      onSave(kept, declared ? timesheetVersion(preview(kept)) : null).then(undefined, () => {
        release();
        setSubmitting(false);
      });
    };
    // Only a finish being CORRECTED is asked about, against the clock NOW.
    const finishChanged = !sameMinute(edit.endedAt, facts.endedAt);
    if (!finishChanged || !confirmFinishAhead(kept.endedAt, now(), proceed, release)) proceed();
  }

  if (declaring && edit !== null) {
    const day = preview(edit);
    const version = JSON.stringify(day);
    return (
      <View style={formStyles.screen}>
        <ScrollView
          testID="edit-timesheet-review-scroll"
          style={formStyles.screen}
          contentContainerStyle={[formStyles.content, { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.xxl }]}
        >
          <BackButton
            testID="edit-timesheet-review-back"
            onPress={() => { setDeclaredFor(null); if (startInReview && unchanged) onLeave(); else setDeclaring(false); }}
          />
          <Text style={formStyles.title} testID="screen-title" accessibilityRole="header">Review Timesheet</Text>
          {undeclared && unchanged ? (
            <Text style={styles.changed} testID="edit-timesheet-changed">
              {standing === "changed"
                ? "This timesheet has changed since you confirmed it. Check it, then confirm it again."
                : "This timesheet needs review and confirmation. Check it, then confirm it."}
            </Text>
          ) : null}
          <TimesheetSummary day={day} inUse={{ vehicle: null, trailer: null }} />
          <FinalDeclaration
            workingFor={day.workingFor}
            confirmed={declaredFor === version}
            onToggle={() => { setDeclaredFor(declaredFor === version ? null : version); }}
            submitting={submitting}
            onConfirm={() => { if (declaredFor === version) save(); }}
            testID="edit-timesheet-final"
          />
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={formStyles.screen}>
      <ScrollView
        testID="edit-timesheet-scroll"
        style={formStyles.screen}
        contentContainerStyle={[formStyles.content, { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.xxl }]}
        {...keyboardSafeScrollProps}
      >
        <BackButton testID="edit-timesheet-back" onPress={onLeave} />
        <Text style={formStyles.title} testID="screen-title" accessibilityRole="header">Edit Timesheet</Text>

        <FormSection label="WORKING FOR">
          {options.map((option, index) => (
            <Choice
              key={keyOf(option)}
              testID={`edit-working-for-${keyOf(option)}`}
              label={workingForLabel(option)}
              selected={keyOf(option) === keyOf(workingFor)}
              onSelect={() => { setWorkingFor(option); }}
              last={index === options.length - 1}
            />
          ))}
        </FormSection>

        <FormSection label="STARTED">
          <DayStepper testID="edit-start-date" day={startDay} today={clock} onStep={by => { setStartOffset(startOffset + by); }} />
          <TimeOfDayFields testID="edit-start-time" time={startTime} />
        </FormSection>

        <FormSection label="FINISHED">
          <DayStepper testID="edit-finish-date" day={endDay} today={clock} onStep={by => { setEndOffset(endOffset + by); }} />
          <TimeOfDayFields testID="edit-finish-time" time={endTime} />
        </FormSection>
        {problem === null ? null : <Text style={styles.error} testID="edit-timesheet-error">{problem}</Text>}

        <FormSection label="NIGHT OUT">
          <Choice testID="edit-night-out-yes" label="Yes" selected={nightOut} onSelect={() => { setNightOut(true); }} last={false} />
          <Choice testID="edit-night-out-no" label="No" selected={!nightOut} onSelect={() => { setNightOut(false); }} last />
        </FormSection>

        <FormSection label="NOTES (OPTIONAL)">
          <TextInput
            testID="edit-notes"
            value={notes}
            onChangeText={setNotes}
            placeholder="Anything to note about this shift"
            placeholderTextColor={colors.placeholder}
            maxLength={SHIFT_NOTES_MAX_LENGTH}
            multiline
            style={[formStyles.input, styles.notes]}
            accessibilityLabel="Notes"
          />
        </FormSection>

        <Text style={styles.hint}>
          Saved as a correction: what this timesheet said when you finished it is kept.
        </Text>
        <View style={formStyles.action}>
          <PrimaryButton
            // A company's timesheet: the corrected timesheet is reviewed and declared first.
            label={declared ? "Review" : "Save correction"}
            onPress={() => {
              if (!declared) { save(); return; }
              setDeclaredFor(null);
              setDeclaring(true);
            }}
            disabled={!canSave}
            submitting={submitting}
            testID="edit-timesheet-save"
          />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  error: { ...typography.error, marginTop: -spacing.md, marginBottom: spacing.lg, marginLeft: spacing.xs },
  notes: { minHeight: 88, paddingTop: spacing.md, textAlignVertical: "top" },
  hint: { ...typography.helper, marginBottom: spacing.lg, marginHorizontal: spacing.xs },
  changed: { ...typography.helper, color: colors.danger, marginBottom: spacing.lg, marginHorizontal: spacing.xs },
});
