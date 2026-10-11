/**
 * Prints the PHONE's checklist ids, versions and item keys as JSON lines —
 * read by `src/lib/checklistKeys.test.ts` to prove the API's hand-made copy
 * (`src/lib/checklistKeys.ts`) has not drifted. A test aid run in its own
 * process: the phone's module is loaded by path at run time, so neither
 * workspace imports — or typechecks — the other's code.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

const Checklist = z.object({
  id:       z.string().max(64),
  version:  z.number().int(),
  sections: z.array(z.object({ items: z.array(z.object({ key: z.string().max(64) })) })),
});
type Checklist = z.infer<typeof Checklist>;

const PHONE_CHECKLISTS = resolve(dirname(fileURLToPath(import.meta.url)), "../../mobile/src/shift/checklists.ts");
const phone: unknown = await import(pathToFileURL(PHONE_CHECKLISTS).href);

function accessor(name: string): (kind: string) => Checklist {
  const value: unknown = typeof phone === "object" && phone !== null ? Reflect.get(phone, name) : undefined;
  if (typeof value !== "function") throw new Error(`the phone's checklists module has no ${name}`);
  return kind => {
    return Checklist.parse(Reflect.apply(value, undefined, [kind]));
  };
}

const forVehicle = accessor("checklistFor");
const forTrailer = accessor("trailerChecklistFor");
for (const list of [forVehicle("class1"), forVehicle("class2"), forVehicle("van"), forTrailer("standard"), forTrailer("refrigerated")]) {
  process.stdout.write(`${JSON.stringify({ id: list.id, version: list.version, keys: list.sections.flatMap(section => section.items.map(item => item.key)) })}\n`);
}
