/**
 * Entity (tenancy) routes — personal + organization entities, owner/manager/member.
 * Ported verbatim from music_api so all apps share identical entity code; the only
 * per-app differences are the injected `entityHelpers`/`upsertEntityUser` (services/
 * entities.ts) and the `entityInvitations` table import. Mounted at /entities and
 * /invitations behind requireAuth.
 */
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { errorResponse, successResponse } from '@sudobility/types';
import { entityHelpers, upsertEntityUser } from '../services/entities';
import { entityInvitations } from '../db/schema';
import { getDb } from '../db';

const entitiesRouter = new Hono();
const invitationsRouter = new Hono();

entitiesRouter.get('/', async (c) => {
  const userId = c.get('userId');
  const email = c.get('userEmail');
  try {
    await upsertEntityUser(userId, email);
    const result = await entityHelpers.entity.getUserEntities(userId, email ?? undefined);
    return c.json(successResponse(result));
  } catch (error) {
    return c.json(errorResponse(error instanceof Error ? error.message : 'Could not load entities'), 500);
  }
});

entitiesRouter.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.displayName !== 'string' || !body.displayName.trim()) {
    return c.json(errorResponse('displayName is required'), 400);
  }
  try {
    await upsertEntityUser(c.get('userId'), c.get('userEmail'));
    const entity = await entityHelpers.entity.createOrganizationEntity(c.get('userId'), {
      displayName: body.displayName.trim(),
      description: typeof body.description === 'string' ? body.description.trim() : undefined,
    });
    return c.json(successResponse(entity), 201);
  } catch (error) {
    return c.json(errorResponse(error instanceof Error ? error.message : 'Could not create organization'), 400);
  }
});

async function getManageableEntity(entitySlug: string, userId: string) {
  const entity = await entityHelpers.entity.getEntityBySlug(entitySlug);
  if (!entity) return { entity: null, allowed: false };
  return { entity, allowed: await entityHelpers.permissions.canManageMembers(entity.id, userId) };
}

entitiesRouter.get('/:entitySlug', async (c) => {
  const entity = await entityHelpers.entity.getEntityBySlug(c.req.param('entitySlug'));
  if (!entity) return c.json(errorResponse('Entity not found'), 404);
  if (!(await entityHelpers.members.isMember(entity.id, c.get('userId')))) return c.json(errorResponse('Access denied'), 403);
  const role = await entityHelpers.members.getUserRole(entity.id, c.get('userId'));
  return c.json(successResponse({ ...entity, userRole: role }));
});

entitiesRouter.put('/:entitySlug', async (c) => {
  const entity = await entityHelpers.entity.getEntityBySlug(c.req.param('entitySlug'));
  if (!entity) return c.json(errorResponse('Entity not found'), 404);
  if (!(await entityHelpers.permissions.canEditEntity(entity.id, c.get('userId')))) return c.json(errorResponse('Insufficient permissions'), 403);
  if (entity.entityType === 'personal') return c.json(errorResponse('Personal workspace details cannot be edited here'), 400);
  const body = await c.req.json().catch(() => ({}));
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : undefined;
  if (!displayName || displayName.length > 100) return c.json(errorResponse('Workspace name must be 1–100 characters'), 400);
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 500) : undefined;
  try {
    return c.json(successResponse(await entityHelpers.entity.updateEntity(entity.id, { displayName, description })));
  } catch (error) {
    return c.json(errorResponse(error instanceof Error ? error.message : 'Could not update workspace'), 400);
  }
});

entitiesRouter.delete('/:entitySlug', async (c) => {
  const entity = await entityHelpers.entity.getEntityBySlug(c.req.param('entitySlug'));
  if (!entity) return c.json(errorResponse('Entity not found'), 404);
  if (!(await entityHelpers.permissions.canDeleteEntity(entity.id, c.get('userId')))) return c.json(errorResponse('Only an organization owner can delete this workspace'), 403);
  try {
    await entityHelpers.entity.deleteEntity(entity.id);
    return c.json(successResponse(null));
  } catch (error) {
    return c.json(errorResponse(error instanceof Error ? error.message : 'Could not delete workspace'), 400);
  }
});

entitiesRouter.get('/:entitySlug/api-keys', async (c) => {
  const entity = await entityHelpers.entity.getEntityBySlug(c.req.param('entitySlug'));
  if (!entity) return c.json(errorResponse('Entity not found'), 404);
  if (!(await entityHelpers.permissions.canViewApiKeys(entity.id, c.get('userId')))) return c.json(errorResponse('Access denied'), 403);
  return c.json(successResponse(await entityHelpers.apiKeys!.getKeys(entity.id)));
});

entitiesRouter.post('/:entitySlug/api-keys', async (c) => {
  const entity = await entityHelpers.entity.getEntityBySlug(c.req.param('entitySlug'));
  if (!entity) return c.json(errorResponse('Entity not found'), 404);
  if (!(await entityHelpers.permissions.canManageApiKeys(entity.id, c.get('userId')))) return c.json(errorResponse('Insufficient permissions'), 403);
  const body = await c.req.json().catch(() => ({}));
  const keyName = typeof body.key_name === 'string' ? body.key_name.trim() : '';
  if (!keyName || keyName.length > 255) return c.json(errorResponse('key_name must be 1–255 characters'), 400);
  return c.json(successResponse(await entityHelpers.apiKeys!.createKey(entity.id, c.get('userId'), keyName)), 201);
});

entitiesRouter.put('/:entitySlug/api-keys/:keyId', async (c) => {
  const entity = await entityHelpers.entity.getEntityBySlug(c.req.param('entitySlug'));
  if (!entity) return c.json(errorResponse('Entity not found'), 404);
  if (!(await entityHelpers.permissions.canManageApiKeys(entity.id, c.get('userId')))) return c.json(errorResponse('Insufficient permissions'), 403);
  const body = await c.req.json().catch(() => ({}));
  const updates: { keyName?: string; isActive?: boolean } = {};
  if (body.key_name !== undefined) {
    if (typeof body.key_name !== 'string' || !body.key_name.trim() || body.key_name.trim().length > 255) return c.json(errorResponse('key_name must be 1–255 characters'), 400);
    updates.keyName = body.key_name.trim();
  }
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') return c.json(errorResponse('is_active must be a boolean'), 400);
    updates.isActive = body.is_active;
  }
  if (Object.keys(updates).length === 0) return c.json(errorResponse('Provide key_name or is_active'), 400);
  const key = await entityHelpers.apiKeys!.updateKey(entity.id, c.req.param('keyId'), updates);
  if (!key) return c.json(errorResponse('API key not found'), 404);
  return c.json(successResponse(key));
});

entitiesRouter.delete('/:entitySlug/api-keys/:keyId', async (c) => {
  const entity = await entityHelpers.entity.getEntityBySlug(c.req.param('entitySlug'));
  if (!entity) return c.json(errorResponse('Entity not found'), 404);
  if (!(await entityHelpers.permissions.canManageApiKeys(entity.id, c.get('userId')))) return c.json(errorResponse('Insufficient permissions'), 403);
  const revoked = await entityHelpers.apiKeys!.revokeKey(entity.id, c.req.param('keyId'));
  if (!revoked) return c.json(errorResponse('API key not found'), 404);
  return c.json(successResponse(null));
});

entitiesRouter.get('/:entitySlug/members', async (c) => {
  const entity = await entityHelpers.entity.getEntityBySlug(c.req.param('entitySlug'));
  if (!entity) return c.json(errorResponse('Entity not found'), 404);
  if (!(await entityHelpers.permissions.canViewEntity(entity.id, c.get('userId')))) return c.json(errorResponse('Access denied'), 403);
  return c.json(successResponse(await entityHelpers.members.getMembers(entity.id)));
});

entitiesRouter.put('/:entitySlug/members/:memberId', async (c) => {
  const { entity, allowed } = await getManageableEntity(c.req.param('entitySlug'), c.get('userId'));
  if (!entity) return c.json(errorResponse('Entity not found'), 404);
  if (!allowed) return c.json(errorResponse('Insufficient permissions'), 403);
  const body = await c.req.json().catch(() => ({}));
  if (body.role !== 'manager' && body.role !== 'member') return c.json(errorResponse('Role must be manager or member'), 400);
  const member = (await entityHelpers.members.getMembers(entity.id)).find((m) => m.id === c.req.param('memberId'));
  if (!member) return c.json(errorResponse('Member not found'), 404);
  try {
    return c.json(successResponse(await entityHelpers.members.updateMemberRole(entity.id, member.userId, body.role)));
  } catch (error) {
    return c.json(errorResponse(error instanceof Error ? error.message : 'Could not update member role'), 400);
  }
});

entitiesRouter.delete('/:entitySlug/members/:memberId', async (c) => {
  const { entity, allowed } = await getManageableEntity(c.req.param('entitySlug'), c.get('userId'));
  if (!entity) return c.json(errorResponse('Entity not found'), 404);
  if (!allowed) return c.json(errorResponse('Insufficient permissions'), 403);
  const member = (await entityHelpers.members.getMembers(entity.id)).find((m) => m.id === c.req.param('memberId'));
  if (!member) return c.json(errorResponse('Member not found'), 404);
  try {
    await entityHelpers.members.removeMember(entity.id, member.userId);
    return c.json(successResponse(null));
  } catch (error) {
    return c.json(errorResponse(error instanceof Error ? error.message : 'Could not remove member'), 400);
  }
});

entitiesRouter.get('/:entitySlug/invitations', async (c) => {
  const entity = await entityHelpers.entity.getEntityBySlug(c.req.param('entitySlug'));
  if (!entity) return c.json(errorResponse('Entity not found'), 404);
  if (!(await entityHelpers.permissions.canManageMembers(entity.id, c.get('userId')))) return c.json(errorResponse('Insufficient permissions'), 403);
  return c.json(successResponse(await entityHelpers.invitations.getEntityInvitations(entity.id, { status: 'pending' as never })));
});

entitiesRouter.post('/:entitySlug/invitations', async (c) => {
  const entity = await entityHelpers.entity.getEntityBySlug(c.req.param('entitySlug'));
  if (!entity) return c.json(errorResponse('Entity not found'), 404);
  if (!(await entityHelpers.permissions.canInviteMembers(entity.id, c.get('userId')))) return c.json(errorResponse('Insufficient permissions'), 403);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.email !== 'string' || !body.email.includes('@')) return c.json(errorResponse('Valid email is required'), 400);
  try {
    const invitation = await entityHelpers.invitations.createInvitation(entity.id, c.get('userId'), {
      email: body.email.trim().toLowerCase(), role: body.role === 'manager' ? ('manager' as never) : ('member' as never),
    });
    return c.json(successResponse(invitation), 201);
  } catch (error) {
    return c.json(errorResponse(error instanceof Error ? error.message : 'Could not invite member'), 400);
  }
});

entitiesRouter.delete('/:entitySlug/invitations/:invitationId', async (c) => {
  const { entity, allowed } = await getManageableEntity(c.req.param('entitySlug'), c.get('userId'));
  if (!entity) return c.json(errorResponse('Entity not found'), 404);
  if (!allowed) return c.json(errorResponse('Insufficient permissions'), 403);
  const [invitation] = await getDb().select().from(entityInvitations).where(and(
    eq(entityInvitations.id, c.req.param('invitationId')),
    eq(entityInvitations.entity_id, entity.id),
  )).limit(1);
  if (!invitation) return c.json(errorResponse('Invitation not found'), 404);
  await entityHelpers.invitations.cancelInvitation(invitation.id);
  return c.json(successResponse(null));
});

entitiesRouter.put('/:entitySlug/invitations/:invitationId', async (c) => {
  const { entity, allowed } = await getManageableEntity(c.req.param('entitySlug'), c.get('userId'));
  if (!entity) return c.json(errorResponse('Entity not found'), 404);
  if (!allowed) return c.json(errorResponse('Insufficient permissions'), 403);
  const [invitation] = await getDb().select().from(entityInvitations).where(and(
    eq(entityInvitations.id, c.req.param('invitationId')),
    eq(entityInvitations.entity_id, entity.id),
  )).limit(1);
  if (!invitation) return c.json(errorResponse('Invitation not found'), 404);
  try {
    return c.json(successResponse(await entityHelpers.invitations.renewInvitation(invitation.id)));
  } catch (error) {
    return c.json(errorResponse(error instanceof Error ? error.message : 'Could not renew invitation'), 400);
  }
});

invitationsRouter.get('/', async (c) => {
  const email = c.get('userEmail');
  if (!email) return c.json(successResponse([]));
  await upsertEntityUser(c.get('userId'), email);
  return c.json(successResponse(await entityHelpers.invitations.getUserPendingInvitations(email.toLowerCase())));
});

invitationsRouter.post('/:token/accept', async (c) => {
  try {
    const invitation = await entityHelpers.invitations.getInvitationByToken(c.req.param('token'));
    if (!invitation || invitation.email.toLowerCase() !== (c.get('userEmail') ?? '').toLowerCase()) {
      return c.json(errorResponse('Invitation is not assigned to this email address'), 403);
    }
    await upsertEntityUser(c.get('userId'), c.get('userEmail'));
    await entityHelpers.invitations.acceptInvitation(c.req.param('token'), c.get('userId'));
    return c.json(successResponse(null));
  } catch (error) {
    return c.json(errorResponse(error instanceof Error ? error.message : 'Could not accept invitation'), 400);
  }
});

invitationsRouter.post('/:token/decline', async (c) => {
  try {
    const invitation = await entityHelpers.invitations.getInvitationByToken(c.req.param('token'));
    if (!invitation || invitation.email.toLowerCase() !== (c.get('userEmail') ?? '').toLowerCase()) {
      return c.json(errorResponse('Invitation is not assigned to this email address'), 403);
    }
    await entityHelpers.invitations.declineInvitation(c.req.param('token'));
    return c.json(successResponse(null));
  } catch (error) {
    return c.json(errorResponse(error instanceof Error ? error.message : 'Could not decline invitation'), 400);
  }
});

export { entitiesRouter, invitationsRouter };
