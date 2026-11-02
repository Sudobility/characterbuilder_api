/**
 * RevenueCat purchase verification — the one call `/consumables/purchase`
 * makes before crediting an account. Mirrors music_api's service: a
 * module-level seam so a test can replace the network client.
 *
 * Reads `REVENUECAT_SECRET_API_KEY` (a RevenueCat REST secret key) lazily, so
 * nothing is required until a purchase is actually confirmed.
 */
import { RevenueCatClient } from '@sudobility/consumables_service';
import { getRequiredEnv } from '../lib/env-helper';

/** The one call this service makes to RevenueCat. */
export type PurchaseVerifier = Pick<RevenueCatClient, 'findCustomerPurchase'>;

let client: RevenueCatClient | null = null;
let injected: PurchaseVerifier | null = null;

/** Test hook: replace the verifier (null restores the real client). */
export function setPurchaseVerifier(next: PurchaseVerifier | null): void {
  injected = next;
}

function revenueCat(): PurchaseVerifier {
  if (injected) return injected;
  if (!client) {
    client = new RevenueCatClient({
      apiKey: getRequiredEnv('REVENUECAT_SECRET_API_KEY'),
    });
  }
  return client;
}

/** Test hook: drop the cached client so a changed environment is picked up. */
export function resetRevenueCatClient(): void {
  client = null;
}

export async function findRevenueCatPurchase(
  appUserId: string,
  transactionId: string,
  productId: string
) {
  return revenueCat().findCustomerPurchase(appUserId, transactionId, productId);
}
