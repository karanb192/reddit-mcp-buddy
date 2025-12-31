/**
 * MCP Tool implementations
 */

import { z } from 'zod';
import { RedditAPI } from '../services/reddit-api.js';
import { ContentProcessor } from '../services/content-processor.js';
import { RedditListing, RedditPost } from '../types/reddit.types.js';

// Tool schemas
export const browseSubredditSchema = z.object({
  subreddit: z.string().describe('Subreddit name without r/ prefix. Use specific subreddit (e.g., "technology"), "all" for Reddit-wide posts, or "popular" for trending across default subreddits'),
  sort: z.enum(['hot', 'new', 'top', 'rising', 'controversial']).optional().default('hot'),
  time: z.enum(['hour', 'day', 'week', 'month', 'year', 'all']).optional(),
  limit: z.number().min(1).max(100).optional().default(25).describe('Default 25, range (1-100). Change ONLY IF user specifies.'),
  include_nsfw: z.boolean().optional().default(false),
  include_subreddit_info: z.boolean().optional().default(false).describe('Include subreddit metadata like subscriber count and description'),
});

export const searchRedditSchema = z.object({
  query: z.string().describe('Search query'),
  subreddits: z.array(z.string()).optional().describe('Subreddits to search in (leave empty for all)'),
  sort: z.enum(['relevance', 'hot', 'top', 'new', 'comments']).optional().default('relevance'),
  time: z.enum(['hour', 'day', 'week', 'month', 'year', 'all']).optional().default('all'),
  limit: z.number().min(1).max(100).optional().default(25).describe('Default 25, range (1-100). Override ONLY IF user requests.'),
  author: z.string().optional(),
  flair: z.string().optional(),
});

export const getPostDetailsSchema = z.object({
  post_id: z.string().optional().describe('Reddit post ID (e.g., "1abc2d3")'),
  subreddit: z.string().optional().describe('Subreddit name (optional with post_id, but more efficient if provided)'),
  url: z.string().optional().describe('Full Reddit URL (alternative to post_id)'),
  comment_limit: z.number().min(1).max(500).optional().default(20).describe('Default 20, range (1-500). Change ONLY IF user asks.'),
  comment_sort: z.enum(['best', 'top', 'new', 'controversial', 'qa']).optional().default('best'),
  comment_depth: z.number().min(1).max(10).optional().default(3).describe('Default 3, range (1-10). Override ONLY IF user specifies.'),
  extract_links: z.boolean().optional().default(false),
  max_top_comments: z.number().min(1).max(20).optional().default(5).describe('Default 5, range (1-20). Change ONLY IF user requests.'),
});

export const userAnalysisSchema = z.object({
  username: z.string().describe('Reddit username'),
  posts_limit: z.number().min(0).max(100).optional().default(10).describe('Default 10, range (0-100). Change ONLY IF user specifies.'),
  comments_limit: z.number().min(0).max(100).optional().default(10).describe('Default 10, range (0-100). Override ONLY IF user asks.'),
  time_range: z.enum(['day', 'week', 'month', 'year', 'all']).optional().default('month').describe('Time range for posts/comments (default: month). Note: When set to values other than "all", posts are sorted by top scores within that period. When set to "all", posts are sorted by newest'),
  top_subreddits_limit: z.number().min(1).max(50).optional().default(10).describe('Default 10, range (1-50). Change ONLY IF user requests.'),
});


export const redditExplainSchema = z.object({
  term: z.string().describe('Reddit term to explain (e.g., "karma", "cake day", "AMA")'),
});

/**
 * Tool implementations
 */
export class RedditTools {
  constructor(private api: RedditAPI) {}

  async browseSubreddit(params: z.infer<typeof browseSubredditSchema>) {
    const listing = await this.api.browseSubreddit(
      params.subreddit,
      params.sort,
      {
        limit: params.limit,
        time: params.time,
      }
    );

    // Filter NSFW content unless requested
    if (!params.include_nsfw) {
      listing.data.children = listing.data.children.filter(
        child => !child.data.over_18
      );
    }

    // Extract just the essential fields from Reddit's verbose response
    const posts = listing.data.children.map(child => ({
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

    let result: any = {
      posts,
      total_posts: posts.length
    };

    // Optionally fetch subreddit info
    if (params.include_subreddit_info) {
      try {
        const subredditInfo = await this.api.getSubreddit(params.subreddit);
        result.subreddit_info = {
          name: subredditInfo.display_name,
          subscribers: subredditInfo.subscribers,
          description: subredditInfo.public_description || subredditInfo.description,
          type: subredditInfo.subreddit_type,
          created: new Date(subredditInfo.created_utc * 1000),
          nsfw: subredditInfo.over18,
        };
      } catch (error) {
        // If subreddit info fails, continue without it
        console.error(`Failed to fetch subreddit info: ${error}`);
      }
    }

    return result;
  }

  async searchReddit(params: z.infer<typeof searchRedditSchema>) {
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
        });
      } else {
        // Multiple subreddits - parallel search with failure tolerance
        const searchPromises = params.subreddits.map(sub =>
          this.api.search(params.query, {
            subreddit: sub,
            sort: params.sort,
            time: params.time,
            limit: Math.ceil(params.limit! / params.subreddits!.length),
          })
        );

        // Use allSettled to handle individual subreddit failures gracefully
        const allResults = await Promise.allSettled(searchPromises);

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
      });
    }

    // Filter by author if specified
    if (params.author) {
      results.data.children = results.data.children.filter(
        child => child.data.author.toLowerCase() === params.author!.toLowerCase()
      );
    }

    // Filter by flair if specified
    if (params.flair) {
      results.data.children = results.data.children.filter(
        child => child.data.link_flair_text?.toLowerCase().includes(params.flair!.toLowerCase())
      );
    }

    // Extract just the essential fields from Reddit's verbose response
    const posts = results.data.children.map(child => ({
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

    return {
      results: posts,
      total_results: posts.length
    };
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

    const post = postListing.data.children[0].data;

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

    // Process comments
    const comments = commentsListing.data.children
      .filter(child => child.kind === 't1') // Only comments
      .map(child => child.data);

    let result: any = {
      post: cleanPost,
      total_comments: comments.length,
      top_comments: comments.slice(0, params.max_top_comments || 5).map(c => ({
        id: c.id,
        author: c.author,
        score: c.score,
        body: (c.body || '').substring(0, 500),
        created_utc: c.created_utc,
        depth: c.depth,
        is_op: c.is_submitter,
        permalink: `https://reddit.com${c.permalink}`,
      })),
    };

    // Extract links if requested
    if (params.extract_links) {
      const links = new Set<string>();
      comments.forEach(c => {
        const urls = (c.body || '').match(/https?:\/\/[^\s]+/g) || [];
        urls.forEach(url => links.add(url));
      });
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

    return summary;
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

  private extractPostIdFromUrl(url: string): string {
    const match = url.match(/\/r\/(\w+)\/comments\/(\w+)/);
    if (match) {
      return `${match[1]}_${match[2]}`;
    }
    throw new Error('Invalid Reddit post URL');
  }
}