/**
 * The trailer a driver enters — its number and whether it is refrigerated —
 * and the one reading of those answers every trailer screen uses.
 *
 * Asked at Add Trailer and at Change Trailer; two copies of "trimmed and
 * upper-cased" would drift apart, so both render these fields and read them
 * through `trailerDetailsFrom`. Nothing else is asked: a trailer has no
 * mileage, and its checks are their own workflow.
 */
import { View, Text, TextInput, StyleSheet } from "react-native";
import {
  TRAILER_NUMBER_MAX_LENGTH,
  TRAILER_TYPES,
  normaliseTrailerNumber,
  type TrailerDetails,
  type TrailerType,
} from "../shift/trailer";
import { Choice, FormSection, formStyles, identifierTooLong } from "./vehicleForm";
import { colors, spacing, typography } from "../theme/index";

/** The two answers as a trailer, or `null` while either is missing. */
export function trailerDetailsFrom(trailerNumber: string, trailerType: TrailerType | null): TrailerDetails | null {
  const number = normaliseTrailerNumber(trailerNumber);
  if (number === "" || trailerType === null || number.length > TRAILER_NUMBER_MAX_LENGTH) return null;
  return { trailerNumber: number, trailerType };
}

export function TrailerFields({ trailerNumber, onTrailerNumber, trailerType, onTrailerType }: {
  trailerNumber: string;
  onTrailerNumber: (next: string) => void;
  trailerType: TrailerType | null;
  onTrailerType: (next: TrailerType) => void;
}) {
  return (
    <>
      <FormSection label="TRAILER NUMBER">
        <TextInput
          testID="trailer-number"
          value={trailerNumber}
          onChangeText={onTrailerNumber}
          placeholder="TR1234"
          placeholderTextColor={colors.placeholder}
          // Upper-cased when stored, not while typing; no format is imposed —
          // fleet numbers are as common as registrations.
          autoCapitalize="characters"
          autoCorrect={false}
          style={formStyles.input}
          accessibilityLabel="Trailer number"
        />
        {identifierTooLong(trailerNumber, TRAILER_NUMBER_MAX_LENGTH) === null ? null : (
          <Text style={styles.tooLong} testID="trailer-number-too-long">{identifierTooLong(trailerNumber, TRAILER_NUMBER_MAX_LENGTH)}</Text>
        )}
      </FormSection>

      <FormSection label="TRAILER TYPE">
        <View accessibilityRole="radiogroup">
          {TRAILER_TYPES.map((option, index) => (
            <Choice
              key={option.id}
              testID={`trailer-type-${option.id}`}
              label={option.label}
              selected={trailerType === option.id}
              onSelect={() => { onTrailerType(option.id); }}
              last={index === TRAILER_TYPES.length - 1}
            />
          ))}
        </View>
      </FormSection>
    </>
  );
}

const styles = StyleSheet.create({
  tooLong: { ...typography.error, marginTop: spacing.xs, marginHorizontal: spacing.xs },
});
