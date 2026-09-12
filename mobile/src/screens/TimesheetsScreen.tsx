/**
 * Timesheets — the driver's completed daily forms, once there are any.
 *
 * There are none, and there cannot be: finishing a shift is not built, nothing
 * can be sent to a company, and no history endpoint exists for this screen to
 * read. So this page asks for nothing and shows nothing — see `ComingSoonCard`
 * for why a specimen row would be worse than an empty page.
 *
 * The layout is the one real rows will arrive into, so adding them later is a
 * change to what is inside the page rather than a redesign of it.
 */
import { AppScreen } from "./AppScreen";
import { ComingSoonCard } from "./ComingSoonCard";

export function TimesheetsScreen() {
  return (
    <AppScreen title="Timesheets">
      <ComingSoonCard
        icon="document"
        headline="Nothing here yet"
        testID="timesheets-empty"
        body={
          "Each day you finish will appear here as a completed form you can open again. "
          + "Starting and finishing a shift is being built now."
        }
      />
    </AppScreen>
  );
}
