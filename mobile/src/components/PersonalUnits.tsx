/**
 * Units for Personal days (D66) — Settings. A company's day uses the
 * company's units; a Personal day uses these. Until both are chosen, a
 * Personal day's readings are recorded without a unit (never a default).
 *
 * Saved for the signed-in account only (F-31), the moment both are chosen.
 * Changing them never relabels anything already recorded.
 */
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { readUnitPreferences, saveUnitPreferences } from "../shift/unitPreferences";
import { useAccountScope } from "../shift/useAccountScope";
import { DISTANCE_UNITS, VOLUME_UNITS, type DistanceUnit, type VolumeUnit } from "../shift/units";
import { colors, radius, spacing, typography } from "../theme/index";

export function PersonalUnits() {
  const scope = useAccountScope();
  const [distance, setDistance] = useState<DistanceUnit | null>(null);
  const [volume, setVolume] = useState<VolumeUnit | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (scope === null) return;
    const stored = readUnitPreferences(scope);
    setDistance(stored.distanceUnit);
    setVolume(stored.volumeUnit);
  }, [scope]);

  function choose(nextDistance: DistanceUnit | null, nextVolume: VolumeUnit | null) {
    setDistance(nextDistance);
    setVolume(nextVolume);
    if (scope === null || nextDistance === null || nextVolume === null) {
      setMessage(nextDistance === null || nextVolume === null ? "Choose both to save them." : null);
      return;
    }
    try {
      saveUnitPreferences(scope, { distanceUnit: nextDistance, volumeUnit: nextVolume });
      setMessage("Saved. Your Personal days are recorded in these from now on.");
    } catch {
      setMessage("Your units could not be saved. Try again.");
    }
  }

  return (
    <View style={styles.wrap} testID="personal-units">
      <Text style={styles.intro}>
        A company&apos;s day uses the company&apos;s units. Your Personal days use these. What is already recorded keeps its own unit.
      </Text>
      <Text style={styles.label}>Distance</Text>
      <View style={styles.options} accessibilityRole="radiogroup">
        {DISTANCE_UNITS.map(unit => (
          <Option key={unit.id} testID={`personal-distance-${unit.id}`} label={unit.label} selected={distance === unit.id}
            onPress={() => { choose(unit.id, volume); }} />
        ))}
      </View>
      <Text style={styles.label}>Fuel</Text>
      <View style={styles.options} accessibilityRole="radiogroup">
        {VOLUME_UNITS.map(unit => (
          <Option key={unit.id} testID={`personal-volume-${unit.id}`} label={unit.label} selected={volume === unit.id}
            onPress={() => { choose(distance, unit.id); }} />
        ))}
      </View>
      {message === null ? null : <Text style={styles.message} testID="personal-units-message" accessibilityLiveRegion="polite">{message}</Text>}
    </View>
  );
}

function Option({ testID, label, selected, onPress }: { testID: string; label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      style={[styles.option, selected ? styles.optionSelected : null]}
    >
      <Text style={[styles.optionLabel, selected ? styles.optionLabelSelected : null]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: spacing.lg, gap: spacing.sm },
  intro: { ...typography.helper },
  label: { fontSize: 15, fontWeight: "600", color: colors.text, marginTop: spacing.sm },
  options: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  option: {
    minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.md,
    borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  optionSelected: { borderColor: colors.brandDark, backgroundColor: colors.surfaceAccent },
  optionLabel: { fontSize: 15, color: colors.text },
  optionLabelSelected: { fontWeight: "700", color: colors.brandDark },
  message: { ...typography.helper, color: colors.text },
});
