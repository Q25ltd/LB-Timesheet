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
| `DECISIONS.md` | Settled decisions (D1–D12) and open questions |
| `DEVLOG.md` | Session history |

## Local development

**Node 22.12+ is required** — Prisma 7 breaks on Node 20. With nvm: `nvm use`
(the repo has a `.nvmrc`).

Postgres runs in Docker on port **5544** (the TMS and something else already hold 5432 and 5433):

```bash
docker compose up -d
```

Then:

```bash
cd api
cp .env.example .env
npm install
npm run db:push
npm run dev
```

`npm run studio` opens a browser table editor for the database — during early
development that is the driver/company admin screen.

Note: do not paste `#` comments onto the end of these commands. Interactive zsh
does not treat `#` as a comment by default and will pass it as an argument.

## Layout

```
api/      Fastify + Prisma backend
web/      company web app          (not started)
mobile/   Expo driver app          (not started)
```
