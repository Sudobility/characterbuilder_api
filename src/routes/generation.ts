import { Hono } from 'hono';
import {
  analyzeRequestSchema,
  composeRequestSchema,
  cursorQuerySchema,
  describeRequestSchema,
  distributionRequestSchema,
  generateRequestSchema,
  sheetRequestSchema,
  type ComposeResponse,
} from '@sudobility/characterbuilder_types';
import { successResponse } from '@sudobility/types';
import {
  analyze,
  compose,
  createSheet,
  describe,
  generate,
  getImage,
  getImageBytes,
  listGenerations,
  loadGeneration,
} from '../services/generation';
import { getDistributions } from '../services/distribution';
import { ensureUser } from '../services/users';
import { getEntityId } from '../middleware/auth';
import { validate } from './util';

const router = new Hono();

router.post('/compose', validate('json', composeRequestSchema), async (c) => {
  const prompt = await compose(getEntityId(c), c.req.valid('json'));
  return c.json(successResponse<ComposeResponse>({ prompt }));
});

// Demographics -> per-trait probability maps (odds the UI can show; the generate
// flow samples these to cast unset traits). Pure compute, no DB.
router.post(
  '/distributions',
  validate('json', distributionRequestSchema),
  async (c) =>
    c.json(
      successResponse(await getDistributions(getEntityId(c), c.req.valid('json')))
    )
);

// Free-text description -> inferred (partial) FaceSpec via an LLM. Charges a
// flat credit cost (CREDITS_DESCRIBE), refunded if the model call fails.
router.post('/describe', validate('json', describeRequestSchema), async (c) =>
  c.json(successResponse(await describe(await getEntityId(c), c.req.valid('json'))))
);

// Uploaded headshot -> read (partial) FaceSpec via a vision model. Charges a
// flat credit cost (CREDITS_ANALYZE), refunded if the model call fails.
router.post('/analyze', validate('json', analyzeRequestSchema), async (c) =>
  c.json(successResponse(await analyze(await getEntityId(c), c.req.valid('json'))))
);

router.post('/generate', validate('json', generateRequestSchema), async (c) => {
  // Persisting a generation FKs to users(id); ensure the row exists for a
  // signed-in user who generates before ever calling GET /me.
  await ensureUser(c.get('principal'));
  return c.json(
    successResponse(
      await generate(await getEntityId(c), c.get('userId'), c.req.valid('json'))
    )
  );
});

// Staged sheet generation (head / body / clothed). Must be registered before
// any `/generate/:x` param routes (there are none) — a literal path, so order
// is not load-bearing, but keep it next to /generate for clarity.
router.post('/generate/sheet', validate('json', sheetRequestSchema), async (c) => {
  await ensureUser(c.get('principal'));
  return c.json(
    successResponse(
      await createSheet(await getEntityId(c), c.get('userId'), c.req.valid('json'))
    )
  );
});

router.get('/generations', validate('query', cursorQuerySchema), async (c) => {
  const { limit, cursor } = c.req.valid('query');
  return c.json(await listGenerations(getEntityId(c), limit, cursor));
});

router.get('/generations/:id', async (c) =>
  c.json(
    successResponse(await loadGeneration(getEntityId(c), c.req.param('id')))
  )
);

// Metadata for one image (spec, owning character, role) — lets a client resolve
// any image by id without paging the full generation history.
router.get('/images/:id/meta', async (c) =>
  c.json(successResponse(await getImage(getEntityId(c), c.req.param('id'))))
);

router.get('/images/:id', async (c) => {
  const { bytes, mimeType } = await getImageBytes(
    getEntityId(c),
    c.req.param('id')
  );
  return new Response(bytes, {
    headers: {
      'Content-Type': mimeType,
      'Cache-Control': 'private, max-age=86400',
    },
  });
});

export default router;
