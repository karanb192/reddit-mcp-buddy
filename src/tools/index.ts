/**
 * MCP Tool implementations
 */

import { z } from 'zod';
import { RedditAPI, RSS_UNKNOWN_SCORE, LoggedOutAccessEndedError, CredentialsRequiredError } from '../services/reddit-api.js';
import { ContentProcessor } from '../services/content-processor.js';
import { RedditListing, RedditPost } from '../types/reddit.types.js';
import { NsfwMode, resolveIncludeNsfw, hidesNsfw, lockedOut, nsfwHint, nsfwHiddenNote, NSFW_NEVER_MESSAGE, INCLUDE_NSFW_DESCRIPTION } from '../core/nsfw.js';

// Reddit identifier formats. These are security boundaries, not just
// ergonomics: every value below is interpolated into a Reddit API path, and an
// authenticated request carries the user's OAuth bearer token — so an
// unconstrained string could steer that token to an arbitrary endpoint.
// Plain names are [A-Za-z0-9_]{2,21}. Two extra legitimate shapes: profile
// subreddits (u_<username>, and usernames may contain hyphens and run to 20
// chars) and multireddit paths (a+b+c), both of which Reddit serves under /r/.
const SUBREDDIT_RE = /^(?:[A-Za-z0-9_]{2,21}(?:\+[A-Za-z0-9_]{2,21})*|u_[A-Za-z0-9_-]{3,20})$/;
const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
// Post IDs are base36; legacy posts have very short ids, modern ones up to 13.
const POST_ID_RE = /^[A-Za-z0-9]{2,13}$/;

const subredditName = (description: string) =>
  z.string()
    .transform(s => s.trim().replace(/^\/?r\//i, ''))
    .refine(s => SUBREDDIT_RE.test(s), 'Subreddit must be 2-21 characters (letters, numbers, underscore) without the r/ prefix; u_<username> profile subreddits and a+b multireddits are also accepted')
    .describe(description);

// Tool schemas
export const browseSubredditSchema = z.object({
  subreddit: subredditName('Subreddit name without r/ prefix. Use specific subreddit (e.g., "technology"), "all" for Reddit-wide posts, or "popular" for trending across default subreddits'),
  sort: z.enum(['hot', 'new', 'top', 'rising', 'controversial']).optional().default('hot'),
  time: z.enum(['hour', 'day', 'week', 'month', 'year', 'all']).optional(),
  limit: z.number().min(1).max(100).optional().default(25).describe('Default 25, range (1-100). Change ONLY IF user specifies.'),
  include_nsfw: z.boolean().optional().describe(INCLUDE_NSFW_DESCRIPTION),
  include_subreddit_info: z.boolean().optional().default(false).describe('Include subreddit metadata like subscriber count and description. Requires Reddit credentials; omitted from RSS fallback results'),
});

export const searchRedditSchema = z.object({
  query: z.string().describe('Search query'),
  subreddits: z.array(subredditName('Subreddit name without r/ prefix')).max(10).optional().describe('Subreddits to search in, max 10 (leave empty for all)'),
  sort: z.enum(['relevance', 'hot', 'top', 'new', 'comments']).optional().default('relevance'),
  time: z.enum(['hour', 'day', 'week', 'month', 'year', 'all']).optional().default('all'),
  limit: z.number().min(1).max(100).optional().default(25).describe('Default 25, range (1-100). Override ONLY IF user requests.'),
  author: z.string().optional(),
  flair: z.string().optional(),
  include_nsfw: z.boolean().optional().describe(INCLUDE_NSFW_DESCRIPTION),
});

export const getPostDetailsSchema = z.object({
  post_id: z.string()
    .transform(s => s.trim().replace(/^t3_/i, ''))
    .refine(s => POST_ID_RE.test(s), 'Post ID must be 2-13 alphanumeric characters (e.g. "1abc2d3"), with or without the t3_ prefix')
    .optional()
    .describe('Reddit post ID (e.g., "1abc2d3")'),
  subreddit: subredditName('Subreddit name (optional with post_id, but more efficient if provided)').optional(),
  url: z.string().optional().describe('Full Reddit URL (alternative to post_id)'),
  comment_limit: z.number().min(1).max(500).optional().default(20).describe('Default 20, range (1-500). Change ONLY IF user asks.'),
  comment_sort: z.enum(['best', 'top', 'new', 'controversial', 'qa']).optional().default('best'),
  comment_depth: z.number().min(1).max(10).optional().default(3).describe('Default 3, range (1-10). Override ONLY IF user specifies.'),
  extract_links: z.boolean().optional().default(false),
  max_top_comments: z.number().min(1).max(20).optional().default(5).describe('Default 5, range (1-20). Change ONLY IF user requests.'),
});

export const userAnalysisSchema = z.object({
  username: z.string()
    .transform(s => s.trim().replace(/^\/?u(?:ser)?\//i, ''))
    .refine(s => USERNAME_RE.test(s), 'Username must be 3-20 characters (letters, numbers, underscore, hyphen), without the u/ prefix')
    .describe('Reddit username without u/ prefix'),
  posts_limit: z.number().min(0).max(100).optional().default(10).describe('Default 10, range (0-100). Change ONLY IF user specifies.'),
  comments_limit: z.number().min(0).max(100).optional().default(10).describe('Default 10, range (0-100). Override ONLY IF user asks.'),
  time_range: z.enum(['day', 'week', 'month', 'year', 'all']).optional().default('month').describe('Time range for posts/comments (default: month). Note: When set to values other than "all", posts are sorted by top scores within that period. When set to "all", posts are sorted by newest'),
  top_subreddits_limit: z.number().min(1).max(50).optional().default(10).describe('Default 10, range (1-50). Change ONLY IF user requests.'),
});


export const redditExplainSchema = z.object({
  term: z.string().describe('Reddit term to explain (e.g., "karma", "cake day", "AMA")'),
});

// Each candidate is looked up as one name. Anything else (a multireddit path such as a+b, a name
// too long to exist) is reported as not found without being sent to Reddit.
const PLAIN_SUBREDDIT_RE = /^[A-Za-z0-9_]{2,21}$/;

export const findSubredditsSchema = z.object({
  query: z.string().trim().min(1).max(512)
    .describe('2 to 4 keywords for the topic, as you would type them in a search box (e.g., "budget cooking", "mechanical keyboards"). NOT a sentence: Reddit matches words, so long phrases return unrelated subreddits.'),
  candidates: z.array(
    z.string().max(100).transform(s => s.trim().replace(/^\/?r\//i, ''))
  ).max(10).optional()
    .describe('Up to 10 subreddit names you think fit, without r/. Each is checked against Reddit; names Reddit does not return come back in not_found.'),
  include_nsfw: z.boolean().optional()
    .describe(`NSFW subreddits left out are counted in nsfw_hidden. ${INCLUDE_NSFW_DESCRIPTION}`),
  limit: z.number().int().min(1).max(50).optional().default(10).describe('Default 10, range (1-50). Most Reddit search suggestions to return. Change ONLY IF user asks.'),
  min_subscribers: z.number().int().min(0).optional().default(1000)
    .describe('Default 1000. Search suggestions with fewer subscribers are left out and counted in small_hidden; your candidates are never filtered by size. Lower it ONLY IF the user wants niche or new communities.'),
});

type SubredditSource = 'assistant' | 'reddit_search';
type UnavailableReason = 'private' | 'quarantined' | 'banned_or_restricted';

interface FoundSubreddit {
  name: string;
  url: string | null;
  title: string | null;
  description: string | null;
  subscribers: number | null;
  subscribers_as_of: string | null;
  type: string | null;
  nsfw: boolean | null;
  source: SubredditSource;
  confirmed_exists: boolean;
}

// A search query longer than this is treated as a sentence and gets a note.
const KEYWORD_QUERY_MAX_WORDS = 5;

/**
 * Pull subreddit records out of a Reddit listing without trusting its shape:
 * a missing listing, null children, non-t5 kinds and records without a name are skipped.
 */
function subredditRecords(listing: unknown): any[] {
  const children = (listing as any)?.data?.children;
  if (!Array.isArray(children)) return [];
  return children
    .filter(child => child?.kind === 't5' && child.data && typeof child.data.display_name === 'string' && child.data.display_name.length > 0)
    .map(child => child.data);
}

/**
 * Reddit still returns a record for a subreddit the token cannot read, with its counts and flags
 * nulled (checked live, 2026-11-11): a private one keeps subreddit_type "private", a quarantined
 * one carries quarantine fields, and a banned one has neither.
 */
function unavailableReason(data: any): UnavailableReason | null {
  if (data.subreddit_type === 'private') return 'private';
  if (data.quarantine === true || 'quarantine_message' in data) return 'quarantined';
  if (data.subscribers == null && data.over18 == null) return 'banned_or_restricted';
  return null;
}

function shapeSubreddit(data: any, source: SubredditSource, fetchedAt: number): FoundSubreddit {
  const description = typeof data.public_description === 'string' && data.public_description.trim()
    ? data.public_description.trim()
    : null;
  return {
    name: data.display_name,
    url: `https://www.reddit.com/r/${encodeURIComponent(data.display_name)}/`,
    title: typeof data.title === 'string' && data.title ? data.title : null,
    description: description ? description.substring(0, 300) : null,
    subscribers: typeof data.subscribers === 'number' && Number.isFinite(data.subscribers) ? data.subscribers : null,
    subscribers_as_of: new Date(fetchedAt).toISOString(),
    type: typeof data.subreddit_type === 'string' ? data.subreddit_type : null,
    nsfw: typeof data.over18 === 'boolean' ? data.over18 : null,
    source,
    confirmed_exists: true,
  };
}

/**
 * Shape RSS-sourced posts for consumption by an LLM.
 *
 * Reddit's public Atom feed (used as the credential-free fallback) does not
 * include engagement metrics — score, num_comments and upvote_ratio are absent.
 * The API client marks those fields with RSS_UNKNOWN_SCORE; here they are
 * normalized to null and an explanatory note is attached so the model treats
 * them as unavailable rather than inferring popularity from placeholder values.
 *
 * The feed also carries no per-post over_18 flag, so the include_nsfw filter
 * cannot apply to RSS results — nsfw is set to null and the note discloses it.
 * (Reddit's logged-out feed refuses NSFW subreddits outright with an error,
 * but individual posts inside SFW subreddits come with no flag to check.)
 */
function shapeRssPosts(posts: any[]): { posts: any[]; note: string } {
  const cleaned = posts.map(p => ({
    ...p,
    score: p.score === RSS_UNKNOWN_SCORE ? null : p.score,
    num_comments: p.num_comments === RSS_UNKNOWN_SCORE ? null : p.num_comments,
    upvote_ratio: p.upvote_ratio ?? null,
    nsfw: p.nsfw ?? null,
  }));
  return {
    posts: cleaned,
    note: 'Served from Reddit\'s public RSS feed (credential-free fallback used because the JSON API was unavailable). score, num_comments, and upvote_ratio are not provided by RSS and are null — do not infer or estimate popularity from them. NSFW flags are also not provided (nsfw is null), so the include_nsfw filter does not apply to these posts; Reddit\'s logged-out feed blocks NSFW subreddits entirely, but posts within other subreddits are unfiltered.',
  };
}

/**
 * Tool implementations
 */
export class RedditTools {
  constructor(private api: RedditAPI, private nsfwMode: NsfwMode = 'ask') {}

  async browseSubreddit(params: z.infer<typeof browseSubredditSchema>) {
    const listing = await this.api.browseSubreddit(
      params.subreddit,
      params.sort,
      {
        limit: params.limit,
        time: params.time,
      }
    );

    // Filter NSFW content unless requested. RSS-sourced posts carry no
    // over_18 flag and pass through — disclosed via the note in shapeRssPosts.
    // Filter into a NEW array: `listing` is the cached object by reference, so
    // reassigning its children would shrink the shared cache entry (the cache
    // key does not include include_nsfw).
    const includeNsfw = resolveIncludeNsfw(this.nsfwMode, params.include_nsfw);
    const readable = listing.data.children.filter(child => child.data);
    const children = readable.filter(child => !hidesNsfw(this.nsfwMode, includeNsfw, child.data.over_18));
    const nsfwHidden = readable.length - children.length;

    // Extract just the essential fields from Reddit's verbose response
    const posts = children.map(child => ({
      id: child.data.id,
      title: child.data.title,
      author: child.data.author,
      score: child.data.score,
      upvote_ratio: child.data.upvote_ratio,
      num_comments: child.data.num_comments,
      created_utc: child.data.created_utc,
      url: child.data.url,
      permalink: `https://reddit.com${child.data.permalink}`,
      subreddit: child.data.subreddit,
      is_video: child.data.is_video,
      is_text_post: child.data.is_self,
      content: child.data.selftext?.substring(0, 500), // Limit text preview
      nsfw: child.data.over_18,
      stickied: child.data.stickied,
      link_flair_text: child.data.link_flair_text,
    }));

    const dataSource = listing.data._source ?? 'api';

    let result: any = {
      posts,
      total_posts: posts.length,
      data_source: dataSource,
    };

    // When data came from the RSS fallback, engagement metrics are unavailable.
    // Shape them so the LLM doesn't fabricate popularity numbers.
    if (dataSource === 'rss') {
      const shaped = shapeRssPosts(posts);
      result.posts = shaped.posts;
      result.note = shaped.note;
    }

    if (nsfwHidden > 0) {
      result.nsfw_hidden = nsfwHidden;
      const hidden = nsfwHiddenNote(this.nsfwMode, nsfwHidden, 'post');
      result.note = result.note ? `${result.note} ${hidden}` : hidden;
    }

    // Optionally fetch subreddit info
    if (params.include_subreddit_info) {
      try {
        const subredditInfo = await this.api.getSubreddit(params.subreddit);
        if (lockedOut(this.nsfwMode, subredditInfo.over18)) {
          const why = `Subreddit info was left out: the subreddit is NSFW or not marked either way. ${NSFW_NEVER_MESSAGE}`;
          result.note = result.note?.includes(NSFW_NEVER_MESSAGE)
            ? `${result.note} Subreddit info was left out for the same reason.`
            : result.note ? `${result.note} ${why}` : why;
        } else {
          result.subreddit_info = {
            name: subredditInfo.display_name,
            subscribers: subredditInfo.subscribers,
            description: subredditInfo.public_description || subredditInfo.description,
            type: subredditInfo.subreddit_type,
            created: new Date(subredditInfo.created_utc * 1000),
            nsfw: subredditInfo.over18,
          };
        }
      } catch (error) {
        // If subreddit info fails, continue without it
        console.error(`Failed to fetch subreddit info: ${error}`);
      }
    }

    return result;
  }

  async searchReddit(params: z.infer<typeof searchRedditSchema>) {
    const includeNsfw = resolveIncludeNsfw(this.nsfwMode, params.include_nsfw);

    // Handle multiple subreddits
    let results: RedditListing<RedditPost>;
    
    if (params.subreddits && params.subreddits.length > 0) {
      if (params.subreddits.length === 1) {
        // Single subreddit - direct search
        results = await this.api.search(params.query, {
          subreddit: params.subreddits[0],
          sort: params.sort,
          time: params.time,
          limit: params.limit,
          includeNsfw,
        });
      } else {
        // Multiple subreddits - parallel search with failure tolerance
        const searchPromises = params.subreddits.map(sub =>
          this.api.search(params.query, {
            subreddit: sub,
            sort: params.sort,
            time: params.time,
            limit: Math.ceil(params.limit! / params.subreddits!.length),
            includeNsfw,
          })
        );

        // Use allSettled to handle individual subreddit failures gracefully
        const allResults = await Promise.allSettled(searchPromises);

        // The shutdown applies to every subreddit. Preserve it even if another search
        // completed just before the cutoff, instead of suggesting different subreddit names.
        for (const result of allResults) {
          if (result.status === 'rejected' && result.reason instanceof LoggedOutAccessEndedError) {
            throw result.reason;
          }
        }

        // Combine results from successful searches, skip failed ones
        const successfulResults = allResults
          .filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled')
          .map(result => result.value);

        const failedSubreddits = allResults
          .map((result, index) => ({ status: result.status, sub: params.subreddits![index] }))
          .filter(item => item.status === 'rejected')
          .map(item => item.sub);

        // Log any failures
        if (failedSubreddits.length > 0) {
          console.warn(`Search failed for subreddits: ${failedSubreddits.join(', ')}`);
        }

        // If all searches failed, throw error
        if (successfulResults.length === 0) {
          throw new Error(`Search failed for all subreddits: ${failedSubreddits.join(', ')}`);
        }

        // Combine results from successful searches
        results = {
          kind: 'Listing',
          data: {
            children: successfulResults.flatMap(r => r.data.children),
            after: null,
            before: null,
          }
        };
      }
    } else {
      // Search all of Reddit
      results = await this.api.search(params.query, {
        subreddit: undefined,
        sort: params.sort,
        time: params.time,
        limit: params.limit,
        includeNsfw,
      });
    }

    // Client-side filters. These build NEW arrays: `results` is the cached
    // object by reference and the cache key excludes author/flair, so
    // reassigning its children would serve the filtered subset to every later
    // caller of the same query.
    // Reddit leaves NSFW posts out when asked to; this also covers a response that carries them anyway.
    const fromReddit = results.data.children.filter(child => child.data);
    let children = fromReddit.filter(child => !hidesNsfw(this.nsfwMode, includeNsfw, child.data.over_18));
    const nsfwHidden = fromReddit.length - children.length;
    const unfilteredCount = children.length;

    // Filter by author if specified
    if (params.author) {
      const author = params.author.replace(/^\/?u\//i, '').toLowerCase();
      children = children.filter(
        child => child.data.author?.toLowerCase() === author
      );
    }

    // Filter by flair if specified
    if (params.flair) {
      const flair = params.flair.toLowerCase();
      children = children.filter(
        child => child.data.link_flair_text?.toLowerCase().includes(flair)
      );
    }

    // Extract just the essential fields from Reddit's verbose response
    const posts = children.map(child => ({
      id: child.data.id,
      title: child.data.title,
      author: child.data.author,
      score: child.data.score,
      upvote_ratio: child.data.upvote_ratio,
      num_comments: child.data.num_comments,
      created_utc: child.data.created_utc,
      url: child.data.url,
      permalink: `https://reddit.com${child.data.permalink}`,
      subreddit: child.data.subreddit,
      is_video: child.data.is_video,
      is_text_post: child.data.is_self,
      content: child.data.selftext?.substring(0, 500), // Limit text preview
      nsfw: child.data.over_18,
      link_flair_text: child.data.link_flair_text,
    }));

    const result: any = {
      results: posts,
      total_results: posts.length
    };

    if (nsfwHidden > 0) {
      result.nsfw_hidden = nsfwHidden;
      result.note = nsfwHiddenNote(this.nsfwMode, nsfwHidden, 'post');
    } else if (!includeNsfw && unfilteredCount === 0) {
      // Reddit drops NSFW posts before it answers, so an empty result cannot say how many there were.
      result.note = `No posts came back. NSFW posts are left out of search, and a search inside an NSFW subreddit returns nothing without them. ${nsfwHint(this.nsfwMode)}`;
    }

    // Author/flair are applied locally, AFTER Reddit truncated the response to
    // `limit`. Say so, otherwise a short result list reads as "few matches
    // exist" rather than "few matches were in the first page".
    if ((params.author || params.flair) && posts.length < unfilteredCount) {
      result.filter_note = `${unfilteredCount} posts matched the query; ${posts.length} remained after applying the ${[params.author && 'author', params.flair && 'flair'].filter(Boolean).join(' and ')} filter locally. Reddit applies the limit before this filter, so more matches may exist beyond the first ${unfilteredCount} results.`;
    }

    return result;
  }

  async getPostDetails(params: z.infer<typeof getPostDetailsSchema>) {
    let postIdentifier: string;

    if (params.url) {
      // Extract from URL - returns format "subreddit_postid"
      postIdentifier = this.extractPostIdFromUrl(params.url);
    } else if (params.post_id) {
      // If subreddit provided, use it; otherwise getPost will fetch it
      postIdentifier = params.subreddit
        ? `${params.subreddit}_${params.post_id}`
        : params.post_id;
    } else {
      throw new Error('Provide either url OR post_id');
    }

    const [postListing, commentsListing] = await this.api.getPost(postIdentifier, {
      limit: params.comment_limit,
      sort: params.comment_sort,
      depth: params.comment_depth,
    });

    const postChild = postListing.data.children?.[0];
    if (!postChild?.data) {
      throw new Error('Reddit returned no post for that id - it may be removed, quarantined, or withheld in your region');
    }
    const post = postChild.data;

    if (lockedOut(this.nsfwMode, post.over_18)) {
      throw new Error(`${post.over_18 ? 'This post is marked NSFW.' : 'Reddit did not say whether this post is NSFW.'} ${NSFW_NEVER_MESSAGE}`);
    }

    // Extract essential post fields
    const cleanPost = {
      id: post.id,
      title: post.title,
      author: post.author,
      score: post.score,
      upvote_ratio: post.upvote_ratio,
      num_comments: post.num_comments,
      created_utc: post.created_utc,
      url: post.url,
      permalink: `https://reddit.com${post.permalink}`,
      subreddit: post.subreddit,
      is_video: post.is_video,
      is_text_post: post.is_self,
      content: post.selftext?.substring(0, 1000), // More text for post details
      nsfw: post.over_18,
      link_flair_text: post.link_flair_text,
      stickied: post.stickied,
      locked: post.locked,
    };

    interface CommentNode {
      id: string;
      author: string;
      score: number;
      body: string;
      created_utc: number;
      depth: number;
      is_op: boolean;
      permalink: string;
      replies: CommentNode[];
    }

    const buildCommentTree = (listing: typeof commentsListing): CommentNode[] => {
      const nodes: CommentNode[] = [];
      for (const child of listing.data.children) {
        // Reddit sends {kind:'t1', data:null} for some removed comments, and
        // 'more' stubs are not comments at all.
        if (child.kind !== 't1' || !child.data) continue;
        const c = child.data;
        const node: CommentNode = {
          id: c.id,
          author: c.author,
          score: c.score,
          body: (c.body || '').substring(0, 500),
          created_utc: c.created_utc,
          depth: c.depth,
          is_op: c.is_submitter ?? false,
          permalink: `https://reddit.com${c.permalink}`,
          replies: [],
        };
        if (c.replies && typeof c.replies !== 'string' && c.replies.data?.children?.length) {
          node.replies = buildCommentTree(c.replies as typeof commentsListing);
        }
        nodes.push(node);
      }
      return nodes;
    };

    const countComments = (nodes: CommentNode[]): number =>
      nodes.reduce((sum, n) => sum + 1 + countComments(n.replies), 0);

    const commentTree = buildCommentTree(commentsListing);

    let result: any = {
      post: cleanPost,
      total_comments: countComments(commentTree),
      top_comments: commentTree.slice(0, params.max_top_comments || 5),
    };

    // Extract links if requested
    if (params.extract_links) {
      const links = new Set<string>();
      const extractLinks = (nodes: CommentNode[]) => {
        for (const node of nodes) {
          const urls = node.body.match(/https?:\/\/[^\s]+/g) || [];
          urls.forEach(url => links.add(url));
          if (node.replies.length) extractLinks(node.replies);
        }
      };
      extractLinks(commentTree);
      result.extracted_links = Array.from(links);
    }

    return result;
  }

  async userAnalysis(params: z.infer<typeof userAnalysisSchema>) {
    // Try to get posts within the specified time range first
    // If time_range is 'all', use 'new' sort; otherwise use 'top' to respect time filtering
    const sort = params.time_range === 'all' ? 'new' : 'top';
    
    let posts = null;
    let comments = null;
    let usedFallback = false;
    
    const user = await this.api.getUser(params.username);
    
    // Fetch posts
    if (params.posts_limit > 0) {
      posts = await this.api.getUserPosts(params.username, 'submitted', {
        limit: params.posts_limit,
        sort,
        time: params.time_range,
      });
      
      // If no results with time filter, fallback to getting recent posts
      if (posts.data.children.length === 0 && params.time_range !== 'all') {
        usedFallback = true;
        posts = await this.api.getUserPosts(params.username, 'submitted', {
          limit: params.posts_limit,
          sort: 'new',
          time: 'all',
        });
      }
    }
    
    // Fetch comments
    if (params.comments_limit > 0) {
      comments = await this.api.getUserPosts(params.username, 'comments', {
        limit: params.comments_limit,
        sort,
        time: params.time_range,
      });
      
      // If no results with time filter, fallback to getting recent comments
      if (comments.data.children.length === 0 && params.time_range !== 'all') {
        usedFallback = true;
        comments = await this.api.getUserPosts(params.username, 'comments', {
          limit: params.comments_limit,
          sort: 'new',
          time: 'all',
        });
      }
    }

    // "never" is the owner's lock, so it also covers a named user's history.
    let nsfwHidden = 0;
    if (this.nsfwMode === 'never') {
      const withoutNsfw = <T extends { data: { children: Array<{ data: any }> } }>(listing: T | null): T | null => {
        if (!listing) return listing;
        // A NEW listing: the fetched one is the cached object.
        const kept = listing.data.children.filter(child => !child.data || !lockedOut(this.nsfwMode, child.data.over_18));
        nsfwHidden += listing.data.children.length - kept.length;
        return { ...listing, data: { ...listing.data, children: kept } };
      };
      posts = withoutNsfw(posts);
      comments = withoutNsfw(comments);
    }

    // Process summary
    let summary: any;
    if (posts) {
      summary = ContentProcessor.processUserSummary(user, posts, {
        maxTopSubreddits: params.top_subreddits_limit,
        comments: comments || undefined
      });
    } else {
      // Fallback when no posts - but still include comments if available
      summary = {
        username: user.name,
        accountAge: 'Unknown',
        karma: {
          link: user.link_karma,
          comment: user.comment_karma,
          total: user.link_karma + user.comment_karma,
        },
      };

      // Add comments even when there are no posts
      if (comments && comments.data.children.length > 0) {
        // Filter out deleted comments (where data is null) and safely extract data
        summary.recentComments = comments.data.children
          .filter(child => child.data !== null && child.data !== undefined)
          .map(child => {
            const comment = child.data as any;
            // Safely handle deleted/removed comments
            if (!comment.id || !comment.body) return null;
            return {
              id: comment.id,
              body: comment.body.substring(0, 200) + (comment.body.length > 200 ? '...' : ''),
              score: comment.score || 0,
              subreddit: comment.subreddit || 'unknown',
              postTitle: comment.link_title || 'deleted',
              created: new Date((comment.created_utc || 0) * 1000),
              url: comment.permalink ? `https://reddit.com${comment.permalink}` : null,
            };
          })
          .filter(c => c !== null); // Remove any null entries from filtering
      }
    }

    // Add note if we used fallback data
    if (usedFallback && params.time_range !== 'all') {
      const timeRangeLabel = {
        'hour': 'hour',
        'day': 'day',
        'week': 'week', 
        'month': 'month',
        'year': 'year'
      }[params.time_range];
      
      summary.timeRangeNote = `No posts found in the last ${timeRangeLabel}, showing all recent posts instead`;
    }

    if (nsfwHidden > 0) {
      summary.nsfwHidden = nsfwHidden;
      summary.nsfwNote = `${nsfwHidden} ${nsfwHidden === 1 ? 'item was' : 'items were'} left out of this user's posts and comments as NSFW or not marked either way. ${NSFW_NEVER_MESSAGE}`;
    }

    return summary;
  }




  async findSubreddits(params: z.infer<typeof findSubredditsSchema>) {
    const includeNsfw = resolveIncludeNsfw(this.nsfwMode, params.include_nsfw);
    const candidates: string[] = [];
    const seen = new Set<string>();
    const invalidNames: string[] = [];
    for (const name of params.candidates ?? []) {
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      (PLAIN_SUBREDDIT_RE.test(name) ? candidates : invalidNames).push(name);
    }

    // Ask for more than the limit, since small and NSFW suggestions are dropped before the cut.
    const searchSize = Math.min(100, params.limit * 3);
    const [searchOutcome, namesOutcome] = await Promise.allSettled([
      this.api.searchSubreddits(params.query, searchSize, includeNsfw),
      candidates.length > 0 ? this.api.getSubredditsByName(candidates) : Promise.resolve(null),
    ]);

    // Access-wide failures win over partial results, so the caller is never sent off to try other names.
    const rejections = [searchOutcome, namesOutcome]
      .filter((o): o is PromiseRejectedResult => o.status === 'rejected')
      .map(o => o.reason);
    const accessError = rejections.find(e => e instanceof LoggedOutAccessEndedError)
      ?? rejections.find(e => e instanceof CredentialsRequiredError);
    if (accessError) {
      throw accessError;
    }
    if (searchOutcome.status === 'rejected' && (candidates.length === 0 || namesOutcome.status === 'rejected')) {
      throw searchOutcome.reason;
    }

    const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
    const notes: string[] = [];
    const unavailable: { name: string; reason: UnavailableReason }[] = [];
    const unavailableNames = new Set<string>();
    const markUnavailable = (name: string, reason: UnavailableReason) => {
      if (!unavailableNames.has(name.toLowerCase())) {
        unavailableNames.add(name.toLowerCase());
        unavailable.push({ name, reason });
      }
    };

    const searchResults: FoundSubreddit[] = [];
    const searchByName = new Map<string, FoundSubreddit>();
    // An unreadable subreddit in the search is named only if the caller asked about it by name:
    // the tool does not point at banned or quarantined subreddits nobody mentioned.
    const unreadableInSearch = new Map<string, { name: string; reason: UnavailableReason }>();
    if (searchOutcome.status === 'fulfilled') {
      for (const data of subredditRecords(searchOutcome.value.listing)) {
        const key = data.display_name.toLowerCase();
        const reason = unavailableReason(data);
        if (reason) {
          unreadableInSearch.set(key, { name: data.display_name, reason });
          continue;
        }
        if (searchByName.has(key)) continue;
        const shaped = shapeSubreddit(data, 'reddit_search', searchOutcome.value.fetched_at);
        searchByName.set(key, shaped);
        searchResults.push(shaped);
      }
    } else {
      notes.push(`Reddit's subreddit search failed, so only your candidates are reported (${message(searchOutcome.reason)}).`);
    }

    const candidateResults: FoundSubreddit[] = [];
    const notFound: string[] = [...invalidNames];
    if (namesOutcome.status === 'fulfilled' && namesOutcome.value) {
      const { listing, fetched_at } = namesOutcome.value;
      const byName = new Map(subredditRecords(listing).map(data => [data.display_name.toLowerCase(), data]));
      for (const name of candidates) {
        const data = byName.get(name.toLowerCase());
        const fromSearch = searchByName.get(name.toLowerCase());
        const reason = data ? unavailableReason(data) : null;
        if (data && reason) {
          markUnavailable(data.display_name, reason);
        } else if (data) {
          candidateResults.push(shapeSubreddit(data, 'assistant', fetched_at));
        } else if (fromSearch) {
          candidateResults.push({ ...fromSearch, source: 'assistant' });
        } else if (unreadableInSearch.has(name.toLowerCase())) {
          const unreadable = unreadableInSearch.get(name.toLowerCase())!;
          markUnavailable(unreadable.name, unreadable.reason);
        } else {
          notFound.push(name);
        }
      }
    } else if (namesOutcome.status === 'rejected') {
      for (const name of candidates) {
        const fromSearch = searchByName.get(name.toLowerCase());
        const unreadable = unreadableInSearch.get(name.toLowerCase());
        if (unreadable) {
          markUnavailable(unreadable.name, unreadable.reason);
          continue;
        }
        candidateResults.push(fromSearch
          ? { ...fromSearch, source: 'assistant' }
          : {
              name,
              url: null,
              title: null,
              description: null,
              subscribers: null,
              subscribers_as_of: null,
              type: null,
              nsfw: null,
              source: 'assistant',
              confirmed_exists: false,
            });
      }
      notes.push(`Reddit's name check failed (${message(namesOutcome.reason)}). Candidates with confirmed_exists false were not checked; do not assume they exist.`);
    }

    // An unchecked candidate carries nothing from Reddit, so there is nothing to hide.
    const hideNsfw = (r: FoundSubreddit) => r.confirmed_exists && hidesNsfw(this.nsfwMode, includeNsfw, r.nsfw);
    const shownCandidates = candidateResults.filter(r => !hideNsfw(r));
    const hiddenCandidates = candidateResults.filter(hideNsfw).map(r => r.name);

    const suggestions = searchResults.filter(r => !seen.has(r.name.toLowerCase()));
    const sfwSuggestions = suggestions.filter(r => !hideNsfw(r));
    const bigEnough = sfwSuggestions.filter(r => r.subscribers === null || r.subscribers >= params.min_subscribers);
    const shownSuggestions = bigEnough.slice(0, params.limit);
    const nsfwHidden = hiddenCandidates.length + (suggestions.length - sfwSuggestions.length);
    const smallHidden = sfwSuggestions.length - bigEnough.length;

    if (notFound.length > invalidNames.length) {
      notes.push('Reddit returned nothing for the names in not_found. Treat them as not existing: do not browse or search them.');
    }
    if (invalidNames.length > 0) {
      notes.push(`Not checked, because a subreddit name is 2 to 21 letters, numbers or underscores: ${invalidNames.join(', ')}.`);
    }
    if (unavailable.length > 0) {
      notes.push('The names in unavailable exist but cannot be read with these credentials. Do not browse or search them.');
    }
    const isSentence = params.query.split(/\s+/).length > KEYWORD_QUERY_MAX_WORDS;
    if (searchOutcome.status === 'fulfilled' && shownSuggestions.length === 0) {
      if (smallHidden > 0) {
        notes.push(`Reddit's subreddit search returned only small subreddits for this query (${smallHidden} under ${params.min_subscribers} subscribers). Try other keywords, or lower min_subscribers if the user wants niche communities.`);
      } else if (isSentence) {
        notes.push("Reddit's subreddit search returned nothing because this query reads like a sentence and it matches words. Retry with 2 to 4 keywords.");
      } else {
        notes.push("Reddit's subreddit search returned nothing for this query. It matches words: try 2 to 4 different keywords, or pass likely subreddit names as candidates.");
      }
    } else if (isSentence) {
      notes.push("This query reads like a sentence. Reddit's subreddit search matches words, so the suggestions may be off topic: retry with 2 to 4 keywords if they do not fit.");
    }

    if (this.nsfwMode === 'never' && (params.include_nsfw === true || nsfwHidden > 0)) {
      notes.push(`Subreddits that are NSFW or not marked either way are left out. ${nsfwHint(this.nsfwMode)}`);
    }

    const shown = [...shownCandidates, ...shownSuggestions];
    const result: any = {
      results: shown,
      total_results: shown.length,
      not_found: notFound,
      unavailable,
      nsfw_hidden: nsfwHidden,
      small_hidden: smallHidden,
    };
    if (hiddenCandidates.length > 0) {
      result.nsfw_hidden_candidates = hiddenCandidates;
    }
    if (notes.length > 0) {
      result.note = notes.join(' ');
    }
    return result;
  }

  async redditExplain(params: z.infer<typeof redditExplainSchema>) {
    // This would ideally use a knowledge base, but we'll provide common explanations
    const explanations: Record<string, any> = {
      'karma': {
        definition: 'Reddit points earned from upvotes on posts and comments',
        origin: 'Concept from Hinduism/Buddhism adapted for Reddit\'s scoring system',
        usage: 'Users accumulate karma to show contribution quality',
        examples: ['High karma users are often trusted more', 'Some subreddits require minimum karma to post'],
      },
      'cake day': {
        definition: 'Anniversary of when a user joined Reddit',
        origin: 'Reddit displays a cake icon next to usernames on this day',
        usage: 'Users often get extra upvotes on their cake day',
        examples: ['Happy cake day!', 'It\'s my cake day, AMA'],
      },
      'ama': {
        definition: 'Ask Me Anything - Q&A session with interesting people',
        origin: 'Started in r/IAmA subreddit',
        usage: 'Celebrities, experts, or people with unique experiences answer questions',
        examples: ['I am Elon Musk, AMA', 'I survived a plane crash, AMA'],
      },
      'eli5': {
        definition: 'Explain Like I\'m 5 - request for simple explanation',
        origin: 'From r/explainlikeimfive subreddit',
        usage: 'Used when asking for complex topics to be explained simply',
        examples: ['ELI5: How does bitcoin work?', 'Can someone ELI5 quantum computing?'],
      },
      'til': {
        definition: 'Today I Learned - sharing interesting facts',
        origin: 'From r/todayilearned subreddit',
        usage: 'Prefix for sharing newly discovered information',
        examples: ['TIL bananas are berries', 'TIL about the Baader-Meinhof phenomenon'],
      },
      'op': {
        definition: 'Original Poster - person who created the post',
        origin: 'Common internet forum terminology',
        usage: 'Refers to the person who started the discussion',
        examples: ['OP delivers!', 'Waiting for OP to respond'],
      },
      'repost': {
        definition: 'Content that has been posted before',
        origin: 'Common issue on content aggregation sites',
        usage: 'Often called out by users who\'ve seen the content before',
        examples: ['This is a repost from last week', 'General Reposti!'],
      },
      'brigading': {
        definition: 'Coordinated effort to manipulate votes or harass',
        origin: 'Named after military brigade tactics',
        usage: 'Against Reddit rules, can result in bans',
        examples: ['Don\'t brigade other subs', 'This looks like brigading'],
      },
      '/s': {
        definition: 'Sarcasm indicator',
        origin: 'HTML-style closing tag for sarcasm',
        usage: 'Added to end of sarcastic comments to avoid misunderstanding',
        examples: ['Yeah, that\'s totally going to work /s', 'Great idea /s'],
      },
      'banana for scale': {
        definition: 'Using a banana to show size in photos',
        origin: 'Started as a Reddit meme in 2013',
        usage: 'Humorous way to provide size reference',
        examples: ['Found this rock, banana for scale', 'No banana for scale?'],
      },
    };

    const term = params.term.toLowerCase();
    const explanation = explanations[term];

    if (!explanation) {
      return {
        definition: 'Term not found in database. This might be a subreddit-specific term or newer slang.',
        origin: 'Unknown',
        usage: 'Try searching Reddit for this term to see how it\'s used',
        examples: [],
        relatedTerms: [],
      };
    }

    return {
      definition: explanation.definition,
      origin: explanation.origin,
      usage: explanation.usage,
      examples: explanation.examples,
      relatedTerms: [],
    };
  }

  /**
   * Extract post ID and subreddit from various Reddit URL formats
   * Supports:
   * - www.reddit.com/r/subreddit/comments/postid/...
   * - old.reddit.com/r/subreddit/comments/postid/...
   * - np.reddit.com/r/subreddit/comments/postid/... (No Participation)
   * - m.reddit.com/r/subreddit/comments/postid/... (Mobile)
   * - reddit.com/r/subreddit/comments/postid/...
   * - redd.it/postid (short URL - subreddit unknown)
   * - URLs with query parameters (?utm_source=...)
   * - URLs with fragments (#comment)
   */
  private extractPostIdFromUrl(url: string): string {
    // Normalize URL: remove query params and fragments for matching
    const cleanUrl = url.split('?')[0].split('#')[0];

    // Standard Reddit URL pattern (handles www, old, np, m, or no subdomain)
    // Matches: reddit.com, www.reddit.com, old.reddit.com, np.reddit.com, m.reddit.com
    const standardMatch = cleanUrl.match(
      /(?:https?:\/\/)?(?:(?:www|old|np|m|new)\.)?reddit\.com\/r\/(\w+)\/comments\/(\w+)/i
    );
    if (standardMatch) {
      return `${standardMatch[1]}_${standardMatch[2]}`;
    }

    // Short URL pattern: redd.it/postid
    const shortMatch = cleanUrl.match(
      /(?:https?:\/\/)?redd\.it\/(\w+)/i
    );
    if (shortMatch) {
      // For short URLs, we only have the post ID, not the subreddit
      // Return with empty subreddit marker - caller must handle this
      return `_${shortMatch[1]}`;
    }

    // Cross-post or share URL pattern: reddit.com/comments/postid
    const crosspostMatch = cleanUrl.match(
      /(?:https?:\/\/)?(?:(?:www|old|np|m|new)\.)?reddit\.com\/comments\/(\w+)/i
    );
    if (crosspostMatch) {
      return `_${crosspostMatch[1]}`;
    }

    // Gallery URL pattern: reddit.com/gallery/postid
    const galleryMatch = cleanUrl.match(
      /(?:https?:\/\/)?(?:(?:www|old|np|m|new)\.)?reddit\.com\/gallery\/(\w+)/i
    );
    if (galleryMatch) {
      return `_${galleryMatch[1]}`;
    }

    throw new Error(
      'Invalid Reddit URL format. Supported formats: ' +
      'reddit.com/r/subreddit/comments/id, old.reddit.com/..., np.reddit.com/..., redd.it/id'
    );
  }
}
