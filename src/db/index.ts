/**
 * Database access: lazy postgres.js client + Drizzle. `initDatabase()` runs
 * idempotent raw SQL (CREATE ... IF NOT EXISTS, forward-only). schema.ts mirrors it.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { runEntityMigration } from '@sudobility/entity_service';
import * as schema from './schema';
import { getEnv, getRequiredEnv } from '../lib/env-helper';

export * from './schema';

let _client: ReturnType<typeof postgres> | null = null;
let _db: PostgresJsDatabase<typeof schema> | null = null;

export function getClient() {
  if (!_client) {
    _client = postgres(getRequiredEnv('DATABASE_URL'), {
      max: parseInt(getEnv('DATABASE_POOL_MAX', '20')!, 10),
      onnotice: () => {},
    });
  }
  return _client;
}

export function getDb() {
  if (!_db) _db = drizzle(getClient(), { schema });
  return _db;
}

export async function closeDatabase(): Promise<void> {
  if (_client) {
    await _client.end({ timeout: 5 });
    _client = null;
    _db = null;
  }
}

export async function initDatabase(): Promise<void> {
  const sql = getClient();

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT,
      email_verified BOOLEAN NOT NULL DEFAULT false,
      display_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email))`;
  // Credits are keyed to an entity; the user's currently-selected one.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS active_entity_id UUID`;

  // Entity layer (@sudobility/entity_service). Creates entities, memberships
  // and invitations (full music parity: personal + organization entities).
  // migrateProjects:false because characterbuilder has no `projects` table for
  // the migration to touch — its domain tables (characters/generations/images)
  // are backfilled with entity_id in resolveEntity instead.
  await runEntityMigration({
    client: sql,
    schemaName: 'public',
    indexPrefix: 'characterbuilder',
    migrateProjects: false,
    migrateUsers: false,
  });
  // runEntityMigration does not own the API-key table; create it here (mirrors
  // music_api) so every startup brings an existing DB up to the key schema.
  await sql`
    CREATE TABLE IF NOT EXISTS entity_api_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      key_name VARCHAR(255) NOT NULL,
      key_hash VARCHAR(64) NOT NULL UNIQUE,
      key_prefix VARCHAR(20) NOT NULL,
      created_by_user_id VARCHAR(128) NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS characterbuilder_entity_api_keys_hash_idx ON entity_api_keys (key_hash)`;
  await sql`CREATE INDEX IF NOT EXISTS characterbuilder_entity_api_keys_entity_idx ON entity_api_keys (entity_id)`;
  await sql`CREATE INDEX IF NOT EXISTS characterbuilder_entity_api_keys_active_idx ON entity_api_keys (is_active)`;

  await sql`
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT,
      notes TEXT,
      spec JSONB NOT NULL DEFAULT '{}',
      preview_image_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS characters_user_idx ON characters (user_id, updated_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS generations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
      prompt TEXT NOT NULL,
      params JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      credits_spent INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      idempotency_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS generations_user_idx ON generations (user_id, created_at DESC)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS generations_idempotency_key
      ON generations (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL`;

  await sql`
    CREATE TABLE IF NOT EXISTS generation_images (
      id TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'image/png',
      width INTEGER,
      height INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS generation_images_gen_idx ON generation_images (generation_id)`;

  // Jobs migration (forward-only): generations became async job rows. Each job
  // carries a base spec + demographics the caster fills per image, reserves
  // credits while running, and records a finish time.
  await sql`ALTER TABLE generations ADD COLUMN IF NOT EXISTS spec JSONB`;
  await sql`ALTER TABLE generations ADD COLUMN IF NOT EXISTS demographics JSONB`;
  await sql`ALTER TABLE generations ADD COLUMN IF NOT EXISTS reserved_credits INTEGER NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE generations ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ`;
  await sql`ALTER TABLE generations ALTER COLUMN prompt DROP NOT NULL`;
  await sql`ALTER TABLE generation_images ADD COLUMN IF NOT EXISTS spec JSONB`;
  await sql`ALTER TABLE generation_images ADD COLUMN IF NOT EXISTS prompt TEXT`;
  // Sheet pipeline (forward-only): a generation has a kind (face | head-sheet |
  // body-sheet | clothed-sheet) and, for a sheet, the prior image it conditions
  // on; each image carries its view/direction role.
  await sql`ALTER TABLE generations ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'face'`;
  await sql`ALTER TABLE generations ADD COLUMN IF NOT EXISTS source_image_id TEXT`;
  await sql`ALTER TABLE generation_images ADD COLUMN IF NOT EXISTS role TEXT`;
  // Simplified /new flow (forward-only): the user's free-text prompt, appended to
  // the composed image prompt at render time.
  await sql`ALTER TABLE generations ADD COLUMN IF NOT EXISTS description TEXT`;
  // Name-after-generation flow (forward-only): a character is created when the
  // user names one of their images, and "deleting" one clears the name, so the
  // column must allow NULL.
  await sql`ALTER TABLE characters ALTER COLUMN name DROP NOT NULL`;
  // 1:M character → headshots: which character owns each generated image. A
  // variation run carries characterId (all its images belong to the character);
  // naming a loose candidate assigns just that one image.
  await sql`ALTER TABLE generation_images ADD COLUMN IF NOT EXISTS character_id TEXT`;
  await sql`ALTER TABLE generations ADD COLUMN IF NOT EXISTS image_note TEXT`;
  await sql`ALTER TABLE generation_images ADD COLUMN IF NOT EXISTS note TEXT`;
  // Per-image framing (headshot … full-length) so a character can separate its
  // headshots from full-body shots.
  await sql`ALTER TABLE generation_images ADD COLUMN IF NOT EXISTS shot TEXT`;
  // At most one running job per user — the real concurrency guarantee (an
  // app-level check races under READ COMMITTED). A losing promotion is a no-op.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS generations_one_running_per_user
      ON generations (user_id) WHERE status = 'running'`;

  // consumables ledger (consumables_service shape)
  await sql`
    CREATE TABLE IF NOT EXISTS consumable_balances (
      user_id VARCHAR(128) PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 0,
      initial_credits INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS consumable_purchases (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(128) NOT NULL,
      credits INTEGER NOT NULL,
      source VARCHAR(20) NOT NULL,
      transaction_ref_id VARCHAR(255),
      product_id VARCHAR(255),
      price_cents INTEGER,
      currency VARCHAR(10),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS consumable_usages (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(128) NOT NULL,
      credits INTEGER NOT NULL DEFAULT 1,
      reference VARCHAR(500),
      filename VARCHAR(500),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS consumable_purchases_transaction_ref
      ON consumable_purchases (transaction_ref_id) WHERE transaction_ref_id IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS consumable_usages_user ON consumable_usages (user_id, created_at DESC)`;

  // Entity-scoping of the ledger (mirrors music_api). `user_id` holds an entity
  // id; the nullable `entity_id` is backfilled from it by a trigger when the id
  // is a UUID. `entity_credit_migrations` records which users have had their
  // old uid-keyed credit rows folded into their personal entity.
  await sql`ALTER TABLE consumable_balances ADD COLUMN IF NOT EXISTS entity_id UUID REFERENCES entities(id) ON DELETE CASCADE`;
  await sql`ALTER TABLE consumable_purchases ADD COLUMN IF NOT EXISTS entity_id UUID REFERENCES entities(id) ON DELETE CASCADE`;
  await sql`ALTER TABLE consumable_usages ADD COLUMN IF NOT EXISTS entity_id UUID REFERENCES entities(id) ON DELETE CASCADE`;
  await sql`CREATE INDEX IF NOT EXISTS consumable_purchases_entity ON consumable_purchases (entity_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS consumable_usages_entity ON consumable_usages (entity_id, created_at DESC)`;
  await sql`CREATE TABLE IF NOT EXISTS entity_credit_migrations (user_id VARCHAR(128) PRIMARY KEY, entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE, migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await sql`
    CREATE OR REPLACE FUNCTION set_consumable_entity_id() RETURNS trigger AS $$
    BEGIN
      IF NEW.entity_id IS NULL AND NEW.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        NEW.entity_id := NEW.user_id::uuid;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `;
  await sql`DROP TRIGGER IF EXISTS consumable_balances_entity_id ON consumable_balances`;
  await sql`CREATE TRIGGER consumable_balances_entity_id BEFORE INSERT OR UPDATE ON consumable_balances FOR EACH ROW EXECUTE FUNCTION set_consumable_entity_id()`;
  await sql`DROP TRIGGER IF EXISTS consumable_purchases_entity_id ON consumable_purchases`;
  await sql`CREATE TRIGGER consumable_purchases_entity_id BEFORE INSERT OR UPDATE ON consumable_purchases FOR EACH ROW EXECUTE FUNCTION set_consumable_entity_id()`;
  await sql`DROP TRIGGER IF EXISTS consumable_usages_entity_id ON consumable_usages`;
  await sql`CREATE TRIGGER consumable_usages_entity_id BEFORE INSERT OR UPDATE ON consumable_usages FOR EACH ROW EXECUTE FUNCTION set_consumable_entity_id()`;

  // Credit coupons (site-admin issued, redeemed to an entity). Raw-SQL, as in
  // music_api — not part of the consumables_service schema.
  await sql`
    CREATE TABLE IF NOT EXISTS credit_coupons (
      code CHAR(8) PRIMARY KEY,
      credits INTEGER NOT NULL CHECK (credits > 0),
      expires_at TIMESTAMPTZ NOT NULL,
      assigned_email VARCHAR(255),
      created_by_user_id VARCHAR(128) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS credit_coupons_created_idx ON credit_coupons (created_at DESC)`;
  await sql`
    CREATE TABLE IF NOT EXISTS credit_coupon_redemptions (
      code CHAR(8) NOT NULL REFERENCES credit_coupons(code) ON DELETE RESTRICT,
      entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      redeemed_by_user_id VARCHAR(128) NOT NULL,
      credits INTEGER NOT NULL CHECK (credits > 0),
      redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (code, entity_id)
    )`;
  await sql`CREATE INDEX IF NOT EXISTS credit_coupon_redemptions_entity_idx ON credit_coupon_redemptions (entity_id, redeemed_at DESC)`;

  // Entity-owned domain data (forward-only): characters, generations and their
  // images carry the owning entity. Existing rows are backfilled to each user's
  // personal entity by resolveEntity on first request (see services/entities.ts).
  await sql`ALTER TABLE characters ADD COLUMN IF NOT EXISTS entity_id UUID REFERENCES entities(id) ON DELETE CASCADE`;
  await sql`ALTER TABLE generations ADD COLUMN IF NOT EXISTS entity_id UUID REFERENCES entities(id) ON DELETE CASCADE`;
  await sql`ALTER TABLE generation_images ADD COLUMN IF NOT EXISTS entity_id UUID REFERENCES entities(id) ON DELETE CASCADE`;
  await sql`CREATE INDEX IF NOT EXISTS characters_entity_idx ON characters (entity_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS generations_entity_idx ON generations (entity_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS generation_images_entity_idx ON generation_images (entity_id)`;
}
