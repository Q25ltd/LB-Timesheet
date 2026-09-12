/**
 * My Records — the driver's own private diary.
 *
 * This is the half of the product that belongs to the DRIVER rather than to a
 * company: their own hours and pay, across every company they drive for, which
 * no single employer can give them (PRODUCT.md, D12). It is also the half with
 * the sharper privacy boundary — CLAUDE.md's, and it is a legal one, not a
 * preference.
 *
 * None of it is built. There is no local store to read (D25: no SQLite yet, and
 * it arrives with this feature, not before), so this page reads nothing and
 * shows nothing rather than estimating anything.
 */
import { AppScreen } from "./AppScreen";
import { ComingSoonCard } from "./ComingSoonCard";

export function RecordsScreen() {
  return (
    <AppScreen title="My Records">
      <ComingSoonCard
        icon="chart"
        headline="Nothing here yet"
        testID="records-empty"
        body={
          "Your own record of time and pay will live here, across every company you drive for. "
          + "It stays private to you — no company ever sees it. Being built now."
        }
      />
    </AppScreen>
  );
}
