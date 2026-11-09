# characterbuilder_api

CharacterBuilder backend: a [Hono](https://hono.dev) REST API running on the
[Bun](https://bun.sh) runtime. It stores FaceSpec **Characters**, composes image
prompts, and generates character images through **ShapeShyft**, metering each
delivered image against **consumable credits**. Persistence is Postgres +
[Drizzle](https://orm.drizzle.team); auth is Firebase ID tokens. All
request/response shapes come from `@sudobility/characterbuilder_types`. Patterns
are copied from `screenwriter_api` (the async job queue is from `music_api`).

Private package (BUSL-1.1). Published container image only — no npm publish.

## Requirements

- [Bun](https://bun.sh) (the runtime; there is no Node build step).
- A Postgres database (`DATABASE_URL`).
- Access to the `@sudobility/*` packages on GitHub Packages. `.npmrc` points
  `@sudobility:registry` at `https://npm.pkg.github.com`, so `bun install` needs
  a GitHub token with `read:packages` (e.g. `BUN_AUTH_TOKEN` / a `//npm.pkg.github.com/:_authToken` entry).

## Install, run, test

```bash
bun install
cp .env.example .env          # set DATABASE_URL, FIREBASE_*, SHAPESHYFT_* …
bun run db:init               # apply schema (also runs on boot unless SKIP_DB_INIT=1)
bun run dev                   # watch mode, http://localhost:8039
# bun run start               # run once (no watch)
bun run typecheck             # tsc --noEmit
bun run test:unit             # vitest run (the DB-free routes; no Postgres needed)
```

The default port is **8039** (`PORT`). `eslint.config.js` / `.prettierrc` exist
for CI, but neither tool is installed locally and there is no `lint` script.

### Local dev without Firebase / DB

- `AUTH_TEST_MODE=1` accepts `Authorization: Bearer dev:<uid>:<email>` tokens, so
  you can skip Firebase entirely.
- `STORAGE_DRIVER=memory` keeps image bytes in process (default; `local` writes
  under `STORAGE_DIR`, default `./.storage`).
- Boot refuses to start without `DATABASE_URL`. Routes that need no database
  (health, `/visual-styles`, `/compose`, `/distributions`, the public catalog)
  work once the app is up; set `SKIP_DB_INIT=1` to skip the `CREATE TABLE` sweep.

See `.env.example` for every variable (ShapeShyft endpoint/key, `CREDIT_PRODUCTS`,
`INITIAL_FREE_CREDITS`, `REVENUECAT_*`, CORS).

## Endpoints (`/api/v1`)

Public (no auth):
- `GET  /visual-styles` — the art-style catalog the UI offers.
- `GET  /consumables/products`, `GET /public/consumables/offerings` — the priced
  credit catalog (the shared client hits the `public/…/offerings` path).
- `POST /consumables/webhook` — RevenueCat webhook (guarded by `REVENUECAT_WEBHOOK_AUTH`).

Authenticated (signed-in user):
- `GET  /me` — profile; upserts the user row.
- `GET/POST /characters`, `GET/PATCH/DELETE /characters/:id` — FaceSpec CRUD (cursor-paginated).
- `GET  /characters/:id/images`, `PATCH|DELETE /characters/:id/images/:imageId` — a character's headshots (1:M).
- `POST /compose` — the prompt a spec+params would produce (no credits).
- `POST /distributions` — demographics → per-trait probability maps (pure compute, no credits).
- `POST /describe` — free text → inferred partial FaceSpec (LLM, no credits).
- `POST /analyze` — uploaded headshot → partial FaceSpec (vision, no credits).
- `POST /generate` — enqueue an async image-generation job; returns it `pending` (poll it).
- `POST /generate/sheet` — staged head/body/clothed sheet job.
- `GET  /generations`, `GET /generations/:id` — history / poll a job to completion.
- `GET  /images/:id` — image bytes (owner only); `GET /images/:id/meta` — its metadata.
- `GET  /consumables/balance`, `GET /consumables/purchases`, `GET /consumables/usages` — credit ledger.
- `POST /consumables/purchase` — confirm + verify a RevenueCat purchase, then credit.
- `POST /consumables/dev-topup` — grant test credits (disabled in production unless `AUTH_TEST_MODE=1`).

## How generation works

`/generate` and `/generate/sheet` are **asynchronous**. A `generations` row *is*
the job; its `status` is `pending → running → succeeded|failed`. Enqueue reserves
the full credit cost up front (402 `INSUFFICIENT_CREDITS` if the balance is short),
inserts a `pending` row, and starts a self-draining pump. At most one job runs per
user (enforced by a partial unique index). The runner casts a fresh coherent
FaceSpec per image, composes the prompt (a remote LLM, falling back to the local
`composePrompt`), renders via ShapeShyft, stores the bytes, then **settles**:
releases whatever was reserved but not delivered. One credit is charged per
delivered image. Clients poll `GET /generations/:id`. Orphaned `running` jobs are
failed and refunded on boot (`recoverOrphanedJobs`). Idempotency is keyed on
`idempotencyKey`.

## Layers

`@sudobility/characterbuilder_types` (schemas / prompt composer) → **this api** →
`characterbuilder_client` → `characterbuilder_lib` → `characterbuilder_app`.
Image generation, auth, and credits reuse ShapeShyft, `@sudobility/auth_service`,
and `@sudobility/consumables_service`.
