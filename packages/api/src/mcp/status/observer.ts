import { randomUUID } from 'crypto';
import type { MCPConnectionStateStore, MCPManagedConnectionObserver } from './types';
import type { MCPConnectionStatusPolicy } from './attempt';
import type { ObservedMCPConnection } from './types';
import { DEFAULT_MCP_CONNECTION_STATUS_POLICY, observeMCPConnection } from './attempt';
import { getMCPToolCatalogGeneration } from '../toolsChanged';

/** Durable manager checkouts can replace or recover a connection after explicit Connect ends. */
export function createMCPConnectionStatusObserver(
  store: MCPConnectionStateStore & {
    getGeneration?: (scope: { userId: string; serverName: string }) => Promise<string | undefined>;
  },
  policyOverrides?: Partial<MCPConnectionStatusPolicy>,
): MCPManagedConnectionObserver {
  const policy = { ...DEFAULT_MCP_CONNECTION_STATUS_POLICY, ...policyOverrides };
  const observers = new WeakMap<ObservedMCPConnection, Map<string, { stop: () => void }>>();
  return async (params) => {
    params.signal?.throwIfAborted();
    const publicationGeneration =
      params.publicationGeneration ?? (await store.getGeneration?.(params));
    if (!publicationGeneration) return;
    const scope = {
      userId: params.userId,
      serverName: params.serverName,
      publicationGeneration,
      configGeneration: getMCPToolCatalogGeneration(params.serverConfig, params.capabilityProfile),
    };
    const current = await store.getMCPConnectionState(scope);
    params.signal?.throwIfAborted();
    // An explicit caller owns its pending result. A fresh checkout may recover an
    // abandoned attempt, but cannot race an active Connect into a false success.
    if (current?.state === 'connecting' && current.deadline > Date.now()) return;
    const ownerKey = JSON.stringify(scope);
    const existing = observers.get(params.connection)?.get(ownerKey);
    if (
      (!params.created || existing != null) &&
      current?.state === 'connected' &&
      (current.verifiedUntil ?? 0) > Date.now()
    )
      return;
    const record = {
      attemptId: randomUUID(),
      state: 'connecting' as const,
      deadline: Date.now() + policy.attemptTimeoutMs,
      requiresOAuth: params.connection.usesOAuth?.() === true,
    };
    const accepted = await store.setMCPConnectionState(
      scope,
      record,
      policy.attemptTimeoutMs + policy.failureRetentionMs,
      current ? true : 'ifAbsent',
      current?.attemptId,
    );
    if (!accepted) return;
    existing?.stop();
    let owners = observers.get(params.connection);
    if (!owners) {
      owners = new Map();
      observers.set(params.connection, owners);
    }
    const observer = observeMCPConnection(params.connection, scope, record, policy, store, () =>
      owners.delete(ownerKey),
    );
    owners.set(ownerKey, observer);
    if (!(await observer.ready)) observer.stop();
  };
}
