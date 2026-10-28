import { expect, test } from '@playwright/test';
import type { MCPConnectionStatusResponse } from 'librechat-data-provider';
import { getAccessToken } from './helpers';

const SERVER = 'e2e-on-demand';

test('keeps on-demand readiness stable across API replicas', async ({ page, baseURL }, info) => {
  test.skip(process.env.E2E_REPLICAS !== '2', 'Requires the real two-process API topology');
  const origin = new URL(baseURL!);
  const replicaURL = (replica: number, pathname: string) => {
    const url = new URL(pathname, origin);
    url.port = String(Number(origin.port) + replica);
    return url.toString();
  };
  await page.goto('/c/new');
  const token = await getAccessToken(page);
  const headers = { Authorization: `Bearer ${token}` };
  const initialized = await page.request.post(replicaURL(1, `/api/mcp/${SERVER}/reinitialize`), {
    headers,
  });
  expect(initialized.ok()).toBe(true);
  expect(await initialized.json()).toMatchObject({ success: true, oauthRequired: false });

  const statuses: MCPConnectionStatusResponse[] = [];
  for (const replica of [1, 2]) {
    const response = await page.request.get(replicaURL(replica, '/api/mcp/connection/status'), {
      headers,
    });
    expect(response.ok()).toBe(true);
    statuses.push(await response.json());
  }
  expect(statuses[0].connectionStatus[SERVER].connectionState).toBe('connected');
  expect(statuses[1].connectionStatus[SERVER].connectionState).toBe('disconnected');
  await info.attach('replica-status-responses', {
    body: JSON.stringify(
      statuses.map((response) => response.connectionStatus[SERVER]),
      null,
      2,
    ),
    contentType: 'application/json',
  });

  // Route the browser's actual status request to each real API process. No status
  // body is fabricated: this substitutes only for the load balancer's pod choice.
  let targetReplica = 2;
  await page.route('**/api/mcp/connection/status', async (route) => {
    const response = await route.fetch({
      url: replicaURL(targetReplica, '/api/mcp/connection/status'),
    });
    await route.fulfill({ response });
  });
  for (const replica of [2, 1]) {
    targetReplica = replica;
    await page.reload();
    const nav = page.getByRole('button', { name: 'MCP Settings', exact: true });
    await nav.click();
    const card = page.getByLabel(/^E2E On Demand - /);
    await expect(card).toBeVisible();
    await expect.soft(card).toHaveAttribute('aria-label', 'E2E On Demand - On-demand');
    await page.screenshot({ path: info.outputPath(`pod-${replica}.png`), animations: 'disabled' });
  }
  for (const response of statuses) {
    expect(response.connectionStatus[SERVER]).toMatchObject({
      onDemand: true,
      authorizationState: 'not_required',
    });
  }
});
