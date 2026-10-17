/**
 * The fonts a timesheet PDF is drawn with (D66 "PDF": international text as
 * stored). Noto, under the SIL Open Font License 1.1 (`assets/fonts/OFL-*.txt`),
 * pinned files — a template never changes once released, and neither do its
 * fonts.
 *
 * One face per script family the owner approved — Latin / Cyrillic / Greek,
 * Arabic, Hebrew, Devanagari, Gurmukhi, Chinese / Japanese / Korean — and a
 * bold Latin face for the template's own labels. Driver text in another script
 * is drawn in that script's regular face, whatever the weight asked for.
 *
 * Han characters are drawn in the Japanese or the Korean design (owner
 * decision, 2026-10-17): Korean when the text has Hangul, otherwise Japanese.
 * The characters are the same either way; only their shapes differ.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type * as Fontkit from "fontkit";
import { installNullAnchorFix } from "./fontkitNullAnchor.js";

/**
 * The SAME fontkit pdfkit uses: pdfkit is CommonJS and `require`s it, and an
 * ES import would load fontkit's other build — a second copy, whose fixes
 * would not reach what pdfkit draws with.
 */
function loadFontkit(loaded: unknown): typeof Fontkit {
  if (typeof loaded === "object" && loaded !== null && "create" in loaded && typeof loaded.create === "function") {
    return loaded as typeof Fontkit;
  }
  throw new Error("fontkit did not load");
}
const fontkit = loadFontkit(createRequire(import.meta.url)("fontkit"));

export const FONT = {
  latin:      "latin",
  latinBold:  "latin-bold",
  arabic:     "arabic",
  hebrew:     "hebrew",
  devanagari: "devanagari",
  gurmukhi:   "gurmukhi",
  cjkJapan:   "cjk-japan",
  cjkKorea:   "cjk-korea",
} as const;

export type FontKey = (typeof FONT)[keyof typeof FONT];

interface FontFile {
  file: string;
  postscriptName: string;
  /** A collection (`.ttc`) is opened by naming its member; a single face is not. */
  collection: boolean;
}

const FILES: Record<FontKey, FontFile> = {
  [FONT.latin]:      { file: "NotoSans-Regular.ttf",           postscriptName: "NotoSans-Regular", collection: false },
  [FONT.latinBold]:  { file: "NotoSans-Bold.ttf",              postscriptName: "NotoSans-Bold", collection: false },
  [FONT.arabic]:     { file: "NotoSansArabic-Regular.ttf",     postscriptName: "NotoSansArabic-Regular", collection: false },
  [FONT.hebrew]:     { file: "NotoSansHebrew-Regular.ttf",     postscriptName: "NotoSansHebrew-Regular", collection: false },
  [FONT.devanagari]: { file: "NotoSansDevanagari-Regular.ttf", postscriptName: "NotoSansDevanagari-Regular", collection: false },
  [FONT.gurmukhi]:   { file: "NotoSansGurmukhi-Regular.ttf",   postscriptName: "NotoSansGurmukhi-Regular", collection: false },
  [FONT.cjkJapan]:   { file: "NotoSansCJK-Regular.ttc",        postscriptName: "NotoSansCJKjp-Regular", collection: true },
  [FONT.cjkKorea]:   { file: "NotoSansCJK-Regular.ttc",        postscriptName: "NotoSansCJKkr-Regular", collection: true },
};

export const FONT_KEYS: readonly FontKey[] = Object.values(FONT);

/** `api/assets/fonts`, from `src/pdf` and from the built `dist/pdf` alike. */
const FONT_DIRECTORY = new URL("../../assets/fonts/", import.meta.url);

const buffers = new Map<string, Buffer>();
const faces = new Map<FontKey, Fontkit.Font>();
let prepared = false;

/** A font file's bytes, read once per process (the two CJK faces share one file). */
export function fontBuffer(key: FontKey): Buffer {
  const { file } = FILES[key];
  const cached = buffers.get(file);
  if (cached !== undefined) return cached;
  const buffer = readFileSync(new URL(file, FONT_DIRECTORY));
  buffers.set(file, buffer);
  return buffer;
}

/** The member to open, for a face inside a collection; undefined for a file that is one face. */
export function fontCollectionMember(key: FontKey): string | undefined {
  const { collection, postscriptName } = FILES[key];
  return collection ? postscriptName : undefined;
}

/**
 * Ready fontkit for drawing — once per process, before any text is laid out:
 * the NULL-anchor fix (`fontkitNullAnchor.ts`) goes onto the processor every
 * face shares.
 */
export function prepareFonts(): void {
  if (prepared) return;
  prepared = true;
  installNullAnchorFix(face(FONT.latin));
}

function face(key: FontKey): Fontkit.Font {
  const cached = faces.get(key);
  if (cached !== undefined) return cached;
  const { postscriptName } = FILES[key];
  const opened = fontkit.create(fontBuffer(key));
  const found = "fonts" in opened ? opened.fonts.find(member => member.postscriptName === postscriptName) : opened;
  if (found === undefined || found.postscriptName !== postscriptName) {
    throw new Error(`font ${key}: the file does not hold ${postscriptName}`);
  }
  faces.set(key, found);
  return found;
}

/** Whether the face draws this code point itself — never its missing-glyph box. */
export function fontHasCodePoint(key: FontKey, codePoint: number): boolean {
  prepareFonts();
  return face(key).hasGlyphForCodePoint(codePoint);
}

/** The distance from the top of a line of this face to its baseline, at a size. */
export function fontAscent(key: FontKey, size: number): number {
  const font = face(key);
  return (font.ascent / font.unitsPerEm) * size;
}
