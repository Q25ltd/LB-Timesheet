/**
 * D66 S5 — fontkit 2.0.4 throws on a NULL GPOS anchor (foliojs/fontkit#367);
 * the fix makes such a subtable "not applied", as HarfBuzz does.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import PDFDocument from "pdfkit";
import { installNullAnchorFix } from "./fontkitNullAnchor.js";
import { FONT, fontBuffer, prepareFonts } from "./fonts.js";

/** Text that reaches a NULL anchor in Noto Sans Gurmukhi: a subjoined ra under a conjunct with a vowel sign. */
const GURMUKHI = "ਸਤ ਸ੍ਰੀ ਅਕਾਲ";

test("FN1. with the fix, the Gurmukhi that crashed fontkit lays out — through pdfkit, the way the PDF is drawn", () => {
  prepareFonts();
  const doc = new PDFDocument({ autoFirstPage: false });
  doc.registerFont(FONT.gurmukhi, fontBuffer(FONT.gurmukhi));
  const width = doc.font(FONT.gurmukhi).fontSize(9).widthOfString(GURMUKHI, { features: [] });
  assert.ok(width > 0);
});

function member(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

test("FN2. installing it twice changes nothing", () => {
  prepareFonts();
  const fontkit: unknown = createRequire(import.meta.url)("fontkit");
  const create = member(fontkit, "create");
  assert.equal(typeof create, "function");
  if (typeof create !== "function") return;
  const face: unknown = Reflect.apply(create, fontkit, [fontBuffer(FONT.latin)]);
  installNullAnchorFix(face);
  const prototype: unknown = Object.getPrototypeOf(member(member(member(face, "_layoutEngine"), "engine"), "GPOSProcessor"));
  const before = member(prototype, "applyLookup");
  assert.equal(typeof before, "function");
  installNullAnchorFix(face);
  assert.equal(member(prototype, "applyLookup"), before);
});

test("FN3. if fontkit's internals are not where 2.0.4 has them, installing FAILS LOUDLY — never a silent crash left in place", () => {
  assert.throws(() => installNullAnchorFix({}), /fontkit/);
  assert.throws(() => installNullAnchorFix({ layout: () => null }), /fontkit/);
});
