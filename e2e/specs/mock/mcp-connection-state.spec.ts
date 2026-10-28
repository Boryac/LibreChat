import { expect, test } from '@playwright/test';
import type { MCPConnectionStatusResponse } from 'librechat-data-provider';
import { getAccessToken } from './helpers';

const SERVER = 'e2e-status';

test('Connect reports verified success or failure consistently across replicas', async ({
  page,
  baseURL,
}, info) => {
  test.skip(
    process.env.E2E_MCP_CONNECTION_STATUS !== 'true',
    'Requires the controlled MCP fixture',
  );
  test.skip(process.env.E2E_REPLICAS !== '2', 'Requires two actual API processes');
  test.setTimeout(120_000);
  const base = new URL(baseURL!);
  const replica = (index: number, path: string) => {
    const url = new URL(path, base);
    url.port = String(Number(base.port) + index);
    return url.toString();
  };
  await page.goto('/c/new');
  const token = await getAccessToken(page);
  const user = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).id;
  expect(typeof user).toBe('string');
  const control = `http://127.0.0.1:28769/control?user=${encodeURIComponent(user)}`;
  const mode = async (value: string) => {
    const result = await page.request.post(control, { data: { mode: value } });
    expect(result.ok()).toBe(true);
  };
  const status = async (index: number) => {
    const response = await page.request.get(replica(index, '/api/mcp/connection/status'), {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.ok()).toBe(true);
    return ((await response.json()) as MCPConnectionStatusResponse).connectionStatus[SERVER];
  };
  // Only the load balancer's choice is controlled. Every status body comes from API process 2.
  await page.route('**/api/mcp/connection/status', async (route) => {
    const response = await route.fetch({ url: replica(2, '/api/mcp/connection/status') });
    await route.fulfill({ response });
  });
  const card = page.getByLabel(/^E2E Connection State - /);
  try {
    await page.getByRole('button', { name: 'MCP Settings', exact: true }).click();
    await expect(card).toBeVisible();
    await mode('hold');
    const initialized = page.waitForResponse((r) =>
      r.url().endsWith(`/api/mcp/${SERVER}/reinitialize`),
    );
    await card.hover();
    await card.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect.soft
      .poll(async () => (await status(2)).connectionState, { timeout: 500 })
      .toBe('connecting');
    await page.screenshot({ path: info.outputPath('connecting.png'), animations: 'disabled' });
    await mode('success');
    expect(await (await initialized).json()).toMatchObject({ success: true, oauthRequired: false });
    for (const index of [1, 2]) {
      await expect.soft
        .poll(async () => (await status(index)).connectionState, { timeout: 1000 })
        .toBe('connected');
    }
    await expect
      .soft(card)
      .toHaveAttribute('aria-label', 'E2E Connection State - Connected', { timeout: 1000 });
    await page.screenshot({ path: info.outputPath('connected.png'), animations: 'disabled' });
    await info.attach('success-replicas.json', {
      body: JSON.stringify(await Promise.all([status(1), status(2)])),
      contentType: 'application/json',
    });

    await mode('fail');
    const failed = page.waitForResponse((r) => r.url().endsWith(`/api/mcp/${SERVER}/reinitialize`));
    await card.hover();
    await card.getByRole('button', { name: 'Reconnect', exact: true }).click();
    const failure = await failed;
    if (failure.ok()) expect(await failure.json()).toMatchObject({ success: false });
    for (const index of [1, 2]) {
      await expect.soft
        .poll(async () => (await status(index)).connectionState, { timeout: 1000 })
        .toBe('error');
    }
    await expect
      .soft(card)
      .toHaveAttribute('aria-label', 'E2E Connection State - Error', { timeout: 1000 });
    await expect(page.getByText('Failed to initialize MCP server', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('failed.png'), animations: 'disabled' });

    await mode('success');
    const retried = page.waitForResponse((r) =>
      r.url().endsWith(`/api/mcp/${SERVER}/reinitialize`),
    );
    await card.hover();
    await card.getByRole('button', { name: 'Connect', exact: true }).click();
    expect(await (await retried).json()).toMatchObject({ success: true });
    await expect.poll(async () => (await status(2)).connectionState).toBe('connected');
    await expect
      .soft(card)
      .toHaveAttribute('aria-label', 'E2E Connection State - Connected', { timeout: 1000 });
    await page.screenshot({ path: info.outputPath('retry-succeeded.png'), animations: 'disabled' });

    await mode('hold');
    const timedOut = page.waitForResponse((r) =>
      r.url().endsWith(`/api/mcp/${SERVER}/reinitialize`),
    );
    await card.hover();
    await card.getByRole('button', { name: 'Reconnect', exact: true }).click();
    const timeoutResponse = await timedOut;
    if (timeoutResponse.ok())
      expect(await timeoutResponse.json()).toMatchObject({ success: false });
    for (const index of [1, 2]) {
      await expect.poll(async () => (await status(index)).connectionState).toBe('error');
    }
    await expect(card).toHaveAttribute('aria-label', 'E2E Connection State - Error');
    await page.screenshot({ path: info.outputPath('timeout.png'), animations: 'disabled' });
    await mode('success');
    for (const index of [1, 2]) {
      expect((await status(index)).connectionState).toBe('error');
    }
  } finally {
    await mode('success');
  }
});
