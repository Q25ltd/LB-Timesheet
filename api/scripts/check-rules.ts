/**
 * check-rules — makes the mandatory rules in CLAUDE.md fail the build.
 *
 * The rules themselves live in ./rules/engine.ts so the fixture tests
 * (rules/engine.test.ts) can execute the REAL checker against known-good and
 * known-bad trees — a rule that is deleted or unwired turns a fixture test
 * red. This file is only the command-line skin: node-version gate, printing,
 * exit code.
 *
 * Escape hatch: `// rules-ignore: <id>` on the offending line, with a reason.
 * Reaching for it often means the rule is wrong — change the rule.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runRules, type Violation } from "./rules/engine.js";

// Prisma 7 breaks on Node 20, and `node --test` only expands globs from 22 —
// both failures surface far from their cause, so say it plainly up front.
const REQUIRED = [22, 13] as const;
{
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < REQUIRED[0] || (major === REQUIRED[0] && minor < REQUIRED[1])) {
    console.error(
      `\n\u2717 Node ${process.versions.node} is too old \u2014 this repo needs ` +
      `${String(REQUIRED[0])}.${String(REQUIRED[1])}+.\n\n  Run:  nvm use\n\n` +
      `  It reverts in every new terminal; nvm's directory hook in ~/.zshrc fixes it for good.\n`,
    );
    process.exit(1);
  }
}

const violations = runRules(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

if (violations.length === 0) {
  console.log("\u2713 check-rules: clean");
  process.exit(0);
}

const byRule = new Map<string, Violation[]>();
for (const violation of violations) {
  const list = byRule.get(violation.id) ?? [];
  list.push(violation);
  byRule.set(violation.id, list);
}

console.error(`\n\u2717 check-rules: ${String(violations.length)} violation(s)\n`);
for (const [id, list] of byRule) {
  console.error(`  [${id}] ${list[0]?.why ?? ""}`);
  for (const violation of list) {
    console.error(`      ${violation.file}:${String(violation.line)}  ${violation.text.slice(0, 100)}`);
  }
  console.error("");
}
console.error("Fix them, or add `// rules-ignore: <id>` on the line with a reason.\n");
process.exit(1);
