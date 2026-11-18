/**
 * Credit coupons (mounted under /consumables, behind requireAuth). Site admins
 * issue 8-char codes; any user redeems one to their active entity. Adapted from
 * music_api — characterbuilder reads siteAdmin/email off the principal and uses
 * the entity already resolved onto the context by requireAuth.
 */
import { randomInt } from 'node:crypto';
import { Hono } from 'hono';
import { errorResponse, successResponse } from '@sudobility/types';
import { getClient } from '../db';
import { getEntityBalance } from '../services/credits';
import { getEntityId } from '../middleware/auth';

const router = new Hono();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function createCode(): string {
  return Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
}

router.post('/coupons', async (c) => {
  if (!c.get('principal').siteAdmin) {
    return c.json(errorResponse('Site admin access required'), 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const credits = Number(body.credits);
  const expiresAt = new Date(body.expires_at);
  const email =
    typeof body.email === 'string' && body.email.trim()
      ? body.email.trim().toLowerCase()
      : null;
  if (!Number.isSafeInteger(credits) || credits < 1 || credits > 10_000_000) {
    return c.json(errorResponse('credits must be a positive integer'), 400);
  }
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    return c.json(errorResponse('Expiration must be a future datetime'), 400);
  }

  const sql = getClient();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = createCode();
    const created = await sql`
      INSERT INTO credit_coupons (code, credits, expires_at, assigned_email, created_by_user_id)
      VALUES (${code}, ${credits}, ${expiresAt}, ${email}, ${c.get('userId')})
      ON CONFLICT (code) DO NOTHING
      RETURNING code
    `;
    if (created.length) return c.json(successResponse({ code }), 201);
  }
  return c.json(errorResponse('Could not allocate a unique coupon code'), 500);
});

router.get('/coupons/history', async (c) => {
  if (!c.get('principal').siteAdmin) {
    return c.json(errorResponse('Site admin access required'), 403);
  }
  const rows = await getClient()`
    SELECT c.code, c.credits, c.expires_at, c.assigned_email, c.created_at,
      r.entity_id, r.redeemed_by_user_id, r.redeemed_at
    FROM credit_coupons c
    LEFT JOIN credit_coupon_redemptions r ON r.code = c.code
    ORDER BY c.created_at DESC, r.redeemed_at DESC NULLS LAST
    LIMIT 500
  `;
  return c.json(
    successResponse(
      rows.map((row) => ({
        code: row.code,
        credits: row.credits,
        expiresAt: new Date(row.expires_at).toISOString(),
        email: row.assigned_email,
        createdAt: new Date(row.created_at).toISOString(),
        entityId: row.entity_id,
        redeemedByUserId: row.redeemed_by_user_id,
        redeemedAt: row.redeemed_at ? new Date(row.redeemed_at).toISOString() : null,
      }))
    )
  );
});

router.post('/redeem-coupon', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{8}$/.test(code)) {
    return c.json(errorResponse('Enter a valid 8-character coupon code'), 400);
  }

  const entityId = await getEntityId(c);
  const userEmail = c.get('principal').email;

  // Ensure the entity has its initial balance before the atomic coupon update.
  await getEntityBalance(entityId);
  try {
    const result = await getClient().begin(async (tx) => {
      const [coupon] = await tx`
        SELECT code, credits, expires_at, assigned_email
        FROM credit_coupons WHERE code = ${code} FOR UPDATE
      `;
      if (!coupon) throw new Error('Coupon code was not found');
      if (new Date(coupon.expires_at).getTime() <= Date.now()) {
        throw new Error('Coupon code has expired');
      }
      if (
        coupon.assigned_email &&
        coupon.assigned_email.toLowerCase() !== (userEmail ?? '').toLowerCase()
      ) {
        throw new Error('This coupon is assigned to another email address');
      }
      const inserted = await tx`
        INSERT INTO credit_coupon_redemptions (code, entity_id, redeemed_by_user_id, credits)
        VALUES (${code}, ${entityId}, ${c.get('userId')}, ${coupon.credits})
        ON CONFLICT (code, entity_id) DO NOTHING
        RETURNING code
      `;
      if (!inserted.length) {
        throw new Error('This coupon has already been redeemed by this entity');
      }
      const [balance] = await tx`
        UPDATE consumable_balances
        SET balance = balance + ${coupon.credits}, updated_at = NOW()
        WHERE user_id = ${entityId}
        RETURNING balance
      `;
      if (!balance) throw new Error('Entity credit balance is unavailable');
      return { balance: balance.balance as number, credits: coupon.credits as number };
    });
    return c.json(successResponse({ ...result, entityId }));
  } catch (error) {
    return c.json(
      errorResponse(error instanceof Error ? error.message : 'Coupon redemption failed'),
      400
    );
  }
});

export default router;
