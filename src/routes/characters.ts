import { Hono } from 'hono';
import {
  createCharacterRequestSchema,
  cursorQuerySchema,
  updateCharacterRequestSchema,
  updateCharacterImageNoteSchema,
} from '@sudobility/characterbuilder_types';
import { successResponse } from '@sudobility/types';
import {
  createCharacter,
  deleteCharacter,
  getCharacter,
  listCharacterImages,
  listCharacters,
  removeCharacterImage,
  updateCharacter,
  updateCharacterImageNote,
} from '../services/characters';
import { ensureUser } from '../services/users';
import { getEntityId } from '../middleware/auth';
import { validate } from './util';

const router = new Hono();

router.get('/', validate('query', cursorQuerySchema), async (c) => {
  const { limit, cursor } = c.req.valid('query');
  return c.json(await listCharacters(getEntityId(c), limit, cursor));
});

router.post('/', validate('json', createCharacterRequestSchema), async (c) => {
  // characters.user_id FKs to users(id); onboard a signed-in user who creates
  // a character before ever calling GET /me.
  await ensureUser(c.get('principal'));
  return c.json(
    successResponse(
      await createCharacter(getEntityId(c), c.get('userId'), c.req.valid('json'))
    ),
    201
  );
});

router.get('/:id', async (c) =>
  c.json(successResponse(await getCharacter(getEntityId(c), c.req.param('id'))))
);

// Every headshot owned by this character (1:M).
router.get('/:id/images', async (c) =>
  c.json(
    successResponse(await listCharacterImages(getEntityId(c), c.req.param('id')))
  )
);

// Remove a headshot from this character (clears the association; keeps the image).
router.delete('/:id/images/:imageId', async (c) =>
  c.json(
    successResponse(
      await removeCharacterImage(
        getEntityId(c),
        c.req.param('id'),
        c.req.param('imageId')
      )
    )
  )
);

router.patch(
  '/:id/images/:imageId',
  validate('json', updateCharacterImageNoteSchema),
  async (c) => c.json(successResponse(await updateCharacterImageNote(
    getEntityId(c), c.req.param('id'), c.req.param('imageId'), c.req.valid('json').note
  )))
);

router.patch(
  '/:id',
  validate('json', updateCharacterRequestSchema),
  async (c) =>
    c.json(
      successResponse(
        await updateCharacter(
          getEntityId(c),
          c.req.param('id'),
          c.req.valid('json')
        )
      )
    )
);

router.delete('/:id', async (c) => {
  await deleteCharacter(getEntityId(c), c.req.param('id'));
  return c.json(successResponse({ deleted: true }));
});

export default router;
