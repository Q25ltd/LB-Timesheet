/**
 * The company's timesheet PDF, template `timesheet-pdf/1` (D66 "PDF").
 *
 * Drawn ONLY from a stored, immutable revision (`TimesheetSubmission`) and
 * the header facts the server derived at submission — never from a request.
 * Before anything is drawn the stored snapshot is validated again, in shape
 * and in meaning, and its canonical JSON must still hash to the SHA-256 that
 * was stored with it: a revision that fails any of these is refused, not
 * drawn.
 *
 * Reproducible: the same revision always gives the same bytes. Every date in
 * the file — its metadata, its attachment — is the revision's server receipt
 * time, the times are shown in the zone the revision was filed in, and the
 * template is never changed once released (a change is a new version).
 *
 * What it says: the shift, every vehicle and trailer use with its readings in
 * the unit they were recorded in (never converted), every fuel, AdBlue / DEF
 * and fridge-diesel event, every check — completed, or a draft that was never
 * certified — with its defects and its correction history, the company-facing
 * finish notes, totals per unit, the declaration, and the reference, revision
 * and review standing. Nothing about working time the app does not record,
 * nothing of the driver's private diary, never the driver's email address.
 *
 * The exact submitted snapshot is attached to the PDF as JSON: what the page
 * draws is a rendering of it; the attachment is the record.
 */
import { createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import { localCalendarDate, isIanaTimeZone } from "../lib/timezone.js";
import {
  SNAPSHOT_SCHEMA_VERSION,
  TimesheetSnapshotV1,
  canonicalJson,
  snapshotProblems,
  type TimesheetSnapshot,
} from "../lib/timesheetSnapshot.js";
import type { TimesheetDecisionKind, TimesheetVerification } from "../generated/enums.js";
import { FONT, FONT_KEYS, fontAscent, fontBuffer, fontCollectionMember, prepareFonts } from "./fonts.js";
import { layoutText, type LaidOutText, type TextMeasure } from "./textLayout.js";

export const PDF_TEMPLATE = "timesheet-pdf/1";

/** One stored revision, as the database holds it, with what the server derived for it. */
export interface TimesheetPdfSource {
  reference: string;
  driverName: string;
  payrollRef: string | null;
  companyName: string;
  submission: {
    revision: number;
    schemaVersion: number;
    /** The stored JSON, unread: it is validated here before anything uses it. */
    payload: unknown;
    payloadSha256: string;
    declaredBy: string;
    receivedAt: Date;
    verification: TimesheetVerification;
    filedInTimezone: string;
  };
  /** The company's decision on THIS revision, when there is one — immutable once made. */
  decision: { decision: TimesheetDecisionKind; reason: string | null; decidedAt: Date } | null;
}

export interface RenderedTimesheetPdf {
  pdf: Buffer;
  /** SHA-256 of the PDF's bytes — what a delivery records (D66). */
  sha256: string;
  template: typeof PDF_TEMPLATE;
  /** The name of the attached snapshot file. */
  attachmentName: string;
  /** Whether any character had to be drawn as a `[U+XXXX]` marker. */
  missingGlyphs: boolean;
}

export const PDF_REFUSAL = {
  timezone:      "timezone",
  schemaVersion: "schema-version",
  malformed:     "malformed",
  inconsistent:  "inconsistent",
  hash:          "hash",
} as const;

export type PdfRefusal = (typeof PDF_REFUSAL)[keyof typeof PDF_REFUSAL];

/** A stored revision that cannot be drawn as it is — never drawn in part. */
export class TimesheetPdfRefused extends Error {
  constructor(readonly refusal: PdfRefusal) {
    super(`timesheet PDF refused: ${refusal}`);
    this.name = "TimesheetPdfRefused";
  }
}

// ── Page geometry (A4, points) ───────────────────────────────────────────────

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const FOOTER = 34;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
const BOTTOM = PAGE_HEIGHT - MARGIN - FOOTER;
const SIZE = { title: 15, heading: 11, body: 9, small: 7.5 } as const;
const LEADING = 1.38;
const CELL_PAD = 3;

const INK = "#111111";
const MUTED = "#555555";
const ALERT = "#9b0000";
const RULE = "#9a9a9a";

interface Cell { text: string; bold?: boolean; color?: string }
interface Column { title: string; width: number }

/** Writes the page top to bottom, breaking pages as it goes. */
class Canvas {
  y = MARGIN;
  missing = false;
  private readonly measure: TextMeasure;

  constructor(private readonly doc: PDFKit.PDFDocument) {
    this.measure = (font, text, size) => this.doc.font(font).fontSize(size).widthOfString(text, { features: [] });
  }

  layout(text: string, width: number, size: number, bold: boolean): LaidOutText {
    const laid = layoutText(text, { width, size, bold }, this.measure);
    if (laid.missing) this.missing = true;
    return laid;
  }

  lineHeight(size: number): number {
    return size * LEADING;
  }

  newPage(): void {
    this.doc.addPage({ size: [PAGE_WIDTH, PAGE_HEIGHT], margin: 0 });
    this.y = MARGIN;
  }

  /** Room for `height` more on this page, or a new page. */
  ensure(height: number): void {
    if (this.y + height > BOTTOM) this.newPage();
  }

  /** One line of laid-out text, its top at `top`, every face on one baseline. */
  drawLine(laid: LaidOutText, index: number, x: number, top: number, size: number, color: string): void {
    const line = laid.lines[index];
    if (line === undefined) return;
    const baseline = top + fontAscent(FONT.latin, size) + (this.lineHeight(size) - size * 1.07) / 2;
    for (const piece of line.pieces) {
      this.doc.font(piece.font).fontSize(size).fillColor(color)
        .text(piece.text, x + piece.x, baseline, { lineBreak: false, baseline: "alphabetic", features: [] });
    }
  }

  /** Text that may run over pages, line by line. */
  paragraph(text: string, options: { size?: number; bold?: boolean; color?: string; indent?: number } = {}): void {
    const size = options.size ?? SIZE.body;
    const indent = options.indent ?? 0;
    const laid = this.layout(text, CONTENT_WIDTH - indent, size, options.bold ?? false);
    laid.lines.forEach((_, index) => {
      this.ensure(this.lineHeight(size));
      this.drawLine(laid, index, MARGIN + indent, this.y, size, options.color ?? INK);
      this.y += this.lineHeight(size);
    });
  }

  heading(text: string): void {
    this.ensure(this.lineHeight(SIZE.heading) + 3 * this.lineHeight(SIZE.body));
    this.y += 6;
    this.paragraph(text, { size: SIZE.heading, bold: true });
    this.rule();
  }

  rule(color = RULE): void {
    this.doc.moveTo(MARGIN, this.y).lineTo(PAGE_WIDTH - MARGIN, this.y).lineWidth(0.5).strokeColor(color).stroke();
    this.y += 3;
  }

  gap(points: number): void {
    this.y += points;
  }

  /** Label → value pairs in two columns, the value free text. */
  pairs(rows: readonly [string, string][]): void {
    const labelWidth = 150;
    for (const [label, value] of rows) {
      const left = this.layout(label, labelWidth - CELL_PAD, SIZE.body, true);
      const right = this.layout(value, CONTENT_WIDTH - labelWidth, SIZE.body, false);
      const count = Math.max(left.lines.length, right.lines.length);
      for (let index = 0; index < count; index += 1) {
        this.ensure(this.lineHeight(SIZE.body));
        this.drawLine(left, index, MARGIN, this.y, SIZE.body, MUTED);
        this.drawLine(right, index, MARGIN + labelWidth, this.y, SIZE.body, INK);
        this.y += this.lineHeight(SIZE.body);
      }
    }
  }

  /** A table whose rows may run over pages; the column titles repeat on each. */
  table(columns: readonly Column[], rows: readonly Cell[][]): void {
    const titles = columns.map(column => this.layout(column.title, column.width - 2 * CELL_PAD, SIZE.small, true));
    const lead = this.lineHeight(SIZE.body);
    const header = (): void => {
      const count = Math.max(...titles.map(title => title.lines.length));
      for (let index = 0; index < count; index += 1) {
        let x = MARGIN;
        titles.forEach((title, column) => {
          this.drawLine(title, index, x + CELL_PAD, this.y, SIZE.small, MUTED);
          x += columns[column]?.width ?? 0;
        });
        this.y += this.lineHeight(SIZE.small);
      }
      this.rule();
    };
    this.ensure(this.lineHeight(SIZE.small) + lead + 4);
    header();
    for (const row of rows) {
      const cells = row.map((cell, column) => this.layout(cell.text, (columns[column]?.width ?? 0) - 2 * CELL_PAD, SIZE.body, cell.bold ?? false));
      const count = Math.max(1, ...cells.map(cell => cell.lines.length));
      for (let index = 0; index < count; index += 1) {
        if (this.y + lead > BOTTOM) { this.newPage(); header(); }
        let x = MARGIN;
        cells.forEach((cell, column) => {
          this.drawLine(cell, index, x + CELL_PAD, this.y, SIZE.body, row[column]?.color ?? INK);
          x += columns[column]?.width ?? 0;
        });
        this.y += lead;
      }
      this.doc.moveTo(MARGIN, this.y).lineTo(PAGE_WIDTH - MARGIN, this.y).lineWidth(0.25).strokeColor("#cccccc").stroke();
      this.y += 2;
    }
  }

  /** Free-standing text at a fixed place — the running footer. */
  at(text: string, x: number, top: number, width: number, size: number, color: string): void {
    const laid = this.layout(text, width, size, false);
    laid.lines.forEach((_, index) => this.drawLine(laid, index, x, top + index * this.lineHeight(size), size, color));
  }
}

// ── What the page says ───────────────────────────────────────────────────────

const VEHICLE_CLASS: Record<TimesheetSnapshot["vehicles"][number]["vehicleClass"], string> = {
  class1: "Articulated truck",
  class2: "Rigid truck",
  van:    "Van",
};
const TRAILER_TYPE: Record<TimesheetSnapshot["trailers"][number]["trailerType"], string> = {
  standard:     "Standard trailer",
  refrigerated: "Refrigerated trailer",
};
const DISTANCE = { kilometre: "km", mile: "mi" } as const;
const VOLUME = { litre: "L", us_gallon: "US gal", imperial_gallon: "imp gal" } as const;
const FILL_TYPE = { fuel: "Fuel", adblue: "AdBlue / DEF", fridge: "Fridge diesel" } as const;
const RESULT = { pass: "Pass", na: "N/A", fail: "DEFECT" } as const;
const LEGACY_MARK = "†";
const NONE = "—";

type Check = TimesheetSnapshot["vehicles"][number]["checks"][number];
type Item = Check["items"][number];
type Fill = TimesheetSnapshot["trailers"][number]["fridgeDiesel"][number];
type FillKind = keyof typeof FILL_TYPE;

interface LocalTime { date: string; time: string; offsetMinutes: number }

const formatters = new Map<string, Intl.DateTimeFormat>();

/** An instant's wall-clock date and time in a zone — built from numeric parts, never a locale's wording. */
function localTime(instant: Date, zone: string): LocalTime {
  let formatter = formatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(zone, formatter);
  }
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(formatter.formatToParts(instant).find(entry => entry.type === type)?.value ?? "0");
  const [year, month, day, hour, minute, second] = (["year", "month", "day", "hour", "minute", "second"] as const).map(part);
  const wall = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0, second ?? 0);
  const two = (value: number | undefined): string => String(value ?? 0).padStart(2, "0");
  return {
    date: `${String(year ?? 0).padStart(4, "0")}-${two(month)}-${two(day)}`,
    time: `${two(hour)}:${two(minute)}`,
    offsetMinutes: Math.round((wall - Math.floor(instant.getTime() / 1000) * 1000) / 60_000),
  };
}

function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

function quantityText(hundredths: number): string {
  return String(hundredths / 100);
}

/** A fill's quantity in the unit the form showed — never converted, never guessed. */
function fillQuantity(fill: Fill): string {
  if (fill.quantity === null) return "not recorded";
  const amount = quantityText(Math.round(fill.quantity * 100));
  if (fill.unit === null) return `${amount} (unit not recorded)`;
  return `${amount} ${VOLUME[fill.unit]}${fill.unitSource === "legacy-litres-label" ? ` ${LEGACY_MARK}` : ""}`;
}

function effectiveItems(check: Check): Item[] {
  return check.revisions[check.revisions.length - 1]?.items ?? check.items;
}

function resultText(item: Item): string {
  return RESULT[item.result];
}

/** What changed from one complete set of answers to the next, in words. */
function changes(before: readonly Item[], after: readonly Item[]): string[] {
  const keys = [...new Set([...before.map(item => item.key), ...after.map(item => item.key)])];
  const lines: string[] = [];
  for (const key of keys) {
    const was = before.find(item => item.key === key);
    const now = after.find(item => item.key === key);
    if (was?.result === now?.result && was?.note === now?.note) continue;
    const label = now?.label ?? was?.label ?? key;
    const say = (item: Item | undefined): string =>
      item === undefined ? "not answered" : `${resultText(item)}${item.note === null ? "" : ` (${item.note})`}`;
    lines.push(`${label}: ${say(was)} → ${say(now)}`);
  }
  return lines;
}

interface Totals { [unit: string]: { hundredths: number; known: number; unknown: number } }

function addFill(totals: Map<FillKind, Totals>, kind: FillKind, fill: Fill): void {
  const byUnit = totals.get(kind) ?? {};
  const unit = fill.unit === null ? "unit not recorded" : VOLUME[fill.unit];
  const entry = byUnit[unit] ?? { hundredths: 0, known: 0, unknown: 0 };
  if (fill.quantity === null) entry.unknown += 1;
  else { entry.hundredths += Math.round(fill.quantity * 100); entry.known += 1; }
  byUnit[unit] = entry;
  totals.set(kind, byUnit);
}

interface Context {
  canvas: Canvas;
  zone: string;
  day: LocalTime;
}

/** A device time as the page shows it: the time, the date too when it is not the shift's, the offset when it differs. */
function when(context: Context, instant: string): string {
  const local = localTime(new Date(instant), context.zone);
  const date = local.date === context.day.date ? "" : `${local.date} `;
  const offset = local.offsetMinutes === context.day.offsetMinutes ? "" : ` (${offsetLabel(local.offsetMinutes)})`;
  return `${date}${local.time}${offset}`;
}

function standingText(source: TimesheetPdfSource, context: Context): { text: string; alert: boolean } {
  const { decision, submission } = source;
  const received = (date: Date): string => {
    const local = localTime(date, context.zone);
    return `${local.date} ${local.time} (${offsetLabel(local.offsetMinutes)})`;
  };
  if (decision !== null) {
    if (decision.decision === "accept") return { text: `Accepted by the company after review, ${received(decision.decidedAt)}.`, alert: false };
    const reason = decision.reason ?? NONE;
    if (decision.decision === "request_correction") return { text: `CORRECTION REQUESTED by the company, ${received(decision.decidedAt)}: ${reason}`, alert: true };
    return { text: `REJECTED by the company, ${received(decision.decidedAt)}: ${reason}`, alert: true };
  }
  if (submission.verification === "membership_active") return { text: "Accepted automatically — the driver's company access was active when it was received.", alert: false };
  if (submission.verification === "start_receipt") return { text: "Accepted automatically — verified late: the driver's start was received while their company access was active, before it was withdrawn.", alert: false };
  return { text: "PENDING COMPANY REVIEW — the start could not be verified. Not accepted.", alert: true };
}

function drawChecks(context: Context, where: string, checks: readonly Check[]): void {
  const { canvas } = context;
  if (checks.length === 0) {
    canvas.paragraph(`${where}: no check recorded.`, { color: MUTED });
    canvas.gap(4);
    return;
  }
  checks.forEach((check, index) => {
    canvas.ensure(4 * canvas.lineHeight(SIZE.body));
    canvas.paragraph(`${where} — check ${String(index + 1)} of ${String(checks.length)} · checklist ${check.checklist}, version ${String(check.checklistVersion)}`, { bold: true });
    if (check.status === "completed") {
      const corrected = check.revisions.length === 0 ? ""
        : ` Corrected ${String(check.revisions.length)} time${check.revisions.length === 1 ? "" : "s"} after certification; the answers below are the latest correction.`;
      canvas.paragraph(`Completed and certified by the driver at ${when(context, check.completedAt ?? check.startedAt)}.${corrected}`);
    } else {
      canvas.paragraph(`DRAFT — NOT CERTIFIED. Started at ${when(context, check.startedAt)}; the driver did not complete this check. The answers below are as far as it went.`, { bold: true, color: ALERT });
    }
    const items = effectiveItems(check);
    if (items.length === 0) {
      canvas.paragraph("No items answered.", { color: MUTED });
    } else {
      const rows: Cell[][] = [];
      let section: string | null = null;
      for (const item of items) {
        const title = item.section?.title ?? null;
        if (title !== null && title !== section) rows.push([{ text: title, bold: true }, { text: "" }, { text: "" }]);
        section = title;
        const defect = item.result === "fail";
        rows.push([
          { text: item.label },
          { text: resultText(item), bold: defect, color: defect ? ALERT : INK },
          { text: item.note ?? "" },
        ]);
      }
      canvas.table([{ title: "Item", width: 230 }, { title: "Result", width: 60 }, { title: "Defect description", width: CONTENT_WIDTH - 290 }], rows);
    }
    if (check.revisions.length > 0) {
      canvas.paragraph("Correction history", { bold: true, size: SIZE.small });
      let before = check.items;
      check.revisions.forEach((revision, number) => {
        const changed = changes(before, revision.items);
        canvas.paragraph(`Correction ${String(number + 1)}, at ${when(context, revision.revisedAt)}${changed.length === 0 ? ": no answer changed." : ":"}`, { size: SIZE.small });
        for (const line of changed) canvas.paragraph(line, { size: SIZE.small, indent: 12 });
        before = revision.items;
      });
    }
    canvas.gap(6);
  });
}

function fillRows(context: Context, fills: readonly (Fill & { kind: FillKind })[]): Cell[][] {
  return fills.map(fill => [
    { text: when(context, fill.recordedAt) },
    { text: FILL_TYPE[fill.kind] },
    { text: fillQuantity(fill) },
    { text: fill.note ?? "" },
  ]);
}

const FILL_COLUMNS: Column[] = [
  { title: "Time", width: 70 }, { title: "Type", width: 90 }, { title: "Quantity", width: 110 }, { title: "Note", width: CONTENT_WIDTH - 270 },
];

function draw(canvas: Canvas, source: TimesheetPdfSource, snapshot: TimesheetSnapshot, attachmentName: string): void {
  const zone = source.submission.filedInTimezone;
  const startedAt = new Date(snapshot.day.startedAt);
  const endedAt = new Date(snapshot.day.endedAt);
  const context: Context = { canvas, zone, day: localTime(startedAt, zone) };
  const shiftDate = localCalendarDate(startedAt, zone).toISOString().slice(0, 10);

  // Title and standing.
  canvas.paragraph("Daily timesheet", { size: SIZE.title, bold: true });
  canvas.paragraph(`${source.reference} · revision ${String(source.submission.revision)}`, { size: SIZE.heading, bold: true });
  canvas.gap(2);
  const standing = standingText(source, context);
  canvas.paragraph(standing.text, { bold: true, color: standing.alert ? ALERT : INK });
  canvas.gap(4);

  const minutes = Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000);
  const received = localTime(source.submission.receivedAt, zone);
  canvas.pairs([
    ["Company", source.companyName],
    ["Driver", source.driverName],
    ["Payroll reference", source.payrollRef ?? NONE],
    ["Shift date", shiftDate],
    ["Start", when(context, snapshot.day.startedAt)],
    ["Finish", when(context, snapshot.day.endedAt)],
    ["Start to finish", `${String(Math.floor(minutes / 60))} h ${String(minutes % 60).padStart(2, "0")} min`],
    ["Night out", snapshot.day.nightOut ? "Yes" : "No"],
    ["Times", `As recorded on the driver's phone, shown in ${zone} (${offsetLabel(context.day.offsetMinutes)}).`],
    ["Received", `${received.date} ${received.time} (${offsetLabel(received.offsetMinutes)}), by LogisticBay's server.`],
  ]);

  // Defects first: what the office must see.
  const defects: Cell[][] = [];
  const assetName = (kind: "vehicle" | "trailer", index: number): string => {
    if (kind === "vehicle") {
      const use = snapshot.vehicles[index];
      return use === undefined ? "" : `${VEHICLE_CLASS[use.vehicleClass]} ${use.registration}`;
    }
    const use = snapshot.trailers[index];
    return use === undefined ? "" : `${TRAILER_TYPE[use.trailerType]} ${use.trailerNumber}`;
  };
  const collect = (kind: "vehicle" | "trailer", index: number, checks: readonly Check[]): void => {
    for (const check of checks) {
      for (const item of effectiveItems(check).filter(entry => entry.result === "fail")) {
        defects.push([
          { text: assetName(kind, index) },
          { text: item.label },
          { text: item.note ?? NONE },
          { text: check.status === "completed" ? "Certified" : "DRAFT — not certified", color: check.status === "completed" ? INK : ALERT },
        ]);
      }
    }
  };
  snapshot.vehicles.forEach((use, index) => collect("vehicle", index, use.checks));
  snapshot.trailers.forEach((use, index) => collect("trailer", index, use.checks));
  canvas.heading(`Defects reported: ${String(defects.length)}`);
  if (defects.length === 0) canvas.paragraph("No defect was reported on any check of this day.");
  else canvas.table([{ title: "Asset", width: 130 }, { title: "Item", width: 130 }, { title: "Description", width: CONTENT_WIDTH - 350 }, { title: "Check", width: 90 }], defects);

  // Vehicles.
  canvas.heading("Vehicles");
  const distances = new Map<string, number>();
  if (snapshot.vehicles.length === 0) canvas.paragraph("No vehicle was used.", { color: MUTED });
  else {
    canvas.table(
      [{ title: "Vehicle", width: 150 }, { title: "From", width: 55 }, { title: "To", width: 55 }, { title: "Odometer start", width: 75 }, { title: "Odometer end", width: 75 }, { title: "Distance", width: CONTENT_WIDTH - 410 }],
      snapshot.vehicles.map(use => {
        const unit = use.odometerUnit === null ? null : DISTANCE[use.odometerUnit];
        const distance = use.odometerEnd - use.odometerStart;
        const key = unit ?? "unit not recorded";
        distances.set(key, (distances.get(key) ?? 0) + distance);
        const reading = (value: number): string => (unit === null ? String(value) : `${String(value)} ${unit}`);
        return [
          { text: `${VEHICLE_CLASS[use.vehicleClass]} ${use.registration}` },
          { text: when(context, use.startedAt) },
          { text: `${when(context, use.endedAt)}${use.endedBy === "finish" ? " (finish)" : ""}` },
          { text: reading(use.odometerStart) },
          { text: reading(use.odometerEnd) },
          { text: unit === null ? `${String(distance)} (unit not recorded)` : `${String(distance)} ${unit}` },
        ];
      }),
    );
  }

  // Trailers.
  canvas.heading("Trailers");
  if (snapshot.trailers.length === 0) canvas.paragraph("No trailer was used.", { color: MUTED });
  else {
    canvas.table(
      [{ title: "Trailer", width: 250 }, { title: "From", width: 80 }, { title: "To", width: CONTENT_WIDTH - 330 }],
      snapshot.trailers.map(use => [
        { text: `${TRAILER_TYPE[use.trailerType]} ${use.trailerNumber}` },
        { text: when(context, use.startedAt) },
        { text: `${when(context, use.endedAt)}${use.endedBy === "finish" ? " (finish)" : ""}` },
      ]),
    );
  }

  // Fuel, AdBlue / DEF, fridge diesel.
  canvas.heading("Fuel, AdBlue / DEF and fridge diesel");
  const totals = new Map<FillKind, Totals>();
  let legacy = false;
  let anyFill = false;
  snapshot.vehicles.forEach((use, index) => {
    if (use.fills.length === 0) return;
    anyFill = true;
    canvas.paragraph(assetName("vehicle", index), { bold: true });
    for (const fill of use.fills) { addFill(totals, fill.type, fill); legacy ||= fill.unitSource === "legacy-litres-label"; }
    canvas.table(FILL_COLUMNS, fillRows(context, use.fills.map(fill => ({ ...fill, kind: fill.type }))));
  });
  snapshot.trailers.forEach((use, index) => {
    if (use.fridgeDiesel.length === 0) return;
    anyFill = true;
    canvas.paragraph(assetName("trailer", index), { bold: true });
    for (const fill of use.fridgeDiesel) { addFill(totals, "fridge", fill); legacy ||= fill.unitSource === "legacy-litres-label"; }
    canvas.table(FILL_COLUMNS, fillRows(context, use.fridgeDiesel.map(fill => ({ ...fill, kind: "fridge" as const }))));
  });
  if (!anyFill) canvas.paragraph("None recorded.", { color: MUTED });
  if (legacy) canvas.paragraph(`${LEGACY_MARK} Recorded before units existed, on a form labelled LITRES.`, { size: SIZE.small, color: MUTED });

  // Checks.
  canvas.heading("Checks");
  snapshot.vehicles.forEach((use, index) => drawChecks(context, assetName("vehicle", index), use.checks));
  snapshot.trailers.forEach((use, index) => drawChecks(context, assetName("trailer", index), use.checks));
  if (snapshot.vehicles.length === 0 && snapshot.trailers.length === 0) canvas.paragraph("No vehicle or trailer, so no check.", { color: MUTED });

  // Totals — per unit, never converted.
  canvas.heading("Totals");
  const totalRows: [string, string][] = [];
  for (const [unit, distance] of distances) totalRows.push([`Distance (${unit})`, String(distance)]);
  for (const kind of ["fuel", "adblue", "fridge"] as const) {
    for (const [unit, entry] of Object.entries(totals.get(kind) ?? {})) {
      const unknown = entry.unknown === 0 ? "" : `${entry.known > 0 ? "; " : ""}${String(entry.unknown)} with the quantity not recorded`;
      totalRows.push([`${FILL_TYPE[kind]} (${unit})`, `${entry.known > 0 ? quantityText(entry.hundredths) : ""}${unknown}`]);
    }
  }
  if (totalRows.length === 0) canvas.paragraph("Nothing to total.", { color: MUTED });
  else canvas.pairs(totalRows);

  // Notes and declaration.
  canvas.heading("Finish notes — seen by the company");
  canvas.paragraph(snapshot.day.notes ?? "None.", { color: snapshot.day.notes === null ? MUTED : INK });

  canvas.heading("Declaration");
  canvas.paragraph(`“I confirm all details are correct.” — confirmed by ${source.driverName} on the phone at ${when(context, snapshot.declaration.declaredAt)} (declaration ${snapshot.declaration.version}).`);
  canvas.gap(8);
  canvas.paragraph(`The exact submitted record is attached to this PDF as ${attachmentName}. SHA-256 of that record: ${source.submission.payloadSha256}.`, { size: SIZE.small, color: MUTED });
  if (canvas.missing) {
    canvas.paragraph(`Some characters could not be drawn and are shown as [U+XXXX] codes. Nothing was removed: the exact text is in ${attachmentName}.`, { size: SIZE.small, bold: true, color: ALERT });
  }
}

/** Parse, re-validate and hash-check a stored revision — or refuse it. */
function storedSnapshot(source: TimesheetPdfSource): { snapshot: TimesheetSnapshot; canonical: string } {
  const { submission } = source;
  if (!isIanaTimeZone(submission.filedInTimezone)) throw new TimesheetPdfRefused(PDF_REFUSAL.timezone);
  if (submission.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) throw new TimesheetPdfRefused(PDF_REFUSAL.schemaVersion);
  const parsed = TimesheetSnapshotV1.safeParse(submission.payload);
  if (!parsed.success) throw new TimesheetPdfRefused(PDF_REFUSAL.malformed);
  if (snapshotProblems(parsed.data, submission.declaredBy).length > 0) throw new TimesheetPdfRefused(PDF_REFUSAL.inconsistent);
  const canonical = canonicalJson(parsed.data);
  if (createHash("sha256").update(canonical).digest("hex") !== submission.payloadSha256) throw new TimesheetPdfRefused(PDF_REFUSAL.hash);
  return { snapshot: parsed.data, canonical };
}

/** Render one stored revision. The same revision always gives the same bytes. */
export function renderTimesheetPdf(source: TimesheetPdfSource): Promise<RenderedTimesheetPdf> {
  const { snapshot, canonical } = storedSnapshot(source);
  prepareFonts();
  const { receivedAt, revision } = source.submission;
  const attachmentName = `${source.reference}-revision-${String(revision)}.json`;

  const doc = new PDFDocument({
    autoFirstPage: false,
    bufferPages: true,
    compress: true,
    pdfVersion: "1.7",
    lang: "und",
    displayTitle: true,
    info: {
      Title: `Timesheet ${source.reference}, revision ${String(revision)}`,
      Creator: `LogisticBay Timesheets (${PDF_TEMPLATE})`,
      Producer: "LogisticBay Timesheets",
      CreationDate: receivedAt,
      ModDate: receivedAt,
    },
  });
  for (const key of FONT_KEYS) doc.registerFont(key, fontBuffer(key), fontCollectionMember(key));

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const canvas = new Canvas(doc);
  canvas.newPage();
  draw(canvas, source, snapshot, attachmentName);

  const range = doc.bufferedPageRange();
  for (let page = range.start; page < range.start + range.count; page += 1) {
    doc.switchToPage(page);
    const top = PAGE_HEIGHT - MARGIN - FOOTER + 10;
    doc.moveTo(MARGIN, top - 4).lineTo(PAGE_WIDTH - MARGIN, top - 4).lineWidth(0.5).strokeColor(RULE).stroke();
    canvas.at(`${source.reference} · revision ${String(revision)} · page ${String(page + 1)} of ${String(range.count)} · ${PDF_TEMPLATE}`, MARGIN, top, CONTENT_WIDTH, SIZE.small, MUTED);
  }

  doc.file(Buffer.from(canonical, "utf8"), {
    name: attachmentName,
    type: "application/json",
    description: `The submitted record of ${source.reference}, revision ${String(revision)}`,
    creationDate: receivedAt,
    modifiedDate: receivedAt,
  });
  doc.end();

  const missingGlyphs = canvas.missing;
  return done.then(pdf => ({
    pdf,
    sha256: createHash("sha256").update(pdf).digest("hex"),
    template: PDF_TEMPLATE,
    attachmentName,
    missingGlyphs,
  }));
}
