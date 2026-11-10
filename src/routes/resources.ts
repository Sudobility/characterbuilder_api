/**
 * @fileoverview Public GET /api/v1/resources — this app's view of the shared
 * Sudobility resources catalog.
 *
 * characterbuilder owns no resources data: it forwards the read to the central
 * sudobility_api (api.sudobility.com) pinning app="characterbuilder", via
 * @sudobility/resources_service's ResourcesForwarder. Public read; writes are
 * curated through sudobility_api's admin key/MCP, never here.
 */
import { Hono } from 'hono';
import { ResourcesForwarder } from '@sudobility/resources_service';
import { getEnv } from '../lib/env-helper';

const forwarder = new ResourcesForwarder({
  baseUrl: getEnv('SUDOBILITY_API_URL', 'https://api.sudobility.com')!,
  app: 'characterbuilder',
});

const resourcesRouter = new Hono();

resourcesRouter.get('/', async (c) => {
  const locale = c.req.query('locale') || undefined;
  try {
    const { resources } = await forwarder.list(locale);
    return c.json({ resources });
  } catch (err) {
    console.error('[resources] forward to sudobility_api failed:', err);
    return c.json({ resources: [] });
  }
});

export default resourcesRouter;
