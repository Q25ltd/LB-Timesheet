/**
 * A fix for fontkit 2.0.4's mark positioning (foliojs/fontkit#367, open):
 * OpenType allows a NULL anchor in a mark-to-base, mark-to-ligature or
 * mark-to-mark record — "this mark does not attach here" — and Noto's fonts
 * use it (Noto Sans Gurmukhi on `ਸ੍ਰੀ`, for one). fontkit dereferences it and
 * throws, so a driver's text could make a timesheet impossible to draw.
 *
 * What a NULL anchor means, as HarfBuzz applies it: that subtable does not
 * apply to this glyph, and the next one is tried. That is exactly what this
 * does — `applyAnchor` refuses before it changes anything, and the lookup it
 * was called from answers "not applied". Nothing else in fontkit changes.
 *
 * It patches the GPOS processor of the fontkit instance pdfkit itself loads
 * (the CommonJS build, `require("fontkit")`), found through a face's own
 * layout engine. fontkit is pinned to 2.0.4 exactly (package.json): a new
 * version is a deliberate change, and if its internals moved, installing this
 * throws rather than silently leaving the crash in place.
 */

/** Thrown from applyAnchor before it changes anything; caught by the lookup that called it. */
class NoAnchor extends Error {}
const NO_ANCHOR = new NoAnchor("fontkit: NULL GPOS anchor");
const INSTALLED = Symbol.for("lb-timesheet.fontkit-null-anchor");

function member(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * Install the fix on the GPOS processor class of `face` — a fontkit face that
 * has a GPOS table. Idempotent.
 */
export function installNullAnchorFix(face: unknown): void {
  const layout = member(face, "layout");
  if (typeof layout !== "function") throw new Error("fontkit: a face without layout()");
  Reflect.apply(layout, face, ["A"]);
  const processor = member(member(member(face, "_layoutEngine"), "engine"), "GPOSProcessor");
  if (typeof processor !== "object" || processor === null) throw new Error("fontkit: no GPOS processor where 2.0.4 has it");
  const prototype: unknown = Object.getPrototypeOf(processor);
  if (typeof prototype !== "object" || prototype === null) throw new Error("fontkit: no GPOS processor class");
  if (Reflect.get(prototype, INSTALLED) === true) return;

  const applyAnchor: unknown = Reflect.get(prototype, "applyAnchor");
  const applyLookup: unknown = Reflect.get(prototype, "applyLookup");
  if (typeof applyAnchor !== "function" || typeof applyLookup !== "function") {
    throw new Error("fontkit: GPOSProcessor.applyAnchor / applyLookup are not where 2.0.4 has them");
  }
  Reflect.set(prototype, "applyAnchor", function (this: unknown, markRecord: unknown, baseAnchor: unknown, baseGlyphIndex: unknown): unknown {
    if (baseAnchor === null || baseAnchor === undefined || member(markRecord, "markAnchor") === null || member(markRecord, "markAnchor") === undefined) {
      throw NO_ANCHOR;
    }
    const result: unknown = Reflect.apply(applyAnchor, this, [markRecord, baseAnchor, baseGlyphIndex]);
    return result;
  });
  Reflect.set(prototype, "applyLookup", function (this: unknown, ...args: unknown[]): unknown {
    try {
      const result: unknown = Reflect.apply(applyLookup, this, args);
      return result;
    } catch (error) {
      if (error === NO_ANCHOR) return false;
      throw error;
    }
  });
  Reflect.set(prototype, INSTALLED, true);
}
