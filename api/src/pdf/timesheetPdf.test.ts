/**
 * D66 S5 — the company's timesheet PDF, template `timesheet-pdf/1`.
 *
 * Drawn only from a stored revision that still validates and still hashes to
 * what was stored; reproducible to the byte; the exact record attached; every
 * reading in the unit it was recorded in; checks, drafts, defects and their
 * history told apart; international text shaped, ordered and never lost.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { checklistKeys } from "../lib/checklistKeys.js";
import { canonicalJson, snapshotSha256, TimesheetSnapshotV1 } from "../lib/timesheetSnapshot.js";
import { documentText, readPdf, type ReadPdf } from "../tests/pdfReader.js";
import { PDF_REFUSAL, PDF_TEMPLATE, renderTimesheetPdf, TimesheetPdfRefused, type TimesheetPdfSource } from "./timesheetPdf.js";

const USER = "user_driver_1";
const START = "2026-10-11T04:00:00.000Z";
const END = "2026-10-11T14:00:00.000Z";
const SECTION = { id: "cab", title: "CAB / DRIVER VIEW" };

type Json = Record<string, unknown>;

const HGV_KEYS = checklistKeys("hgv-unit", 1) ?? [];
const LABELS: Record<string, string> = { "front-view": "Front view", wipers: "Windscreen wipers" };

/** Every row of hgv-unit v1 — a whole certificate — passed unless `over` says otherwise. */
function hgvRows(over: Record<string, Json> = {}): Json[] {
  return HGV_KEYS.map(key => ({ key, label: LABELS[key] ?? key, section: SECTION, result: "pass", note: null, ...over[key] }));
}

/** Certified with one defect, then corrected once: the front view was a defect too. */
function certifiedCheck(): { items: Json[] } & Json {
  return {
    id: "c1", checklist: "hgv-unit", checklistVersion: 1, status: "completed",
    startedAt: START, completedAt: "2026-10-11T04:10:00.000Z", completedBy: USER,
    items: hgvRows({ wipers: { result: "fail", note: "Nearside blade split" } }),
    revisions: [{
      id: "r1", revisedAt: "2026-10-11T05:00:00.000Z", revisedBy: USER,
      items: hgvRows({ "front-view": { result: "fail", note: "Crack in screen" }, wipers: { result: "fail", note: "Nearside blade split" } }),
    }],
  };
}

/** The day's unit: fuel, AdBlue on the old LITRES label, a certified check corrected once. */
function unitUse(over: Json = {}): Json {
  return {
    useId: "a1111111-2222-4333-8444-555555555555", startedAt: START, endedAt: END, endedBy: "finish",
    vehicleClass: "class1", registration: "LY12 ABC", odometerStart: 120_000, odometerEnd: 120_350, odometerUnit: "kilometre",
    fills: [
      { id: "f1", type: "fuel", recordedAt: "2026-10-11T09:00:00.000Z", quantity: 310.5, unit: "litre", unitSource: "recorded", note: null },
      { id: "f2", type: "adblue", recordedAt: "2026-10-11T09:05:00.000Z", quantity: 20.25, unit: "litre", unitSource: "legacy-litres-label", note: null },
    ],
    checks: [certifiedCheck()],
    ...over,
  };
}

/** A fridge trailer: diesel of unknown quantity, a walkaround started and never certified. */
function fridgeTrailer(over: Json = {}): Json {
  return {
    useId: "b1111111-2222-4333-8444-555555555555", startedAt: "2026-10-11T05:00:00.000Z", endedAt: END, endedBy: "finish",
    trailerType: "refrigerated", trailerNumber: "TR-23",
    fridgeDiesel: [{ id: "d1", recordedAt: "2026-10-11T11:00:00.000Z", quantity: null, unit: "litre", unitSource: "recorded", note: "Gauge broken" }],
    checks: [{ id: "c2", checklist: "trailer-refrigerated", checklistVersion: 1, status: "draft", startedAt: "2026-10-11T05:05:00.000Z", completedAt: null, completedBy: null, items: [], revisions: [] }],
    ...over,
  };
}

/** A whole, true day — the S4 test's day, with a corrected check and a draft one. */
function snapshot(over: Json = {}): Json {
  return {
    schemaVersion: 1,
    day: { startedAt: START, endedAt: END, nightOut: true, notes: "Waited two hours at the depot" },
    vehicles: [unitUse()],
    trailers: [fridgeTrailer()],
    declaration: { version: "v-abc123", declaredAt: END },
    ...over,
  };
}

function day(notes: string | null): Json {
  return { startedAt: START, endedAt: END, nightOut: false, notes };
}

/** The payload as a JSON column gives it back. */
function stored(snap: Json): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(snap));
  return copy;
}

/** A stored revision as the database would hand it over: the payload as JSON, hashed when it was stored. */
function source(snap: Json = snapshot(), over: Partial<TimesheetPdfSource> = {}, submission: Partial<TimesheetPdfSource["submission"]> = {}): TimesheetPdfSource {
  const parsed = TimesheetSnapshotV1.parse(snap);
  return {
    reference: "TS-7K3M9QX2",
    driverName: "Marta Kowalska",
    payrollRef: "PAY-77",
    companyName: "Northgate Haulage",
    decision: null,
    ...over,
    submission: {
      revision: 1,
      schemaVersion: 1,
      payload: stored(snap),
      payloadSha256: snapshotSha256(parsed),
      declaredBy: USER,
      receivedAt: new Date("2026-10-11T14:05:00.000Z"),
      verification: "membership_active",
      filedInTimezone: "Europe/London",
      ...submission,
    },
  };
}

async function rendered(input: TimesheetPdfSource): Promise<{ read: ReadPdf; text: string; pdf: Buffer; missing: boolean }> {
  const result = await renderTimesheetPdf(input);
  const read = readPdf(result.pdf);
  return { read, text: documentText(read), pdf: result.pdf, missing: result.missingGlyphs };
}

// ── The file ─────────────────────────────────────────────────────────────────

test("TP1. a well-formed PDF 1.7: every cross-reference offset right, A4 on every page, numbered pages, the template named", async () => {
  const result = await renderTimesheetPdf(source());
  const read = readPdf(result.pdf); // throws on a bad xref / trailer / EOF
  assert.ok(read.pages.length >= 1);
  for (const page of read.pages) assert.deepEqual(page.mediaBox, [0, 0, 595.28, 841.89]);
  const text = documentText(read);
  assert.ok(text.includes(`page 1 of ${String(read.pages.length)} · ${PDF_TEMPLATE}`));
  assert.equal(result.template, "timesheet-pdf/1");
  assert.equal(result.sha256, createHash("sha256").update(result.pdf).digest("hex"));
});

test("TP2. REPRODUCIBLE: the same stored revision gives the same bytes, every time; another revision does not", async () => {
  const first = await renderTimesheetPdf(source());
  const second = await renderTimesheetPdf(source());
  assert.equal(first.sha256, second.sha256);
  assert.ok(first.pdf.equals(second.pdf));
  const other = await renderTimesheetPdf(source(snapshot({ day: day("Different") })));
  assert.notEqual(other.sha256, first.sha256);
  // Its dates are the revision's receipt time — never the time of drawing.
  const raw = first.pdf.toString("latin1");
  assert.ok(raw.includes("(D:20261011140500Z)"));
  assert.equal(raw.match(/\(D:\d{14}Z\)/g)?.every(date => date === "(D:20261011140500Z)"), true);
});

test("TP3. the EXACT submitted record is attached: its bytes are the canonical JSON whose SHA-256 was stored, and the page says so", async () => {
  const input = source();
  const { read, text } = await rendered(input);
  const attached = read.attachments.get("TS-7K3M9QX2-revision-1.json");
  assert.ok(attached !== undefined, "no attachment");
  assert.equal(createHash("sha256").update(attached).digest("hex"), input.submission.payloadSha256);
  assert.deepEqual(JSON.parse(attached.toString("utf8")), snapshot());
  assert.equal(attached.toString("utf8"), canonicalJson(TimesheetSnapshotV1.parse(snapshot())));
  assert.ok(text.includes(input.submission.payloadSha256));
});

// ── What it says ─────────────────────────────────────────────────────────────

test("TP4. the day: reference, revision, company, driver, payroll reference, date, times in the FILED zone, length, night out, notes, declaration", async () => {
  const { text } = await rendered(source(snapshot(), {}, { filedInTimezone: "Asia/Tokyo" }));
  for (const expected of [
    "Daily timesheet", "TS-7K3M9QX2 · revision 1", "Northgate Haulage", "Marta Kowalska", "PAY-77",
    "2026-10-11", "13:00", "23:00", "10 h 00 min", "Asia/Tokyo (UTC+09:00)",
    "Waited two hours at the depot", "Finish notes — seen by the company",
    "“I confirm all details are correct.” — confirmed by Marta Kowalska",
  ]) assert.ok(text.includes(expected), `missing ${expected}`);
  assert.ok(/Night out\s*Yes/.test(text));
});

test("TP5. vehicles, trailers and readings in the unit they were RECORDED in — distance per use and totals per unit", async () => {
  const { text } = await rendered(source());
  for (const expected of ["Articulated truck LY12 ABC", "120000 km", "120350 km", "350 km", "Refrigerated trailer TR-23", "Distance (km)"]) {
    assert.ok(text.includes(expected), `missing ${expected}`);
  }
});

test("TP6. NEVER CONVERTED, NEVER GUESSED: an unknown unit stays unknown; miles and gallons stay themselves; units are never added together", async () => {
  const snap = snapshot({
    vehicles: [
      unitUse({ endedAt: "2026-10-11T12:00:00.000Z", endedBy: null, odometerUnit: null, checks: [],
        fills: [{ id: "f1", type: "fuel", recordedAt: "2026-10-11T05:00:00.000Z", quantity: 100, unit: "us_gallon", unitSource: "recorded", note: null }] }),
      unitUse({ useId: "a2", startedAt: "2026-10-11T12:00:00.000Z", registration: "MILE 1", odometerStart: 5000, odometerEnd: 5040, odometerUnit: "mile", checks: [],
        fills: [{ id: "f2", type: "fuel", recordedAt: "2026-10-11T12:30:00.000Z", quantity: 50.5, unit: "litre", unitSource: "recorded", note: null },
                { id: "f3", type: "fuel", recordedAt: "2026-10-11T12:40:00.000Z", quantity: 10, unit: "imperial_gallon", unitSource: "recorded", note: null }] }),
    ],
  });
  const { text } = await rendered(source(snap));
  for (const expected of [
    "350 (unit not recorded)", "Distance (unit not recorded)", "40 mi", "Distance (mi)",
    "100 US gal", "50.5 L", "10 imp gal", "Fuel (US gal)", "Fuel (L)", "Fuel (imp gal)",
  ]) assert.ok(text.includes(expected), `missing ${expected}`);
  assert.ok(!text.includes("120000 km"), "an unknown unit was labelled");
});

test("TP7. fuel, AdBlue / DEF and fridge diesel: each event, its quantity or 'not recorded', the LITRES provenance, totals", async () => {
  const { text } = await rendered(source());
  for (const expected of [
    "Fuel", "310.5 L", "AdBlue / DEF", "20.25 L †", "Recorded before units existed, on a form labelled LITRES",
    "Fridge diesel", "not recorded", "Gauge broken", "1 with the quantity not recorded",
  ]) assert.ok(text.includes(expected), `missing ${expected}`);
});

test("TP8. checks told apart: a certified check, its CORRECTED result and its history; a DRAFT that was never certified; defects first", async () => {
  const { text } = await rendered(source());
  for (const expected of [
    "Defects reported: 2", "Crack in screen", "Nearside blade split", "DEFECT",
    "Completed and certified by the driver at 05:10", "Corrected 1 time after certification",
    "Correction history", "Front view: Pass → DEFECT (Crack in screen)",
    "DRAFT — NOT CERTIFIED", "the driver did not complete this check",
  ]) assert.ok(text.includes(expected), `missing ${expected}`);
  // The corrected answer is the result; the original survives only as history.
  assert.ok(text.indexOf("Defects reported") < text.indexOf("Vehicles"));
});

test("TP9. a use with no check says so — nothing implies a check was done", async () => {
  const { text } = await rendered(source(snapshot({ trailers: [fridgeTrailer({ checks: [] })] })));
  assert.ok(text.includes("Refrigerated trailer TR-23: no check recorded."));
});

test("TP10. the standing it states: automatic, verified late, pending review, correction requested and rejected — with the reason", async () => {
  const cases: [Partial<TimesheetPdfSource>, Partial<TimesheetPdfSource["submission"]>, string][] = [
    [{}, {}, "Accepted automatically — the driver's company access was active"],
    [{}, { verification: "start_receipt" }, "verified late"],
    [{}, { verification: "unverified" }, "PENDING COMPANY REVIEW"],
    [{ decision: { decision: "accept", reason: null, decidedAt: new Date("2026-10-12T08:00:00Z") } }, { verification: "unverified" }, "Accepted by the company after review"],
    [{ decision: { decision: "request_correction", reason: "Wrong trailer", decidedAt: new Date("2026-10-12T08:00:00Z") } }, { verification: "unverified" }, "CORRECTION REQUESTED by the company, 2026-10-12 09:00 (UTC+01:00): Wrong trailer"],
    [{ decision: { decision: "reject", reason: "Not our driver that day", decidedAt: new Date("2026-10-12T08:00:00Z") } }, { verification: "unverified" }, "REJECTED by the company"],
  ];
  for (const [over, submission, expected] of cases) {
    const { text } = await rendered(source(snapshot(), over, submission));
    assert.ok(text.includes(expected), `missing ${expected}`);
  }
});

test("TP11. nothing that is not on the record: no email address, nothing of a private diary — the source has no field for either", async () => {
  const { text, read } = await rendered(source());
  assert.ok(!text.includes("@"));
  assert.ok(!read.info.includes("@"));
});

// ── International text ───────────────────────────────────────────────────────

const WORLD = "שלום עולם (נמל) — مرحبا بالعالم ١٢٣ — नमस्ते क्षत्रिय — ਸਤ ਸ੍ਰੀ ਅਕਾਲ — 東京の倉庫 — 서울 — Ελληνικά — Привет — Žluťoučký";

test("TP12. ten scripts drawn in their own faces, embedded and SHAPED: Devanagari and Gurmukhi conjuncts form, Arabic is laid out as a whole run", async () => {
  const { read, missing } = await rendered(source(snapshot({ day: day(WORLD) })));
  assert.equal(missing, false);
  const runs = read.pages.flatMap(page => page.runs);
  const faces = new Set(runs.map(run => run.face));
  for (const face of ["NotoSans-Regular", "NotoSans-Bold", "NotoSansHebrew-Regular", "NotoSansArabic-Regular", "NotoSansDevanagari-Regular", "NotoSansGurmukhi-Regular", "NotoSansCJKjp-Regular", "NotoSansCJKkr-Regular"]) {
    assert.ok(faces.has(face), `no ${face}`);
  }
  // No glyph is the missing-glyph box.
  assert.ok(runs.every(run => !run.glyphs.includes(0)));
  // Conjuncts: fewer glyphs than characters.
  const devanagari = runs.find(run => run.face === "NotoSansDevanagari-Regular" && run.text.includes("क्ष"));
  assert.ok(devanagari !== undefined && devanagari.glyphs.length < [...devanagari.text].length);
  const gurmukhi = runs.find(run => run.face === "NotoSansGurmukhi-Regular" && run.text.includes("ਸ"));
  assert.ok(gurmukhi !== undefined);
  // Arabic: whole words per run, drawn right to left — each run's glyphs read backwards are stored text.
  const arabic = runs.filter(run => run.face === "NotoSansArabic-Regular" && /\p{Script=Arabic}{2}/u.test(run.text));
  assert.ok(arabic.some(run => [...run.glyphTexts].reverse().join("").trim() === "بالعالم" || [...run.glyphTexts].reverse().join("").includes("مرحبا")));
  for (const run of arabic) assert.ok(WORLD.includes([...run.glyphTexts].reverse().join("").trim()), `"${run.text}" is not in visual order`);
});

test("TP13. bidirectional order on the page: Arabic-Indic digits keep their order to the left of the Arabic words; Hebrew brackets are mirrored", async () => {
  const { read } = await rendered(source(snapshot({ day: day("مرحبا ١٢٣") })));
  const runs = read.pages.flatMap(page => page.runs).filter(run => run.face === "NotoSansArabic-Regular");
  const digits = runs.filter(run => /^[٠-٩]$/u.test(run.text)).sort((a, b) => a.x - b.x).map(run => run.text);
  assert.deepEqual(digits, ["١", "٢", "٣"]);
  const words = runs.find(run => run.glyphs.length >= 4);
  assert.ok(words !== undefined && runs.filter(run => /[٠-٩]/u.test(run.text)).every(run => run.x < words.x));

  // "(נמל)" in a right-to-left paragraph: "(" drawn on the left, ")" on the right — each mirrored.
  const hebrew = await rendered(source(snapshot({ day: day("(נמל)") })));
  const word = hebrew.read.pages.flatMap(page => page.runs).find(run => run.face === "NotoSansHebrew-Regular");
  assert.ok(word !== undefined);
  const sameLine = hebrew.read.pages.flatMap(page => page.runs).filter(run => run.page === word.page && run.y === word.y).sort((a, b) => a.x - b.x);
  assert.deepEqual(sameLine.map(run => run.text), ["(", word.text, ")"]);
});

test("TP14. a character no face can draw is NEVER silently dropped: a visible [U+XXXX] marker, a notice, and the flag", async () => {
  const { text, missing } = await rendered(source(snapshot({ day: day("Truck 🚚 at สวัสดี gate\u0007") })));
  assert.equal(missing, true);
  for (const expected of ["[U+1F69A]", "[U+0E2A]", "[U+0007]", "Some characters could not be drawn", "Nothing was removed"]) {
    assert.ok(text.includes(expected), `missing ${expected}`);
  }
  const plain = await rendered(source());
  assert.equal(plain.missing, false);
  assert.ok(!plain.text.includes("Some characters could not be drawn"));
});

// ── Long content ─────────────────────────────────────────────────────────────

test("TP15. LONG content runs over pages and stays inside them: fifty uses, the longest fields, unbroken text", async () => {
  const minutes = (n: number) => new Date(Date.parse(START) + n * 60_000).toISOString();
  const vehicles = Array.from({ length: 50 }, (_, index) => unitUse({
    useId: `use-${String(index)}`,
    startedAt: minutes(index * 12), endedAt: minutes(index * 12 + 10), endedBy: null,
    registration: `W${String(index).padStart(2, "0")}WWWWWWWWWWWWW`,
    fills: [], checks: [{
      id: `check-${String(index)}`, checklist: "hgv-unit", checklistVersion: 1, status: "completed",
      startedAt: minutes(index * 12), completedAt: minutes(index * 12 + 1), completedBy: USER,
      items: hgvRows({ wipers: { label: "L".repeat(200), result: "fail", note: "N".repeat(500) } }),
      revisions: [],
    }],
  }));
  const snap = snapshot({ day: { ...day("Ж".repeat(500)), endedAt: minutes(50 * 12) }, vehicles, trailers: [], declaration: { version: "v", declaredAt: minutes(50 * 12) } });
  const { read, text } = await rendered(source(snap));
  assert.ok(read.pages.length > 5, `only ${String(read.pages.length)} pages`);
  for (const page of read.pages) {
    for (const run of page.runs) {
      assert.ok(run.x >= 40 - 0.01 && run.x < 595.28 - 40, `x ${String(run.x)} outside the margins`);
      assert.ok(run.y > 0 && run.y < 841.89 - 40 + 0.01, `y ${String(run.y)} outside the page`);
    }
  }
  for (let index = 0; index < 50; index += 1) assert.ok(text.includes(`W${String(index).padStart(2, "0")}WWWWWWWWWWWWW`), `vehicle ${String(index)} missing`);
  assert.equal(text.replace(/[^Ж]/g, "").length, 500, "the unbroken note lost characters");
  assert.ok(text.includes(`page ${String(read.pages.length)} of ${String(read.pages.length)}`));
});

// ── Refusals ─────────────────────────────────────────────────────────────────

async function refusal(input: TimesheetPdfSource): Promise<string> {
  try {
    await renderTimesheetPdf(input);
  } catch (error) {
    if (error instanceof TimesheetPdfRefused) return error.refusal;
    throw error;
  }
  return "drawn";
}

test("TP16. a stored revision that does not validate, or no longer hashes to what was stored, is REFUSED — never drawn, never drawn in part", async () => {
  const good = source();
  assert.equal(await refusal({ ...good, submission: { ...good.submission, payload: { ...snapshot(), extra: 1 } } }), PDF_REFUSAL.malformed);
  assert.equal(await refusal({ ...good, submission: { ...good.submission, payload: "not a snapshot" } }), PDF_REFUSAL.malformed);
  assert.equal(await refusal({ ...good, submission: { ...good.submission, payload: null } }), PDF_REFUSAL.malformed);
  assert.equal(await refusal({ ...good, submission: { ...good.submission, payload: snapshot({ day: day("Altered after storing") }) } }), PDF_REFUSAL.hash);
  assert.equal(await refusal({ ...good, submission: { ...good.submission, payloadSha256: "0".repeat(64) } }), PDF_REFUSAL.hash);
  assert.equal(await refusal({ ...good, submission: { ...good.submission, declaredBy: "someone_else" } }), PDF_REFUSAL.inconsistent);
  assert.equal(await refusal({ ...good, submission: { ...good.submission, schemaVersion: 2 } }), PDF_REFUSAL.schemaVersion);
  assert.equal(await refusal({ ...good, submission: { ...good.submission, filedInTimezone: "Mars/Olympus" } }), PDF_REFUSAL.timezone);
});

test("TP17. (R1) a stored CERTIFIED check missing rows of its checklist, or with an undescribed defect, is refused — never drawn as a valid certificate", async () => {
  const partial = unitUse({ checks: [{ ...certifiedCheck(), items: certifiedCheck().items.slice(1) }] });
  const undescribed = unitUse({ checks: [{ ...certifiedCheck(), items: hgvRows({ wipers: { result: "fail", note: null } }) }] });
  for (const vehicle of [partial, undescribed]) {
    const snap = snapshot({ vehicles: [vehicle] });
    // Stored as if an earlier, looser validator had accepted it: hashed as it is.
    const looselyStored: TimesheetPdfSource = {
      ...source(),
      submission: { ...source().submission, payload: snap, payloadSha256: createHash("sha256").update(canonicalJson(snap)).digest("hex") },
    };
    assert.equal(await refusal(looselyStored), PDF_REFUSAL.inconsistent);
  }
});

test("TP18. (R1) a defect a correction took back is NOT silently erased: the summary still lists it, saying it was corrected and when", async () => {
  const check = {
    ...certifiedCheck(),
    items: hgvRows({ "front-view": { result: "fail", note: "Crack in screen" } }),
    revisions: [{ id: "r1", revisedAt: "2026-10-11T05:00:00.000Z", revisedBy: USER, items: hgvRows() }],
  };
  const { text } = await rendered(source(snapshot({ vehicles: [unitUse({ checks: [check] })], trailers: [] })));
  assert.ok(text.includes("Defects reported: 0 open, 1 corrected"), "the summary forgot the corrected defect");
  assert.ok(text.includes("Crack in screen"));
  assert.ok(/Corrected to Pass\s+at\s+06:00/.test(text), "no word of the correction that took it back");
});

test("TP19. the corrected-defect line pairs a result with the time of the SAME correction — Defect → Pass at 17:00 → N/A at 18:00 says Pass at 17:00, never N/A at 17:00", async () => {
  const check = {
    ...certifiedCheck(),
    items: hgvRows({ "front-view": { result: "fail", note: "Crack in screen" } }),
    revisions: [
      { id: "r1", revisedAt: "2026-10-11T16:00:00.000Z", revisedBy: USER, items: hgvRows() },
      { id: "r2", revisedAt: "2026-10-11T17:00:00.000Z", revisedBy: USER, items: hgvRows({ "front-view": { result: "na", note: null } }) },
    ],
  };
  const { text } = await rendered(source(snapshot({ vehicles: [unitUse({ checks: [check] })], trailers: [] })));
  assert.ok(/Corrected to Pass\s+at\s+17:00/.test(text), "the line did not name the correction that took the defect back");
  assert.ok(!/Corrected to N\/A\s+at\s+17:00/.test(text), "a later result was paired with an earlier correction's time");
  // The full history still tells the whole story.
  assert.ok(text.includes("Front view: DEFECT (Crack in screen) → Pass"));
  assert.ok(text.includes("Front view: Pass → N/A"));
});
