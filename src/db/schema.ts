/**
 * Drizzle schema — mirrors the raw DDL in `initDatabase()` (index.ts). The
 * consumable ledger tables are `@sudobility/consumables_service`'s own shape,
 * copied verbatim (the music_api / screenwriter_api pattern).
 */
import {
  pgTable,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  serial,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  createEntitiesTablePublic,
  createEntityApiKeysTablePublic,
  createEntityInvitationsTablePublic,
  createEntityMembersTablePublic,
} from '@sudobility/entity_service';
import type {
  Demographics,
  FaceSpec,
  GenerationParams,
} from '@sudobility/characterbuilder_types';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email'),
  emailVerified: boolean('email_verified').notNull().default(false),
  displayName: text('display_name'),
  // The user's currently-selected entity (credits are keyed to an entity, not
  // the user). Null until the first authenticated request resolves a personal
  // entity. See services/entities.ts `resolveEntity`.
  activeEntityId: uuid('active_entity_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/*
 * Alias mapping of the `users` table with the drizzle PROPERTY names
 * `@sudobility/entity_service` expects (firebase_uid/email/display_name) — our
 * canonical `users` table uses id/displayName. Passed as `usersTable` to
 * createEntityHelpers so its member joins resolve. Reads only.
 */
export const entityUsersTable = pgTable('users', {
  firebase_uid: text('id').primaryKey(),
  email: text('email'),
  display_name: text('display_name'),
});

/*
 * Entity layer (@sudobility/entity_service). Credits are owned by an *entity*,
 * not a user; every user gets one personal entity on first request and can
 * create organization entities with members/invitations/API keys (full music
 * parity). Domain tables (characters/generations/…) are entity-owned via their
 * `entity_id` column.
 */
export const entities = createEntitiesTablePublic('characterbuilder');
export const entityMembers = createEntityMembersTablePublic('characterbuilder');
export const entityInvitations = createEntityInvitationsTablePublic('characterbuilder');
export const entityApiKeys = createEntityApiKeysTablePublic('characterbuilder');

export const characters = pgTable('characters', {
  id: text('id').primaryKey(),
  // `userId` is the creator/author; ownership is scoped by `entityId` (the
  // user's personal entity). Both are kept in sync so history follows the
  // entity, mirroring music/screenwriter's entity-owned domain tables.
  userId: text('user_id').notNull(),
  entityId: uuid('entity_id'),
  // Nullable: a character is born when the user names a generated image, and
  // "deleting" one just clears the name (hidden from the Characters list, row
  // and image kept).
  name: text('name'),
  role: text('role'),
  notes: text('notes'),
  spec: jsonb('spec').$type<FaceSpec>().notNull().default({}),
  previewImageId: text('preview_image_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const generations = pgTable('generations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  entityId: uuid('entity_id'),
  characterId: text('character_id'),
  // The job's inputs: a base (partial) spec the caster fills per image, plus the
  // demographics that steer that casting. `prompt` holds the first image's prompt
  // (kept for history; each image records its own prompt on generation_images).
  spec: jsonb('spec').$type<FaceSpec>(),
  demographics: jsonb('demographics').$type<Demographics>(),
  prompt: text('prompt'),
  // The user's free-text prompt (simplified /new flow), appended to the composed
  // image prompt at render time so the model has the original wording.
  description: text('description'),
  imageNote: text('image_note'),
  params: jsonb('params').$type<GenerationParams>().notNull(),
  // The single-image `face` flow, or a sheet stage; and, for a sheet, the prior
  // image it was conditioned on.
  kind: text('kind').notNull().default('face'),
  sourceImageId: text('source_image_id'),
  status: text('status').notNull().default('pending'),
  creditsSpent: integer('credits_spent').notNull().default(0),
  reservedCredits: integer('reserved_credits').notNull().default(0),
  error: text('error'),
  idempotencyKey: text('idempotency_key'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

export const generationImages = pgTable('generation_images', {
  id: text('id').primaryKey(),
  generationId: text('generation_id').notNull(),
  userId: text('user_id').notNull(),
  entityId: uuid('entity_id'),
  storageKey: text('storage_key').notNull(),
  mimeType: text('mime_type').notNull().default('image/png'),
  // The fully-cast spec and composed prompt that produced THIS image.
  spec: jsonb('spec').$type<FaceSpec>(),
  prompt: text('prompt'),
  // For a sheet image, its view/direction label (e.g. `front`, `back-left`).
  role: text('role'),
  // The character that owns this headshot (a character has many headshots, 1:M).
  // Null = a loose candidate not yet named into a character.
  characterId: text('character_id'),
  note: text('note'),
  // The framing this image was rendered at (headshot | bust | three-quarter |
  // full-length). Lets a character separate its headshots from full-body shots.
  shot: text('shot'),
  width: integer('width'),
  height: integer('height'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/* ── consumables ledger (consumables_service shape) ── */

// The `user_id` column holds an ENTITY id (credits are entity-owned). The
// nullable `entity_id` column + the `set_consumable_entity_id` trigger (see
// index.ts) backfill it when `user_id` is a UUID, mirroring music_api.
export const consumableBalances = pgTable('consumable_balances', {
  user_id: varchar('user_id', { length: 128 }).primaryKey(),
  balance: integer('balance').notNull().default(0),
  initial_credits: integer('initial_credits').notNull().default(0),
  entity_id: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

export const consumablePurchases = pgTable('consumable_purchases', {
  id: serial('id').primaryKey(),
  user_id: varchar('user_id', { length: 128 }).notNull(),
  credits: integer('credits').notNull(),
  source: varchar('source', { length: 20 }).notNull(),
  transaction_ref_id: varchar('transaction_ref_id', { length: 255 }),
  product_id: varchar('product_id', { length: 255 }),
  price_cents: integer('price_cents'),
  currency: varchar('currency', { length: 10 }),
  entity_id: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
  created_at: timestamp('created_at').defaultNow().notNull(),
});

export const consumableUsages = pgTable('consumable_usages', {
  id: serial('id').primaryKey(),
  user_id: varchar('user_id', { length: 128 }).notNull(),
  credits: integer('credits').notNull().default(1),
  reference: varchar('reference', { length: 500 }),
  filename: varchar('filename', { length: 500 }),
  entity_id: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
  created_at: timestamp('created_at').defaultNow().notNull(),
});
