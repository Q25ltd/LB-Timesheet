/**
 * The part of fontkit (a dependency of pdfkit, declared in package.json) the
 * PDF renderer uses: open a face, ask whether it has a glyph, read its
 * vertical metrics. fontkit ships no types; this declares only what is read.
 */
declare module "fontkit" {
  export interface Font {
    readonly postscriptName: string;
    readonly unitsPerEm: number;
    readonly ascent: number;
    readonly descent: number;
    hasGlyphForCodePoint(codePoint: number): boolean;
  }
  export interface FontCollection {
    readonly fonts: Font[];
  }
  export function create(buffer: Buffer, postscriptName?: string): Font | FontCollection;
}
