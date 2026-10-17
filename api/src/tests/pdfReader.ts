/**
 * A small PDF reader for tests: enough of the format to prove what pdfkit
 * wrote — the cross-reference table, the pages, the attached files, and every
 * run of text drawn, with its face, size, position, glyphs and (through the
 * font's ToUnicode map) its characters. Not a general parser: it reads the
 * files this repository writes.
 */
import { inflateSync } from "node:zlib";

interface PdfObject { dict: string; stream: Buffer | null }

interface TextRun {
  page: number;
  /** The face's PostScript name, without the subset tag. */
  face: string;
  size: number;
  x: number;
  y: number;
  glyphs: number[];
  /** Each glyph's characters, in the order the glyphs are drawn. */
  glyphTexts: string[];
  text: string;
}

export interface ReadPdf {
  objects: Map<number, PdfObject>;
  pages: { mediaBox: number[]; runs: TextRun[] }[];
  attachments: Map<string, Buffer>;
  info: string;
}

function parseObjects(pdf: Buffer): Map<number, PdfObject> {
  const text = pdf.toString("latin1");
  const objects = new Map<number, PdfObject>();
  const pattern = /(\d+) 0 obj\s*/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index + match[0].length;
    const end = text.indexOf("endobj", start);
    const body = text.slice(start, end);
    const streamAt = body.indexOf("stream\n");
    if (streamAt < 0) {
      objects.set(Number(match[1]), { dict: body, stream: null });
      continue;
    }
    const dict = body.slice(0, streamAt);
    const length = Number(/\/Length (\d+)/.exec(dict)?.[1] ?? "0");
    const from = start + streamAt + "stream\n".length;
    const raw = pdf.subarray(from, from + length);
    objects.set(Number(match[1]), { dict, stream: dict.includes("/FlateDecode") ? inflateSync(raw) : raw });
    pattern.lastIndex = end;
  }
  return objects;
}

/** Throws unless the trailer, the cross-reference table and every offset in it are right. */
function assertWellFormed(pdf: Buffer): void {
  const text = pdf.toString("latin1");
  if (!text.startsWith("%PDF-1.7")) throw new Error("no PDF 1.7 header");
  if (!text.trimEnd().endsWith("%%EOF")) throw new Error("no %%EOF");
  const startxref = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)?.[1] ?? "-1");
  if (text.slice(startxref, startxref + 4) !== "xref") throw new Error("startxref does not point at the xref table");
  const header = /^xref\s+0 (\d+)\s+/.exec(text.slice(startxref));
  if (header === null) throw new Error("unreadable xref header");
  const count = Number(header[1]);
  const size = Number(/\/Size (\d+)/.exec(text.slice(startxref))?.[1] ?? "-1");
  if (size !== count) throw new Error(`trailer /Size ${String(size)} is not the xref's ${String(count)}`);
  const entries = text.slice(startxref + header[0].length).split("\n").slice(0, count);
  entries.forEach((entry, number) => {
    const fields = /^(\d{10}) (\d{5}) ([nf])/.exec(entry);
    if (fields === null) throw new Error(`xref entry ${String(number)} unreadable`);
    if (fields[3] !== "n") return;
    const offset = Number(fields[1]);
    if (!text.startsWith(`${String(number)} 0 obj`, offset)) throw new Error(`xref entry ${String(number)} points at the wrong place`);
  });
}

function ref(dict: string, key: string): number | null {
  const found = new RegExp(`/${key} (\\d+) 0 R`).exec(dict);
  return found === null ? null : Number(found[1]);
}

function hexUtf16(spaced: string): string {
  const hex = spaced.replace(/\s+/g, "");
  const units: number[] = [];
  for (let index = 0; index < hex.length; index += 4) units.push(parseInt(hex.slice(index, index + 4), 16));
  return String.fromCharCode(...units);
}

function toUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const line of (block[1] ?? "").matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F\s]+>)/g)) {
      const from = parseInt(line[1] ?? "0", 16);
      const target = line[3] ?? "";
      if (target.startsWith("[")) {
        [...target.matchAll(/<([0-9a-fA-F\s]*)>/g)].forEach((value, offset) => map.set(from + offset, hexUtf16(value[1] ?? "")));
      } else {
        const to = parseInt(line[2] ?? "0", 16);
        const base = parseInt(target.slice(1, -1), 16);
        for (let code = from; code <= to; code += 1) map.set(code, String.fromCharCode(base + code - from));
      }
    }
  }
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const line of (block[1] ?? "").matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]*)>/g)) map.set(parseInt(line[1] ?? "0", 16), hexUtf16(line[2] ?? ""));
  }
  return map;
}

export function readPdf(pdf: Buffer): ReadPdf {
  assertWellFormed(pdf);
  const objects = parseObjects(pdf);
  const get = (number: number | null): PdfObject => {
    const found = number === null ? undefined : objects.get(number);
    if (found === undefined) throw new Error(`no object ${String(number)}`);
    return found;
  };

  // Fonts by resource name: Type0 → its BaseFont and ToUnicode map.
  const fonts = new Map<string, { face: string; unicode: Map<number, string> }>();
  for (const { dict } of objects.values()) {
    const block = /\/Font\s*<<([^>]*)>>/.exec(dict);
    if (block === null) continue;
    for (const entry of (block[1] ?? "").matchAll(/\/(F\d+) (\d+) 0 R/g)) {
      const font = get(Number(entry[2])).dict;
      const face = /\/BaseFont \/(?:[A-Z]{6}\+)?([^\s/]+)/.exec(font)?.[1] ?? "?";
      const unicodeRef = ref(font, "ToUnicode");
      const cmap = unicodeRef === null ? "" : get(unicodeRef).stream?.toString("latin1") ?? "";
      fonts.set(entry[1] ?? "", { face, unicode: toUnicode(cmap) });
    }
  }

  const catalog = [...objects.values()].find(object => object.dict.includes("/Type /Catalog"));
  if (catalog === undefined) throw new Error("no catalog");
  const kids = /\/Kids \[([^\]]*)\]/.exec(get(ref(catalog.dict, "Pages")).dict)?.[1] ?? "";
  const pages = [...kids.matchAll(/(\d+) 0 R/g)].map((kid, pageIndex) => {
    const page = get(Number(kid[1])).dict;
    const mediaBox = (/\/MediaBox \[([^\]]*)\]/.exec(page)?.[1] ?? "").trim().split(/\s+/).map(Number);
    const content = get(ref(page, "Contents")).stream?.toString("latin1") ?? "";
    const runs: TextRun[] = [];
    for (const block of content.matchAll(/BT([\s\S]*?)ET/g)) {
      const body = block[1] ?? "";
      const tm = /1 0 0 1 ([\d.-]+) ([\d.-]+) Tm/.exec(body);
      const tf = /\/(F\d+) ([\d.]+) Tf/.exec(body);
      const font = fonts.get(tf?.[1] ?? "");
      if (tm === null || tf === null || font === undefined) continue;
      // A run with positioned glyphs (marks, kerning) is several Tm / TJ pairs in one block.
      const glyphs = [...body.matchAll(/\[([^\]]*)\] TJ/g)].flatMap(array => [...(array[1] ?? "").matchAll(/<([0-9a-fA-F]+)>/g)])
        .flatMap(hex => (hex[1] ?? "").match(/.{4}/g) ?? [])
        .map(code => parseInt(code, 16));
      const glyphTexts = glyphs.map(glyph => font.unicode.get(glyph) ?? "�");
      runs.push({ page: pageIndex + 1, face: font.face, size: Number(tf[2]), x: Number(tm[1]), y: Number(tm[2]), glyphs, glyphTexts, text: glyphTexts.join("") });
    }
    return { mediaBox, runs };
  });

  const attachments = new Map<string, Buffer>();
  for (const { dict } of objects.values()) {
    if (!dict.includes("/Type /Filespec")) continue;
    const name = /\/F \(([^)]*)\)/.exec(dict)?.[1] ?? "";
    const file = get(ref(/\/EF\s*<<([^>]*)>>/.exec(dict)?.[1] ?? "", "F")).stream;
    if (file !== null) attachments.set(name, file);
  }
  const trailer = pdf.toString("latin1").slice(pdf.toString("latin1").lastIndexOf("trailer"));
  return { objects, pages, attachments, info: get(ref(trailer, "Info")).dict };
}

/** A page's text, line by line (runs sharing a baseline, left to right). */
function pageText(read: ReadPdf, page: number): string {
  const runs = read.pages[page - 1]?.runs ?? [];
  const lines = new Map<number, TextRun[]>();
  for (const run of runs) {
    const key = Math.round(run.y * 10);
    lines.set(key, [...(lines.get(key) ?? []), run]);
  }
  return [...lines.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, line]) => line.sort((a, b) => a.x - b.x).map(run => run.text).join(""))
    .join("\n");
}

/** Every page's text. */
export function documentText(read: ReadPdf): string {
  return read.pages.map((_, index) => pageText(read, index + 1)).join("\n");
}
