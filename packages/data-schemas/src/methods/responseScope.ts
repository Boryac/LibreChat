import { createHash } from 'node:crypto';
import type { ResponseOwner } from '~/models/response';
import { createResponseScopeModel } from '~/models/responseScope';
import { createStoredResponseModel } from '~/models/response';

/** The tenant policy treats missing, null and empty tenant IDs as one partition. */
export function responseOwnerFilter(owner: ResponseOwner): {
  userId: string;
  tenantId: string | { $in: Array<null | string> };
} {
  return { userId: owner.userId, tenantId: owner.tenantId || { $in: [null, ''] } };
}

export async function eraseResponseRecords(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationIds?: readonly string[],
): Promise<void> {
  await createStoredResponseModel(mongoose).deleteMany({
    ...responseOwnerFilter(owner),
    ...(conversationIds ? { conversationId: { $in: conversationIds } } : {}),
  });
}

function scopeKey(owner: ResponseOwner, conversationId?: string): string {
  return createHash('sha256')
    .update(JSON.stringify([owner.tenantId || null, owner.userId, conversationId ?? null]))
    .digest('hex');
}

export function responseScopeKeys(owner: ResponseOwner, conversationId: string): string[] {
  return [scopeKey(owner), scopeKey(owner, conversationId)];
}

/** Initializes only metadata; a late initializer can never reopen an erased scope. */
export async function initializeResponseScopes(
  mongoose: typeof import('mongoose'),
  keys: string[],
): Promise<void> {
  const model = createResponseScopeModel(mongoose);
  for (const key of keys) {
    try {
      await model.updateOne(
        { _id: key },
        { $setOnInsert: { closed: false, revision: 0 } },
        { upsert: true },
      );
    } catch (error) {
      if (
        !(error instanceof mongoose.mongo.MongoServerError) ||
        error.code !== 11000 ||
        !(await model.exists({ _id: key }))
      )
        throw error;
    }
  }
}

export async function isResponseScopeClosed(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationId: string,
): Promise<boolean> {
  return (
    (await createResponseScopeModel(mongoose).exists({
      _id: { $in: responseScopeKeys(owner, conversationId) },
      closed: true,
    })) != null
  );
}

/** Irreversible deletion intent. Ordinary retries complete erasure without readmitting work. */
export async function closeResponseScopes(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationIds?: string[],
): Promise<void> {
  const model = createResponseScopeModel(mongoose);
  const keys = conversationIds?.map((id) => scopeKey(owner, id)) ?? [scopeKey(owner)];
  // Bound each command independently of the number of conversations being removed.
  for (let offset = 0; offset < keys.length; offset += 250) {
    const operations = keys.slice(offset, offset + 250).map((key) => ({
      updateOne: {
        filter: { _id: key },
        update: { $set: { closed: true }, $setOnInsert: { revision: 0 } },
        upsert: true,
      },
    }));
    // Keys already hash tenant + owner; these payload-free anchors have no tenantId column.
    // eslint-disable-next-line no-restricted-syntax
    const close = () => model.bulkWrite(operations, { ordered: false });
    try {
      await close();
    } catch (error) {
      if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) throw error;
      await close();
    }
  }
  await createStoredResponseModel(mongoose).updateMany(
    {
      ...responseOwnerFilter(owner),
      ...(conversationIds ? { conversationId: { $in: conversationIds } } : {}),
      status: { $in: ['queued', 'in_progress', 'requires_action'] },
      cancellationRequestedAt: { $exists: false },
      pendingTerminal: { $exists: false },
    },
    { $set: { cancellationRequestedAt: Date.now() } },
  );
}
