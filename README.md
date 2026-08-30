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
npm run check                 # the authoritative gate — see below
npm run dev                   # http://localhost:3000/health
```

**The schema reaches databases through migrations only** (`api/prisma/migrations`),
never `db push`. You normally never apply them by hand: `npm run check`'s db
stage builds a throwaway `lb_timesheet_check` database with `prisma migrate
deploy` on every run.

## The authoritative gate

`npm run check` = generate → typecheck → eslint → check-rules → prisma validate
→ knip → unit tests → **db stage** (clean database + real migrations + the
PostgreSQL integrity and Company A/B repository suites). CI runs exactly this
one command — there is no separate CI checklist to drift.

`npm run studio` (in `api/`) opens a table editor — during early development
that is the admin screen.

Note: don't paste `#` comments onto the ends of commands; interactive zsh
passes them through as arguments.

## Layout

```
api/      Fastify + Prisma backend
web/      company web app          (not started)
mobile/   Expo driver app          (not started)
```
