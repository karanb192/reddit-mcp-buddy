import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLiveWrite } from './live-write.mjs';

const dir = mkdtempSync(join(tmpdir(), 'reddit-stdio-test-'));
const stateFile = join(dir, 'state.json');
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
try {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('REDDIT_')) delete process.env[key];
  }
  Object.assign(process.env, {
    REDDIT_CLIENT_ID: 'offline-client', REDDIT_CLIENT_SECRET: 'offline-secret',
    REDDIT_USERNAME: 'sandbox_test_user', REDDIT_PASSWORD: 'offline-password',
    REDDIT_BUDDY_WRITE: 'true', REDDIT_BUDDY_HTTP: 'false',
    SANDBOX_FIXTURE_STATE: stateFile,
    NODE_OPTIONS: '--import=' + fileURLToPath(new URL('./fixtures/live-write-api.mjs', import.meta.url)),
  });
  await import('./fixtures/live-write-api.mjs');
  const { createSharedServices } = await import('../dist/mcp-server.js');
  for (const mode of ['password', 'refresh']) {
    if (mode === 'refresh') {
      delete process.env.REDDIT_PASSWORD;
      process.env.REDDIT_REFRESH_TOKEN = 'offline-refresh';
    }
    writeFileSync(stateFile, JSON.stringify({ items: {}, actions: [] }));
    const shared = await createSharedServices();
    const logs = [];
    const passed = await runLiveWrite({ shared, sub: 'private_test', marker: 'offline-stdio-test',
      sleep: async () => {}, log: text => logs.push(text) });
    assert.ok(passed, logs.join('\n'));
    for (const expected of ['LIVE_DECLINE_OK', 'LIVE_PREVIEW_OK', 'LIVE_CLEANUP_OK']) assert.ok(logs.includes(expected));
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.deepEqual(state.actions, ['submit', 'comment', 'delete:t1_c1', 'delete:t3_p1']);
    assert.deepEqual(state.items, {});
  }
  console.log('OFFLINE-STDIO: pass (password and refresh auth; real MCP transports; no network)');
} finally {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(dir, { recursive: true, force: true });
}
