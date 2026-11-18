/**
 * The distribution endpoint's logic: demographics -> per-trait probability maps.
 *
 * Hybrid design: `buildDistributions` is the deterministic STATIC base
 * (ancestry/age/health/sex weighting from characterbuilder_types). When a fine
 * sub-population is named (e.g. "Korean"), the static tables only know the broad
 * ancestry, so we ask the `character-distribution` LLM endpoint for per-trait
 * ODDS overrides and fold them in. The LLM call is best-effort: any failure
 * falls back to the static base.
 */
import {
  buildDistributions,
  type Demographics,
  type DistributionResponse,
} from '@sudobility/characterbuilder_types';
import { log } from '../lib/log';
import { refineDistributionsRemote } from './shapeshyft';
import { creditCost, releaseCredits, reserveCredits } from './credits';

/**
 * Build (and, for a named sub-population, LLM-refine) the trait distribution.
 *
 * The LLM refine is a PAID enhancement (`CREDITS_DISTRIBUTIONS`): it runs only
 * for a named sub-population AND only when the entity can afford it. If the
 * balance is short, or the model call fails, the charge is released and the
 * free static base is returned — this endpoint drives the editor UI and must
 * never hard-fail on credits, so it degrades gracefully rather than 402-ing.
 */
export async function getDistributions(
  entityId: string,
  demo: Demographics
): Promise<DistributionResponse> {
  let overrides;
  if (demo.subPopulation) {
    const cost = creditCost('distributions');
    const ref = `distributions:${crypto.randomUUID()}`;
    const reserved = await reserveCredits(entityId, cost, ref);
    if (reserved.success) {
      overrides = await refineDistributionsRemote(demo).catch((err) => {
        log('warn', '[distribution] LLM refine failed; using static base', {
          error: err instanceof Error ? err.message : String(err),
        });
        void releaseCredits(entityId, cost, ref);
        return undefined;
      });
    } else {
      // Can't afford the refine — skip the model call, serve the static base.
      log('info', '[distribution] insufficient credits; using static base', {
        required: cost,
        balance: reserved.balance,
      });
    }
  }
  const distributions = buildDistributions(demo, overrides);
  return { demographics: demo, distributions };
}
