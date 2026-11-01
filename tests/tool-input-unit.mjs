import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

for (const key of Object.keys(process.env)) {
  if (key.startsWith('REDDIT_')) delete process.env[key];
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('network is not allowed in this test'); };
const { createMCPServer, MAX_TOOL_INPUT_ELEMENTS } = await import('../dist/mcp-server.js');
const { server, cacheManager } = await createMCPServer();
const client = new Client({ name: 'tool-input-unit', version: '1.0.0' });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
try {
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const explain = await client.callTool({ name: 'reddit_explain', arguments: { term: 'karma' } });
  assert.notEqual(explain.isError, true, 'an ordinary call must still succeed');
  // { query, subreddits: [n] } counts n + 2: the two keys plus each element.
  const call = n => client.callTool({ name: 'search_reddit', arguments: { query: 'x', subreddits: Array(n).fill('a') } });
  const atLimit = await call(MAX_TOOL_INPUT_ELEMENTS - 2);
  assert.equal(atLimit.isError, true, 'at the limit the call reaches the tool and its schema rejects it');
  await assert.rejects(call(MAX_TOOL_INPUT_ELEMENTS - 1), error => error.code === -32602 && /more than 1000/.test(error.message));
  await assert.rejects(call(100000), error => error.code === -32602);
  const nested = { query: 'x', subreddits: [[[Array(MAX_TOOL_INPUT_ELEMENTS).fill(1)]]] };
  await assert.rejects(client.callTool({ name: 'search_reddit', arguments: nested }), error => error.code === -32602);
  const wide = Object.fromEntries(Array.from({ length: MAX_TOOL_INPUT_ELEMENTS + 1 }, (_, i) => ['k' + i, 1]));
  await assert.rejects(client.callTool({ name: 'search_reddit', arguments: wide }), error => error.code === -32602);
  console.log('TOOL-INPUT: pass');
} finally {
  await client.close();
  cacheManager?.destroy?.();
  globalThis.fetch = originalFetch;
}
