import { logger } from '@librechat/data-schemas';
import { resolveMCPAppsPolicy } from 'librechat-data-provider';
import type { MCPReinitializeResponse, TMCPAppsPolicy } from 'librechat-data-provider';
import type { AppConfig, PluginAuthMethods } from '@librechat/data-schemas';
import type { Request, RequestHandler, Response } from 'express';
import type { MCPConnectionStateStore, ObservedMCPConnection } from './types';
import type { MCPServerCatalogRecoveryPolicy } from '../catalog/recovery';
import type { MCPServersRegistry } from '../registry/MCPServersRegistry';
import type { AuthIdentityContext } from '~/utils/identity';
import type { UpstreamTokenProvider } from '../oauth/obo';
import type { ParsedServerConfig } from '../types';
import { validateMCPConnectionAttemptId, getMCPConnectionAttemptErrorResponse } from './request';
import { MCPAuthenticationRejectedError, MCPAuthenticationRefreshError } from '../errors';
import { resolveMCPClientCapabilityProfile } from '../capabilities';
import { resolveMCPReinitializeConfig } from '../reinitialize';
import { createAuthIdentityContext } from '~/utils/identity';
import { OpenIDReauthRequiredError } from '~/utils/oidc';
import { mcpConfig as mcpSettings } from '../mcpConfig';
import { runMCPConnectionAttempt } from './attempt';
import { MCPOAuthHandler } from '../oauth/handler';
import { setOAuthCsrfCookie } from '~/oauth/csrf';
import { createSafeUser } from '~/utils/env';
import { getUserMCPAuthMap } from '../auth';

type Principal = NonNullable<Parameters<typeof createSafeUser>[0]> & { idOnTheSource?: string };
type ReinitializeRequest = Request<{ serverName: string }, unknown, { attemptId?: unknown }> & {
  user: Principal;
  config?: AppConfig;
};

export interface MCPReinitializeDependencies extends MCPConnectionStateStore {
  getMCPManager: () => {
    disconnectUserConnection: (userId: string, serverName: string) => Promise<void>;
    getToolPublicationGeneration: (connection: ObservedMCPConnection) => string | undefined;
  };
  getMCPServersRegistry: () => Pick<MCPServersRegistry, 'getServerConfig' | 'recoverServerConfig'>;
  resolveConfigServers: (
    req: ReinitializeRequest,
  ) => Promise<Record<string, ParsedServerConfig> | undefined>;
  invalidateCachedTools: (scope: { userId: string; serverName: string }) => Promise<unknown>;
  getMCPToolsCacheGeneration: (scope: {
    userId: string;
    serverName: string;
  }) => Promise<string | undefined>;
  db: Pick<PluginAuthMethods, 'findPluginAuthsByKeys'>;
  getTenantId: () => string | undefined;
  createOpenIDSessionTokenProvider: (params: {
    req: ReinitializeRequest;
    res: Response;
    user: Principal;
    identityContext: AuthIdentityContext;
    tokenPreference: 'access_token';
  }) => UpstreamTokenProvider;
  reinitMCPServer: (params: {
    connectionObserver: (connection: ObservedMCPConnection) => void;
    signal: AbortSignal;
    user: ReturnType<typeof createSafeUser>;
    serverName: string;
    serverConfig: ParsedServerConfig;
    configServers?: Record<string, ParsedServerConfig>;
    userMCPAuthMap?: Record<string, Record<string, string>>;
    upstreamTokenProvider: UpstreamTokenProvider;
    oboIdentityContext: AuthIdentityContext;
    recoveryPolicy?: Partial<MCPServerCatalogRecoveryPolicy>;
    mcpApps: TMCPAppsPolicy;
  }) => Promise<(MCPReinitializeResponse & { oauthExpiresAt?: number }) | undefined>;
}

function getMCPReinitializeOAuthTimeout(oauthExpiresAt?: number) {
  if (typeof oauthExpiresAt !== 'number' || !Number.isFinite(oauthExpiresAt))
    return mcpSettings.OAUTH_HANDLING_TIMEOUT;
  return Math.max(0, oauthExpiresAt - Date.now());
}

/** Own the complete HTTP operation; legacy callers only supply application dependencies. */
export function createMCPReinitializeHandler(deps: MCPReinitializeDependencies): RequestHandler {
  const {
    getMCPManager,
    getMCPServersRegistry,
    resolveConfigServers,
    invalidateCachedTools,
    getMCPToolsCacheGeneration,
    getMCPConnectionState,
    setMCPConnectionState,
    db,
    getTenantId,
    createOpenIDSessionTokenProvider,
    reinitMCPServer,
  } = deps;
  return async (request, res, next) => {
    const req = request as ReinitializeRequest;

    try {
      const attemptId = validateMCPConnectionAttemptId(req.body?.attemptId);
      const { serverName } = req.params;
      const user = createSafeUser(req.user);

      if (!user.id) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      logger.info(`[MCP Reinitialize] Reinitializing server: ${serverName}`);

      const mcpManager = getMCPManager();
      const configServers = await resolveConfigServers(req);
      const serverConfig = await getMCPServersRegistry().getServerConfig(
        serverName,
        user.id,
        configServers,
        req.user.role,
        { idOnTheSource: req.user.idOnTheSource },
      );
      if (!serverConfig) {
        res.status(404).json({
          error: `MCP server '${serverName}' not found in configuration`,
        });
        return;
      }

      try {
        await invalidateCachedTools({ userId: user.id, serverName });
      } finally {
        await mcpManager.disconnectUserConnection(user.id, serverName);
      }
      logger.info(
        `[MCP Reinitialize] Disconnected existing user connection for server: ${serverName}`,
      );

      /** @type {Record<string, Record<string, string>> | undefined} */
      let userMCPAuthMap: Record<string, Record<string, string>> | undefined;
      if (serverConfig.customUserVars && typeof serverConfig.customUserVars === 'object') {
        userMCPAuthMap = await getUserMCPAuthMap({
          userId: user.id,
          servers: [serverName],
          findPluginAuthsByKeys: db.findPluginAuthsByKeys,
        });
      }
      const oboIdentityContext = createAuthIdentityContext({
        user: req.user,
        tenantId: getTenantId(),
      });

      const mcpApps = resolveMCPAppsPolicy(
        req.config?.mcpSettings?.apps,
        undefined,
        req.config?.mcpAppSandbox?.maxPersistedAppBytes,
        req.config?.mcpAppSandbox?.maxAdmissionRequestsPerMinute,
        req.config?.mcpAppSandbox?.url,
        req.config?.mcpAppSandbox?.maxActiveViews,
        req.config?.mcpAppSandbox?.maxActionPreviewChars,
        req.config?.mcpAppSandbox?.operationLimits,
      );
      const userId = user.id;
      const result: (MCPReinitializeResponse & { oauthExpiresAt?: number }) | undefined =
        await runMCPConnectionAttempt(
          {
            attemptId,
            userId: user.id,
            serverName,
            serverConfig,
            capabilityProfile: resolveMCPClientCapabilityProfile(mcpApps),
            policy: req.config?.mcpSettings?.connectionStatus,
          },
          {
            getGeneration: () => getMCPToolsCacheGeneration({ userId, serverName }),
            getConnectionGeneration: (connection) =>
              mcpManager.getToolPublicationGeneration(connection),
            resolveConfig: () =>
              resolveMCPReinitializeConfig(
                getMCPServersRegistry(),
                serverName,
                serverConfig,
                user.id,
              ),
            getMCPConnectionState,
            setMCPConnectionState,
            connect: (connectionObserver, signal, resolvedServerConfig) =>
              reinitMCPServer({
                connectionObserver,
                signal,
                user,
                serverName,
                serverConfig: resolvedServerConfig,
                configServers,
                userMCPAuthMap,
                upstreamTokenProvider: createOpenIDSessionTokenProvider({
                  req,
                  res,
                  user: req.user,
                  identityContext: oboIdentityContext,
                  tokenPreference: 'access_token',
                }),
                oboIdentityContext,
                recoveryPolicy: req.config?.mcpSettings?.catalogRecovery,
                mcpApps,
              }),
          },
        );

      if (!result) {
        res.status(500).json({ error: 'Failed to reinitialize MCP server for user' });
        return;
      }

      const {
        success,
        message,
        oauthRequired,
        oauthUrl,
        oauthExpiresAt,
        failureReason,
        missingUserVars,
        connectionDeferred,
        connectionAttempt,
        statusUnavailable,
      } = result;

      let flowId;
      if (oauthRequired) {
        flowId = MCPOAuthHandler.generateFlowId(user.id, serverName, getTenantId());
        setOAuthCsrfCookie(res, flowId, '/api/mcp');
      }

      res.json({
        success,
        message,
        oauthUrl,
        flowId,
        oauthTimeout: oauthRequired ? getMCPReinitializeOAuthTimeout(oauthExpiresAt) : undefined,
        serverName,
        oauthRequired,
        failureReason,
        missingUserVars,
        connectionDeferred,
        connectionAttempt,
        statusUnavailable,
      });
    } catch (error) {
      if (
        error instanceof MCPAuthenticationRejectedError ||
        error instanceof MCPAuthenticationRefreshError ||
        error instanceof OpenIDReauthRequiredError
      ) {
        return next(error);
      }
      const { status, body } = getMCPConnectionAttemptErrorResponse(error);
      res.status(status).json(body);
    }
  };
}
