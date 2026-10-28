import type { MCPReinitializeResponse } from 'librechat-data-provider';
import type { LocalizeFunction } from '~/common';

export function getMCPReinitializeErrorMessage(
  response: MCPReinitializeResponse,
  localize: LocalizeFunction,
): string {
  switch (response.failureReason) {
    case 'status_unavailable':
      return localize('com_ui_mcp_status_unavailable');
    case 'unreachable':
      return localize('com_ui_mcp_server_connection_failed');
    case 'missing_custom_user_vars':
      return localize('com_ui_mcp_missing_custom_user_vars', {
        0: response.serverName,
        1: response.missingUserVars?.join(', ') ?? '',
      });
    case 'oauth_required':
      return localize('com_ui_mcp_reauthentication_required', { 0: response.serverName });
    default:
      return localize('com_ui_mcp_init_failed');
  }
}

/** A proxy/server error cannot establish whether the backend committed the operation. */
export function isMCPDeliveryUncertain(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false;
  if (
    'code' in error &&
    ['ECONNABORTED', 'ETIMEDOUT', 'ERR_NETWORK', 'ERR_CANCELED'].includes(String(error.code))
  )
    return true;
  if (!('response' in error) || error.response == null || typeof error.response !== 'object')
    return false;
  return (
    'status' in error.response &&
    typeof error.response.status === 'number' &&
    error.response.status >= 500
  );
}
