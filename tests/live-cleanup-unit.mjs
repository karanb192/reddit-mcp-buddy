import assert from 'node:assert/strict';
import { runLiveWrite } from './live-write.mjs';

async function scenario(mode) {
  const items = new Map();
  const deleted = [];
  const logs = [];
  const state = { exitCode: 0 };
  let writes = 0;
  let destroyed = false;
  let closed = 0;
  let connections = 0;
  const api = {
    auth: { hasScopes: () => mode !== 'missing-scopes' },
    async getSubredditAboutFull() {
      return { subreddit_type: mode === 'public' ? 'public' : 'private', user_is_moderator: mode !== 'non-moderator' };
    },
    async getPostInfoFresh() {
      if (mode === 'post-read-failure') throw new Error('verification read failed');
      return items.get('t3_p1');
    },
    async get(path) {
      if (path.startsWith('/api/info')) {
        const id = new URL('https://example.com' + path).searchParams.get('id');
        if (mode === 'comment-read-failure' && id === 't1_c1' && !deleted.includes(id)) throw new Error('verification read failed');
        const item = items.get(id);
        return { data: { children: item ? [{ data: item }] : [] } };
      }
      const type = path.includes('/comments.json') ? 't1_' : 't3_';
      if (mode === 'post-read-failure' || mode === 'comment-read-failure') return { data: { children: [] } };
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
  const connect = async onConfirm => {
    connections++;
    let previewed = false;
    return {
      async close() { closed++; },
      async call(name, params) {
        if (name === 'subreddit_rules') return { untrusted_content_note: 'reference only' };
        if (name === 'create_post') {
          assert.equal(params.subreddit, 'private_test');
          const decision = await onConfirm({ params: { message: 'Post to r/private_test: ' + params.title,
            requestedSchema: { properties: { confirm: { type: 'boolean' } } } } });
          if (decision.action === 'decline' && mode !== 'decline-write') throw new Error('User declined the confirmation; nothing was posted.');
          writes++;
          if (mode === 'post-not-found') throw new Error('request failed');
          items.set('t3_p1', { id: 'p1', title: params.title, selftext: params.body_markdown, subreddit: params.subreddit, author: 'test_user' });
          if (mode === 'decline-write') throw new Error('User declined the confirmation; nothing was posted.');
          if (mode === 'ambiguous-post') throw new Error('response lost');
          return { post_id: 'p1', status: 'live' };
        }
        assert.equal(name, 'add_comment');
        assert.equal(onConfirm, undefined, 'fallback client must not advertise elicitation');
        if (!previewed) {
          previewed = true;
          if (mode !== 'preview-write') return { status: 'confirmation_required', would_comment: { target: 't3_' + params.post_id, preview: params.text } };
        }
        if (mode === 'comment-failure') throw new Error('comment rejected');
        items.set('t1_c1', { id: 'c1', body: params.text, link_id: 't3_' + params.post_id, subreddit: 'private_test', author: 'test_user' });
        if (mode === 'ambiguous-comment') throw new Error('response lost');
        if (mode === 'preview-write') return { status: 'confirmation_required', would_comment: { target: 't3_' + params.post_id, preview: params.text } };
        return { comment_id: 'c1' };
      },
    };
  };
  const passed = await runLiveWrite({
    shared: { writeStatus: { enabled: true }, actingUser: 'test_user', writeTools: { api }, cacheManager: { destroy() { destroyed = true; } } },
    sub: 'r/private_test', marker: 'unique-test-marker', connect, sleep: async () => {}, log: text => logs.push(text),
  });
  state.exitCode = passed ? 0 : 1;
  assert.equal(closed, connections, 'all MCP transports must close');
  assert.ok(destroyed, 'cache timers must be stopped');
  assert.ok(logs.some(line => line.startsWith('LIVE_MARKER ')), 'print recovery marker before any write');
  return { deleted, logs, state, writes, items };
}

const ok = await scenario('success');
assert.deepEqual(ok.deleted, ['t1_c1', 't3_p1']);
assert.equal(ok.state.exitCode, 0);
assert.ok(ok.logs.includes('LIVE_CLEANUP_OK'));

const missingScopes = await scenario('missing-scopes');
assert.equal(missingScopes.writes, 0);
assert.equal(missingScopes.state.exitCode, 1);
assert.deepEqual(missingScopes.deleted, []);

const commentFailure = await scenario('comment-failure');
assert.deepEqual(commentFailure.deleted, ['t3_p1']);
assert.equal(commentFailure.state.exitCode, 1);

const ambiguous = await scenario('ambiguous-post');
assert.deepEqual(ambiguous.deleted, ['t3_p1']);
assert.equal(ambiguous.items.size, 0);
assert.equal(ambiguous.state.exitCode, 1);

const ambiguousComment = await scenario('ambiguous-comment');
assert.deepEqual(ambiguousComment.deleted, ['t1_c1', 't3_p1']);
assert.equal(ambiguousComment.items.size, 0);
assert.equal(ambiguousComment.state.exitCode, 1);

const notFound = await scenario('post-not-found');
assert.deepEqual(notFound.deleted, []);
assert.ok(notFound.logs.some(line => line.includes('manually check marker')));
assert.equal(notFound.state.exitCode, 1);

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
for (const mode of ['decline-write', 'preview-write']) {
  const result = await scenario(mode);
  assert.equal(result.state.exitCode, 1);
  assert.equal(result.items.size, 0, 'unexpected writes must also be cleaned up');
}
const nonModerator = await scenario('non-moderator');
assert.equal(nonModerator.writes, 0);
assert.equal(nonModerator.state.exitCode, 1);
for (const mode of ['post-read-failure', 'comment-read-failure']) {
  const result = await scenario(mode);
  assert.equal(result.state.exitCode, 1);
  assert.equal(result.items.size, 0, 'known IDs must be deleted even before they appear in user listings');
  assert.deepEqual(result.deleted, mode === 'post-read-failure' ? ['t3_p1'] : ['t1_c1', 't3_p1']);
}
console.log('LIVE-CLEANUP: pass (14 scenarios)');
