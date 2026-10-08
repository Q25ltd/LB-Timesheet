/**
 * The nightly PostgreSQL backup job (ops/backup/backup.sh), run for real
 * with stand-in `pg_dump`, `pg_restore`, `age`, `aws`, `curl` and `timeout`
 * on its PATH. Each stand-in records how it was called, and an environment
 * variable makes any one of them fail — so every way the job can go wrong is
 * forced, and "it never reports success unless the backup is in S3, intact"
 * is observable. Nothing here reaches a database, AWS or the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "backup.sh");

const SECRETS = {
  PGPASSWORD: "pg-secret-Zq81x",
  AWS_SECRET_ACCESS_KEY: "aws-secret-Kv22y",
  AWS_ACCESS_KEY_ID: "AKIAFAKEBACKUPKEY01",
  HEALTHCHECK_URL: "https://hc-ping.com/uuid-secret-Wt33z",
};

/** The stand-ins. `$LOG` records each call; `FAIL_<TOOL>=1` makes that tool fail. */
const FAKES = {
  timeout: `#!/bin/bash
echo "timeout $1" >> "$LOG"; shift; exec "$@"`,
  pg_dump: `#!/bin/bash
echo "pg_dump $*" >> "$LOG"
[ "\${FAIL_PG_DUMP:-}" = 1 ] && { echo "pg_dump: error: connection failed" >&2; exit 1; }
out=""; while [ $# -gt 0 ]; do case "$1" in -f|--file) out="$2"; shift 2;; --file=*) out="\${1#--file=}"; shift;; *) shift;; esac; done
printf 'PGDMP-plaintext-row-for-%s' "\${PGDATABASE:-}" > "$out"`,
  pg_restore: `#!/bin/bash
echo "pg_restore $*" >> "$LOG"
[ "\${FAIL_PG_RESTORE:-}" = 1 ] && exit 1
if [ "\${EMPTY_DUMP:-}" = 1 ]; then echo "; Archive created"; else echo "; Archive created"; echo "3456; 0 16390 TABLE DATA public _prisma_migrations app"; fi`,
  age: `#!/bin/bash
echo "age $*" >> "$LOG"
[ "\${FAIL_AGE:-}" = 1 ] && exit 1
out=""; in=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -r) shift 2;; *) in="$1"; shift;; esac; done
{ printf 'age-encryption.org/v1\\n'; printf 'ENCRYPTED(%s bytes)' "$(wc -c < "$in" | tr -d ' ')"; } > "$out"`,
  aws: `#!/bin/bash
echo "aws $*" >> "$LOG"
[ "\${FAIL_AWS:-}" = 1 ] && { echo "An error occurred (AccessDenied) when calling the PutObject operation" >&2; exit 254; }
body=""; sum=""; while [ $# -gt 0 ]; do case "$1" in --body) body="$2"; shift 2;; --checksum-sha256) sum="$2"; shift 2;; *) shift;; esac; done
cp "$body" "$CAPTURE/uploaded.bin"
[ "\${WRONG_CHECKSUM:-}" = 1 ] && sum="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
printf '{"ETag": "\\\\"abc\\\\"", "ChecksumSHA256": "%s", "VersionId": "v1"}\\n' "$sum"`,
  curl: `#!/bin/bash
url="\${@: -1}"; echo "curl $url" >> "$LOG"
if [ "\${FAIL_PING:-}" = 1 ] && [[ "$url" != */start && "$url" != */fail* ]]; then exit 22; fi
exit 0`,
};

/**
 * @typedef {{ status: number | null, out: string, calls: string[], uploaded: string | null, leftovers: string[] }} RunResult
 */

/**
 * Run backup.sh once in its own scratch directory.
 * @param {Record<string, string>} [env] settings added to, or overriding, a complete configuration
 * @param {{ unset?: string[] }} [options] settings to remove
 * @returns {RunResult}
 */
function run(env = {}, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lbts-backup-test-"));
  const bin = join(dir, "bin");
  const capture = join(dir, "capture");
  const work = join(dir, "work");
  for (const d of [bin, capture, work]) spawnSync("mkdir", ["-p", d]);
  for (const [name, body] of Object.entries(FAKES)) {
    writeFileSync(join(bin, name), body + "\n");
    chmodSync(join(bin, name), 0o755);
  }
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const base = {
    PATH: `${bin}:/usr/bin:/bin`,
    LOG: log, CAPTURE: capture, TMPDIR: work,
    PGHOST: "postgres.railway.internal", PGPORT: "5432", PGDATABASE: "railway", PGUSER: "lb_backup",
    // The shape of a real age X25519 recipient: "age1" and 58 bech32 characters.
    AGE_RECIPIENT: `age1${"q".repeat(51)}fakekey`,
    S3_BUCKET: "lb-timesheets-backups", AWS_REGION: "eu-west-2",
    ...SECRETS,
  };
  /** @type {Record<string, string>} */
  const merged = { ...base, ...env };
  for (const key of options.unset ?? []) delete merged[key];
  const res = spawnSync("bash", [SCRIPT], { env: merged, encoding: "utf8", timeout: 30_000 });
  const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  const uploaded = existsSync(join(capture, "uploaded.bin")) ? readFileSync(join(capture, "uploaded.bin"), "utf8") : null;
  const leftovers = readdirSync(work);
  rmSync(dir, { recursive: true, force: true });
  return { status: res.status, out: `${res.stdout}${res.stderr}`, calls, uploaded, leftovers };
}

/** @param {RunResult} r */
const pings = r => r.calls.filter(c => c.startsWith("curl ")).map(c => c.slice(5));
const SUCCESS = SECRETS.HEALTHCHECK_URL;
/** @param {RunResult} r */
const reportedSuccess = r => pings(r).includes(SUCCESS);
/** @param {RunResult} r */
const reportedFailure = r => pings(r).some(p => p.startsWith(`${SUCCESS}/fail`));
/** @param {RunResult} r */
const uploads = r => r.calls.filter(c => c.startsWith("aws "));

/**
 * @param {RunResult} r
 * @param {string} label
 */
function assertNoSecrets(r, label) {
  for (const [name, value] of Object.entries(SECRETS)) {
    assert.ok(!r.out.includes(value), `${label}: ${name}'s value must never appear in the job's output`);
  }
  assert.ok(!r.out.includes("PGDMP-plaintext"), `${label}: no dump content in the output`);
}

test("B1. a good run dumps, verifies, encrypts, uploads with a SHA-256 checksum, and only THEN reports success", () => {
  const r = run();
  assert.equal(r.status, 0, r.out);
  const order = r.calls.map(c => c.split(" ")[0]);
  assert.deepEqual(order.filter(t => t !== "timeout"), ["curl", "pg_dump", "pg_restore", "age", "aws", "curl"], r.calls.join("\n"));
  assert.equal(pings(r)[0], `${SUCCESS}/start`);
  assert.equal(pings(r).at(-1), SUCCESS, "success is the LAST thing, after the upload");
  assert.ok(!reportedFailure(r));
  assertNoSecrets(r, "success");
  assert.deepEqual(r.leftovers, [], "the plaintext dump and its encrypted copy are deleted");
});

test("B2. pg_dump is custom-format, bounded by a timeout, and the dump is checked readable before anything else", () => {
  const r = run();
  const dump = r.calls.find(c => c.startsWith("pg_dump "));
  assert.match(dump ?? "", /(-Fc|--format=custom)/);
  assert.ok(r.calls.some(c => c.startsWith("timeout ")), "the dump runs under a time limit");
  assert.match(r.calls.find(c => c.startsWith("pg_restore ")) ?? "", /--list/);
});

test("B3. what is uploaded is the age-ENCRYPTED file — never the plaintext dump", () => {
  const r = run();
  assert.ok(r.uploaded !== null);
  assert.ok(r.uploaded.startsWith("age-encryption.org/v1\n"), "the uploaded body is age output");
  assert.ok(!r.uploaded.includes("PGDMP-plaintext"), "no plaintext reaches S3");
  assert.match(r.calls.find(c => c.startsWith("age ")) ?? "", /-r age1/);
});

test("B4. the upload carries a SHA-256 checksum, refuses to overwrite, and goes to a unique dated key", () => {
  const a = run();
  const b = run();
  const put = uploads(a)[0] ?? "";
  assert.match(put, /s3api put-object/);
  assert.match(put, /--checksum-algorithm SHA256/);
  assert.match(put, /--checksum-sha256 [A-Za-z0-9+/]{43}=/);
  assert.match(put, /--if-none-match \*/);
  assert.match(put, /--bucket lb-timesheets-backups/);
  const key = /--key (\S+)/.exec(put)?.[1] ?? "";
  assert.match(key, /^pg\/\d{4}\/\d{2}\/\d{2}\/lb-timesheets-\d{8}T\d{6}Z-[0-9a-f]{8}\.dump\.age$/);
  const keyB = /--key (\S+)/.exec(uploads(b)[0] ?? "")?.[1];
  assert.notEqual(key, keyB, "two runs never share an object key");
});

test("B5. a FAILED DUMP never reports success, uploads nothing, and reports failure", () => {
  const r = run({ FAIL_PG_DUMP: "1" });
  assert.notEqual(r.status, 0);
  assert.ok(!reportedSuccess(r));
  assert.ok(reportedFailure(r));
  assert.deepEqual(uploads(r), []);
  assertNoSecrets(r, "failed dump");
  assert.deepEqual(r.leftovers, []);
});

test("B6. a dump that does not read back as a Timesheets database never reports success and is not uploaded", () => {
  /** @type {Record<string, string>[]} */
  const cases = [{ FAIL_PG_RESTORE: "1" }, { EMPTY_DUMP: "1" }];
  for (const env of cases) {
    const r = run(env);
    assert.notEqual(r.status, 0, JSON.stringify(env));
    assert.ok(!reportedSuccess(r));
    assert.ok(reportedFailure(r));
    assert.deepEqual(uploads(r), []);
  }
});

test("B7. a failed ENCRYPTION never reports success and uploads nothing", () => {
  const r = run({ FAIL_AGE: "1" });
  assert.notEqual(r.status, 0);
  assert.ok(!reportedSuccess(r));
  assert.ok(reportedFailure(r));
  assert.deepEqual(uploads(r), []);
});

test("B8. a FAILED UPLOAD never reports success", () => {
  const r = run({ FAIL_AWS: "1" });
  assert.notEqual(r.status, 0);
  assert.ok(!reportedSuccess(r));
  assert.ok(reportedFailure(r));
  assertNoSecrets(r, "failed upload");
});

test("B9. an upload S3 acknowledges with a DIFFERENT checksum never reports success", () => {
  const r = run({ WRONG_CHECKSUM: "1" });
  assert.notEqual(r.status, 0);
  assert.ok(!reportedSuccess(r));
  assert.ok(reportedFailure(r));
});

test("B10. a missing setting stops the job before it touches the database — naming the setting, never a value", () => {
  for (const name of ["PGHOST", "PGUSER", "PGPASSWORD", "PGDATABASE", "AGE_RECIPIENT", "S3_BUCKET", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "HEALTHCHECK_URL"]) {
    const r = run({}, { unset: [name] });
    assert.notEqual(r.status, 0, name);
    assert.match(r.out, new RegExp(`${name} is required`), name);
    assert.ok(!r.calls.some(c => c.startsWith("pg_dump ")), `${name}: no dump without full configuration`);
    assertNoSecrets(r, `missing ${name}`);
  }
});

test("B11. an age recipient that is not an age public key is refused before the dump", () => {
  const r = run({ AGE_RECIPIENT: "AGE-SECRET-KEY-1QQQQ" });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /AGE_RECIPIENT must be an age public key/);
  assert.ok(!r.out.includes("AGE-SECRET-KEY-1QQQQ"), "a private key pasted by mistake is never echoed");
  assert.ok(!r.calls.some(c => c.startsWith("pg_dump ")));
});

test("B12. if the success ping itself fails, the job exits non-zero — a silent success the monitor never heard is not a success", () => {
  const r = run({ FAIL_PING: "1" });
  assert.notEqual(r.status, 0);
  assert.equal(uploads(r).length, 1, "the backup itself was uploaded");
  assertNoSecrets(r, "failed ping");
});
