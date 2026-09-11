# LogisticBay Timesheets

Replaces the paper daily timesheet and daily vehicle/trailer check sheet used by
UK HGV drivers with a phone app. On submit it generates a PDF and emails it to
the company's office.

**Paper form → phone → PDF → company email.**

> This is **not** the LogisticBay TMS. That is a separate product in a separate
> repo (`~/timesheet-app`) with its own database. See `CLAUDE.md`.

## Docs

| File | What it is |
|---|---|
| `CLAUDE.md` | Agent instructions and mandatory rules — read first |
| `PRODUCT.md` | Product scope and the in/out boundary |
| `STATUS.md` | What is actually built |
| `AUTH.md` | Frozen auth/tenant contract — read before touching anything tenant-scoped |
| `DECISIONS.md` | Settled decisions and open questions |
| `audits/` | Adversarial review reports — what was found, what got fixed |
| `DEVLOG.md` | Session history |

## Local development

Requires **Node 22.13+** (`.nvmrc` pins it; `nvm use`) and Docker.

```bash
nvm use
docker compose up -d          # Postgres 16 on port 5544
cp api/.env.example api/.env  # then follow the comments in it — the JWT
                              # placeholder is deliberately rejected
npm install                   # root deps: eslint, knip
npm install --prefix api      # api deps + prisma generate
npm install --prefix mobile   # Expo driver app deps
cd api
npx prisma migrate deploy     # build YOUR dev database from the real migrations
npm run db:smoke              # prove it actually enforces the guarantees
cd ..
npm run check                 # the authoritative gate — see below
npm run dev                   # API on http://localhost:3000/health
npm start --prefix mobile     # Expo driver app (needs the API running)
```

In development the app derives the API host from the Metro dev server it was
loaded from — if Metro is on `192.168.0.235:8081`, the API is assumed to be on
`192.168.0.235:3000`. That works on a physical phone and on both simulators
with no per-machine configuration, because the device demonstrably reaches
that host already. Set `EXPO_PUBLIC_API_URL` to override it (and in any build
that is not served by Metro). Only the public API base URL belongs in mobile
configuration; never a signing secret or a database URL, both of which ship
inside the app bundle.

Two things to check first when the app reports "No connection": the API must
actually be running (`npm run dev`), and **your dev database must be up to
date** — `npx prisma migrate deploy` from `api/` after any new migration, or
registration fails on a schema that has no `firstName` column. In development
the connection error also names the exact URL it tried.

**The schema reaches every database through migrations only** (`api/prisma/migrations`)
— there is no `db push` script; it does not exist in this repo. `npm run check`'s
db stage builds its own isolated, throwaway `lb_timesheet_check` database with
`prisma migrate deploy` on every run, which proves the migrations themselves are
correct — but it never touches the database the app actually runs against
locally. `prisma migrate deploy` (above) is what brings *your* dev database up
to date after cloning or after pulling a new migration; run it again whenever
`api/prisma/migrations` gains a new folder.

`npm run db:smoke` (from `api/`) is the proof that step worked: it writes a
handful of tagged fixture rows inside a transaction, confirms the composite
foreign keys, the `MembershipRole` enum, and the one-open-shift-per-user index
all reject exactly what they're supposed to reject, then rolls the whole
transaction back and checks nothing was left behind. It refuses to run at all
unless `NODE_ENV` is `development` or `test` and the target is a local
`lb_timesheet` or `lb_timesheet_check` database — it will not touch anything
else.

## The authoritative gate

`npm run check` = generate → typecheck → eslint (**both workspaces**) →
check-rules → prisma validate → knip → api unit tests → **mobile typecheck and
tests** → **db stage** (clean database + real migrations + the PostgreSQL
integrity and Company A/B repository suites). CI runs exactly this one command
— there is no separate CI checklist to drift, and no second, laxer standard for
the app.

`npm run studio` (in `api/`) opens a table editor — during early development
that is the admin screen.

Note: don't paste `#` comments onto the ends of commands; interactive zsh
passes them through as arguments.

## Layout

```
api/      Fastify + Prisma backend
mobile/   Expo driver app          (registration only — see STATUS.md)
web/      company web app          (not started)
```
