import { Hono } from 'hono';
import { visualStyleGroups } from '@sudobility/characterbuilder_types';
import { requireAuth } from '../middleware/auth';
import me from './me';
import characters from './characters';
import generation from './generation';
import consumablesBalance, {
  consumablesPublic,
  consumablesWebhook,
} from './consumables';
import resources from './resources';

const routes = new Hono();
routes.get('/visual-styles', (c) => c.json({ success: true, data: { groups: visualStyleGroups } }));

// Guard the authenticated prefixes (registered before the routers they protect).
routes.use('/me', requireAuth);
routes.use('/me/*', requireAuth);
routes.use('/characters', requireAuth);
routes.use('/characters/*', requireAuth);
routes.use('/compose', requireAuth);
routes.use('/distributions', requireAuth);
routes.use('/generate', requireAuth);
routes.use('/generations', requireAuth);
routes.use('/generations/*', requireAuth);
routes.use('/images/*', requireAuth);
routes.use('/consumables/balance', requireAuth);
routes.use('/consumables/dev-topup', requireAuth);
routes.use('/consumables/purchases', requireAuth);
routes.use('/consumables/usages', requireAuth);
routes.use('/consumables/purchase', requireAuth);

// Public: product catalog + RevenueCat webhook (no auth). The shared
// ConsumablesApiClient fetches the catalog from `/api/v1/public/consumables/...`
// by default, so the catalog is mounted under both the bare and the `public`
// prefix (the `public` one is what the client actually hits).
routes.route('/consumables', consumablesPublic);
routes.route('/public/consumables', consumablesPublic);
routes.route('/consumables', consumablesWebhook);

// Authenticated.
routes.route('/consumables', consumablesBalance);
routes.route('/me', me);
routes.route('/characters', characters);
// Public resources catalog (forwards to sudobility_api).
routes.route('/resources', resources);
routes.route('/', generation);

export default routes;
