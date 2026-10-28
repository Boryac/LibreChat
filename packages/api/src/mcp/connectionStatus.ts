import type { MCPServerStatus } from 'librechat-data-provider';
import type { MCPConnectionStateRecord } from './status/types';
import type { ParsedServerConfig } from './types';
import { requiresEphemeralUserConnection, hasRuntimeUrlPlaceholders } from './utils';

interface StatusConnection {
  isStale: (updatedAt?: number) => boolean;
  usesOAuth?: () => boolean;
  connectionState?: MCPServerStatus['connectionState'];
}

interface StatusDependencies<Context> {
  getSharedState: (
    config: ParsedServerConfig,
  ) => Promise<{ record: MCPConnectionStateRecord | null; generation?: string }>;
  getConnectionGeneration: (connection: StatusConnection) => string | undefined;
  isReconnecting: (userId: string, serverName: string) => boolean;
  checkOAuthFlowStatus: (
    userId: string,
    serverName: string,
  ) => Promise<{
    hasActiveFlow: boolean;
    hasFailedFlow: boolean;
  }>;
  hasDurableAuthorization: (
    userId: string,
    serverName: string,
    config: ParsedServerConfig,
    context: Context,
  ) => Promise<boolean>;
  getUserConfigurationState: (
    serverName: string,
    config: ParsedServerConfig,
    context: Context,
  ) => Promise<MCPServerStatus['configurationState']>;
}

function canDetectMCPRuntimeOAuth(config: ParsedServerConfig): boolean {
  return config.requiresOAuth == null && config.apiKey == null && hasRuntimeUrlPlaceholders(config);
}

/** Explicit, generation-fenced connection-attempt observations take precedence over
 * the answering API replica's local transport map. No configuration-derived readiness. */
export async function getMCPServerConnectionStatus<Context>(
  {
    userId,
    serverName,
    config,
    appConnections,
    userConnections,
    oauthServers,
    runtimeContext,
  }: {
    userId: string;
    serverName: string;
    config: ParsedServerConfig;
    appConnections: ReadonlyMap<string, StatusConnection>;
    userConnections: ReadonlyMap<string, StatusConnection>;
    oauthServers: ReadonlySet<string>;
    runtimeContext: Context;
  },
  deps: StatusDependencies<Context>,
): Promise<MCPServerStatus> {
  const connection = appConnections.get(serverName) || userConnections.get(serverName);
  const isStaleOrDoNotExist = connection ? connection?.isStale(config.updatedAt) : true;
  const configuredOAuth = oauthServers.has(serverName);
  const liveConnectionOAuth = connection?.usesOAuth?.() === true;
  const runtimeOAuthCandidate = canDetectMCPRuntimeOAuth(config);
  const requestScoped = requiresEphemeralUserConnection(config);
  const configurationState = requestScoped
    ? await deps.getUserConfigurationState(serverName, config, runtimeContext)
    : undefined;

  const observation = requestScoped ? null : await deps.getSharedState(config);
  const shared = observation?.record;
  const effectiveOAuth = configuredOAuth || liveConnectionOAuth || shared?.requiresOAuth === true;
  const connectionGeneration = connection && deps.getConnectionGeneration(connection);
  const staleGeneration =
    connectionGeneration != null &&
    observation?.generation != null &&
    connectionGeneration !== observation.generation;
  let sharedState = shared?.state;
  if (shared?.state === 'connecting' && shared.deadline <= Date.now()) {
    sharedState = 'error';
  } else if (shared?.state === 'connected' && (shared.verifiedUntil ?? 0) <= Date.now()) {
    sharedState = 'disconnected';
  }
  const baseConnectionState =
    sharedState ??
    (isStaleOrDoNotExist || staleGeneration
      ? 'disconnected'
      : connection?.connectionState || 'disconnected');
  let finalConnectionState = baseConnectionState;
  let requiresOAuth = effectiveOAuth;
  let authorizationState: MCPServerStatus['authorizationState'] = effectiveOAuth
    ? 'needs_authorization'
    : 'not_required';

  // connection state overrides specific to OAuth servers
  if (effectiveOAuth && baseConnectionState === 'connected') {
    authorizationState = 'authorized';
  } else if (effectiveOAuth && baseConnectionState === 'connecting') {
    authorizationState = 'authorizing';
  } else if (effectiveOAuth && baseConnectionState === 'error') {
    authorizationState = 'error';
  } else if (baseConnectionState === 'disconnected' && (effectiveOAuth || runtimeOAuthCandidate)) {
    // check if server is actively being reconnected
    if (deps.isReconnecting(userId, serverName)) {
      requiresOAuth = true;
      finalConnectionState = 'connecting';
      authorizationState = 'authorizing';
    } else {
      const { hasActiveFlow, hasFailedFlow } = await deps.checkOAuthFlowStatus(userId, serverName);

      if (hasFailedFlow) {
        requiresOAuth = true;
        finalConnectionState = 'error';
        authorizationState = 'error';
      } else if (hasActiveFlow) {
        requiresOAuth = true;
        finalConnectionState = 'connecting';
        authorizationState = 'authorizing';
      } else if (
        !shared &&
        (await deps.hasDurableAuthorization(userId, serverName, config, runtimeContext))
      ) {
        /** OAuth readiness is durable even when this pod has no live connection. */
        requiresOAuth = true;
        finalConnectionState = 'connected';
        authorizationState = 'authorized';
      }
    }
  }

  return {
    requiresOAuth,
    ...(requestScoped && { requestScoped: true }),
    ...(configurationState && { configurationState }),
    connectionState: finalConnectionState,
    authorizationState,
  };
}
