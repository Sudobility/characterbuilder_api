/**
 * Entity layer (@sudobility/entity_service). Credits are owned by an *entity*,
 * not a user. Full music parity: every user gets a personal entity and can
 * create organization entities with members/invitations/API keys, and domain
 * data (characters/generations/images) is entity-owned. Kept byte-identical to
 * music_api's services/entities.ts except the documented per-app seams: the
 * `keyPrefix`/`usersTable` (entityUsersTable alias over this app's `users`
 * table), the raw-client accessor name (`getClient`), and the domain-table
 * backfill in `resolveEntity` (characters/generations/generation_images here
 * vs. projects/snapshots in music). Helpers are built lazily so the DB-free
 * test suite can import the app without DATABASE_URL.
 */
import {
  createEntityHelpers,
  type ApiKeyHelperConfig,
  type InvitationHelperConfig,
} from '@sudobility/entity_service';
import { eq } from 'drizzle-orm';
import { getClient, getDb } from '../db';
import {
  entities,
  entityApiKeys,
  entityInvitations,
  entityMembers,
  entityUsersTable,
  users,
} from '../db/schema';

// Built lazily so importing this module (and the app) does not require
// DATABASE_URL — `getDb()` constructs the postgres client eagerly. The DB-free
// test suite imports the app without a database configured.
let _helpers: ReturnType<typeof createEntityHelpers> | null = null;
function buildHelpers(): ReturnType<typeof createEntityHelpers> {
  if (!_helpers) {
    const config: InvitationHelperConfig & ApiKeyHelperConfig = {
      db: getDb() as never,
      entitiesTable: entities,
      membersTable: entityMembers,
      invitationsTable: entityInvitations,
      apiKeysTable: entityApiKeys,
      keyPrefix: 'cbuilder',
      usersTable: entityUsersTable,
    };
    _helpers = createEntityHelpers(config);
  }
  return _helpers;
}

/** Entity helpers (entity/members/invitations/apiKeys). Lazily initialised. */
export const entityHelpers = new Proxy(
  {} as ReturnType<typeof createEntityHelpers>,
  { get: (_t, prop) => buildHelpers()[prop as keyof ReturnType<typeof createEntityHelpers>] }
);

/**
 * The id of a user's personal entity (the one credits are keyed to). Used by
 * background jobs that settle credits detached from the request, where only the
 * `userId` is on the job row. CharacterBuilder has one personal entity per user,
 * so this is deterministic and matches the entity used to reserve at enqueue.
 */
export async function personalEntityId(userId: string): Promise<string> {
  const entity = await entityHelpers.entity.getOrCreatePersonalEntity(userId);
  return entity.id;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ensure a `users` row exists (entity_service reads it to name a workspace). */
export async function upsertEntityUser(userId: string, email: string | null) {
  await getDb()
    .insert(users)
    .values({ id: userId, email, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: users.id,
      set: { ...(email ? { email } : {}), updatedAt: new Date() },
    });
}

/**
 * Resolve the entity to use for this request and reject ids the user cannot
 * access. Also folds any pre-entity, uid-keyed credit rows into the user's
 * personal entity — this is the migration path for existing users (runs on
 * every request, never once, so a stray uid-keyed grant can't be stranded).
 */
export async function resolveEntity(
  userId: string,
  email: string | null,
  requestedId?: string | null
) {
  await upsertEntityUser(userId, email);
  const personalEntity = await entityHelpers.entity.getOrCreatePersonalEntity(
    userId,
    email ?? undefined
  );
  const [user] = await getDb()
    .select({ activeEntityId: users.activeEntityId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  // Backfill entity-owned domain data: tag this user's characters, generations
  // and images with their personal entity (idempotent — only rows not yet
  // tagged). Cheap no-op once migrated.
  await getClient()`UPDATE characters SET entity_id = ${personalEntity.id} WHERE user_id = ${userId} AND entity_id IS NULL`;
  await getClient()`UPDATE generations SET entity_id = ${personalEntity.id} WHERE user_id = ${userId} AND entity_id IS NULL`;
  await getClient()`UPDATE generation_images SET entity_id = ${personalEntity.id} WHERE user_id = ${userId} AND entity_id IS NULL`;

  // Fold any uid-owned balance/history into the personal entity. `DELETE ...
  // RETURNING` takes the balance row atomically so two concurrent requests
  // cannot both move it. With nothing under the uid this is one PK lookup.
  await getClient().begin(async (tx) => {
    await tx`
      INSERT INTO entity_credit_migrations (user_id, entity_id)
      VALUES (${userId}, ${personalEntity.id})
      ON CONFLICT (user_id) DO NOTHING
    `;
    const [stranded] = await tx`
      DELETE FROM consumable_balances WHERE user_id = ${userId}
      RETURNING balance, initial_credits, created_at, updated_at
    `;
    if (!stranded) return;
    await tx`
      INSERT INTO consumable_balances (user_id, balance, initial_credits, created_at, updated_at)
      VALUES (${personalEntity.id}, ${stranded.balance}, ${stranded.initial_credits}, ${stranded.created_at}, ${stranded.updated_at})
      ON CONFLICT (user_id) DO UPDATE SET
        balance = consumable_balances.balance + EXCLUDED.balance,
        initial_credits = consumable_balances.initial_credits + EXCLUDED.initial_credits,
        updated_at = NOW()
    `;
    await tx`UPDATE consumable_purchases SET user_id = ${personalEntity.id}, entity_id = ${personalEntity.id} WHERE user_id = ${userId}`;
    await tx`UPDATE consumable_usages SET user_id = ${personalEntity.id}, entity_id = ${personalEntity.id} WHERE user_id = ${userId}`;
  });

  if (requestedId && !UUID_RE.test(requestedId)) throw new Error('Invalid entity ID');
  let entity;
  if (requestedId) {
    // Asked for by id: one the user cannot reach is refused, never swapped.
    entity = await entityHelpers.entity.getEntity(requestedId);
    if (!entity) throw new Error('Entity not found');
    if (!(await entityHelpers.members.isMember(entity.id, userId))) {
      throw new Error('Access denied');
    }
  } else {
    // Only remembered: a workspace since deleted, or left, falls back to the
    // personal one. Refusing it would fail every request the user makes.
    const remembered = user?.activeEntityId
      ? await entityHelpers.entity.getEntity(user.activeEntityId)
      : null;
    entity =
      remembered && (await entityHelpers.members.isMember(remembered.id, userId))
        ? remembered
        : personalEntity;
  }
  await getDb()
    .update(users)
    .set({ activeEntityId: entity.id, updatedAt: new Date() })
    .where(eq(users.id, userId));
  return entity;
}
