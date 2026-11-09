# CLAUDE.md — characterbuilder_api

Hono REST API on the **Bun** runtime (no Node build). Layer 2 of five. Postgres +
Drizzle, Firebase auth, ShapeShyft image generation, consumable credits. Patterns
copied from `screenwriter_api`; the async generation queue is from `music_api`.
Private package, BUSL-1.1 (container image only — never `npm publish`).

## Commands (verified)
- `bun install` — needs a GitHub `read:packages` token; `.npmrc` routes `@sudobility:*` to GitHub Packages.
- `bun run dev` — watch mode on **:8039** (`PORT`). `bun run start` = run once.
- `bun run typecheck` — `tsc --noEmit`.
- `bun run test:unit` — `vitest run`; the included tests are DB-free (no Postgres needed).
- `bun run db:init` — apply schema. Also runs on boot unless `SKIP_DB_INIT=1`.
- No `lint` script. `eslint.config.js` / `.prettierrc` exist for CI but neither tool is installed locally — do not try to run them.

## Shape
- `src/app.ts` — Hono app, CORS, secure headers, error envelope. No boot side effects.
- `src/index.ts` — boot: `bootProblems()` (refuses without `DATABASE_URL`), `initDatabase()`, `recoverOrphanedJobs()`, server export (port 8039).
- `src/lib/` — `env-helper`, `log`, `errors` (`HttpError` → envelope), `config`, `health`.
- `src/middleware/` — `auth.ts` (firebase-or-dev `UserPrincipal`; `requireAuth` sets `principal`/`userId`), `request.ts` (request id + logger).
- `src/db/` — lazy postgres.js client + Drizzle; `initDatabase()` is idempotent raw SQL (forward-only `CREATE/ALTER … IF NOT EXISTS`); `schema.ts` mirrors it.
- `src/services/` — `users`, `credits`, `storage` (memory|local), `shapeshyft` (image/LLM transport), `characters`, `generation` (request-facing flow), `jobs` (the async runner), `distribution`, `firebase`, `revenuecat`.
- `src/routes/` — `index` (auth guards + mounting), `me`, `characters`, `generation` (compose/distributions/describe/analyze/generate/sheet/generations/images), `consumables`, `util` (`validate`).

## Rules
- All request/response shapes come from `@sudobility/characterbuilder_types`. Never hand-roll a DTO. Routes validate with `validate(target, schema)` (`routes/util.ts`).
- Services throw `HttpError(code, msg)`; `app.onError` maps the code → HTTP status + error envelope.
- Credits go through `services/credits.ts` only (the single cached `ConsumablesHelper`).
- Prompts are composed with `composePrompt` from the types package (same text as the frontend); the runner prefers a remote LLM compose and falls back to `composePrompt`.
- Keep `schema.ts` and the `initDatabase()` DDL in lockstep; migrations are forward-only ALTERs.

## Generation is ASYNC (not synchronous — this changed)
- A `generations` row IS the job: `status` = pending → running → succeeded|failed.
- `enqueueGeneration`/`enqueueSheet` **reserve** the full credit cost up front (`reserveCredits`, an atomic `balance >= cost` debit; 402 if short), insert a `pending` row, and `startNext()` the self-draining pump.
- One running job per user is guaranteed by a **partial unique index** `generations(user_id) WHERE status='running'` (not app-level checks). A lost promotion race is a harmless no-op.
- The runner casts a fresh FaceSpec per image, composes, renders via ShapeShyft, stores bytes, then **settles**: `releaseCredits` for whatever was reserved but not delivered. 1 credit per delivered image.
- Clients poll `GET /generations/:id`. Reference images are transient (in-memory, keyed by job id) — a job that outlives a restart runs without them; sheet inputs are lost on restart and fail.
- `recoverOrphanedJobs()` at boot fails every stuck `running` row, refunds its reserve, and re-pumps pending work. Idempotency via `idempotencyKey` (unique per user).

## Auth & access
- Every request is a signed-in user; there are no API keys.
- `requireAuth` accepts a Firebase ID token (via `@sudobility/auth_service`, needs `FIREBASE_*`) or, when `AUTH_TEST_MODE=1`, `Bearer dev:<uid>:<email>`.
- Public routes (no auth): `/visual-styles`, `/consumables/products`, `/public/consumables/offerings`, `/consumables/webhook`.
- The credit catalog is mounted under both `/consumables` and `/public/consumables` because the shared `ConsumablesApiClient` fetches `/api/v1/public/consumables/offerings` by default.

## Types dependency (non-obvious)
- `@sudobility/characterbuilder_types` is a normal published dependency, BUT `tsconfig.json` `paths` and `vitest.config.ts` alias it to the sibling source `../characterbuilder_types/src/index.ts` when that checkout exists — so typecheck/tests run against local source, not the installed package. Edits to the sibling are picked up without reinstalling.

## Dev notes
- `STORAGE_DRIVER=memory` (default) keeps bytes in process; `local` writes under `STORAGE_DIR` (`./.storage`). The DB stores only the opaque `storage_key`.
- `/generate` and `/generate/sheet` call `ensureUser(principal)` first, because persisting a generation FKs to `users(id)` (a user may generate before ever calling `GET /me`).
- `POST /consumables/dev-topup` is inert in production unless `AUTH_TEST_MODE=1`.
