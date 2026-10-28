import type { MCPClientCapabilityProfile } from '../capabilities';
import type { MCPConnectionStateStore } from './types';
import type { ParsedServerConfig } from '../types';
import { STANDARD_MCP_CAPABILITY_PROFILE } from '../capabilities';
import { getMCPToolCatalogGeneration } from '../toolsChanged';

export async function readMCPConnectionObservation(
  params: {
    userId: string;
    serverName: string;
    serverConfig: ParsedServerConfig;
    capabilityProfile?: MCPClientCapabilityProfile;
  },
  deps: Pick<MCPConnectionStateStore, 'getMCPConnectionState'> & {
    getGeneration: () => Promise<string | undefined>;
  },
) {
  const generation = await deps.getGeneration();
  const record = generation
    ? await deps.getMCPConnectionState({
        userId: params.userId,
        serverName: params.serverName,
        configGeneration: getMCPToolCatalogGeneration(
          params.serverConfig,
          params.capabilityProfile ?? STANDARD_MCP_CAPABILITY_PROFILE,
        ),
        publicationGeneration: generation,
      })
    : null;
  return { record, generation };
}
