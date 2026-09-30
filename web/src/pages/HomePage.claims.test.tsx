import { describe, expect, test } from "vitest";
import { PATHS } from "../paths";
import { renderRoute } from "../test/renderRoute";

/**
 * The homepage may claim only what the product does today (STATUS.md).
 *
 * Two rules, because there are two ways to get this wrong:
 *
 * 1. PLANNED capability — sending a timesheet to a company, PDFs, email,
 *    company accounts, submitted records, sync — is described ONLY inside a
 *    `data-status="planned"` region, and every such region says plainly that
 *    it is not available yet. So "your office receives a PDF" in the hero
 *    fails, and so does a planned region that forgets to say it is planned.
 * 2. Invented EVIDENCE never appears anywhere: statistics, prices, customer
 *    counts, testimonials, certification or compliance claims, and the
 *    tracking this product deliberately does not do.
 *
 * A copy change that trips one of these is either a false claim or a sign
 * that the product has changed — in which case STATUS.md must say so first.
 */

/** Words that describe what reaches a company, which is not built yet. */
const PLANNED_CAPABILITY =
  /\b(send|sends|sent|sending|submit|submits|submitted|submission|e-?mail\w*|pdfs?|deliver\w*|download\w*|sync\w*|dashboard\w*|office receives)\b/i;

const INVENTED_EVIDENCE: readonly (readonly [string, RegExp])[] = [
  ["a percentage", /\d\s*%/],
  // A saving CLAIM ("save 5 hours", "saves time") — not the product's own
  // "Save Timesheet" button.
  ["a price or saving", /£\s*\d|\bsav(e|es|ing|ings)\s+(up to\s+)?(\d|hours|money|time)/i],
  // Not "review": reviewing the day is a real step of the product.
  ["customer evidence", /\b(testimonials?|customer reviews?|star rating|trusted by|customers|clients|companies use)\b/i],
  ["certification or compliance", /\b(certified|certification|compliant|compliance|approved|accredited|guarantee\w*|ISO\s?\d)/i],
  ["tracking", /\b(gps|track(s|ed|ing)?|live location|real[- ]time)\b/i],
  ["an integration", /\b(integrat\w*|api)\b/i],
  ["hype", /\b(revolutioni[sz]\w*|seamless\w*|cutting[- ]edge|ai[- ]powered|next[- ]gen\w*)\b/i],
];

const NOT_AVAILABLE_YET = /not (available|open) yet/i;

function textOutsidePlanned(): string {
  const copy = document.body.cloneNode(true);
  if (!(copy instanceof HTMLElement)) throw new Error("cloning <body> did not produce an element");
  copy.querySelectorAll('[data-status="planned"]').forEach(region => region.remove());
  return copy.textContent ?? "";
}

describe("the homepage claims only what exists", () => {
  test("planned capability is described only inside regions marked planned", () => {
    renderRoute(PATHS.home);
    const outside = textOutsidePlanned();
    expect(outside.match(PLANNED_CAPABILITY)?.[0] ?? null, "planned capability described as if it exists").toBeNull();
  });

  test("every planned region says, in words, that it is not available yet", () => {
    renderRoute(PATHS.home);
    const planned = [...document.querySelectorAll('[data-status="planned"]')];
    expect(planned.length).toBeGreaterThan(0);
    for (const region of planned) {
      expect(region.textContent ?? "").toMatch(NOT_AVAILABLE_YET);
      // The label must be visible text, not hidden from sighted readers.
      expect(region.querySelector(".visually-hidden, [hidden]")).toBeNull();
    }
  });

  test.each(INVENTED_EVIDENCE)("no %s anywhere on the page", (_kind, pattern) => {
    renderRoute(PATHS.home);
    expect((document.body.textContent ?? "").match(pattern)?.[0] ?? null).toBeNull();
  });

  test("the rules are live: each one catches the claim it exists for", () => {
    // Guards against a pattern that silently matches nothing.
    expect("Finished timesheets are emailed to your office as a PDF.").toMatch(PLANNED_CAPABILITY);
    expect("Submitted records sync to the office dashboard.").toMatch(PLANNED_CAPABILITY);
    const samples = [
      "Cut admin by 40%.",
      "From £5 per driver.",
      "Trusted by 200 haulage firms.",
      "DVSA-approved checks.",
      "Live GPS tracking of every vehicle.",
      "Integrates with your payroll.",
      "Revolutionise your fleet.",
    ];
    INVENTED_EVIDENCE.forEach(([kind, pattern], index) => {
      expect(samples[index], kind).toMatch(pattern);
    });
  });
});
