-- The backup job's own database role (DEPLOYMENT.md §6): it may READ every
-- table and nothing else. Run ONCE, as the database owner, with the password
-- passed as a psql variable so it is never part of this file or of history:
--
--   psql -v ON_ERROR_STOP=1 -v backup_password="$PASSWORD" -f backup-role.sql
--
-- Additive only: it creates a role and grants a read-only built-in role. It
-- touches no table, no row and no application role.
CREATE ROLE lb_backup
  LOGIN
  PASSWORD :'backup_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 2;

-- PostgreSQL's predefined read-everything role (SELECT on all tables, views
-- and sequences, USAGE on all schemas) — no write privilege of any kind.
GRANT pg_read_all_data TO lb_backup;

-- Belt and braces: every session it opens is read-only unless it asks
-- otherwise, and pg_dump never does.
ALTER ROLE lb_backup SET default_transaction_read_only = on;
