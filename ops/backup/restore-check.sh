#!/bin/bash
# Restore one encrypted backup into a THROWAWAY PostgreSQL 18 and prove it
# usable (DEPLOYMENT.md §6). Runs on the owner's machine, never on Railway:
# it needs the age PRIVATE key, which exists nowhere else.
#
#   ops/backup/restore-check.sh <backup.dump.age> <age-identity-file>
#
# Needs Docker and age. The decrypted dump is streamed straight into the
# throwaway container — it is never written to disk — and the container is
# removed when the check ends, pass or fail. Nothing here connects to the
# production database.
set -Eeuo pipefail

encrypted="${1:?usage: restore-check.sh <backup.dump.age> <age-identity-file>}"
identity="${2:?usage: restore-check.sh <backup.dump.age> <age-identity-file>}"
[ -f "$encrypted" ] || { echo "no such backup file: $encrypted" >&2; exit 2; }
[ -f "$identity" ] || { echo "no such identity file: $identity" >&2; exit 2; }

name="lbts-restore-check-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== starting a throwaway PostgreSQL 18 ($name)"
docker run -d --rm --name "$name" -e POSTGRES_USER=restore -e POSTGRES_PASSWORD=restore -e POSTGRES_DB=restored postgres:18-alpine >/dev/null
for _ in $(seq 1 60); do
  docker exec "$name" pg_isready -U restore -d restored >/dev/null 2>&1 && docker exec "$name" psql -U restore -d restored -tAc 'select 1' >/dev/null 2>&1 && break
  sleep 1
done

echo "== decrypting and restoring (streamed — no plaintext on disk)"
age -d -i "$identity" "$encrypted" | docker exec -i "$name" pg_restore -U restore -d restored --no-owner --no-privileges --exit-on-error

q() { docker exec "$name" psql -U restore -d restored -v ON_ERROR_STOP=1 -tAc "$1"; }

echo "== migrations"
applied="$(q "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null")"
failed="$(q "select count(*) from _prisma_migrations where finished_at is null or rolled_back_at is not null")"
echo "applied: $applied   unfinished or rolled back: $failed"
q "select migration_name from _prisma_migrations order by migration_name desc limit 1" | sed 's/^/latest: /'

echo "== schema"
echo "tables: $(q "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")"
q "select contype, count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public' group by contype order by contype" \
  | sed -e 's/^c|/check: /' -e 's/^n|/not null: /' -e 's/^f|/foreign key: /' -e 's/^p|/primary key: /' -e 's/^u|/unique: /' -e 's/^x|/exclusion: /'
echo "indexes: $(q "select count(*) from pg_indexes where schemaname='public'")"
echo "extensions: $(q "select string_agg(extname, ', ' order by extname) from pg_extension")"

echo "== rows per table"
for table in $(q "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name"); do
  printf '%-34s %s\n' "$table" "$(q "select count(*) from \"$table\"")"
done

if [ "$applied" -lt 1 ] || [ "$failed" -ne 0 ]; then
  echo "RESTORE CHECK FAILED: the migration history is not intact" >&2
  exit 1
fi
echo "RESTORE CHECK PASSED"
