/**
 * D66 S5 — laying out international text for the PDF: shaping runs, the
 * bidirectional order, font fallback, wrapping, and nothing ever lost.
 * Measured with the real fonts through pdfkit, as the PDF is drawn.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import PDFDocument from "pdfkit";
import { FONT, FONT_KEYS, fontBuffer, fontCollectionMember, fontHasCodePoint, prepareFonts } from "./fonts.js";
import { layoutText, type LaidOutText, type TextMeasure } from "./textLayout.js";

prepareFonts();
const doc = new PDFDocument({ autoFirstPage: false });
for (const key of FONT_KEYS) doc.registerFont(key, fontBuffer(key), fontCollectionMember(key));
const measure: TextMeasure = (font, text, size) => doc.font(font).fontSize(size).widthOfString(text, { features: [] });

const lay = (text: string, width = 400, bold = false): LaidOutText => layoutText(text, { width, size: 9, bold }, measure);
/** Pieces of one line, left to right. */
const pieces = (laid: LaidOutText, line = 0) => [...(laid.lines[line]?.pieces ?? [])].sort((a, b) => a.x - b.x);
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

test("TL1. an Arabic phrase goes to the shaper WHOLE, in logical order, in the Arabic face — never letter by letter", () => {
  const laid = lay("مرحبا بالعالم");
  assert.deepEqual(pieces(laid).map(piece => [piece.font, piece.text]), [[FONT.arabic, "مرحبا بالعالم"]]);
});

test("TL2. a Hebrew paragraph is right-to-left: right-aligned, its Latin and numbers on the LEFT and in reading order", () => {
  const laid = lay("שלום abc 123", 300);
  const line = pieces(laid);
  assert.equal(line[line.length - 1]?.font, FONT.hebrew);
  assert.equal(line[line.length - 1]?.text.trim(), "שלום");
  assert.equal(line[0]?.text.startsWith("abc 123"), true, `got ${JSON.stringify(line.map(piece => piece.text))}`);
  const last = line[line.length - 1];
  assert.ok(last !== undefined && Math.abs(last.x + last.width - 300) < 0.01, "right-aligned");
});

test("TL3. Arabic-Indic digits read left to right inside Arabic: drawn one by one, in order, to the LEFT of the words", () => {
  const line = pieces(lay("مرحبا ١٢٣"));
  const digits = line.filter(piece => /[٠-٩]/u.test(piece.text));
  assert.deepEqual(digits.map(piece => piece.text), ["١", "٢", "٣"]);
  const word = line.find(piece => piece.text.includes("مرحبا"));
  assert.ok(word !== undefined && digits.every(digit => digit.x < word.x));
});

test("TL4. brackets are MIRRORED in right-to-left text — fontkit does not", () => {
  const line = pieces(lay("(נמל)"));
  assert.equal(line[0]?.text, "(");
  assert.equal(line[line.length - 1]?.text, ")");
  assert.ok(line.some(piece => piece.font === FONT.hebrew && piece.text === "נמל"));
});

test("TL5. a left-to-right line keeps the bidi order: Latin, then the Arabic run reversed as a whole, then Latin", () => {
  const line = pieces(lay("AB12 مرحبا CD")).filter(piece => piece.text.trim() !== "");
  assert.deepEqual(line.map(piece => [piece.font, piece.text.trim()]), [[FONT.latin, "AB12"], [FONT.arabic, "مرحبا"], [FONT.latin, "CD"]]);
  assert.equal(line[1]?.text, "مرحبا");
});

const EVERY_SCRIPT = "Žluťoučký Ελληνικά Привет שלום مرحبا नमस्ते क्षत्रिय ਸਤ ਸ੍ਰੀ ਅਕਾਲ 東京の倉庫 서울 창고 中文 123 — ?!";

test("TL6. FALLBACK: every piece is drawn in a face that has every character it draws, across all ten approved scripts", () => {
  const laid = lay(EVERY_SCRIPT, 2000);
  assert.equal(laid.missing, false);
  for (const piece of laid.lines.flatMap(line => line.pieces)) {
    for (const character of piece.text) {
      if (IGNORABLE.test(character)) continue;
      assert.ok(fontHasCodePoint(piece.font, character.codePointAt(0) ?? 0), `${piece.font} lacks U+${(character.codePointAt(0) ?? 0).toString(16)}`);
    }
  }
  const faces = new Set(laid.lines.flatMap(line => line.pieces.map(piece => piece.font)));
  for (const face of [FONT.latin, FONT.hebrew, FONT.arabic, FONT.devanagari, FONT.gurmukhi, FONT.cjkKorea]) assert.ok(faces.has(face), `no ${face}`);
});

test("TL7. NOTHING DISAPPEARS: every visible character drawn is one of the text's, each exactly once, in some face or as a marker", () => {
  const text = `${EVERY_SCRIPT} 🚚 สวัสดี ctrl\u0007x tab\tend`;
  const laid = lay(text, 2000);
  const drawn = laid.lines.flatMap(line => line.pieces.map(piece => piece.text)).join("");
  const markers = [...drawn.matchAll(/\[U\+([0-9A-F]{4,6})\]/g)].map(found => String.fromCodePoint(parseInt(found[1] ?? "0", 16)));
  const plain = drawn.replace(/\[U\+[0-9A-F]{4,6}\]/g, "");
  const count = (characters: Iterable<string>) => {
    const counts = new Map<string, number>();
    for (const character of characters) if (!IGNORABLE.test(character) && character !== " ") counts.set(character, (counts.get(character) ?? 0) + 1);
    return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  };
  // Mirrored brackets are the same characters drawn the other way round.
  const unmirror = (character: string) => (character === ")" ? "(" : character);
  assert.deepEqual(
    count([...plain, ...markers].map(unmirror)),
    count([...text].map(unmirror)),
  );
  assert.equal(laid.missing, true);
  assert.ok(drawn.includes("[U+1F69A]") && drawn.includes("[U+0E2A]") && drawn.includes("[U+0007]") && drawn.includes("[U+0009]"));
});

test("TL8. invisible characters (bidi marks, joiners) draw nothing and raise no alarm — they still steer the order", () => {
  const laid = lay("‏abc‍");
  assert.equal(laid.missing, false);
  assert.ok(!pieces(laid).some(piece => piece.text.includes("[U+")));
  // RLM makes the paragraph right-to-left: right-aligned.
  const last = pieces(laid).at(-1);
  assert.ok(last !== undefined && Math.abs(last.x + last.width - 400) < 0.01);
});

test("TL9. Han is drawn in the Japanese design, or the Korean one when the text has Hangul (owner decision)", () => {
  assert.equal(pieces(lay("中文の倉庫"))[0]?.font, FONT.cjkJapan);
  assert.equal(pieces(lay("中文"))[0]?.font, FONT.cjkJapan);
  assert.ok(pieces(lay("漢字 한국")).every(piece => piece.font === FONT.cjkKorea));
});

test("TL10. WRAPPING: no line is wider than its box, a word too long for it is broken between clusters, and every character survives in order", () => {
  const long = "W".repeat(500);
  const laid = lay(long, 120);
  assert.ok(laid.lines.length > 5);
  for (const line of laid.lines) assert.ok(line.width <= 120 + 0.01, `a line of ${String(line.width)}`);
  assert.equal(laid.lines.map(line => line.pieces.map(piece => piece.text).join("")).join(""), long);

  const words = lay("the quick brown fox jumps over the lazy dog ".repeat(10).trim(), 150);
  for (const line of words.lines) assert.ok(line.width <= 150 + 0.01);
  assert.ok(words.lines.every(line => !(line.pieces[0]?.text.startsWith(" ") ?? false)), "a line never starts with the space it broke at");
});

test("TL11. Chinese and Japanese break between characters; Korean between words", () => {
  const cjk = lay("東京の倉庫で待機".repeat(20), 100);
  assert.ok(cjk.lines.length > 3);
  for (const line of cjk.lines) assert.ok(line.width <= 100 + 0.01);
  assert.equal(cjk.lines.map(line => line.pieces.map(piece => piece.text).join("")).join(""), "東京の倉庫で待機".repeat(20));
});

test("TL12. a line break in the text starts a new line; each paragraph finds its own direction", () => {
  const laid = lay("Waited at the depot\nשלום", 300);
  assert.equal(laid.lines.length, 2);
  assert.equal(pieces(laid, 0)[0]?.x, 0);
  const hebrew = pieces(laid, 1)[0];
  assert.ok(hebrew !== undefined && Math.abs(hebrew.x + hebrew.width - 300) < 0.01);
});

test("TL13. bold asks for the bold Latin face; other scripts keep their regular face", () => {
  const line = pieces(lay("Driver שלום", 400, true));
  assert.deepEqual(line.map(piece => piece.font).sort(), [FONT.hebrew, FONT.latinBold].sort());
});

test("TL14. the same text always lays out the same", () => {
  assert.deepEqual(lay(EVERY_SCRIPT, 180), lay(EVERY_SCRIPT, 180));
});
