import homeCard from "../../assets/images/home-shift-card.png";

/**
 * The photograph behind Home's Start Shift card — isolated here so replacing
 * it is an ASSET SWAP and nothing else.
 *
 * THE COPY SITS ON TOP OF THIS IMAGE, as the approved design has it: the truck
 * enters from the right and the heading, body and button lie over the left.
 * That only works because the asset carries its own LEFT-TO-RIGHT FADE TO
 * TRANSPARENCY, so the copy side is the card's own surface colour and nothing
 * is layered over the text to keep it legible. A scrim would dull the
 * photograph; a gradient component would mean a new dependency
 * (`expo-linear-gradient` is not installed). Baking the fade into the asset
 * costs neither.
 *
 * HOW THE ASSET IS PRODUCED, so it can be regenerated rather than guessed at.
 * `assets/images/truckhero.jpg` is the owner-supplied master and is kept for
 * exactly that reason; it is deliberately NOT imported. The derived file is
 * rendered from it with `rsvg-convert`, already present on the build machine:
 *
 *   - canvas 1499x999 (3:2), matching the card's own proportion, so `cover`
 *     has almost nothing left to crop;
 *   - the master drawn at 1998x999, offset +36px, which puts the cab's nose
 *     clear of the copy column;
 *   - an 11-stop linear gradient used as a mask — fully transparent to 24%,
 *     ramping to fully opaque by 62% — so the fade is smooth rather than a
 *     visible edge;
 *   - output at 1100px wide, which is 3x the card's ~354pt on the densest
 *     phone.
 *
 * WHY NOT THE AUTH HERO. `registration-truck-sunrise.png` belongs to Login and
 * Registration and was rejected for Home on review: its warm sunrise fought
 * Home's cool surface, its truck sat on the LEFT where the copy goes, and
 * reusing it made Home read as a third sign-in screen. It stays in
 * `components/Brand.tsx`; Home does not reference it.
 */
export const HOME_CARD_IMAGE = homeCard;
