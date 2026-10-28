import type { MCPConnectionStateStore, MCPConnectionStateRecord } from './types';
import type { MCPClientCapabilityProfile } from '../capabilities';
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
): Promise<{ record: MCPConnectionStateRecord | null; generation: string | undefined }> {
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
