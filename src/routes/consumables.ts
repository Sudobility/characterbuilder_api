import { Hono, type Context } from 'hono';
import {
  API_ERROR_CODES,
  errorResponse,
  successResponse,
} from '@sudobility/characterbuilder_types';
import {
  consumables,
  creditProducts,
  creditsForProduct,
  getBalance,
  grantDevCredits,
} from '../services/credits';
import { findRevenueCatPurchase } from '../services/revenuecat';
import { getEnv } from '../lib/env-helper';
import { log } from '../lib/log';

/** Bounded so a caller cannot ask for every row an account ever wrote. */
function pageParams(c: Context): { limit: number; offset: number } {
  const limit = Math.min(
    Math.max(parseInt(c.req.query('limit') ?? '50') || 50, 1),
    200
  );
  const offset = Math.max(parseInt(c.req.query('offset') ?? '0') || 0, 0);
  return { limit, offset };
}

/** Authenticated: the signed-in user's balance. */
const router = new Hono();
router.get('/balance', async (c) =>
  c.json(successResponse(await getBalance(c.get('userId'))))
);

/** Paginated purchase (top-up) history, most recent first. */
router.get('/purchases', async (c) => {
  const { limit, offset } = pageParams(c);
  return c.json(
    successResponse(
      await consumables().getPurchaseHistory(c.get('userId'), limit, offset)
    )
  );
});

/** Paginated usage (spend) history, most recent first. */
router.get('/usages', async (c) => {
  const { limit, offset } = pageParams(c);
  return c.json(
    successResponse(
      await consumables().getUsageHistory(c.get('userId'), limit, offset)
    )
  );
});

/**
 * Confirm a RevenueCat purchase. The credit amount is server-owned (derived
 * from the product), and the transaction is independently verified against
 * RevenueCat for the signed-in app user before anything is credited. Idempotent
 * on the transaction id. Mirrors music_api's `/purchase`.
 */
router.post('/purchase', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    product_id?: string;
    transaction_ref_id?: string;
    price_cents?: number;
    currency?: string;
  };
  if (!body.product_id || !body.transaction_ref_id) {
    return c.json(
      errorResponse(
        'product_id and transaction_ref_id are required',
        API_ERROR_CODES.VALIDATION
      ),
      400
    );
  }
  const credits = creditsForProduct(body.product_id);
  if (credits === null) {
    return c.json(
      errorResponse(
        `Unknown product ${body.product_id}`,
        API_ERROR_CODES.VALIDATION
      ),
      400
    );
  }
  let verified;
  try {
    verified = await findRevenueCatPurchase(
      c.get('userId'),
      body.transaction_ref_id,
      body.product_id
    );
  } catch (error) {
    log('error', 'RevenueCat purchase verification failed', {
      error: String(error),
    });
    return c.json(
      errorResponse('Unable to verify purchase', API_ERROR_CODES.AI_UNAVAILABLE),
      503
    );
  }
  if (!verified || verified.product_id !== body.product_id) {
    return c.json(
      errorResponse(
        'Purchase could not be verified for this account',
        API_ERROR_CODES.VALIDATION
      ),
      400
    );
  }
  const store = (verified.store ?? '').toLowerCase();
  const source = store.includes('app_store')
    ? 'apple'
    : store.includes('play_store')
      ? 'google'
      : 'web';
  await consumables().recordPurchaseFromWebhook(
    c.get('userId'),
    body.transaction_ref_id,
    credits,
    source,
    body.product_id,
    Math.round(body.price_cents ?? 0),
    body.currency ?? 'USD'
  );
  return c.json(successResponse(await getBalance(c.get('userId'))));
});

/**
 * Dev-only top-up: grant credits to the signed-in user. Gated on AUTH_TEST_MODE
 * so it is inert in production. Body: `{ credits?: number }` (clamped 1..1000,
 * default 100). No purchase, no payment — local testing only.
 */
router.post('/dev-topup', async (c) => {
  // Dev convenience only: on by default locally, OFF in production.
  if (getEnv('NODE_ENV') === 'production' && getEnv('AUTH_TEST_MODE') !== '1') {
    return c.text('Dev top-up is disabled in production', 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as { credits?: number };
  const credits = Math.min(Math.max(Math.round(body.credits ?? 100), 1), 1000);
  return c.json(successResponse(await grantDevCredits(c.get('userId'), credits)));
});
export default router;

/** Public: the priced catalog. */
export const consumablesPublic = new Hono();
consumablesPublic.get('/products', (c) =>
  c.json(successResponse(creditProducts()))
);
/**
 * The same server-owned catalog, at the path the shared `ConsumablesApiClient`
 * fetches by default (`/api/v1/public/consumables/offerings`). Credit grants
 * are server-owned; prices come from the RevenueCat SDK on the client.
 */
consumablesPublic.get('/offerings', (c) =>
  c.json(successResponse({ products: creditProducts() }))
);

/**
 * RevenueCat webhook: grants credits for a verified purchase, idempotent on the
 * transaction id. Protected by a shared bearer secret (REVENUECAT_WEBHOOK_AUTH).
 */
export const consumablesWebhook = new Hono();
consumablesWebhook.post('/webhook', async (c) => {
  const expected = getEnv('REVENUECAT_WEBHOOK_AUTH');
  if (expected) {
    const got = c.req.header('authorization');
    if (got !== `Bearer ${expected}`) return c.text('Unauthorized', 401);
  }
  const body = (await c.req.json().catch(() => null)) as {
    event?: {
      app_user_id?: string;
      product_id?: string;
      transaction_id?: string;
      store?: string;
      price_in_purchased_currency?: number;
      currency?: string;
    };
  } | null;
  const e = body?.event;
  if (!e?.app_user_id || !e.product_id || !e.transaction_id) {
    return c.text('Bad Request', 400);
  }
  const credits = creditsForProduct(e.product_id);
  if (!credits) {
    log('warn', 'webhook for unknown product', { product: e.product_id });
    return c.json({ ok: true, ignored: true });
  }
  const store = (e.store ?? '').toLowerCase();
  const source = store.includes('app_store')
    ? 'apple'
    : store.includes('play_store')
      ? 'google'
      : 'web';
  const result = await consumables().recordPurchaseFromWebhook(
    e.app_user_id,
    e.transaction_id,
    credits,
    source,
    e.product_id,
    Math.round((e.price_in_purchased_currency ?? 0) * 100),
    e.currency ?? 'USD'
  );
  return c.json({ ok: true, balance: result.balance });
});
