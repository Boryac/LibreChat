#!/usr/bin/env node
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const {
  StreamableHTTPServerTransport,
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const port = Number(process.env.E2E_MCP_STATUS_PORT || 28769);
const users = new Map();
const sessions = new Map();
function state(user) {
  if (!users.has(user)) users.set(user, { mode: 'fail', pending: [], initializations: 0 });
  return users.get(user);
}
async function body(req) {
  let value = '';
  for await (const chunk of req) value += chunk;
  return value ? JSON.parse(value) : undefined;
}
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/') {
    res.end('ok');
    return;
  }
  if (url.pathname === '/control') {
    const user = state(url.searchParams.get('user'));
    if (req.method === 'POST') {
      const next = await body(req);
      user.mode = next.mode;
      for (const resolve of user.pending.splice(0)) resolve();
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        mode: user.mode,
        initializations: user.initializations,
        pending: user.pending.length,
      }),
    );
    return;
  }
  if (url.pathname !== '/mcp') {
    res.writeHead(404).end();
    return;
  }
  if (req.headers.authorization !== 'Bearer e2e-status-token' || !req.headers['x-e2e-user']) {
    res.writeHead(401).end();
    return;
  }
  const user = state(req.headers['x-e2e-user']);
  const parsed = req.method === 'POST' ? await body(req) : undefined;
  if (parsed?.method === 'initialize') user.initializations++;
  if (user.mode === 'hold' && parsed?.method === 'initialize') {
    await new Promise((resolve) => user.pending.push(resolve));
  }
  if (user.mode === 'fail') {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: parsed?.id ?? null,
        error: { code: -32000, message: 'Synthetic MCP unavailable' },
      }),
    );
    return;
  }
  const sid = req.headers['mcp-session-id'];
  let transport = sessions.get(sid);
  if (!transport) {
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    const mcp = new McpServer({ name: 'e2e-status', version: '1.0.0' });
    mcp.registerTool(
      'status_ping',
      { inputSchema: {}, description: 'Synthetic connection-state regression tool' },
      async () => ({ content: [{ type: 'text', text: 'pong' }] }),
    );
    await mcp.connect(transport);
  }
  await transport.handleRequest(req, res, parsed);
  if (transport.sessionId && !sessions.has(transport.sessionId)) {
    sessions.set(transport.sessionId, transport);
    transport.onclose = () => sessions.delete(transport.sessionId);
  }
});
httpServer.listen(port, '127.0.0.1', () =>
  console.log(`[e2e] MCP connection fixture on http://127.0.0.1:${port}`),
);
