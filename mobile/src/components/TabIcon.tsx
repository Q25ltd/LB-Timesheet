/**
 * The app's icons, drawn from React Native views.
 *
 * WHY THEY ARE NOT FROM A LIBRARY. The workspace declares no icon package, and
 * the two obvious candidates each cost more than they are worth here:
 * `@expo/vector-icons` ships several megabytes of icon fonts for four glyphs,
 * and `expo-symbols` is SF Symbols — iOS only, so the Android tab bar would
 * need a second implementation anyway. These are four simple shapes; a box, a
 * triangle, some bars and a ring cost one file and no dependency, and they
 * render identically on both platforms because they are just views.
 *
 * Every icon is drawn inside a square of `size`, takes its colour from the
 * caller, and is decorative: the label beside it carries the meaning, so none
 * of them is exposed to assistive technology.
 */
import { View, StyleSheet } from "react-native";
import { colors } from "../theme/index";

export type TabIconName = "home" | "document" | "chart" | "gear" | "clock";

interface TabIconProps {
  name: TabIconName;
  color: string;
  size?: number;
}

const DEFAULT_SIZE = 24;

export function TabIcon({ name, color, size = DEFAULT_SIZE }: TabIconProps) {
  return (
    <View style={[styles.box, { width: size, height: size }]} accessible={false} pointerEvents="none">
      {name === "home" ? <HomeGlyph color={color} size={size} /> : null}
      {name === "document" ? <DocumentGlyph color={color} size={size} /> : null}
      {name === "chart" ? <ChartGlyph color={color} size={size} /> : null}
      {name === "gear" ? <GearGlyph color={color} size={size} /> : null}
      {name === "clock" ? <ClockGlyph color={color} size={size} /> : null}
    </View>
  );
}

/** A roof over a body. The roof is the classic zero-size border triangle. */
function HomeGlyph({ color, size }: { color: string; size: number }) {
  const unit = size / 24;
  return (
    <>
      <View
        style={{
          width: 0,
          height: 0,
          borderLeftWidth: 11 * unit,
          borderRightWidth: 11 * unit,
          borderBottomWidth: 9 * unit,
          borderLeftColor: "transparent",
          borderRightColor: "transparent",
          borderBottomColor: color,
          marginBottom: -1 * unit,
        }}
      />
      <View
        style={{
          width: 14 * unit,
          height: 11 * unit,
          backgroundColor: color,
          borderBottomLeftRadius: 2 * unit,
          borderBottomRightRadius: 2 * unit,
        }}
      />
    </>
  );
}

/** A page with three lines of writing on it. */
function DocumentGlyph({ color, size }: { color: string; size: number }) {
  const unit = size / 24;
  return (
    <View
      style={{
        width: 16 * unit,
        height: 20 * unit,
        borderWidth: 2 * unit,
        borderColor: color,
        borderRadius: 3 * unit,
        paddingHorizontal: 3 * unit,
        paddingTop: 4 * unit,
        gap: 2.5 * unit,
      }}
    >
      <View style={{ height: 1.8 * unit, backgroundColor: color, borderRadius: unit }} />
      <View style={{ height: 1.8 * unit, backgroundColor: color, borderRadius: unit }} />
      <View style={{ height: 1.8 * unit, width: "60%", backgroundColor: color, borderRadius: unit }} />
    </View>
  );
}

/** Three bars of different heights, sitting on one baseline. */
function ChartGlyph({ color, size }: { color: string; size: number }) {
  const unit = size / 24;
  const bar = (height: number) => ({
    width: 4 * unit,
    height: height * unit,
    backgroundColor: color,
    borderRadius: 1.5 * unit,
  });
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 3 * unit, height: 18 * unit }}>
      <View style={bar(9)} />
      <View style={bar(18)} />
      <View style={bar(13)} />
    </View>
  );
}

/**
 * A ring with six teeth around it.
 *
 * Each tooth is one small bar rotated around the centre, so the spacing comes
 * from arithmetic rather than from six hand-placed offsets that drift when the
 * size changes.
 */
const GEAR_TEETH = 6;

function GearGlyph({ color, size }: { color: string; size: number }) {
  const unit = size / 24;
  return (
    <View style={styles.centred}>
      {Array.from({ length: GEAR_TEETH }, (_unused, index) => (
        <View
          key={index}
          style={{
            position: "absolute",
            width: 3.5 * unit,
            height: 20 * unit,
            backgroundColor: color,
            borderRadius: 1.5 * unit,
            transform: [{ rotate: `${String((index * 180) / GEAR_TEETH)}deg` }],
          }}
        />
      ))}
      <View
        style={{
          width: 15 * unit,
          height: 15 * unit,
          borderRadius: 7.5 * unit,
          borderWidth: 3 * unit,
          borderColor: color,
          backgroundColor: colors.surface,
        }}
      />
    </View>
  );
}

/** A ring with an hour and a minute hand. */
function ClockGlyph({ color, size }: { color: string; size: number }) {
  const unit = size / 24;
  // Each hand pivots about the face's centre: the bar's BOTTOM sits there, and
  // `transformOrigin` rotates it around that point rather than its own middle.
  const hand = (length: number, degrees: number) => ({
    position: "absolute" as const,
    bottom: "50%" as const,
    width: 2 * unit,
    height: length * unit,
    backgroundColor: color,
    borderRadius: unit,
    transformOrigin: "bottom center" as const,
    transform: [{ rotate: `${String(degrees)}deg` }],
  });
  return (
    <View style={styles.centred}>
      <View
        style={{
          width: 20 * unit,
          height: 20 * unit,
          borderRadius: 10 * unit,
          borderWidth: 2 * unit,
          borderColor: color,
        }}
      />
      {/* Ten past ten: both hands ABOVE the centre line, which is why clock
          faces are conventionally drawn at this time. Hands near-opposite
          would render as a single diagonal stroke and read as a slash. */}
      <View style={hand(6, -60)} />
      <View style={hand(7.5, 60)} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: "center", justifyContent: "center" },
  centred: { alignItems: "center", justifyContent: "center" },
});
