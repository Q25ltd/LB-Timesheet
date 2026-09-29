/**
 * A vehicle or trailer use's own start and end — each an explicit date and
 * time, corrected when they were wrong (D42). A use still in use has no end
 * here: its end is the finish.
 *
 * The end cannot be before the start, said as the driver types. Everything
 * else the day must hold — inside the shift, no two uses of a kind at once,
 * no trailer left without a vehicle to tow it — is decided by the store and
 * explained if refused (`useTimesMessage`); no other use is ever moved.
 *
 * A use the day's finish ended says so: changing its end makes it the use's
 * own time, no longer following the finish (D40).
 */
import { useRef, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { PrimaryButton } from "../components/PrimaryButton";
import type { UseTimesProblem } from "../shift/localShift";
import { formatDateTime } from "./format";
import { DayStepper, TimeOfDayFields, useTimeOfDay } from "./timeOfDay";
import { FormSection } from "./vehicleForm";
import { colors, spacing, typography } from "../theme/index";

export interface UseTimes {
  startedAt: Date;
  /** `null` exactly when the use is still in use. */
  endedAt: Date | null;
}

/** Why the store refused a use's times — what the driver can put right. */
export function useTimesMessage(problem: UseTimesProblem): string {
  switch (problem.kind) {
    case "end-before-start":   return "The end can't be before the start.";
    case "before-shift-start": return `It can't start before the shift started, ${formatDateTime(problem.at)}.`;
    case "after-shift-finish": return `It can't end after the shift finished, ${formatDateTime(problem.at)}.`;
    case "overlaps":           return `That overlaps ${problem.name}, ${formatDateTime(problem.startedAt)} – ${problem.endedAt === null ? "in use" : formatDateTime(problem.endedAt)}. Only one at a time.`;
    case "trailer-untowed":    return `That would leave ${problem.name} without a vehicle to tow it.`;
  }
}

/** Midnight of an instant's local day, moved by whole days. */
function dayOf(iso: string, offset: number): Date {
  const at = new Date(iso);
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + offset);
}

const sameMinute = (typed: Date, stored: string) => Math.floor(typed.getTime() / 60_000) === Math.floor(Date.parse(stored) / 60_000);

export function UseTimesEditor({ prefix, startedAt, endedAt, endsWithFinish, onSave }: {
  /** Test-id prefix: `${prefix}-start-date`, `${prefix}-times-save` … */
  prefix: string;
  startedAt: string;
  /** `null` while the use is still in use. */
  endedAt: string | null;
  /** The day's finish ended it (`endedBy: "finish"`). */
  endsWithFinish: boolean;
  /** Store the corrected times. Rejects if they could not be stored. */
  onSave: (times: UseTimes) => Promise<void>;
}) {
  const [startOffset, setStartOffset] = useState(0);
  const [endOffset, setEndOffset] = useState(0);
  const startTime = useTimeOfDay(() => new Date(startedAt));
  const endTime = useTimeOfDay(() => new Date(endedAt ?? startedAt));
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const inFlight = useRef(false);

  const startDay = dayOf(startedAt, startOffset);
  const endDay = endedAt === null ? null : dayOf(endedAt, endOffset);
  const typedStart = startTime.at(startDay);
  const typedEnd = endDay === null ? null : endTime.at(endDay);
  // A time left as it was keeps its stored value exactly — seconds included.
  const start = typedStart === null ? null : sameMinute(typedStart, startedAt) ? new Date(startedAt) : typedStart;
  const end = endedAt === null || typedEnd === null ? null : sameMinute(typedEnd, endedAt) ? new Date(endedAt) : typedEnd;
  const complete = start !== null && (endedAt === null || end !== null);
  const backwards = start !== null && end !== null && end.getTime() < start.getTime();
  const changed = complete && (start.toISOString() !== startedAt || (end !== null && end.toISOString() !== endedAt));
  const canSave = complete && changed && !backwards;

  function save() {
    if (!canSave || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    onSave({ startedAt: start, endedAt: end }).then(
      () => { inFlight.current = false; setSubmitting(false); setSaved(true); },
      () => { inFlight.current = false; setSubmitting(false); },
    );
  }

  return (
    <>
      <FormSection label="STARTED">
        <DayStepper testID={`${prefix}-start-date`} day={startDay} today={new Date()} onStep={by => { setStartOffset(startOffset + by); setSaved(false); }} />
        <TimeOfDayFields testID={`${prefix}-start-time`} time={startTime} />
      </FormSection>
      {endDay === null ? (
        <Text style={styles.hint} testID={`${prefix}-end-at-finish`}>Still in use — it ends at the finish.</Text>
      ) : (
        <FormSection label="ENDED">
          <DayStepper testID={`${prefix}-end-date`} day={endDay} today={new Date()} onStep={by => { setEndOffset(endOffset + by); setSaved(false); }} />
          <TimeOfDayFields testID={`${prefix}-end-time`} time={endTime} />
        </FormSection>
      )}
      {backwards ? <Text style={styles.error} testID={`${prefix}-times-error`}>The end can't be before the start.</Text> : null}
      {endsWithFinish && endDay !== null ? (
        <Text style={styles.hint} testID={`${prefix}-ends-with-finish`}>
          Ends with the shift's finish. Changing its end makes it this use's own time.
        </Text>
      ) : null}
      <PrimaryButton label="Save Times" onPress={save} disabled={!canSave} submitting={submitting} testID={`${prefix}-times-save`} />
      {saved ? <Text style={styles.saved} testID={`${prefix}-times-saved`}>Times saved.</Text> : null}
      <View style={styles.between} />
    </>
  );
}

const styles = StyleSheet.create({
  hint: { ...typography.helper, marginTop: -spacing.md, marginBottom: spacing.lg, marginHorizontal: spacing.xs },
  error: { ...typography.error, marginBottom: spacing.md, marginHorizontal: spacing.xs },
  saved: { ...typography.helper, color: colors.success, textAlign: "center", marginTop: spacing.sm },
  between: { height: spacing.xl },
});
