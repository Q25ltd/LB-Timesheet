#!/bin/bash
# The nightly PostgreSQL backup of LogisticBay Timesheets (DEPLOYMENT.md §6).
#
# Runs as its own Railway cron service, next to the database it backs up:
#
#   pg_dump (custom format, read-only role, private network, time-limited)
#     → read back with pg_restore --list: must be a Timesheets database
#     → age-encrypted to the owner's PUBLIC key (the private key never
#       exists here)
#     → S3 PutObject with a SHA-256 checksum S3 verifies, to a unique dated
#       key, never overwriting (If-None-Match: *)
#     → the checksum S3 acknowledges must equal ours
#     → only then: the success ping
#
# Anything else is a failure: the failure ping, a non-zero exit, and no
# success ping. Settings come from the environment and are NEVER printed —
# errors name a setting, never its value. The plaintext dump lives only in a
# private temporary directory and is deleted as soon as it is encrypted.
set -Eeuo pipefail
umask 077

readonly KEY_PREFIX_DEFAULT="pg"
readonly TIMEOUT_DEFAULT=1800

log() { printf '[backup] %s\n' "$*" >&2; }
fail() { log "FAILED: $*"; exit 1; }

# A ping to the monitor: bounded, quiet, the URL as the last argument.
ping_monitor() { curl -fsS -m 10 --retry 3 -o /dev/null "$1"; }

work=""
uploaded=0
reported=0

on_exit() {
  local status=$?
  if [ -n "$work" ]; then rm -rf "$work"; fi
  if [ "$status" -ne 0 ] && [ "$uploaded" -eq 0 ] && [ -n "${HEALTHCHECK_URL:-}" ]; then
    ping_monitor "${HEALTHCHECK_URL}/fail" >/dev/null 2>&1 || log "the monitor could not be told of the failure"
  fi
  if [ "$status" -eq 0 ] && [ "$reported" -ne 1 ]; then exit 1; fi
}
trap on_exit EXIT

# ── Configuration: present and well-formed, before anything runs ──────────────
for name in PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD AGE_RECIPIENT S3_BUCKET AWS_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY HEALTHCHECK_URL; do
  if [ -z "${!name:-}" ]; then fail "$name is required"; fi
done
if [[ ! "$AGE_RECIPIENT" =~ ^age1[0-9a-z]{58}$ ]]; then
  fail "AGE_RECIPIENT must be an age public key (age1…) — never the private key"
fi
if [[ ! "$HEALTHCHECK_URL" =~ ^https://[^[:space:]]+$ ]]; then fail "HEALTHCHECK_URL must be an https URL"; fi
prefix="${S3_PREFIX:-$KEY_PREFIX_DEFAULT}"
if [[ ! "$prefix" =~ ^[a-z0-9-]{1,32}$ ]]; then fail "S3_PREFIX must be lowercase letters, digits or -"; fi
limit="${BACKUP_TIMEOUT_SECONDS:-$TIMEOUT_DEFAULT}"
if [[ ! "$limit" =~ ^[0-9]{2,5}$ ]]; then fail "BACKUP_TIMEOUT_SECONDS must be a number of seconds"; fi

ping_monitor "${HEALTHCHECK_URL}/start" || log "the monitor could not be told the backup started"

work="$(mktemp -d "${TMPDIR:-/tmp}/lbts-backup.XXXXXX")"
dump="$work/timesheets.dump"
encrypted="$work/timesheets.dump.age"

# ── Dump ──────────────────────────────────────────────────────────────────────
log "dumping ${PGDATABASE} from ${PGHOST} as ${PGUSER}"
timeout "$limit" pg_dump --format=custom --no-password --file "$dump" || fail "pg_dump did not complete"

# ── It must read back, and be this product's database ─────────────────────────
pg_restore --list "$dump" > "$work/contents" || fail "the dump does not read back"
grep -q 'TABLE DATA public _prisma_migrations' "$work/contents" || fail "the dump holds no Timesheets schema"

# ── Encrypt, and destroy the plaintext ────────────────────────────────────────
age -r "$AGE_RECIPIENT" -o "$encrypted" "$dump" || fail "encryption did not complete"
rm -f "$dump"
IFS= read -r header < "$encrypted" || true
[ "$header" = "age-encryption.org/v1" ] || fail "the encrypted file is not age output"

size="$(wc -c < "$encrypted" | tr -d ' ')"
checksum="$(openssl dgst -sha256 -binary "$encrypted" | base64)"
[ -n "$checksum" ] || fail "the checksum could not be computed"

# ── Upload: a unique key, S3 verifies the checksum, nothing is overwritten ────
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
day="$(date -u +%Y/%m/%d)"
nonce="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
key="${prefix}/${day}/lb-timesheets-${stamp}-${nonce}.dump.age"

log "uploading ${size} bytes to s3://${S3_BUCKET}/${key}"
response="$(aws s3api put-object \
  --bucket "$S3_BUCKET" --key "$key" --body "$encrypted" \
  --checksum-algorithm SHA256 --checksum-sha256 "$checksum" \
  --if-none-match '*' --region "$AWS_REGION" --output json)" || fail "the upload did not complete"

acknowledged="$(printf '%s\n' "$response" | sed -n 's/.*"ChecksumSHA256": *"\([^"]*\)".*/\1/p' | head -n 1)"
[ "$acknowledged" = "$checksum" ] || fail "S3 acknowledged a different checksum"
uploaded=1
log "stored s3://${S3_BUCKET}/${key} — ${size} bytes, sha256 ${checksum}"

# ── Only now: success ─────────────────────────────────────────────────────────
ping_monitor "$HEALTHCHECK_URL" || fail "the backup is stored, but the monitor could not be told — it will report a missed run"
reported=1
log "done"
