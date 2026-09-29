/**
 * Timesheets — every day the driver has finished, kept on this phone.
 *
 * The driver's own local history (D38): finished days only, newest first,
 * each opening its own page by its id. Never the open day, never a recovery
 * file, never a server or company record, never a specimen row. A day that
 * cannot be read is left out rather than shown with guessed values
 * (`listCompletedShifts`) — and a small warning says how many, so the driver
 * is not left believing every saved day is here. Nothing is deleted or
 * repaired, and the readable days are shown as usual.
 *
 * Nothing here has been sent anywhere, and nothing here says it has.
 */
import { View, Text, StyleSheet } from "react-native";
import { AppScreen } from "./AppScreen";
import { ComingSoonCard } from "./ComingSoonCard";
import { TimesheetRow } from "./TimesheetRow";
import type { CompletedShiftListing } from "../shift/localShift";
import { colors, radius, spacing, typography } from "../theme/index";

interface TimesheetsScreenProps {
  /** Every readable finished day and how many could not be read — or while reading, or when the phone could not be read. */
  listing: CompletedShiftListing | "loading" | "unreadable";
  /** Opens one finished day, by its id. */
  onOpen: (id: string) => void;
}

export function TimesheetsScreen({ listing, onOpen }: TimesheetsScreenProps) {
  return (
    <AppScreen title="Timesheets">
      {listing === "loading" ? null : listing === "unreadable" ? (
        <ComingSoonCard
          icon="document"
          headline="Timesheets couldn't be read"
          testID="timesheets-unreadable"
          body="Your finished timesheets are kept on this phone, and they couldn't be read just now. Try again in a moment."
        />
      ) : (
        <History timesheets={listing.timesheets} unreadable={listing.unreadable} onOpen={onOpen} />
      )}
    </AppScreen>
  );
}

function History({ timesheets, unreadable, onOpen }: CompletedShiftListing & { onOpen: (id: string) => void }) {
  return (
    <>
      {unreadable === 0 ? null : (
        <Text style={styles.damaged} testID="timesheets-damaged">
          {unreadable === 1 ? "1 saved timesheet could not be read." : `${String(unreadable)} saved timesheets could not be read.`}
        </Text>
      )}
      {timesheets.length === 0 ? (unreadable > 0 ? null : (
        <ComingSoonCard
          icon="document"
          headline="No completed timesheets yet"
          testID="timesheets-empty"
          body="Each shift you finish is kept here on this phone, and opens again as the form you completed."
        />
      )) : (
        <View style={styles.list} testID="timesheets-list">
          {timesheets.map((shift, index) => (
            <TimesheetRow
              key={shift.id}
              shift={shift}
              testID={`timesheet-${String(index)}`}
              last={index === timesheets.length - 1}
              onOpen={onOpen}
            />
          ))}
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  damaged: {
    ...typography.helper,
    color: colors.danger,
    backgroundColor: colors.dangerBg,
    borderRadius: radius.card,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  list: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
});
