/**
 * @fileoverview Public GET /api/v1/resources/data — this app's one-call view of
 * the shared Sudobility resources catalog (sectioned: section → resources).
 *
 * characterbuilder owns no resources data: it forwards the aggregate read to
 * the central sudobility_api (api.sudobility.com) pinning app="characterbuilder",
 * via @sudobility/resources_service's ResourcesForwarder. Public read; CRUD is
 * curated centrally through sudobility_api's admin key/MCP, never here.
 */
import { Hono } from 'hono';
import { ResourcesForwarder } from '@sudobility/resources_service';
import { getEnv } from '../lib/env-helper';

const forwarder = new ResourcesForwarder({
  baseUrl: getEnv('SUDOBILITY_API_URL', 'https://api.sudobility.com')!,
  app: 'characterbuilder',
});

const resourcesRouter = new Hono();

resourcesRouter.get('/data', async (c) => {
  const lang = c.req.query('lang') || 'en';
  try {
    const { sections } = await forwarder.data(lang);
    return c.json({ sections });
  } catch (err) {
    console.error('[resources] forward to sudobility_api failed:', err);
    return c.json({ sections: [] });
  }
});

export default resourcesRouter;
