/**
 * Database-backed app tests. Excluded from the default `vitest` run (see
 * vitest.config.ts) so CI and plain `bun test` never need — or touch — a
 * database, and in particular never the remote DB that `.env` DATABASE_URL
 * points at. This suite forces a LOCAL test database, creating it if needed,
 * and skips entirely when no local Postgres is reachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const TEST_DB = 'characterbuilder_apitest';
const LOCAL = `postgres://localhost:5432/${TEST_DB}`;

let ready = false;

beforeAll(async () => {
  // Create the test DB (idempotent) via the maintenance connection.
  try {
    const admin = postgres('postgres://localhost:5432/postgres', { onnotice: () => {} });
    try {
      await admin`CREATE DATABASE ${admin.unsafe(TEST_DB)}`;
    } catch (e) {
      // 42P04 = duplicate_database — fine; anything else means no local PG.
      if ((e as { code?: string }).code !== '42P04') throw e;
    } finally {
      await admin.end({ timeout: 5 });
    }
    // Point the app at the local test DB BEFORE the db module connects, then
    // initialise the schema.
    process.env.DATABASE_URL = LOCAL;
    process.env.AUTH_TEST_MODE = '1';
    process.env.CREDIT_PRODUCTS = 'cb_credits_100:100';
    const { initDatabase } = await import('./db');
    await initDatabase();
    ready = true;
  } catch {
    ready = false; // No local Postgres — skip the suite rather than fail.
  }
});

afterAll(async () => {
  if (!ready) return;
  const { closeDatabase } = await import('./db');
  await closeDatabase();
});

const call = async (req: Request) => {
  const { app } = await import('./app');
  const res = await app.fetch(req);
  const body = await res.json().catch(() => null);
  return { status: res.status, body } as {
    status: number;
    body: Record<string, unknown> | null;
  };
};

describe('characterbuilder_api app (db)', () => {
  it('rejects a schema-invalid /generate with 400', async () => {
    if (!ready) return;
    const r = await call(
      new Request('http://t/api/v1/generate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer dev:dbt-u1:a@b.co',
        },
        body: JSON.stringify({ params: { count: 99 } }), // count is 1..10
      })
    );
    expect(r.status).toBe(400);
    expect(r.body?.error).toBe('Invalid request');
  });

  it('returns trait distributions for demographics', async () => {
    if (!ready) return;
    const r = await call(
      new Request('http://t/api/v1/distributions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer dev:dbt-u1:a@b.co',
        },
        body: JSON.stringify({ ancestry: 'east-asian', sex: 'female' }),
      })
    );
    expect(r.status).toBe(200);
    const data = (r.body as { data?: { distributions?: Record<string, unknown> } })
      .data;
    expect(data?.distributions?.hairTexture).toBeTruthy();
  });

  it('scopes characters to the entity and backfills legacy rows', async () => {
    if (!ready) return;
    const { getClient } = await import('./db');
    const sql = getClient();
    await sql`INSERT INTO users(id,email) VALUES ('dbt-legacy','leg@x.co') ON CONFLICT (id) DO NOTHING`;
    await sql`INSERT INTO characters(id,user_id,name,spec) VALUES ('dbt-legChar','dbt-legacy','Bob','{}'::jsonb) ON CONFLICT (id) DO NOTHING`;
    const r = await call(
      new Request('http://t/api/v1/characters', {
        headers: { authorization: 'Bearer dev:dbt-legacy:leg@x.co' },
      })
    );
    expect(r.status).toBe(200);
    const names = ((r.body as { data?: { name: string }[] }).data ?? []).map(
      (ch) => ch.name
    );
    expect(names).toContain('Bob');
    const [row] = await sql`SELECT entity_id FROM characters WHERE id='dbt-legChar'`;
    expect(row.entity_id).toBeTruthy(); // backfilled to the personal entity
  });

  // --- Entity API-key authentication (music_api parity, cbuilder_ prefix) ---

  const mintKey = async () => {
    const { entityHelpers, upsertEntityUser } = await import('./services/entities');
    await upsertEntityUser('dbt-keyuser', 'key@x.co');
    const entity = await entityHelpers.entity.getOrCreatePersonalEntity(
      'dbt-keyuser',
      'key@x.co'
    );
    const created = await entityHelpers.apiKeys!.createKey(
      entity.id,
      'dbt-keyuser',
      'ci'
    );
    return { entityId: entity.id, key: created.key };
  };

  it('authenticates an entity API key on a product endpoint', async () => {
    if (!ready) return;
    const { key } = await mintKey();
    expect(key.startsWith('cbuilder_')).toBe(true);
    const r = await call(
      new Request('http://t/api/v1/characters', {
        headers: { authorization: `Bearer ${key}` },
      })
    );
    expect(r.status).toBe(200); // the key reaches the entity-scoped product route
  });

  it('refuses an API key on account paths and credits', async () => {
    if (!ready) return;
    const { key } = await mintKey();
    for (const path of ['/api/v1/entities', '/api/v1/me', '/api/v1/consumables/balance']) {
      const r = await call(
        new Request(`http://t${path}`, {
          headers: { authorization: `Bearer ${key}` },
        })
      );
      expect(r.status).toBe(403);
    }
  });

  it('rejects an X-Entity-Id that does not match the key', async () => {
    if (!ready) return;
    const { key } = await mintKey();
    const r = await call(
      new Request('http://t/api/v1/characters', {
        headers: {
          authorization: `Bearer ${key}`,
          'X-Entity-Id': '00000000-0000-0000-0000-000000000000',
        },
      })
    );
    expect(r.status).toBe(403);
  });

  it('answers 401 to an unknown cbuilder_ token', async () => {
    if (!ready) return;
    const r = await call(
      new Request('http://t/api/v1/characters', {
        headers: { authorization: 'Bearer cbuilder_deadbeef_not_a_real_key' },
      })
    );
    expect(r.status).toBe(401); // falls through to the normal bearer path
  });
});
