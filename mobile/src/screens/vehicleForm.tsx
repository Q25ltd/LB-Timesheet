/**
 * The vehicle a driver enters — class, number plate, start mileage — and the
 * form pieces Start Shift and Add Vehicle are both built from.
 *
 * ONE DEFINITION OF A VALID VEHICLE. The same three answers are asked in two
 * places: at Start Shift for a day that begins with a truck, and at Add
 * Vehicle for a day that began without one. Two copies of "a whole,
 * non-negative mileage" or "trimmed and upper-cased" would drift apart, and a
 * plate stored one way from one screen and another way from the other is the
 * kind of disagreement nobody notices until a timesheet is wrong. So both
 * screens render these fields and read them through `vehicleDetailsFrom`.
 *
 * The rows, sections and inputs are Start Shift's own, moved here unchanged:
 * the owner approved that form on a phone, and the second screen that asks
 * the same questions should look like the first.
 */
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";
import {
  VEHICLE_CLASSES,
  normalisePlate,
  type VehicleClass,
  type VehicleDetails,
} from "../shift/localShift";
import { colors, radius, sizing, spacing, typography } from "../theme/index";

/**
 * THE KEYBOARD MUST NOT SIT ON THE FIELD BEING TYPED INTO. Number plate and
 * Start mileage sit low in a scrolling form, so without these the keyboard
 * covers them and the driver types blind.
 *
 * iOS insets the scroll content by the keyboard's height and brings the
 * focused field into view; Android's window is already resized
 * (`adjustResize`), so the same scroll view shrinks there by itself. No
 * measured heights, no device-specific offsets, and no permanent padding that
 * would leave a hole when the keyboard is down.
 *
 * Dragging the form puts the keyboard away — the platform convention, and the
 * one Login and Registration already use. A tap no control handles closes the
 * keyboard instead of being swallowed, so the first tap on a choice row still
 * selects it.
 */
export const keyboardSafeScrollProps = {
  automaticallyAdjustKeyboardInsets: true,
  keyboardDismissMode: "on-drag",
  keyboardShouldPersistTaps: "handled",
} as const;

/**
 * A whole, non-negative mileage.
 *
 * Digits only: an odometer reads whole miles, and allowing `12.5`, `1e4` or a
 * minus sign would only widen what can be written into a payroll record.
 * `0` is valid — a new vehicle genuinely reads zero.
 */
function parseMileage(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** The three answers as a vehicle, or `null` while any of them is missing or invalid. */
export function vehicleDetailsFrom(
  vehicleClass: VehicleClass | null,
  numberPlate: string,
  mileage: string,
): VehicleDetails | null {
  const plate = normalisePlate(numberPlate);
  const miles = parseMileage(mileage);
  if (vehicleClass === null || plate === "" || miles === null) return null;
  return { vehicleClass, numberPlate: plate, startMileage: miles };
}

interface VehicleFieldsProps {
  vehicleClass: VehicleClass | null;
  onVehicleClass: (next: VehicleClass) => void;
  numberPlate: string;
  onNumberPlate: (next: string) => void;
  mileage: string;
  onMileage: (next: string) => void;
}

/** Class, number plate and start mileage — the three vehicle questions. */
export function VehicleFields({
  vehicleClass, onVehicleClass, numberPlate, onNumberPlate, mileage, onMileage,
}: VehicleFieldsProps) {
  return (
    <>
      <FormSection label="VEHICLE">
        <View accessibilityRole="radiogroup">
          {VEHICLE_CLASSES.map((option, index) => (
            <Choice
              key={option.id}
              testID={`vehicle-class-${option.id}`}
              label={option.label}
              selected={vehicleClass === option.id}
              onSelect={() => { onVehicleClass(option.id); }}
              last={index === VEHICLE_CLASSES.length - 1}
            />
          ))}
        </View>
      </FormSection>

      <FormSection label="NUMBER PLATE">
        <TextInput
          testID="number-plate"
          value={numberPlate}
          onChangeText={onNumberPlate}
          placeholder="AB24 XYZ"
          placeholderTextColor={colors.placeholder}
          // Upper-cased when the vehicle is stored rather than while typing,
          // so the caret cannot jump in the middle of a word.
          autoCapitalize="characters"
          autoCorrect={false}
          // No UK format is imposed: plates are international.
          style={formStyles.input}
          accessibilityLabel="Number plate"
        />
      </FormSection>

      <FormSection label="START MILEAGE">
        <TextInput
          testID="start-mileage"
          value={mileage}
          onChangeText={onMileage}
          placeholder="0"
          placeholderTextColor={colors.placeholder}
          keyboardType="number-pad"
          style={formStyles.input}
          accessibilityLabel="Start mileage"
        />
      </FormSection>
    </>
  );
}

export function BackButton({ testID, onPress }: { testID: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel="Back"
      hitSlop={12}
      style={formStyles.back}
    >
      <View style={formStyles.chevron} />
      <Text style={formStyles.backLabel}>Back</Text>
    </Pressable>
  );
}

export function FormSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={formStyles.section}>
      <Text style={formStyles.sectionLabel}>{label}</Text>
      <View style={formStyles.card}>{children}</View>
    </View>
  );
}

/**
 * One choice in a single-selection group.
 *
 * The whole row is the target rather than the tick: this is pressed with cold
 * hands before dawn, so the row is 60pt tall and the tick is feedback rather
 * than something to aim at.
 */
export function Choice({ testID, label, selected, onSelect, last }: {
  testID: string; label: string; selected: boolean; onSelect: () => void; last: boolean;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onSelect}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        formStyles.option,
        last ? null : formStyles.optionDivided,
        pressed ? formStyles.optionPressed : null,
      ]}
    >
      <View style={[formStyles.tick, selected ? formStyles.tickOn : null]}>
        {selected ? <View style={formStyles.checkMark} /> : null}
      </View>
      <Text style={[formStyles.optionLabel, selected ? formStyles.optionLabelOn : null]}>{label}</Text>
    </Pressable>
  );
}

export const formStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1, paddingHorizontal: spacing.xl },

  back: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: sizing.minTouch,
    alignSelf: "flex-start",
  },
  chevron: {
    width: 10,
    height: 10,
    borderLeftWidth: 2.5,
    borderBottomWidth: 2.5,
    borderColor: colors.brandLight,
    transform: [{ rotate: "45deg" }],
  },
  backLabel: { color: colors.brandLight, fontWeight: "700", fontSize: 16 },

  title: { ...typography.title, marginTop: spacing.sm, marginBottom: spacing.xl },

  section: { marginBottom: spacing.xl },
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
    overflow: "hidden",
  },

  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
    minHeight: 60,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  optionDivided: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  optionPressed: { backgroundColor: colors.surfaceAccent },
  tick: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  tickOn: { borderColor: colors.brandLight, backgroundColor: colors.brandLight },
  checkMark: {
    width: 11,
    height: 6,
    borderLeftWidth: 2.5,
    borderBottomWidth: 2.5,
    borderColor: colors.onBrand,
    transform: [{ rotate: "-45deg" }],
    marginTop: -3,
  },
  optionLabel: { flex: 1, fontSize: 17, color: colors.text },
  optionLabelOn: { fontWeight: "700", color: colors.brandDark },

  input: {
    minHeight: sizing.control,
    paddingHorizontal: spacing.lg,
    fontSize: 17,
    color: colors.text,
  },

  action: { marginTop: spacing.sm },
});
