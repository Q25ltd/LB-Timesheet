/**
 * Lays out one piece of stored text for the PDF (D66 "PDF"): wrapped to a
 * width, each line in VISUAL order, each piece in the one face that draws it.
 *
 * - Shaping: a run of one script in one face goes to the shaper (fontkit, via
 *   pdfkit) whole, so Arabic joins and Devanagari / Gurmukhi conjuncts form.
 * - Direction: the Unicode Bidirectional Algorithm (bidi-js) resolves levels
 *   per paragraph, its base direction from the text itself; lines are broken
 *   in logical order and then reordered (UAX #9, L2), and an RTL paragraph is
 *   right-aligned. Mirrored characters are mirrored in RTL runs — fontkit does
 *   not. A right-to-left run is handed to fontkit in logical order, which
 *   reverses it; anything fontkit would wrongly reverse (Arabic-Indic digits,
 *   which read left to right) is drawn one cluster at a time.
 * - Fallback: each grapheme cluster takes the first face that has every one of
 *   its characters — the face of its own script first; a neutral (a space, a
 *   digit, punctuation) stays in the face before it when that face has it.
 * - Nothing disappears: a cluster no face can draw — a control character, an
 *   unsupported script, an emoji — is drawn as a visible `[U+XXXX]` marker,
 *   and the result says so. Only characters that are invisible by definition
 *   (Default_Ignorable_Code_Point: bidi controls, joiners, variation
 *   selectors) draw nothing, and those still steer direction and shaping.
 *
 * The stored text is never altered: this decides what is DRAWN. The exact
 * text travels in the PDF's attached snapshot.
 */
import bidiModule from "bidi-js";
import { FONT, fontHasCodePoint, type FontKey } from "./fonts.js";

/** The width of `text` drawn in `font` at `size`, as the PDF will draw it. */
export type TextMeasure = (font: FontKey, text: string, size: number) => number;

interface DrawnPiece {
  font: FontKey;
  /** What to hand to the PDF: logical order for a shaped RTL run, visual otherwise. */
  text: string;
  /** From the left edge of the box. */
  x: number;
  width: number;
}

interface TextLine {
  pieces: DrawnPiece[];
  width: number;
}

export interface LaidOutText {
  lines: TextLine[];
  /** Whether any character was drawn as a `[U+XXXX]` marker. */
  missing: boolean;
}

export interface TextStyle {
  size: number;
  bold: boolean;
  /** The box's width; a line is never wider unless one cluster is. */
  width: number;
}

/**
 * bidi-js is CommonJS whose `module.exports` IS the factory, while its types
 * declare a default export: under NodeNext the import is the factory itself.
 */
const loaded: unknown = bidiModule;
const bidi = (typeof loaded === "function" ? (loaded as typeof bidiModule.default) : bidiModule.default)();

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const CONTROL = /\p{Cc}/u;
const NEUTRAL = /^[\p{Script=Common}\p{Script=Inherited}]/u;
/** Spaces a line may break after: every space separator except the no-break ones. */
const BREAKING_SPACE = /^(?![\u00A0\u2007\u202F])\p{Zs}$/u;
/** Ideographic and syllabic scripts written without spaces: a line may break around any cluster. */
const UNSPACED = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;
/** The right-to-left scripts among the faces here — what fontkit reverses. */
const SHAPED_RIGHT_TO_LEFT = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;
const PARAGRAPH_BREAK = /\r\n|[\n\r\u2028\u2029]/u;

const SCRIPT_FACE: readonly [RegExp, FontKey | "cjk"][] = [
  [/^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u, FONT.latin],
  [/^\p{Script=Arabic}/u, FONT.arabic],
  [/^\p{Script=Hebrew}/u, FONT.hebrew],
  [/^\p{Script=Devanagari}/u, FONT.devanagari],
  [/^\p{Script=Gurmukhi}/u, FONT.gurmukhi],
  [/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u, "cjk"],
];

interface Cluster {
  text: string;
  font: FontKey;
  /** What is drawn: the cluster less the invisible characters its face lacks, or its marker. */
  draw: string;
  marker: boolean;
  level: number;
  breakingSpace: boolean;
  unspaced: boolean;
  /**
   * In a script fontkit lays out right to left (it decides by SCRIPT, not by
   * bidi class): it reverses a run holding one — Arabic-Indic digits included,
   * which are Arabic script yet read left to right.
   */
  rightToLeftScript: boolean;
}

const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });

function codePoints(text: string): number[] {
  return Array.from(text, character => character.codePointAt(0) ?? 0);
}

function marker(text: string): string {
  return codePoints(text)
    .filter(codePoint => !IGNORABLE.test(String.fromCodePoint(codePoint)))
    .map(codePoint => `[U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}]`)
    .join("");
}

/** The cluster's characters a face must have: all but the invisible ones. */
function visibleCodePoints(text: string): number[] {
  return codePoints(text).filter(codePoint => !IGNORABLE.test(String.fromCodePoint(codePoint)));
}

function faceDraws(font: FontKey, text: string): boolean {
  const visible = visibleCodePoints(text);
  return visible.length > 0 && visible.every(codePoint => fontHasCodePoint(font, codePoint));
}

/** The cluster as its face draws it: invisible characters the face has no glyph for are left out. */
function drawnIn(font: FontKey, text: string): string {
  return Array.from(text)
    .filter(character => !IGNORABLE.test(character) || fontHasCodePoint(font, character.codePointAt(0) ?? 0))
    .join("");
}

function fallbackOrder(bold: boolean, cjk: FontKey): FontKey[] {
  return [bold ? FONT.latinBold : FONT.latin, FONT.arabic, FONT.hebrew, FONT.devanagari, FONT.gurmukhi, cjk];
}

function scriptFace(text: string, bold: boolean, cjk: FontKey): FontKey | null {
  for (const [pattern, face] of SCRIPT_FACE) {
    if (!pattern.test(text)) continue;
    if (face === "cjk") return cjk;
    return face === FONT.latin && bold ? FONT.latinBold : face;
  }
  return null;
}

function clustersOf(paragraph: string, levels: Uint8Array, bold: boolean, cjk: FontKey): Cluster[] {
  const clusters: Cluster[] = [];
  let previous: FontKey | null = null;
  for (const { segment, index } of graphemes.segment(paragraph)) {
    const level = levels[index] ?? 0;
    const rightToLeftScript = SHAPED_RIGHT_TO_LEFT.test(segment);
    const base = { text: segment, level, rightToLeftScript, breakingSpace: BREAKING_SPACE.test(segment), unspaced: UNSPACED.test(segment) };

    if (visibleCodePoints(segment).length === 0) {
      // Invisible by definition: it has steered the levels; nothing is drawn.
      clusters.push({ ...base, font: previous ?? FONT.latin, draw: "", marker: false });
      continue;
    }
    const neutral = NEUTRAL.test(segment);
    const candidates: FontKey[] = [
      ...(neutral && previous !== null ? [previous] : []),
      ...(neutral ? [] : [scriptFace(segment, bold, cjk)].filter((face): face is FontKey => face !== null)),
      ...fallbackOrder(bold, cjk),
    ];
    const font: FontKey | undefined = CONTROL.test(segment) ? undefined : candidates.find(face => faceDraws(face, segment));
    if (font === undefined) {
      clusters.push({ ...base, font: bold ? FONT.latinBold : FONT.latin, draw: marker(segment), marker: true, rightToLeftScript: false });
      continue;
    }
    clusters.push({ ...base, font, draw: drawnIn(font, segment), marker: false });
    previous = font;
  }
  return clusters;
}

/** UAX #9 rule L2: from the highest level down to the lowest odd one, reverse every run at that level or above. */
function visualOrder(line: readonly Cluster[]): Cluster[] {
  const ordered = [...line];
  const levels = ordered.map(cluster => cluster.level);
  const highest = Math.max(0, ...levels);
  const lowestOdd = Math.min(...levels.filter(level => level % 2 === 1), highest + 1);
  for (let level = highest; level >= lowestOdd; level -= 1) {
    let index = 0;
    while (index < ordered.length) {
      if ((ordered[index]?.level ?? 0) < level) { index += 1; continue; }
      let end = index;
      while (end < ordered.length && (ordered[end]?.level ?? 0) >= level) end += 1;
      const reversed = ordered.slice(index, end).reverse();
      ordered.splice(index, reversed.length, ...reversed);
      index = end;
    }
  }
  return ordered;
}

function mirrored(text: string): string {
  return Array.from(text, character => bidi.getMirroredCharacter(character) ?? character).join("");
}

/** A cluster that must be drawn on its own: a marker, or a cluster fontkit would reverse inside a left-to-right run. */
function alone(cluster: Cluster): boolean {
  return cluster.marker || (cluster.level % 2 === 0 && cluster.rightToLeftScript);
}

interface Run { font: FontKey; text: string }

/** Visual clusters → the runs handed to the PDF, each in the order fontkit needs. */
function runsOf(visual: readonly Cluster[]): Run[] {
  const groups: Cluster[][] = [];
  for (const cluster of visual) {
    if (cluster.draw === "") continue;
    const last = groups[groups.length - 1];
    const head = last?.[0];
    if (last !== undefined && head !== undefined && !alone(cluster) && !alone(head)
      && head.font === cluster.font && head.level === cluster.level) {
      last.push(cluster);
    } else {
      groups.push([cluster]);
    }
  }
  return groups.flatMap(group => {
    const head = group[0];
    if (head === undefined) return [];
    if (head.level % 2 === 0) return [{ font: head.font, text: group.map(cluster => cluster.draw).join("") }];
    const shaped = group.some(cluster => cluster.rightToLeftScript);
    const ordered = shaped ? [...group].reverse() : group;
    return [{ font: head.font, text: ordered.map(cluster => mirrored(cluster.draw)).join("") }];
  });
}

/** The width of clusters in logical order — the same runs, so the same shaping, as they are drawn. */
function widthOf(clusters: readonly Cluster[], size: number, measure: TextMeasure): number {
  return runsOf(clusters).reduce((sum, run) => sum + measure(run.font, run.text, size), 0);
}

function lineOf(clusters: readonly Cluster[], style: TextStyle, rightToLeft: boolean, measure: TextMeasure): TextLine {
  let end = clusters.length;
  while (end > 0 && clusters[end - 1]?.breakingSpace === true) end -= 1;
  const runs = runsOf(visualOrder(clusters.slice(0, end)));
  const pieces: DrawnPiece[] = [];
  let x = 0;
  for (const run of runs) {
    const width = measure(run.font, run.text, style.size);
    pieces.push({ font: run.font, text: run.text, x, width });
    x += width;
  }
  const offset = rightToLeft ? Math.max(0, style.width - x) : 0;
  return { pieces: pieces.map(piece => ({ ...piece, x: piece.x + offset })), width: x };
}

/** Logical clusters → words: each ends where a line may break. */
function wordsOf(clusters: readonly Cluster[]): Cluster[][] {
  const words: Cluster[][] = [];
  let current: Cluster[] = [];
  clusters.forEach((cluster, index) => {
    const next = clusters[index + 1];
    if (cluster.unspaced && current.length > 0 && !current.every(member => member.breakingSpace)) {
      words.push(current);
      current = [];
    }
    current.push(cluster);
    const breakAfter = next === undefined
      || (cluster.breakingSpace && !next.breakingSpace)
      || cluster.unspaced;
    if (breakAfter) {
      words.push(current);
      current = [];
    }
  });
  if (current.length > 0) words.push(current);
  return words;
}

function wrap(clusters: readonly Cluster[], style: TextStyle, measure: TextMeasure): Cluster[][] {
  const lines: Cluster[][] = [];
  let line: Cluster[] = [];
  const fits = (candidate: readonly Cluster[]): boolean => {
    let end = candidate.length;
    while (end > 0 && candidate[end - 1]?.breakingSpace === true) end -= 1;
    return widthOf(candidate.slice(0, end), style.size, measure) <= style.width;
  };
  for (const word of wordsOf(clusters)) {
    if (fits([...line, ...word])) { line.push(...word); continue; }
    if (line.length > 0) { lines.push(line); line = []; }
    if (fits(word)) { line.push(...word); continue; }
    // A word wider than the box: broken between clusters, never lost.
    for (const cluster of word) {
      if (line.length > 0 && !fits([...line, cluster])) { lines.push(line); line = []; }
      line.push(cluster);
    }
  }
  lines.push(line);
  return lines;
}

/** Lay out stored text in a box `style.width` wide. */
export function layoutText(text: string, style: TextStyle, measure: TextMeasure): LaidOutText {
  const cjk = HANGUL.test(text) ? FONT.cjkKorea : FONT.cjkJapan;
  const lines: TextLine[] = [];
  let missing = false;
  for (const paragraph of text.split(PARAGRAPH_BREAK)) {
    const resolved = bidi.getEmbeddingLevels(paragraph, "auto");
    const rightToLeft = (resolved.paragraphs[0]?.level ?? 0) % 2 === 1;
    const clusters = clustersOf(paragraph, resolved.levels, style.bold, cjk);
    if (clusters.some(cluster => cluster.marker)) missing = true;
    for (const line of wrap(clusters, style, measure)) lines.push(lineOf(line, style, rightToLeft, measure));
  }
  return { lines, missing };
}
