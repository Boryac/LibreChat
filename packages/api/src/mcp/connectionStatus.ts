import type { MCPServerStatus } from 'librechat-data-provider';
import type { MCPConnectionStateRecord } from './status/types';
import type { ParsedServerConfig } from './types';
import {
  requiresEphemeralUserConnection,
  hasRuntimeUrlPlaceholders,
  hasCustomUserVars,
} from './utils';
import { projectMCPConnectionAttempt } from './status/projection';

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
  const isStaleOrDoNotExist = connection ? connection.isStale(config.updatedAt) : true;
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
  const now = shared?.serverNow ?? Date.now();
  let sharedState = shared?.statusUnavailable ? ('disconnected' as const) : shared?.state;
  if (shared?.state === 'connecting' && shared.deadline <= now) {
    sharedState = 'error';
  } else if (shared?.state === 'connected' && (shared.verifiedUntil ?? 0) <= now) {
    sharedState = 'disconnected';
  }
  // A process-local socket cannot establish a deployment-wide result, including
  // after the retained operation expires. OAuth's durable authorization fallback is separate.
  const baseConnectionState =
    sharedState ??
    ((effectiveOAuth || requestScoped) && !isStaleOrDoNotExist && !staleGeneration
      ? (connection?.connectionState ?? 'disconnected')
      : 'disconnected');
  let finalConnectionState = baseConnectionState;
  let requiresOAuth = effectiveOAuth;
  let authorizationState: MCPServerStatus['authorizationState'] = effectiveOAuth
    ? 'needs_authorization'
    : 'not_required';

  // connection state overrides specific to OAuth servers
  if (shared?.statusUnavailable && effectiveOAuth) {
    authorizationState = (await deps.hasDurableAuthorization(
      userId,
      serverName,
      config,
      runtimeContext,
    ))
      ? 'authorized'
      : 'needs_authorization';
  } else if (effectiveOAuth && baseConnectionState === 'connected') {
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
      } else if (await deps.hasDurableAuthorization(userId, serverName, config, runtimeContext)) {
        /** OAuth readiness is durable even when this pod has no live connection. */
        requiresOAuth = true;
        finalConnectionState = shared ? baseConnectionState : 'connected';
        authorizationState = 'authorized';
      }
    }
  }

  const statusUnavailable =
    finalConnectionState === 'disconnected' &&
    !requestScoped &&
    (shared?.statusUnavailable === true || authorizationState !== 'needs_authorization');
  return {
    connectionObservationAvailable: observation?.generation != null,
    ...(observation?.generation && { authorizationGeneration: observation.generation }),
    ...(shared && {
      connectionAttempt: projectMCPConnectionAttempt(shared, observation?.generation),
    }),
    ...(statusUnavailable && { statusUnavailable: true }),
    requiresOAuth,
    ...(requestScoped && { requestScoped: true }),
    ...(configurationState && { configurationState }),
    connectionState: finalConnectionState,
    authorizationState,
  };
}

/** A display-store outage provides no connectivity or authorization evidence. */
export function getUnavailableMCPServerStatus(
  config: ParsedServerConfig,
  requiresOAuth: boolean,
): MCPServerStatus {
  return {
    connectionState: 'disconnected',
    connectionObservationAvailable: false,
    statusUnavailable: true,
    requiresOAuth,
    ...(requiresEphemeralUserConnection(config) && { requestScoped: true }),
    ...(requiresEphemeralUserConnection(config) &&
      hasCustomUserVars(config) && { configurationState: 'needs_configuration' as const }),
  };
}

/** Absence is authoritative only when the surrounding read fence matches its scope. */
export function finalizeMCPConnectionStatus(
  status: MCPServerStatus,
  generation?: string,
): MCPServerStatus {
  const available =
    status.connectionObservationAvailable === true &&
    generation != null &&
    status.authorizationGeneration === generation;
  if (status.connectionObservationAvailable && !available) {
    return {
      ...status,
      connectionObservationAvailable: false,
      connectionState: 'disconnected',
      connectionAttempt: undefined,
      authorizationGeneration: undefined,
      authorizationState: undefined,
      statusUnavailable: true,
    };
  }
  return {
    ...status,
    connectionObservationAvailable: available,
    authorizationGeneration: generation,
  };
}
