import { describe, it, expect } from 'vitest';
import { app } from './app';

const call = async (req: Request) => {
  const res = await app.fetch(req);
  const body = await res.json().catch(() => null);
  return { status: res.status, body } as {
    status: number;
    body: Record<string, unknown> | null;
  };
};

describe('characterbuilder_api app', () => {
  it('serves health without a database', async () => {
    const r = await call(new Request('http://t/health'));
    expect(r.status).toBe(200);
    expect(r.body?.success).toBe(true);
  });

  it('exposes the public consumables catalog', async () => {
    process.env.CREDIT_PRODUCTS = 'cb_credits_100:100';
    const r = await call(new Request('http://t/api/v1/consumables/products'));
    expect(r.status).toBe(200);
    expect(Array.isArray((r.body as { data?: unknown }).data)).toBe(true);
  });

  it('serves the offerings catalog at the path the shared client fetches', async () => {
    // ConsumablesApiClient fetches credit products from
    // `/api/v1/public/consumables/offerings` by default; that path must resolve
    // (a 404 here surfaces as a "Not found" error on the credits page).
    process.env.CREDIT_PRODUCTS = 'cb_credits_100:100';
    const r = await call(
      new Request('http://t/api/v1/public/consumables/offerings')
    );
    expect(r.status).toBe(200);
    const products = (r.body as { data?: { products?: unknown } }).data
      ?.products;
    expect(Array.isArray(products)).toBe(true);
  });

  it('requires auth for /me', async () => {
    const r = await call(new Request('http://t/api/v1/me'));
    expect(r.status).toBe(401);
    expect(r.body?.success).toBe(false);
    expect(r.body?.error).toBe('Authentication required');
  });

  // Authenticated endpoints (/generate, /distributions, …) now resolve the
  // request's entity in auth middleware, so they need a database. Their coverage
  // lives in app.db.test.ts (run against a local DB), never in this DB-free
  // suite — which must stay off the remote DB that .env points at.
});
