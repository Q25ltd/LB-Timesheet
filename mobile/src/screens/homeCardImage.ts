import homeTruck from "../../assets/images/truckhero.jpg";

/**
 * The photograph in Home's Start Shift card — isolated here so replacing it is
 * an ASSET SWAP and nothing else.
 *
 * WHY THIS FILE EXISTS. Home's image was expected to change after the first
 * visual review, and it did. Keeping the source and its crop ratio in one
 * module means the replacement touched one line: no component restructuring,
 * no style change, no test change.
 *
 * WHY IT IS NOT THE AUTH HERO. `registration-truck-sunrise.png` is Login and
 * Registration's, and it was rejected for Home on review: its warm orange
 * sunrise fights Home's cool blue surface, its truck sits on the LEFT where
 * Home puts its heading and copy, and reusing it made Home read as a third
 * sign-in screen. That file stays where it belongs — `components/Brand.tsx` —
 * and Home no longer references it.
 *
 * The asset below is the owner-supplied Home image: cool daylight, white
 * articulated HGV on the RIGHT, motorway, quiet left third for the heading,
 * no third-party logos, no readable plate, no embedded text.
 */

export const HOME_CARD_IMAGE = homeTruck;

/**
 * How the card crops it: width is the card's, height follows from this.
 *
 * A ratio rather than a height, so the band scales with the phone instead of
 * squashing on a narrow screen — and so a replacement image of any landscape
 * proportion lands in the same box. The source is 2:1 and this is wider, so
 * `cover` fills the width and trims evenly top and bottom; the truck sits
 * mid-frame and survives the crop.
 */
export const HOME_CARD_IMAGE_ASPECT = 2.7;
