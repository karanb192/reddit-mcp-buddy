import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export const testBody = 'Private integration test. Cleanup is attempted even if a later step fails.';

export async function connectStdio(onConfirm) {
  const client = new Client({ name: 'private-sandbox-validation', version: '1.0.0' }, {
    capabilities: onConfirm ? { elicitation: { form: {} } } : {},
  });
  if (onConfirm) client.setRequestHandler(ElicitRequestSchema, onConfirm);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, 'dist/index.js')],
    cwd: root,
    env: { ...process.env, REDDIT_BUDDY_HTTP: 'false', REDDIT_BUDDY_WRITE: 'true' },
    stderr: 'inherit',
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    for (const name of ['create_post', 'add_comment', 'subreddit_rules']) {
      assert.ok(tools.some(tool => tool.name === name), `${name} is not enabled over stdio`);
    }
  } catch (error) {
    await transport.close();
    throw error;
  }
  return {
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (result.isError) throw new Error(text);
      return JSON.parse(text);
    },
    close: () => client.close(),
  };
}

export async function runLiveWrite({ shared, sub, marker, connect = connectStdio, sleep = pause, log = console.log }) {
  sub = sub.trim().replace(/^\/?r\//i, '');
  const commentText = 'Integration test comment: ' + marker;
  const created = new Set();
  const attempted = { submitted: false, comments: false };
  const clients = [];
  let api;
  let postId;
  let commentId;
  let failed = false;
  log('LIVE_MARKER ' + marker);
  const fail = message => { failed = true; log('LIVE_FAIL ' + message); };
  const belongs = item => item?.subreddit?.toLowerCase() === sub.toLowerCase()
    && item?.author?.toLowerCase() === shared.actingUser?.toLowerCase();
  const matches = (item, type) => belongs(item) && (type === 'submitted'
    ? item.title === marker
    : item.body === commentText && item.link_id === 't3_' + postId);
  const listing = async type => {
    const result = await api.get('/user/' + encodeURIComponent(shared.actingUser) + '/' + type + '.json?sort=new&limit=100');
    assert.ok(Array.isArray(result?.data?.children), 'invalid recovery listing');
    return result.data.children.map(child => child.data).filter(item => matches(item, type));
  };
  try {
    assert.match(sub, /^[A-Za-z0-9_]{3,21}$/);
    assert.ok(marker && marker.length < 200, 'a unique test marker is required');
    assert.ok(shared.writeStatus.enabled && shared.writeTools, 'write access not enabled');
    api = shared.writeTools.api;
    assert.ok(api.auth.hasScopes(['identity', 'read', 'submit', 'flair', 'edit', 'history']),
      'live validation requires identity, read, submit, flair, edit, and history scopes for posting, recovery, and cleanup');
    const about = await api.getSubredditAboutFull(sub);
    assert.ok(about?.subreddit_type === 'private' && about?.user_is_moderator === true,
      'sandbox must be private and the acting user must be a moderator');
    log('LIVE_WRITE_READY acting_user=' + shared.actingUser);
    assert.equal((await listing('submitted')).length, 0, 'marker already exists; do not repeat this run');

    let decision = 'decline';
    let prompts = 0;
    const eliciting = await connect(async request => {
      assert.ok(request.params.message.includes(marker) && request.params.message.includes('r/' + sub),
        'confirmation must describe the exact sandbox post');
      assert.equal(request.params.requestedSchema.properties.confirm.type, 'boolean');
      prompts++;
      return decision === 'accept' ? { action: 'accept', content: { confirm: true } } : { action: 'decline' };
    });
    clients.push(eliciting);
    const rules = await eliciting.call('subreddit_rules', { subreddit: sub });
    assert.ok(rules.untrusted_content_note, 'rules response missing reference-only note');
    log('LIVE_RULES_OK');
    const postArgs = { subreddit: sub, title: marker, body_markdown: testBody };
    attempted.submitted = true;
    await assert.rejects(eliciting.call('create_post', postArgs), /declined the confirmation/);
    assert.equal(prompts, 1, 'decline must pass through MCP elicitation');
    assert.equal((await listing('submitted')).length, 0, 'declined post was created');
    attempted.submitted = false;
    log('LIVE_DECLINE_OK');

    decision = 'accept';
    attempted.submitted = true;
    const post = await eliciting.call('create_post', postArgs);
    assert.equal(prompts, 2, 'accept must pass through MCP elicitation');
    assert.match(post.post_id ?? '', /^[a-z0-9]+$/i);
    postId = post.post_id;
    created.add('t3_' + postId);
    const fresh = await api.getPostInfoFresh(postId);
    assert.ok(matches(fresh, 'submitted') && fresh.selftext === testBody, 'created post content or owner mismatch');
    assert.equal(post.status, 'live', 'test post was filtered or not verified live');
    log('LIVE_POST_OK id=' + postId + ' status=' + post.status);
    log('LIVE_POST_VISIBLE');

    await sleep(16000);
    const fallback = await connect();
    clients.push(fallback);
    const commentArgs = { post_id: postId, text: commentText };
    attempted.comments = true;
    const preview = await fallback.call('add_comment', commentArgs);
    assert.equal(preview.status, 'confirmation_required');
    assert.equal(preview.would_comment.target, 't3_' + postId);
    assert.equal(preview.would_comment.preview, commentText);
    assert.equal((await listing('comments')).length, 0, 'preview created a comment');
    attempted.comments = false;
    log('LIVE_PREVIEW_OK');

    attempted.comments = true;
    const comment = await fallback.call('add_comment', commentArgs);
    assert.match(comment.comment_id ?? '', /^[a-z0-9]+$/i);
    commentId = comment.comment_id;
    created.add('t1_' + commentId);
    const info = await api.get('/api/info.json?id=t1_' + commentId);
    assert.ok(matches(info?.data?.children?.[0]?.data, 'comments'), 'created comment content or owner mismatch');
    log('LIVE_COMMENT_OK id=' + commentId);
  } catch (error) {
    fail(error.message);
  } finally {
    // Stop producers before recovery, including a server with an outstanding call.
    for (const client of clients) {
      try { await client.close(); } catch (error) { fail('transport close: ' + error.message); }
    }
    if (api) {
      for (const type of ['submitted', 'comments']) {
        if (!attempted[type]) continue;
        try {
          const found = await listing(type);
          for (const item of found) {
            assert.match(item.id ?? '', /^[a-z0-9]+$/i);
            created.add((type === 'submitted' ? 't3_' : 't1_') + item.id);
          }
          const known = [...created].some(id => id.startsWith(type === 'submitted' ? 't3_' : 't1_'));
          if (!found.length && !known) throw new Error('write outcome unknown; manually check marker ' + marker);
        } catch (error) { fail('recovery: ' + error.message); }
      }
      for (const id of [...created].sort()) {
        try {
          await api.postForm('/api/del', new URLSearchParams({ api_type: 'json', id }));
          const info = await api.get('/api/info.json?id=' + encodeURIComponent(id));
          assert.ok(Array.isArray(info?.data?.children), 'invalid deletion verification response');
          const item = info.data.children[0]?.data;
          if (item && item.author !== '[deleted]' && item.body !== '[deleted]' && item.removed_by_category !== 'deleted') {
            throw new Error('deletion not yet verified for ' + id);
          }
          log('LIVE_DELETED ' + id);
        } catch (error) { fail('cleanup ' + id + ': ' + error.message); }
      }
    }
    shared.cacheManager.destroy();
  }
  if (!failed && postId && commentId) log('LIVE_CLEANUP_OK');
  return !failed && Boolean(postId && commentId);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sub = process.env.REDDIT_TEST_SUBREDDIT;
  const marker = 'reddit-mcp-buddy test ' + randomUUID();
  if (!process.argv.includes('--run')) {
    console.log(JSON.stringify({ subreddit: sub ?? '<private sandbox>', title: marker, body: testBody,
      comment: 'Integration test comment: ' + marker,
      actions: ['decline post', 'approve post through MCP', 'preview comment', 'repeat exact comment', 'delete and verify both'],
      writes_performed: 0 }, null, 2));
  } else {
    for (const key of ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_TEST_SUBREDDIT']) {
      if (!process.env[key]?.trim()) throw new Error('Missing required local configuration: ' + key);
    }
    if (!process.env.REDDIT_REFRESH_TOKEN?.trim() && !(process.env.REDDIT_USERNAME?.trim() && process.env.REDDIT_PASSWORD?.trim())) {
      throw new Error('Live validation requires REDDIT_REFRESH_TOKEN or REDDIT_USERNAME and REDDIT_PASSWORD');
    }
    if (process.env.RUN_WRITE_TESTS !== '1') throw new Error('Live writes require RUN_WRITE_TESTS=1 and --run');
    process.env.REDDIT_BUDDY_HTTP = 'false';
    process.env.REDDIT_BUDDY_WRITE = 'true';
    const { createSharedServices } = await import('../dist/mcp-server.js');
    const shared = await createSharedServices();
    if (!await runLiveWrite({ shared, sub, marker })) process.exitCode = 1;
  }
}
