/**
 * A vehicle check — one walkaround, answered item by item.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE SERVER'S VOCABULARY, NOT A NEW ONE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The schema already defines a completed check item as
 * `{ key, label, result: pass | fail | na, note }`, and says a defect IS a
 * failed item with a note (`ShiftSegment.truckChecks`, D10). So a stored item
 * uses exactly those names. The screen says OK, N/A and DEFECT; underneath,
 * OK is `pass`, N/A is `na`, and DEFECT is `fail` with its description in
 * `note`. One concept, one name.
 *
 * `label` is stored with every answer, not looked up later: a completed check
 * must still say what was checked even after the checklist is reworded.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHERE A CHECK BELONGS
 * ════════════════════════════════════════════════════════════════════════════
 *
 * A check is stored INSIDE the vehicle it checks — `vehicle.checks` in the
 * open shift — not in a table keyed by number plate. That containment is its
 * identity: which shift is the document it sits in, which vehicle use is the
 * vehicle entry it sits under (itself identified by `vehicle.startedAt`), and
 * the class and plate are that vehicle's. When a later increment lets a driver
 * return to a unit used earlier the same day, that return is a NEW vehicle
 * entry with its own, empty, list of checks — an old check can never stand in
 * for a new use of the same registration. `checks` is a list for the same
 * reason: a repeat check on one use is a second record, not an overwrite.
 *
 * Nothing about severity or roadworthiness is recorded. DVSA's guidance asks
 * for the driver's assessment of a defect (for example "dangerous"); that is a
 * separate product decision, and until it is made the app claims nothing.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * A DEFAULT IS A PROPOSAL; COMPLETING IS A DECLARATION
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Before completion, the results on screen are the checklist's declared
 * defaults with the driver's overrides over them. They are what the driver is
 * being SHOWN, and they say nothing about what has been inspected: 38 OK and
 * 4 N/A on an untouched screen is a proposal, not a walkaround. Only the
 * stored overrides are the driver's own input, which is why a draft holds
 * those and nothing else.
 *
 * `completedAt === null` therefore means exactly one thing — this walkaround
 * has NOT been certified — whatever the screen is currently rendering.
 *
 * Pressing Complete Check is the declaration: "I have completed the walkaround
 * and these are the results." It is the only thing that resolves the defaults
 * into results, freezes them, and records WHEN and BY WHOM.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * A COMPLETED CHECK IS HISTORY, AND DESCRIBES ITSELF
 * ════════════════════════════════════════════════════════════════════════════
 *
 * A draft is shorthand: overrides, read against the checklist it was begun
 * on. A completed check is the opposite — every row the driver confirmed, each
 * with the label they saw, the section it sat under and the result they gave,
 * in the order they met them. Everything needed to show it again is inside it,
 * so it is shown from itself alone (`resultsOf`, `sectionsOf`): a later
 * checklist that adds, retires, renames, re-sections or re-defaults a row
 * changes nothing about what an earlier certificate appears to contain.
 *
 * A MISTAKE IS CORRECTED, NEVER OVERWRITTEN (D36). The certified rows,
 * `completedAt` and `completedBy` stay as they are; a correction is appended
 * to `revisions` as a complete snapshot of its own, and the latest one is the
 * effective result every screen shows (`effectiveItems`).
 *
 * Records completed before sections were stored keep their rows, labels,
 * results and order, and are shown as one list. Their sections are NOT
 * reconstructed from today's checklist: where a row sat when the driver signed
 * is not something such a record says.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHOSE CLOCK, AND WHOSE WORD
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `completedAt` is the DEVICE clock at the moment the driver certified, and it
 * is the driver's declared time — the same standing `LocalShift.startedAt`
 * has (D20: declared times are the driver's data; the server never rewrites
 * them). It is NOT a server acceptance time, and must never be presented as
 * one. When submission is built, the server will record its own receipt in its
 * own field, alongside this one rather than over it.
 *
 * `id` is this completion's stable client event identity, in the shape D19
 * fixed for offline events: generated once on the device, reused on every
 * replay, and the thing that makes a repeated completion idempotent rather
 * than a second certificate. The server keeps its own row id when it arrives.
 */
import { checklistItems, type Checklist, type ChecklistId } from "./checklists";

/** OK, N/A and DEFECT, as the schema names them. */
export const CHECK_RESULT = { ok: "pass", notApplicable: "na", defect: "fail" } as const;
export type CheckResult = typeof CHECK_RESULT[keyof typeof CHECK_RESULT];
const RESULTS: readonly string[] = Object.values(CHECK_RESULT);

export const CHECK_STATUS = { draft: "draft", completed: "completed" } as const;
type CheckStatus = typeof CHECK_STATUS[keyof typeof CHECK_STATUS];

/** The defect description limit shown under the field (owner: raised from 200). */
export const DEFECT_NOTE_MAX_LENGTH = 500;

/** Where a completed row sat, as the driver saw it: the section and its title. */
interface CheckSection {
  id: string;
  title: string;
}

export interface CheckItem {
  key: string;
  label: string;
  /**
   * Recorded on a COMPLETED row only, as part of the frozen record. A draft's
   * rows are laid out by the checklist it is being answered against, and carry
   * none. Absent on a completed record written before sections were stored.
   */
  section?: CheckSection;
  result: CheckResult;
  /** The defect description. `null` unless the result is a defect. */
  note: string | null;
}

export interface VehicleCheck {
  /** This check's own identity, independent of the plate. */
  id: string;
  checklist: ChecklistId;
  checklistVersion: number;
  /** When the driver began this check. */
  startedAt: string;
  status: CheckStatus;
  /**
   * The driver's declared moment of certification — device clock, set exactly
   * when `status` is completed and never otherwise. `null` is unambiguous:
   * this walkaround has not been certified.
   */
  completedAt: string | null;
  /**
   * WHO declared it: the authenticated driver's stable user id.
   *
   * The user rather than the membership, because a day worked Personal has no
   * membership at all and the declaration still has an author. It is recorded
   * only on completion — a draft is nobody's declaration yet.
   */
  completedBy: string | null;
  /** Answered items only, in checklist order. Unanswered is absence. */
  items: CheckItem[];
  /**
   * CORRECTIONS to a completed check, oldest first — append-only. Absent means
   * none, and is how every check from before corrections existed is stored:
   * it reads as the original snapshot and zero revisions, and is never
   * rewritten to add an empty list. `items`, `completedAt` and `completedBy`
   * stay exactly as first certified; the LAST revision is the effective result.
   */
  revisions?: CheckRevision[];
}

/**
 * One confirmed correction of a completed check: a COMPLETE snapshot — every
 * row, with its section and any defect description — and who made it, when.
 * Never edited once written; a later mistake is corrected by the next one.
 */
export interface CheckRevision {
  /** Stable id: a repeated confirmation of one correction is one revision. */
  id: string;
  /** The device clock when the driver confirmed the correction — never backdated. */
  revisedAt: string;
  /** The signed-in driver who made the correction. */
  revisedBy: string;
  items: CheckItem[];
}

/**
 * What a completed check says NOW: its latest revision, or the original
 * snapshot when it was never corrected. What every screen shows.
 */
export function effectiveItems(check: VehicleCheck): CheckItem[] {
  const latest = check.revisions?.[check.revisions.length - 1];
  return latest?.items ?? check.items;
}

/** Whether a completed check has been corrected at least once. */
export function isCorrected(check: VehicleCheck | null): boolean {
  return (check?.revisions?.length ?? 0) > 0;
}

/** One answer as the driver is giving it — the description as typed. */
export interface CheckAnswer {
  key: string;
  result: CheckResult;
  note: string;
}

const CHECKLIST_IDS: readonly string[] = ["hgv-unit", "hgv-rigid", "van", "trailer-standard", "trailer-refrigerated"];

/**
 * Narrow stored data to a check, or reject it.
 *
 * Structural only: what a check may contain at all. Whether its items belong
 * to the vehicle's checklist is checked by the caller, which knows the vehicle.
 * A completed check must be internally complete — every defect described, a
 * completion time present — or it is not a completed check. Nothing is
 * repaired: a result that cannot be read is never read as OK.
 *
 * Recorded sections take the one shape a completion writes: on a completed
 * check only, on every row or on none (none being a record from before they
 * were stored), each section one unbroken run of rows under one title. Any
 * other layout is not a record this app made, and is not shown as one.
 */
function asVehicleCheck(value: unknown): VehicleCheck | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, checklist, checklistVersion, startedAt, status, completedAt, items } = value as Record<string, unknown>;

  if (typeof id !== "string" || id === "") return null;
  if (typeof checklist !== "string" || !CHECKLIST_IDS.includes(checklist)) return null;
  if (typeof checklistVersion !== "number" || !Number.isSafeInteger(checklistVersion)) return null;
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) return null;
  if (status !== CHECK_STATUS.draft && status !== CHECK_STATUS.completed) return null;
  const { completedBy } = value as Record<string, unknown>;
  if (status === CHECK_STATUS.completed) {
    if (typeof completedAt !== "string" || Number.isNaN(Date.parse(completedAt))) return null;
    // A completed check that cannot say who certified it is not auditable, and
    // an unauditable declaration is not a declaration.
    if (typeof completedBy !== "string" || completedBy === "") return null;
  } else if (completedAt !== null || (completedBy !== null && completedBy !== undefined)) {
    return null;
  }
  const parsed = parseItems(items, status === CHECK_STATUS.completed);
  if (parsed === null) return null;

  // Corrections belong to a COMPLETED check only, and each is itself a
  // complete, sectioned snapshot with its own author and time.
  const { revisions } = value as Record<string, unknown>;
  let parsedRevisions: CheckRevision[] | undefined;
  if (revisions !== undefined) {
    if (status !== CHECK_STATUS.completed || !Array.isArray(revisions)) return null;
    parsedRevisions = [];
    const revisionIds = new Set<string>();
    for (const raw of revisions) {
      if (typeof raw !== "object" || raw === null) return null;
      const { id: revisionId, revisedAt, revisedBy, items: revisedItems } = raw as Record<string, unknown>;
      if (typeof revisionId !== "string" || revisionId === "" || revisionIds.has(revisionId)) return null;
      if (typeof revisedAt !== "string" || Number.isNaN(Date.parse(revisedAt))) return null;
      if (typeof revisedBy !== "string" || revisedBy === "") return null;
      const snapshot = parseItems(revisedItems, true);
      if (snapshot === null || snapshot.length === 0 || snapshot.some(item => item.section === undefined)) return null;
      revisionIds.add(revisionId);
      parsedRevisions.push({ id: revisionId, revisedAt, revisedBy, items: snapshot });
    }
  }

  return {
    id,
    checklist: checklist as ChecklistId,
    checklistVersion,
    startedAt,
    status,
    completedAt: status === CHECK_STATUS.completed ? completedAt : null,
    completedBy: status === CHECK_STATUS.completed && typeof completedBy === "string" ? completedBy : null,
    items: parsed,
    ...(parsedRevisions === undefined ? {} : { revisions: parsedRevisions }),
  };
}

/**
 * An asset use's checks — a vehicle's or a trailer's — keeping only those that
 * can be read as what they are against THAT use's checklist.
 *
 * A DRAFT holds only the rows the driver CHANGED from the checklist's
 * defaults, so it is read against the version it was written for: its items
 * must be items of that checklist. A COMPLETED check holds every row with its
 * own label and result and is read as it stands, whatever the checklist says
 * now — a finished record is evidence, and a later change to a default must
 * never reinterpret it.
 *
 * ABSENT means none — every build before Vehicle Checks stored vehicles
 * without the field, and no check was ever made on them.
 *
 * A check that cannot be read is DROPPED, not repaired and not allowed to
 * take the day with it. The safe direction is unambiguous: a lost check reads
 * as "Not completed" and the driver checks again; a guessed one could read as
 * a vehicle that passed. And unlike a broken vehicle, a broken check is no
 * reason to report that the driver has no open day at all — that would let a
 * new day overwrite this one, start time and all.
 *
 * Readable means: structurally a check (`asVehicleCheck`) for THIS vehicle's
 * checklist. A draft must be for the current version, every item a real item
 * of it; a completed check must carry rows of its own — all of them, if it
 * claims the current version. A second check with an id already seen is
 * dropped too.
 */
export function readChecksFor(value: unknown, checklist: Checklist): VehicleCheck[] {
  if (!Array.isArray(value)) return [];
  const keys = new Set(checklistItems(checklist).map(entry => entry.key));
  const ids = new Set<string>();
  const checks: VehicleCheck[] = [];
  for (const raw of value) {
    const check = asVehicleCheck(raw);
    if (check === null || ids.has(check.id)) continue;
    if (check.checklist !== checklist.id) continue;
    if (check.status === CHECK_STATUS.completed) {
      // Self-describing: every row, with the label and result recorded then.
      if (check.items.length === 0) continue;
      if (check.checklistVersion === checklist.version && check.items.length !== keys.size) continue;
      // Every correction of it is complete in the same way.
      if (check.checklistVersion === checklist.version && (check.revisions ?? []).some(revision => revision.items.length !== keys.size)) continue;
    } else {
      // Overrides, which only mean anything against the version they were
      // written for.
      if (check.checklistVersion !== checklist.version) continue;
      if (!check.items.every(entry => keys.has(entry.key))) continue;
    }
    ids.add(check.id);
    checks.push(check);
  }
  return checks;
}

/**
 * The results as they stand: the checklist's declared defaults, with whatever
 * the driver has changed laid over them.
 *
 * A stored DRAFT holds only those changes, so this is where a part-finished
 * check is put back together. A COMPLETED check holds every row itself, and is
 * used as it stands — its results are what the driver confirmed, and nothing
 * here re-reads them against today's defaults.
 */
export function resultsOf(checklist: Checklist, check: VehicleCheck | null): Map<string, CheckAnswer> {
  const answers = new Map<string, CheckAnswer>();
  if (check?.status === CHECK_STATUS.completed) {
    // The EFFECTIVE result: the latest correction, or the original.
    for (const item of effectiveItems(check)) answers.set(item.key, { key: item.key, result: item.result, note: item.note ?? "" });
    return answers;
  }
  for (const entry of checklistItems(checklist)) {
    answers.set(entry.key, { key: entry.key, result: entry.defaultResult, note: "" });
  }
  for (const item of check?.items ?? []) {
    answers.set(item.key, { key: item.key, result: item.result, note: item.note ?? "" });
  }
  return answers;
}

/** A run of rows under one heading, as the screen lists them. */
export interface ShownSection {
  id: string;
  /** `null` for a completed record that stored no sections — see `sectionsOf`. */
  title: string | null;
  rows: { key: string; label: string }[];
}

/** The one run a record without stored sections is shown as. */
const UNSECTIONED = "recorded";

/**
 * Which rows the screen lists, in what order, under which headings.
 *
 * A check still being written is laid out by the checklist it is answered
 * against. A COMPLETED check is laid out by itself alone — its own rows, its
 * own order, the labels and section titles it recorded — and `checklist` is
 * not consulted for it at all.
 *
 * A completed record from before sections were stored is listed as one run
 * with no title, in its stored order: it does not say where its rows sat, and
 * filing them under today's sections would present a guess as history.
 */
export function sectionsOf(checklist: Checklist, check: VehicleCheck | null): ShownSection[] {
  if (check?.status !== CHECK_STATUS.completed) {
    return checklist.sections.map(section => ({
      id: section.id,
      title: section.title,
      rows: section.items.map(entry => ({ key: entry.key, label: entry.label })),
    }));
  }
  const shown: ShownSection[] = [];
  for (const item of effectiveItems(check)) {
    const row = { key: item.key, label: item.label };
    const id = item.section?.id ?? UNSECTIONED;
    const last = shown[shown.length - 1];
    if (last?.id === id) last.rows.push(row);
    else shown.push({ id, title: item.section?.title ?? null, rows: [row] });
  }
  return shown;
}

export interface CheckSummary {
  /**
   * How many rows this check covers. While drafting that is the current
   * checklist; once completed it is the RECORD's own rows, which is not the
   * same number if the checklist has been reworked since.
   */
  total: number;
  ok: number;
  notApplicable: number;
  defects: number;
  /** Defects whose description is still empty. */
  undescribedDefects: number;
  /** Every item of the CURRENT checklist answered, and every defect described. */
  canComplete: boolean;
}

/**
 * Counts taken from the answers themselves — never estimated, never padded.
 *
 * The tallies count the answers GIVEN, not the rows the current checklist
 * happens to have. That distinction only bites once a checklist is reworked,
 * and then it decides whether history is honest: a completed check's answers
 * are its stored rows (`resultsOf`), so counting them against today's keys
 * would drop a row that has since been retired and pad the total with rows
 * that did not exist when the driver signed. A certificate is read back, never
 * recomputed.
 *
 * `canComplete` is the one thing that must look at the current checklist,
 * because it asks about a check still being written: a driver may only certify
 * when every row in front of them today has a result.
 */
export function summarise(checklist: Checklist, answers: ReadonlyMap<string, CheckAnswer>): CheckSummary {
  let ok = 0, notApplicable = 0, defects = 0, undescribedDefects = 0;
  for (const answer of answers.values()) {
    if (answer.result === CHECK_RESULT.ok) ok += 1;
    else if (answer.result === CHECK_RESULT.notApplicable) notApplicable += 1;
    else {
      defects += 1;
      if (answer.note.trim() === "") undescribedDefects += 1;
    }
  }
  const everyRowAnswered = checklistItems(checklist).every(entry => answers.has(entry.key));
  return {
    total: answers.size,
    ok,
    notApplicable,
    defects,
    undescribedDefects,
    canComplete: everyRowAnswered && undescribedDefects === 0,
  };
}

/**
 * Whether the driver has changed anything: some row's result differs from
 * where that row starts. A defect always does — no row starts at one.
 *
 * This is the same line the store draws when it keeps a draft's overrides and
 * drops the rest, so the screen and the saved draft agree on it. Opening a
 * check, and looking at its defaults, changes nothing.
 */
export function hasOverrides(checklist: Checklist, answers: ReadonlyMap<string, CheckAnswer>): boolean {
  return checklistItems(checklist).some(entry => {
    const answer = answers.get(entry.key);
    return answer !== undefined && answer.result !== entry.defaultResult;
  });
}

/**
 * Not started until the driver has changed something; in progress while a
 * change stands; completed only once Complete Check was pressed.
 */
export type VehicleCheckState = "not-started" | "in-progress" | "completed";

/** The check that describes the vehicle now: the most recent one. */
export function latestCheck(checks: readonly VehicleCheck[]): VehicleCheck | null {
  return checks.length === 0 ? null : (checks[checks.length - 1] ?? null);
}

export function checkStateOf(checks: readonly VehicleCheck[]): VehicleCheckState {
  const latest = latestCheck(checks);
  if (latest === null) return "not-started";
  if (latest.status === CHECK_STATUS.completed) return "completed";
  // A draft's rows ARE its overrides. One whose every change was put back
  // holds none, and a driver who changed nothing has nothing in progress.
  return latest.items.length > 0 ? "in-progress" : "not-started";
}

/**
 * The rows of a check or of one of its revisions, or `null` if any is not a
 * row this app wrote: unique keys, a known result, a description only on a
 * defect (and never blank on a completed one), and — on a completed record —
 * sections on every row or on none, each one unbroken run.
 */
function parseItems(items: unknown, completed: boolean): CheckItem[] | null {
  const parsed: CheckItem[] = [];
  const seen = new Set<string>();
  const sectionIds = new Set<string>();
  let previous: CheckSection | null = null;
  if (!Array.isArray(items)) return null;
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) return null;
    const { key, label, section, result, note } = raw as Record<string, unknown>;
    if (typeof key !== "string" || key === "" || seen.has(key)) return null;
    if (typeof label !== "string" || label === "") return null;
    if (typeof result !== "string" || !RESULTS.includes(result)) return null;
    if (result === CHECK_RESULT.defect) {
      if (note !== null && typeof note !== "string") return null;
      if (typeof note === "string" && note.length > DEFECT_NOTE_MAX_LENGTH) return null;
      if (completed && (typeof note !== "string" || note.trim() === "")) return null;
    } else if (note !== null) {
      return null;
    }
    seen.add(key);
    const item: CheckItem = { key, label, result: result as CheckResult, note };

    if (section !== undefined) {
      if (!completed) return null;
      if (typeof section !== "object" || section === null) return null;
      const { id: sectionId, title } = section as Record<string, unknown>;
      if (typeof sectionId !== "string" || sectionId === "") return null;
      if (typeof title !== "string" || title === "") return null;
      const recorded: CheckSection = { id: sectionId, title };
      const continues = previous !== null && previous.id === sectionId;
      if (continues && previous?.title !== title) return null;
      if (!continues) {
        if (sectionIds.has(sectionId)) return null;
        sectionIds.add(sectionId);
      }
      item.section = recorded;
      previous = recorded;
    }
    parsed.push(item);
  }
  const sectioned = parsed.filter(item => item.section !== undefined).length;
  if (sectioned !== 0 && sectioned !== parsed.length) return null;

  return parsed;
}
