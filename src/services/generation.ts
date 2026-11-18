import { and, desc, eq, lt } from 'drizzle-orm';
import {
  applyFemaleFacialHairRule,
  composePrompt,
  generationParamsSchema,
  type ComposeRequest,
  type Generation,
  type GeneratedImage,
  type GenerateRequest,
  type DescribeRequest,
  type DescribeResponse,
  type AnalyzeRequest,
  type AnalyzeResponse,
  type FaceSpec,
  type SheetRequest,
} from '@sudobility/characterbuilder_types';
import { type PaginatedResponse } from '@sudobility/types';
import { getDb, generations, generationImages } from '../db';
import { HttpError } from '../lib/errors';
import { getStorage, imageUrl } from './storage';
import { getCharacter } from './characters';
import { enqueueGeneration, enqueueSheet } from './jobs';
import { creditCost, releaseCredits, reserveCredits } from './credits';
import { describeToSpecRemote, analyzeImageRemote } from './shapeshyft';

/**
 * Run a flat-cost AI action: reserve its credits atomically (402 if short),
 * run `fn`, and refund if it throws. Charges on success only. Used by the
 * lightweight synchronous AI endpoints (describe/analyze).
 */
async function withCreditCharge<T>(
  entityId: string,
  action: Parameters<typeof creditCost>[0],
  fn: () => Promise<T>
): Promise<T> {
  const cost = creditCost(action);
  const ref = `${action}:${crypto.randomUUID()}`;
  const reserved = await reserveCredits(entityId, cost, ref);
  if (!reserved.success) {
    throw new HttpError(402, 'Not enough credits', {
      required: cost,
      balance: reserved.balance,
    });
  }
  try {
    return await fn();
  } catch (err) {
    await releaseCredits(entityId, cost, ref);
    throw err;
  }
}

/** Resolve the FaceSpec from either a saved character or the inline spec. */
async function resolveSpec(
  entityId: string,
  req: { characterId?: string; spec?: FaceSpec }
): Promise<{ spec: FaceSpec; characterId: string | null }> {
  if (req.characterId) {
    const character = await getCharacter(entityId, req.characterId);
    return { spec: character.spec, characterId: character.id };
  }
  return { spec: req.spec ?? {}, characterId: null };
}

export async function compose(
  entityId: string,
  req: ComposeRequest
): Promise<string> {
  const { spec } = await resolveSpec(entityId, req);
  const params = generationParamsSchema.partial().parse(req.params ?? {});
  return composePrompt(spec, params);
}

/**
 * Describe-to-spec: map a free-text description onto the structured FaceSpec via
 * the `character-describe` LLM endpoint. Charges a flat credit cost
 * (`CREDITS_DESCRIBE`) against the entity, refunded if the model call fails.
 */
export async function describe(
  entityId: string,
  req: DescribeRequest
): Promise<DescribeResponse> {
  const spec = await withCreditCharge(entityId, 'describe', () =>
    describeToSpecRemote(req.description, req.demographics)
  );
  // Keep the inferred spec consistent with the caster: a female never carries
  // facial hair (the describe LLM can misfire on an ambiguous description).
  return { spec: applyFemaleFacialHairRule(spec) };
}

/**
 * Analyze-to-spec (vision): read an uploaded headshot into a partial FaceSpec via
 * the `character-analyze` endpoint. Charges a flat credit cost (`CREDITS_ANALYZE`)
 * against the entity, refunded if the model call fails. The image is transient.
 */
export async function analyze(
  entityId: string,
  req: AnalyzeRequest
): Promise<AnalyzeResponse> {
  const spec = await withCreditCharge(entityId, 'analyze', () =>
    analyzeImageRemote(req.image, req.demographics)
  );
  return { spec: applyFemaleFacialHairRule(spec) };
}

export function toGeneratedImage(
  row: typeof generationImages.$inferSelect
): GeneratedImage {
  return {
    id: row.id,
    mimeType: row.mimeType,
    url: imageUrl(row.id),
    width: row.width,
    height: row.height,
    spec: row.spec ?? undefined,
    prompt: row.prompt ?? undefined,
    role: row.role ?? undefined,
    characterId: row.characterId ?? null,
    note: row.note ?? null,
    shot: row.shot ?? undefined,
  };
}

/**
 * Enqueue an async generation job and return it in its initial `pending` state.
 * The job reserves credits up front, then a background runner casts a fresh spec
 * per image, renders, stores, and settles. Clients poll GET /generations/:id.
 */
export async function generate(
  entityId: string,
  userId: string,
  req: GenerateRequest
): Promise<Generation> {
  // Idempotent replay: a retried request with the same key returns the first job.
  if (req.idempotencyKey) {
    const [existing] = await getDb()
      .select()
      .from(generations)
      .where(
        and(
          eq(generations.userId, userId),
          eq(generations.idempotencyKey, req.idempotencyKey)
        )
      );
    if (existing) return await loadGeneration(entityId, existing.id);
  }

  const id = await enqueueGeneration(entityId, userId, req);
  return await loadGeneration(entityId, id);
}

/** Resolve a stored image the entity owns into a `data:` reference string. */
async function referenceFromImage(entityId: string, imageId: string): Promise<string> {
  const { bytes, mimeType } = await getImageBytes(entityId, imageId);
  const b64 = Buffer.from(bytes).toString('base64');
  return `data:${mimeType};base64,${b64}`;
}

/**
 * Enqueue a staged sheet job (head / body / clothed) and return it `pending`.
 * The conditioning image is resolved here: stage 1 may use an uploaded
 * `referenceImage` (data URL) or a selected `sourceImageId`; stages 2–3 always
 * resolve the selected `sourceImageId`'s bytes. The provider returns the whole
 * sheet in one call (split by the runner).
 */
export async function createSheet(
  entityId: string,
  userId: string,
  req: SheetRequest
): Promise<Generation> {
  if (req.idempotencyKey) {
    const [existing] = await getDb()
      .select()
      .from(generations)
      .where(
        and(
          eq(generations.userId, userId),
          eq(generations.idempotencyKey, req.idempotencyKey)
        )
      );
    if (existing) return await loadGeneration(entityId, existing.id);
  }

  // Validate the owning character (if any) before spending credits — throws
  // CHARACTER_NOT_FOUND for a missing or someone else's character.
  if (req.characterId) await getCharacter(entityId, req.characterId);

  let referenceImage: string;

  if (req.kind === 'head-sheet') {
    if (req.referenceImage && req.sourceImageId) {
      throw new HttpError(400, 'Provide exactly one of sourceImageId or referenceImage');
    }
    if (req.referenceImage) {
      referenceImage = req.referenceImage;
    } else if (req.sourceImageId) {
      referenceImage = await referenceFromImage(entityId, req.sourceImageId);
    } else {
      throw new HttpError(400, 'A head sheet needs a sourceImageId or an uploaded referenceImage');
    }
    const id = await enqueueSheet(entityId, userId, req, {
      kind: 'head-sheet',
      referenceImage,
      traits: req.traits,
    });
    return await loadGeneration(entityId, id);
  }

  if (req.kind === 'body-sheet') {
    referenceImage = await referenceFromImage(entityId, req.sourceImageId);
    const id = await enqueueSheet(entityId, userId, req, {
      kind: 'body-sheet',
      referenceImage,
      body: req.body,
    });
    return await loadGeneration(entityId, id);
  }

  // clothed-sheet
  referenceImage = await referenceFromImage(entityId, req.sourceImageId);
  const clothedId = await enqueueSheet(entityId, userId, req, {
    kind: 'clothed-sheet',
    referenceImage,
    wardrobe: req.wardrobe,
  });
  return await loadGeneration(entityId, clothedId);
}

export async function loadGeneration(
  entityId: string,
  id: string
): Promise<Generation> {
  const [gen] = await getDb()
    .select()
    .from(generations)
    .where(and(eq(generations.id, id), eq(generations.entityId, entityId)));
  if (!gen) throw new HttpError(404, 'Generation not found');
  const imgs = await getDb()
    .select()
    .from(generationImages)
    .where(eq(generationImages.generationId, id));
  return {
    id: gen.id,
    characterId: gen.characterId,
    prompt: gen.prompt ?? '',
    params: gen.params,
    status: gen.status as Generation['status'],
    images: imgs.map(toGeneratedImage),
    creditsSpent: gen.creditsSpent,
    error: gen.error,
    createdAt: gen.createdAt.toISOString(),
    kind: gen.kind ?? 'face',
    sourceImageId: gen.sourceImageId,
  };
}

export async function listGenerations(
  entityId: string,
  limit: number,
  cursor?: string
): Promise<PaginatedResponse<Generation>> {
  const after = cursor
    ? Buffer.from(cursor, 'base64url').toString('utf8')
    : null;
  const where = after
    ? and(eq(generations.entityId, entityId), lt(generations.id, after))
    : eq(generations.entityId, entityId);
  const rows = await getDb()
    .select()
    .from(generations)
    .where(where)
    .orderBy(desc(generations.createdAt), desc(generations.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const nextCursor =
    rows.length > limit
      ? Buffer.from(page[page.length - 1]!.id).toString('base64url')
      : null;
  const items = await Promise.all(
    page.map((r) => loadGeneration(entityId, r.id))
  );
  return {
    success: true,
    data: items,
    timestamp: new Date().toISOString(),
    pagination: { hasNextPage: nextCursor != null, nextCursor, pageSize: limit },
  };
}

/** Metadata (spec, owning character, role) for a single image the entity owns. */
export async function getImage(
  entityId: string,
  imageId: string
): Promise<GeneratedImage> {
  const [row] = await getDb()
    .select()
    .from(generationImages)
    .where(
      and(eq(generationImages.id, imageId), eq(generationImages.entityId, entityId))
    );
  if (!row) throw new HttpError(404, 'Image not found');
  return toGeneratedImage(row);
}

/** Serve raw bytes for an image id the entity owns. */
export async function getImageBytes(
  entityId: string,
  imageId: string
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const [row] = await getDb()
    .select()
    .from(generationImages)
    .where(
      and(eq(generationImages.id, imageId), eq(generationImages.entityId, entityId))
    );
  if (!row) throw new HttpError(404, 'Image not found');
  const bytes = await getStorage().get(row.storageKey);
  if (!bytes) throw new HttpError(404, 'Image bytes not found');
  return { bytes, mimeType: row.mimeType };
}
