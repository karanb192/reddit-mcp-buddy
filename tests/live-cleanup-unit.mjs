import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./test-integration.sh', import.meta.url), 'utf8');
const match = source.match(/WRITE_LIVE_OUTPUT=\$\(REDDIT_BUDDY_WRITE=true node --input-type=module -e '\n([\s\S]*?)\n  ' 2>&1\)/);
assert.ok(match, 'live test driver must be present');
const body = match[1].replace(/^    import .*;\n/gm, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const driver = new AsyncFunction('createSharedServices', 'randomUUID', 'process', 'console', 'setTimeout', body);

async function scenario(mode) {
  const items = new Map();
  const deleted = [];
  const logs = [];
  const state = { env: { REDDIT_TEST_SUBREDDIT: 'private_test' }, exitCode: 0 };
  let writes = 0;
  let destroyed = false;
  const api = {
    async getSubredditAboutFull() {
      return { subreddit_type: mode === 'public' ? 'public' : 'private', user_is_moderator: true };
    },
    async getPostInfoFresh() { return items.get('t3_p1'); },
    async get(path) {
      if (path.startsWith('/api/info')) {
        const id = new URL('https://example.com' + path).searchParams.get('id');
        const item = items.get(id);
        return { data: { children: item ? [{ data: item }] : [] } };
      }
      const type = path.includes('/comments.json') ? 't1_' : 't3_';
      return { data: { children: [...items].filter(([id]) => id.startsWith(type)).map(([, data]) => ({ data })) } };
    },
    async postForm(endpoint, form) {
      assert.equal(endpoint, '/api/del');
      const id = form.get('id');
      deleted.push(id);
      if (mode === 'delete-failure' && id === 't1_c1') throw new Error('delete rejected');
      if (mode !== 'unverified-delete') items.delete(id);
    },
  };
  const tools = {
    api,
    async subredditRules() { return { untrusted_content_note: 'reference only' }; },
    async createPost(params) {
      assert.equal(params.subreddit, 'private_test');
      writes++;
      items.set('t3_p1', { id: 'p1', title: params.title, subreddit: params.subreddit, author: 'test_user' });
      if (mode === 'ambiguous-post') throw new Error('response lost');
      return { post_id: 'p1', status: 'live' };
    },
    async addComment(params) {
      if (mode === 'comment-failure') throw new Error('comment rejected');
      items.set('t1_c1', { id: 'c1', body: params.text, link_id: 't3_' + params.post_id, subreddit: 'private_test', author: 'test_user' });
      return { comment_id: 'c1' };
    },
  };
  await driver(async () => ({ writeStatus: { enabled: true }, actingUser: 'test_user', writeTools: tools, cacheManager: { destroy() { destroyed = true; } } }),
    () => 'unique-test-marker', state, { log: text => logs.push(text) }, callback => callback());
  assert.ok(destroyed, 'cache timers must be stopped');
  return { deleted, logs, state, writes, items };
}

const ok = await scenario('success');
assert.deepEqual(ok.deleted, ['t1_c1', 't3_p1']);
assert.equal(ok.state.exitCode, 0);
assert.ok(ok.logs.includes('LIVE_CLEANUP_OK'));

const commentFailure = await scenario('comment-failure');
assert.deepEqual(commentFailure.deleted, ['t3_p1']);
assert.equal(commentFailure.state.exitCode, 1);

const ambiguous = await scenario('ambiguous-post');
assert.deepEqual(ambiguous.deleted, ['t3_p1']);
assert.equal(ambiguous.items.size, 0);
assert.equal(ambiguous.state.exitCode, 1);

const deleteFailure = await scenario('delete-failure');
assert.deepEqual(deleteFailure.deleted, ['t1_c1', 't3_p1']);
assert.equal(deleteFailure.state.exitCode, 1);
assert.ok(!deleteFailure.logs.includes('LIVE_CLEANUP_OK'));

const unverified = await scenario('unverified-delete');
assert.equal(unverified.state.exitCode, 1);
assert.ok(unverified.logs.some(line => line.includes('deletion not yet verified')));

const publicSub = await scenario('public');
assert.equal(publicSub.writes, 0);
assert.deepEqual(publicSub.deleted, []);
assert.equal(publicSub.state.exitCode, 1);
console.log('LIVE-CLEANUP: pass (6 scenarios)');
