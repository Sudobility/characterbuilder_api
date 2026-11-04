import { and, desc, eq, lt, or } from 'drizzle-orm';
import {
  makeId,
  normalizeLegacyHairStyle,
  type Character,
  type CreateCharacterRequest,
  type GeneratedImage,
  type UpdateCharacterRequest,
  type Paginated,
} from '@sudobility/characterbuilder_types';
import { getDb, characters, generationImages } from '../db';
import { HttpError } from '../lib/errors';
import { toGeneratedImage } from './generation';

type Row = typeof characters.$inferSelect;

function toCharacter(r: Row): Character {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    notes: r.notes,
    spec: normalizeLegacyHairStyle(r.spec),
    previewImageId: r.previewImageId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Cursor = base64url("<updatedAtMs>:<id>"), keyset over (updatedAt desc, id desc). */
function encodeCursor(r: Row): string {
  return Buffer.from(`${r.updatedAt.getTime()}:${r.id}`).toString('base64url');
}
function decodeCursor(cursor: string): { ms: number; id: string } | null {
  try {
    const [ms, id] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
    if (!ms || !id) return null;
    return { ms: Number(ms), id };
  } catch {
    return null;
  }
}

export async function listCharacters(
  userId: string,
  limit: number,
  cursor?: string
): Promise<Paginated<Character>> {
  const db = getDb();
  const after = cursor ? decodeCursor(cursor) : null;
  const where = after
    ? and(
        eq(characters.userId, userId),
        or(
          lt(characters.updatedAt, new Date(after.ms)),
          and(
            eq(characters.updatedAt, new Date(after.ms)),
            lt(characters.id, after.id)
          )
        )
      )
    : eq(characters.userId, userId);
  const rows = await db
    .select()
    .from(characters)
    .where(where)
    .orderBy(desc(characters.updatedAt), desc(characters.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1]!) : null;
  return { items: page.map(toCharacter), nextCursor };
}

export async function getCharacter(
  userId: string,
  id: string
): Promise<Character> {
  const [row] = await getDb()
    .select()
    .from(characters)
    .where(and(eq(characters.id, id), eq(characters.userId, userId)));
  if (!row) throw new HttpError('CHARACTER_NOT_FOUND', 'Character not found');
  return toCharacter(row);
}

export async function createCharacter(
  userId: string,
  req: CreateCharacterRequest
): Promise<Character> {
  const id = makeId('character', crypto.randomUUID().replace(/-/g, ''));
  const db = getDb();
  const [row] = await db
    .insert(characters)
    .values({
      id,
      userId,
      name: req.name,
      role: req.role ?? null,
      notes: req.notes ?? null,
      spec: req.spec ?? {},
      previewImageId: req.previewImageId ?? null,
    })
    .returning();
  // Adopt the named image as the character's first headshot (1:M). Scoped to the
  // user and to that ONE image, so naming a different image from the same run
  // creates a SEPARATE character (the link is per-image, not per-generation).
  if (req.previewImageId) {
    await db
      .update(generationImages)
      .set({ characterId: id, note: null })
      .where(
        and(
          eq(generationImages.id, req.previewImageId),
          eq(generationImages.userId, userId)
        )
      );
  }
  return toCharacter(row!);
}

/** Every headshot owned by a character (1:M), newest first. */
export async function listCharacterImages(
  userId: string,
  id: string
): Promise<GeneratedImage[]> {
  await getCharacter(userId, id); // 404 if not owned
  const rows = await getDb()
    .select()
    .from(generationImages)
    .where(
      and(
        eq(generationImages.characterId, id),
        eq(generationImages.userId, userId)
      )
    )
    .orderBy(desc(generationImages.createdAt), desc(generationImages.id));
  return rows.map(toGeneratedImage);
}

/**
 * Remove the association between a headshot and a character (set its
 * character_id to NULL). The image is NOT deleted — it stays in the gallery, it
 * just no longer belongs to this character. If it was the character's hero image,
 * the preview is repointed to the newest remaining headshot (or cleared).
 */
export async function removeCharacterImage(
  userId: string,
  characterId: string,
  imageId: string
): Promise<Character> {
  const character = await getCharacter(userId, characterId); // 404 if not owned
  const db = getDb();
  await db
    .update(generationImages)
    .set({ characterId: null, note: null })
    .where(
      and(
        eq(generationImages.id, imageId),
        eq(generationImages.userId, userId),
        eq(generationImages.characterId, characterId)
      )
    );
  if (character.previewImageId === imageId) {
    const [next] = await db
      .select()
      .from(generationImages)
      .where(
        and(
          eq(generationImages.characterId, characterId),
          eq(generationImages.userId, userId)
        )
      )
      .orderBy(desc(generationImages.createdAt), desc(generationImages.id))
      .limit(1);
    const [row] = await db
      .update(characters)
      .set({ previewImageId: next?.id ?? null, updatedAt: new Date() })
      .where(and(eq(characters.id, characterId), eq(characters.userId, userId)))
      .returning();
    return toCharacter(row!);
  }
  return character;
}

/** Edit only while the image belongs to this user's character. */
export async function updateCharacterImageNote(
  userId: string,
  characterId: string,
  imageId: string,
  note: string | null
): Promise<GeneratedImage> {
  await getCharacter(userId, characterId);
  const [row] = await getDb()
    .update(generationImages)
    .set({ note })
    .where(and(
      eq(generationImages.id, imageId),
      eq(generationImages.userId, userId),
      eq(generationImages.characterId, characterId)
    ))
    .returning();
  if (!row) throw new HttpError('IMAGE_NOT_FOUND', 'Character image not found');
  return toGeneratedImage(row);
}

export async function updateCharacter(
  userId: string,
  id: string,
  req: UpdateCharacterRequest
): Promise<Character> {
  await getCharacter(userId, id); // 404 if not owned
  const patch: Partial<Row> = { updatedAt: new Date() };
  if (req.name !== undefined) patch.name = req.name;
  if (req.role !== undefined) patch.role = req.role;
  if (req.notes !== undefined) patch.notes = req.notes;
  if (req.spec !== undefined) patch.spec = req.spec;
  if (req.previewImageId !== undefined) patch.previewImageId = req.previewImageId;
  const [row] = await getDb()
    .update(characters)
    .set(patch)
    .where(and(eq(characters.id, id), eq(characters.userId, userId)))
    .returning();
  return toCharacter(row!);
}

export async function deleteCharacter(userId: string, id: string): Promise<void> {
  const result = await getDb()
    .delete(characters)
    .where(and(eq(characters.id, id), eq(characters.userId, userId)))
    .returning({ id: characters.id });
  if (result.length === 0)
    throw new HttpError('CHARACTER_NOT_FOUND', 'Character not found');
}
