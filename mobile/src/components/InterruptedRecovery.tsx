import { useCallback, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, spacing, typography } from "../theme";
import { formatDateTime } from "../screens/format";
import { assertLiveScope, type AccountScope } from "../shift/accountScope";
import { findInterruptedWrites, recoverInterruptedWrite, type InterruptedWriteOffer } from "../shift/localShift";

/** Offers never render their contents as an accepted day. Not now writes nothing. */
export function InterruptedRecovery({ scope, onRecovered }: { scope: AccountScope | null; onRecovered: () => void }) {
  const insets = useSafeAreaInsets();
  const [offers, setOffers] = useState<InterruptedWriteOffer[]>([]);
  const [loadedFor, setLoadedFor] = useState<AccountScope | null>(null);
  const [error, setError] = useState<string | null>(null);
  useFocusEffect(useCallback(() => {
    let cancelled = false;
    setOffers([]);
    setLoadedFor(null);
    setError(null);
    if (scope !== null) void findInterruptedWrites(scope).then(found => {
      if (!cancelled) { setOffers(found); setLoadedFor(scope); }
    }).catch(() => { if (!cancelled) setError("Recovery copies could not be checked. Try again later."); });
    return () => { cancelled = true; };
  }, [scope]));

  function offerRecovery(offer: InterruptedWriteOffer) {
    if (scope === null) return;
    try { assertLiveScope(scope); } catch { return; }
    Alert.alert("Recover interrupted save?", `An unacknowledged ${offer.kind === "open" ? "shift" : "timesheet"} copy started ${formatDateTime(offer.startedAt)} was found. Recovery does not prove the earlier save completed. Review its details afterwards.`, [
      { text: "Not now", style: "cancel" },
      { text: "Recover", onPress: () => {
        void recoverInterruptedWrite(scope, offer, { confirmedByDriver: true }).then(result => {
          assertLiveScope(scope);
          if (result === "recovered") {
            setOffers([]);
            onRecovered();
            Alert.alert("Interrupted copy recovered", "Review the recovered details. The previous save was not acknowledged.");
          } else setError("Recovery was refused because the copy or destination changed. Your files have been preserved.");
        }).catch(() => {
          try { assertLiveScope(scope); } catch { return; }
          setError("Recovery could not be completed safely. The original copy has been preserved.");
        });
      } },
    ]);
  }

  if (scope === null || loadedFor !== scope) return null;
  if (error === null && offers.length === 0) return null;
  return <View style={[styles.banner, { paddingTop: insets.top + spacing.sm }]}>
    {error === null ? null : <Text style={typography.error} accessibilityLiveRegion="polite">{error}</Text>}
    {offers.map(offer => <Pressable key={offer.key} style={styles.offer} accessibilityRole="button" onPress={() => { offerRecovery(offer); }}>
      <Text style={styles.offerText}>Review interrupted {offer.kind === "open" ? "shift" : "timesheet"} recovery — started {formatDateTime(offer.startedAt)}</Text>
    </Pressable>)}
  </View>;
}

const styles = StyleSheet.create({
  banner:    { backgroundColor: colors.dangerBg, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: spacing.xs },
  offer:     { paddingVertical: spacing.sm },
  offerText: { ...typography.label, color: colors.text },
});
