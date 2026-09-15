/**
 * The LogisticBay Timesheets lockup, and the hero photograph beneath the form.
 */
import { Image, View, Text, StyleSheet } from "react-native";
import brandLogo from "../../assets/images/lblogo.png";
import registrationHero from "../../assets/images/registration-truck-sunrise.png";
import { typography } from "../theme/index";

/**
 * The approved LogisticBay mark — the LB road symbol and the wordmark, one
 * image. It REPLACES the text wordmark rather than sitting beside it: the
 * image already says LogisticBay, and saying it twice is two logos.
 *
 * The file is the owner's artwork trimmed to its own edges with 24px of
 * transparent margin and its white canvas made transparent, so it sits on
 * any surface without a box. `LOGO_ASPECT` is that file's own proportion, and
 * `contain` means it can only ever be scaled — never stretched, never cropped.
 */
const LOGO_FILE_WIDTH = 1921;
const LOGO_FILE_HEIGHT = 487;
const LOGO_ASPECT = LOGO_FILE_WIDTH / LOGO_FILE_HEIGHT;

/**
 * Wide enough that the wordmark inside the mark reads at the size the old
 * 26pt text wordmark did, and no wider: horizontal room on a big phone is not
 * a reason to let the brand dominate the screen. Below this it shrinks with
 * its container, so a narrow phone gets a smaller logo rather than a clipped
 * one.
 */
const LOGO_MAX_WIDTH = 200;

/**
 * Where the "LogisticBay" wordmark sits inside the file, in the file's own
 * pixels — measured from its transparency: the LB symbol occupies columns
 * 29–531, then a 38px gap, then the wordmark 570–1893, whose lowest ink (the
 * descenders of g and y) is row 362. Replacing the logo file means
 * re-measuring these.
 */
const WORDMARK_START = 570 / LOGO_FILE_WIDTH;
const WORDMARK_END = 1894 / LOGO_FILE_WIDTH;
const WORDMARK_BOTTOM_ROW = 363;
const SYMBOL_TO_WORDMARK_GAP = 38;

/**
 * How far TIMESHEETS is lifted into the logo's lower margin, as a share of
 * the logo's width.
 *
 * The LB symbol's road hangs well below the wordmark, so spacing TIMESHEETS
 * from the bottom of the IMAGE left ~20pt of empty band under the letters
 * (owner correction: too big, not symmetric). Lifted by this much, the gap
 * under the wordmark's descenders equals the gap between the symbol and the
 * wordmark — the logo's own spacing, used twice. Expressed against width
 * because the logo's height is proportional to it, so the gap stays equal at
 * any size the logo is drawn.
 */
const PRODUCT_LIFT =
  (LOGO_FILE_HEIGHT - WORDMARK_BOTTOM_ROW - SYMBOL_TO_WORDMARK_GAP) / LOGO_FILE_WIDTH;

/**
 * The empty space a line of TIMESHEETS reserves ABOVE its capitals.
 *
 * The lift above lines up the text's box; the letters start this far below
 * the top of that box, which on device left the gap 3.33pt wider than the
 * symbol-to-wordmark gap it is meant to equal. It belongs to the label's
 * 13pt type, not to the logo, so it is a fixed amount rather than a share of
 * the logo's width. Measured on iOS, where the owner reviews the app.
 */
const PRODUCT_CAP_INSET = 10 / 3;

export function BrandLockup() {
  return (
    <View style={styles.lockup} accessibilityRole="header">
      {/* The proportions live on this box, NOT on the Image. A bundled image
          is given its file's intrinsic pixel height unless its style sets one,
          and that beats `aspectRatio` — on device the 487px file produced a
          487pt-tall box and pushed the screen half a page down. The box takes
          its height from its width, and the image simply fills it. */}
      <View style={styles.logoBox}>
        <Image
          source={brandLogo}
          style={styles.logo}
          resizeMode="contain"
          accessible
          accessibilityRole="image"
          accessibilityLabel="LogisticBay"
          testID="brand-logo"
        />
      </View>
      {/* The product, centred under the WORDMARK rather than under the whole
          mark. Centred under everything it landed below "gisticB" and read as
          detached from the name it qualifies (owner correction). The row is
          the logo's own width and the label spans the wordmark's share of it,
          so the two stay aligned at whatever size the logo is drawn. It stays
          at all because the logo names the company, and LogisticBay has two
          products — without it this screen could be the TMS. */}
      <View style={styles.productRow}>
        <Text style={[typography.lockup, styles.product]}>TIMESHEETS</Text>
      </View>
    </View>
  );
}

/**
 * The full-bleed hero.
 *
 * It is rendered as a SIBLING of the padded form, never inside it. The
 * previous version lived inside the form's horizontally-padded container and
 * cancelled that padding with `marginHorizontal: -24` — a full-bleed trick
 * that only works if every ancestor's width is exactly the screen's. It
 * wasn't, so the image sat short of the right edge and left a white strip.
 *
 * Here the parent is already edge-to-edge, so the image simply fills it and
 * there is no padding to cancel and nothing to get out of step.
 *
 * `flexShrink` with `minHeight: 0` is what makes it adapt: on a tall phone it
 * takes its natural aspect ratio, and on a short one it gives its space to
 * the form rather than pushing the form off-screen.
 */
export function BrandHero() {
  return (
    <View style={styles.hero} accessible={false} testID="brand-hero">
      <Image source={registrationHero} style={styles.heroImage} resizeMode="cover" />
    </View>
  );
}

const styles = StyleSheet.create({
  // Stretched across its container so the logo's width can be a share of the
  // space actually available, then centred inside it.
  lockup: { alignSelf: "stretch", alignItems: "center" },
  // A DEFINITE width, capped by the container — not `width: "100%"` capped by
  // a maximum. Yoga derives `aspectRatio` height from the width BEFORE the
  // maximum applies, so the percentage form made an 87pt-tall box around a
  // 51pt logo on Login and a shorter one on Home, where the badge slot is
  // narrower. Starting from the real width, the box is exactly as tall as the
  // logo on every screen that has room for it.
  logoBox: { width: LOGO_MAX_WIDTH, maxWidth: "100%", aspectRatio: LOGO_ASPECT },
  logo: { width: "100%", height: "100%" },
  // Exactly the logo box's width, so percentages below are shares of the logo.
  productRow: { width: LOGO_MAX_WIDTH, maxWidth: "100%", marginTop: -PRODUCT_CAP_INSET },
  product: {
    // Percentage margins resolve against the PARENT's width — this row, which
    // is exactly the logo's width — so both of these scale with the logo.
    marginTop: `${-PRODUCT_LIFT * 100}%`,
    marginLeft: `${WORDMARK_START * 100}%`,
    width: `${(WORDMARK_END - WORDMARK_START) * 100}%`,
    textAlign: "center",
    // Letter spacing is added after the LAST letter too, which would pull the
    // word's visual centre left by half of it; this puts that half back.
    paddingLeft: typography.lockup.letterSpacing,
  },
  hero: {
    width: "100%",
    aspectRatio: 2.25,
    flexShrink: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  // Absolute fill rather than 100%/100%: when flexShrink squeezes the
  // container below its aspect ratio, a percentage-sized child can round to
  // a hairline short of the edge. Pinning all four sides cannot.
  heroImage: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, width: "100%", height: "100%" },
});
