import { readFileSync, writeFileSync } from 'node:fs';

const stateFile = process.env.SANDBOX_FIXTURE_STATE;
if (!stateFile) throw new Error('Offline fixture requires an explicit state file');
const json = body => Response.json(body);
const listing = items => ({ data: { children: items.map(data => ({ data })) } });

// Fail closed: even an unexpected endpoint must never reach the network.
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (!['www.reddit.com', 'oauth.reddit.com'].includes(url.hostname)) throw new Error('Unexpected fixture host');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const path = url.pathname;
  if (path === '/api/v1/access_token') return json({ access_token: 'offline-token', token_type: 'bearer', expires_in: 3600, scope: '*' });
  if (path === '/api/v1/me') return json({ name: 'sandbox_test_user' });
  if (path === '/r/private_test/about.json') return json({ data: { subreddit_type: 'private', user_is_moderator: true, submission_type: 'self' } });
  if (path === '/r/private_test/about/rules.json') return json({ rules: [] });
  if (path === '/api/v1/private_test/post_requirements') return json({});
  if (path === '/r/private_test/api/link_flair_v2.json') return json([]);
  if (path === '/api/info.json') return json(listing([state.items[url.searchParams.get('id')]].filter(Boolean)));
  if (path === '/user/sandbox_test_user/submitted.json') return json(listing(Object.values(state.items).filter(item => item.name.startsWith('t3_'))));
  if (path === '/user/sandbox_test_user/comments.json') return json(listing(Object.values(state.items).filter(item => item.name.startsWith('t1_'))));
  const form = new URLSearchParams(options.body);
  const save = () => writeFileSync(stateFile, JSON.stringify(state));
  if (path === '/api/submit') {
    if (form.get('sr') !== 'private_test' || options.method !== 'POST') throw new Error('Invalid fixture post');
    state.actions.push('submit');
    state.items.t3_p1 = { id: 'p1', name: 't3_p1', title: form.get('title'), selftext: form.get('text'), subreddit: 'private_test', author: 'sandbox_test_user', removed_by_category: null };
    save();
    return json({ json: { errors: [], data: { id: 'p1', name: 't3_p1', url: 'https://www.reddit.com/r/private_test/comments/p1/test/' } } });
  }
  if (path === '/api/comment') {
    if (form.get('thing_id') !== 't3_p1' || options.method !== 'POST') throw new Error('Invalid fixture comment');
    state.actions.push('comment');
    state.items.t1_c1 = { id: 'c1', name: 't1_c1', body: form.get('text'), link_id: 't3_p1', subreddit: 'private_test', author: 'sandbox_test_user' };
    save();
    return json({ json: { errors: [], data: { things: [{ data: { id: 'c1', permalink: '/r/private_test/comments/p1/test/c1/' } }] } } });
  }
  if (path === '/api/del') {
    if (options.method !== 'POST') throw new Error('Invalid fixture deletion');
    state.actions.push('delete:' + form.get('id'));
    delete state.items[form.get('id')];
    save();
    return json({});
  }
  throw new Error('Unexpected offline endpoint: ' + path);
};
