import type { MCPServerStatus, MCPServersListResponse } from 'librechat-data-provider';
import type { MCPConnectResult } from '~/store/mcp';

const discoveryFields = new Set([
  'tools',
  'toolFunctions',
  'initDuration',
  'capabilities',
  'inspectionFailed',
]);

export function getMCPConnectKey(
  server: MCPServersListResponse[string] | undefined,
  owner: string,
): string {
  // The API includes discovery metadata beyond the declared configuration type.
  const configuration = Object.fromEntries(
    Object.entries(server ?? {}).filter(([key]) => !discoveryFields.has(key)),
  );
  return JSON.stringify([owner, configuration]);
}

/** A local check result cannot be undone by another replica having no transport. */
export function applyMCPConnectResults(
  statuses: Record<string, MCPServerStatus> | undefined,
  results: Record<string, MCPConnectResult>,
  servers: MCPServersListResponse | undefined,
  owner: string,
): Record<string, MCPServerStatus> | undefined {
  let next = statuses;
  for (const [name, result] of Object.entries(results)) {
    if (
      result.configKey !== getMCPConnectKey(servers?.[name], owner) ||
      (servers && !servers[name])
    ) {
      continue;
    }
    const current = statuses?.[name];
    if (
      current?.configurationState === 'needs_configuration' ||
      (result.authorizationGeneration != null &&
        current?.authorizationGeneration != null &&
        result.authorizationGeneration !== current.authorizationGeneration)
    ) {
      continue;
    }
    // In-flight actions supersede cached authorization state. Settled results cannot.
    if (
      result.state !== 'connecting' &&
      (current?.authorizationState === 'needs_authorization' ||
        current?.authorizationState === 'authorizing' ||
        current?.authorizationState === 'error')
    ) {
      continue;
    }
    if (
      result.state === 'connected' &&
      current &&
      (current.connectionState === 'error' ||
        current.connectionState === 'connecting' ||
        (current.connectionState === 'disconnected' &&
          current.connectionStateSource !== 'unobserved' &&
          current.connectionStateSource != null))
    ) {
      continue;
    }
    next = {
      ...next,
      [name]: {
        requiresOAuth: false,
        authorizationState: 'not_required',
        ...current,
        connectionState: result.state,
      },
    };
  }
  return next;
}
