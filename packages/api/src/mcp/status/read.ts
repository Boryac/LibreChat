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
    timeoutMs?: number;
  },
  deps: Pick<MCPConnectionStateStore, 'getMCPConnectionState'> & {
    getGeneration: () => Promise<string | undefined>;
  },
): Promise<{ record: MCPConnectionStateRecord | null; generation: string | undefined }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('MCP connection status read timed out')),
      params.timeoutMs ?? 500,
    );
  });
  const read = async () => {
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
  };
  try {
    return await Promise.race([read(), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
