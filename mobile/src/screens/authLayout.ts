/**
 * The layout contract the Registration and Sign-in screens SHARE.
 *
 * Extracted from `RegisterScreen` — moved, not reimplemented — when Login
 * became the second screen to need it. The point is not tidiness: the hero
 * threshold, the keyboard rule and the scroll contract are values the owner
 * approved on a physical phone, and two literal copies of `720` in two files
 * is exactly how one screen's behaviour changes and the other's does not.
 * Changing anything here changes BOTH screens, deliberately.
 *
 * THE CONTRACT, unchanged from the approved Registration implementation:
 *
 *   - At rest the whole screen fits, on every phone, with NO scrolling in
 *     either direction. The container is `flexGrow: 1` with scrolling
 *     disabled, so there is nothing to scroll even by a pixel.
 *   - Scrolling is enabled ONLY while the keyboard is up, because the
 *     alternative there is fields the driver cannot reach.
 *   - Horizontal scrolling is off unconditionally, and bounce is disabled so
 *     an edge cannot be dragged past.
 *   - The hero is a SIBLING of the padded form, edge to edge, and yields its
 *     space first: it shrinks on a short screen and is removed entirely when
 *     the keyboard is up.
 *
 * This module owns layout only. It renders nothing and knows nothing about
 * credentials, validation or navigation — there is deliberately no
 * "BaseAuthScreen" here, because Registration has six controls and Sign-in
 * has three, and one component parameterised for both would be harder to
 * read than two screens calling the same primitives.
 */
import { useEffect, useState } from "react";
import { Keyboard, Platform, StyleSheet, useWindowDimensions } from "react-native";
import { colors, spacing } from "../theme/index";

/**
 * Below this window height the form leaves the hero so little room that it
 * renders as a squashed band — which reads as a broken image rather than as
 * branding. On those screens it is dropped entirely: the form still fits
 * without scrolling, which is what actually matters. An iPhone SE is 667pt;
 * an iPhone 14 is 844pt.
 *
 * Sign-in's form is shorter than Registration's and would survive a lower
 * threshold, but the threshold is deliberately NOT tuned per screen: one
 * number, one behaviour, and the two screens stay siblings.
 */
export const MIN_HEIGHT_FOR_HERO = 720;

/**
 * Whether the keyboard is currently covering part of the screen.
 *
 * Drives two things: the hero is dropped to give the form its space back,
 * and scrolling is turned on so every field stays reachable.
 *
 * Module-private: `useAuthLayout` is the ONE way a screen asks about layout,
 * so the keyboard state and the hero rule can never be read separately and
 * then disagree.
 */
function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // iOS reports will-show/will-hide, which animate in step with the
    // keyboard; Android only reports did-show/did-hide.
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const shown  = Keyboard.addListener(showEvent, () => { setVisible(true); });
    const hidden = Keyboard.addListener(hideEvent, () => { setVisible(false); });
    return () => { shown.remove(); hidden.remove(); };
  }, []);

  return visible;
}

/**
 * The keyboard state and whether the hero may be shown, in one call.
 *
 * Returned together because every caller needs both and they must agree: the
 * hero is the first thing to go — it is decoration, and the form is not.
 */
export function useAuthLayout(): { keyboardVisible: boolean; showHero: boolean } {
  const keyboardVisible = useKeyboardVisible();
  const { height } = useWindowDimensions();
  return { keyboardVisible, showHero: !keyboardVisible && height >= MIN_HEIGHT_FOR_HERO };
}

/**
 * The ScrollView props that do not depend on the keyboard.
 *
 * `scrollEnabled` is deliberately NOT here: it is the one prop that varies,
 * and each screen sets it from `keyboardVisible` at the call site so the
 * rule stays visible where it is read.
 */
export const authScrollProps = {
  bounces: false,
  alwaysBounceVertical: false,
  alwaysBounceHorizontal: false,
  showsVerticalScrollIndicator: false,
  showsHorizontalScrollIndicator: false,
  keyboardShouldPersistTaps: "handled",
  keyboardDismissMode: "on-drag",
} as const;

/**
 * The shared skeleton. Every value here is the one the owner approved for
 * Registration on a physical phone.
 */
export const authStyles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.surface },
  // `flexGrow: 1` is what makes "no scrolling" true rather than merely
  // usually true: the content is never shorter than the screen, so there is
  // no slack, and never wider, so there is nothing to pan sideways to.
  content: { flexGrow: 1 },
  // The padded column. The hero is its sibling and gets no padding.
  //
  // `flex: 1` is what pins the hero to the BOTTOM edge: the form absorbs
  // whatever vertical slack a tall screen has, instead of the slack landing
  // below the hero and leaving a strip of background under the photograph.
  // It is also what lets Sign-in's shorter form give the extra room to the
  // hero rather than stretching its own spacing to fill the screen.
  form: { flex: 1, paddingHorizontal: spacing.xl },
  heading: { marginTop: spacing.lg, marginBottom: spacing.lg },
  centred: { textAlign: "center" },
  formError: {
    backgroundColor: colors.dangerBg,
    borderRadius: spacing.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: spacing.lg,
  },
  link: { color: colors.brandLight, fontWeight: "700", fontSize: 15 },
});
