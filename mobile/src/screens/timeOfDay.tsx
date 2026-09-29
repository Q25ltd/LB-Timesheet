/**
 * The time of day a driver types — two big number fields, hours and minutes.
 *
 * ONE DEFINITION, wherever the app asks for a time. Start Shift asks for the
 * moment the day began; a fuel or AdBlue entry asks for the moment it went in.
 * Both are the same question — a clock time the driver may correct — so both
 * read the same way, validate the same way and look the same.
 *
 * It is a CLOCK, not a date: the fields carry hours and minutes only, and the
 * caller decides which day they land on by seeding from a `Date` it already
 * holds. Nothing here reads the clock, so a screen can read it ONCE when it
 * opens and keep the answer still while the driver types (see `useTimeOfDay`).
 */
import { useRef, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";
import { colors, radius, spacing, typography } from "../theme/index";
import { calendarDaysBetween, formatDate } from "./format";

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** Hours 00–23 / minutes 00–59, and nothing else. */
function parseClockPart(raw: string, max: number): number | null {
  if (!/^\d{1,2}$/.test(raw.trim())) return null;
  const value = Number(raw);
  return value >= 0 && value <= max ? value : null;
}

interface TimeOfDay {
  hours: string;
  minutes: string;
  setHours: (next: string) => void;
  setMinutes: (next: string) => void;
  /** 0–23, or `null` while what is typed is not an hour. */
  hour: number | null;
  /** 0–59, or `null` while what is typed is not a minute. */
  minute: number | null;
  /** Both parts are a real time. */
  valid: boolean;
  /**
   * The typed clock time, on the DAY of `base` — or of the seed when none is
   * given, which is read once so a time that was correct when the screen
   * opened does not creep forward while the driver fills in the rest.
   *
   * `base` is what an entry already recorded is corrected against: its own
   * day, never today's. A fill entered at 23:50 and corrected ten minutes
   * after midnight must stay on the day it happened.
   */
  at: (base?: Date) => Date | null;
}

/** Hours and minutes seeded from one reading of the clock, kept still after that. */
export function useTimeOfDay(seed: () => Date): TimeOfDay {
  const openedAt = useRef(seed());
  const [hours, setHours] = useState(() => twoDigits(openedAt.current.getHours()));
  const [minutes, setMinutes] = useState(() => twoDigits(openedAt.current.getMinutes()));

  const hour = parseClockPart(hours, 23);
  const minute = parseClockPart(minutes, 59);

  return {
    hours, minutes, setHours, setMinutes, hour, minute,
    valid: hour !== null && minute !== null,
    at: (base?: Date) => {
      if (hour === null || minute === null) return null;
      const at = new Date(base ?? openedAt.current);
      at.setHours(hour, minute, 0, 0);
      return at;
    },
  };
}

/** The pair of fields. `testID` prefixes each one, as the caller's screen names it. */
export function TimeOfDayFields({ testID, time }: { testID: string; time: TimeOfDay }) {
  return (
    <View style={styles.clock} testID={testID}>
      <ClockField testID={`${testID}-hours`} label="Hours" value={time.hours} onChange={time.setHours} invalid={time.hour === null} />
      <Text style={styles.clockSeparator}>:</Text>
      <ClockField testID={`${testID}-minutes`} label="Minutes" value={time.minutes} onChange={time.setMinutes} invalid={time.minute === null} />
    </View>
  );
}

/** Deliberately large: a gloved thumb in a dark yard, not a settings screen. */
function ClockField({ testID, label, value, onChange, invalid }: {
  testID: string; label: string; value: string; onChange: (next: string) => void; invalid: boolean;
}) {
  return (
    <TextInput
      testID={testID}
      value={value}
      onChangeText={onChange}
      keyboardType="number-pad"
      maxLength={2}
      selectTextOnFocus
      accessibilityLabel={label}
      style={[styles.clockInput, invalid ? styles.clockInvalid : null]}
    />
  );
}

/**
 * A DAY, stepped a day back or forward — the date beside the clock where a
 * time may fall on another day (a finish after midnight, a corrected start).
 * Two buttons rather than a date field, so the usual same-day entry costs
 * nothing. Said as Today / Yesterday / Tomorrow against `today`.
 */
export function DayStepper({ testID, day, today, onStep }: { testID: string; day: Date; today: Date; onStep: (step: -1 | 1) => void }) {
  const offset = calendarDaysBetween(today.toISOString(), day.toISOString());
  const relative = offset === 0 ? "Today" : offset === -1 ? "Yesterday" : offset === 1 ? "Tomorrow" : null;
  return (
    <View style={styles.dayRow}>
      <StepButton testID={`${testID}-previous`} label="Previous day" glyph="‹" onPress={() => { onStep(-1); }} />
      <View style={styles.dayText}>
        <Text style={styles.dayValue} testID={testID}>{formatDate(day.toISOString())}</Text>
        {relative === null ? null : <Text style={styles.dayRelative} testID={`${testID}-relative`}>{relative}</Text>}
      </View>
      <StepButton testID={`${testID}-next`} label="Next day" glyph="›" onPress={() => { onStep(1); }} />
    </View>
  );
}

function StepButton({ testID, label, glyph, onPress }: { testID: string; label: string; glyph: string; onPress: () => void }) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={({ pressed }) => [styles.step, pressed ? styles.stepPressed : null]}
    >
      <Text style={styles.stepGlyph}>{glyph}</Text>
    </Pressable>
  );
}

export const timeStyles = StyleSheet.create({
  hint: { ...typography.helper, marginTop: spacing.sm, marginHorizontal: spacing.xs },
});

const styles = StyleSheet.create({
  clock: { flexDirection: "row", alignItems: "center", justifyContent: "center", paddingVertical: spacing.lg },
  clockInput: {
    width: 84,
    minHeight: 64,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.field,
    backgroundColor: colors.surface,
    textAlign: "center",
    fontSize: 30,
    fontWeight: "700",
    color: colors.brandDark,
  },
  clockInvalid: { borderColor: colors.danger, backgroundColor: colors.dangerBg },
  dayRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.md,
  },
  dayText: { flex: 1, alignItems: "center" },
  dayValue: { fontSize: 17, fontWeight: "700", color: colors.brandDark },
  dayRelative: { fontSize: 13, color: colors.textMuted },
  step: { width: 48, height: 48, borderRadius: radius.button, alignItems: "center", justifyContent: "center" },
  stepPressed: { backgroundColor: colors.surfaceAccent },
  stepGlyph: { fontSize: 30, fontWeight: "700", color: colors.brandLight },
  clockSeparator: { fontSize: 30, fontWeight: "700", color: colors.brandDark, marginHorizontal: spacing.md },
});
