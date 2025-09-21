/**
 * Proper MCP Server implementation with stdio and streamable HTTP transports
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { 
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool
} from '@modelcontextprotocol/sdk/types.js';
import { createServer, IncomingMessage, ServerResponse } from 'http';

import { AuthManager } from './core/auth.js';
import { CacheManager } from './core/cache.js';
import { RateLimiter } from './core/rate-limiter.js';
import { RedditAPI } from './services/reddit-api.js';
import {
  RedditTools,
  browseSubredditSchema,
  searchRedditSchema,
  getPostDetailsSchema,
  userAnalysisSchema,
  redditExplainSchema,
} from './tools/index.js';

// Server metadata
export const SERVER_NAME = 'reddit-mcp-buddy';
export const SERVER_VERSION = '1.1.4';

/**
 * Create MCP server with proper protocol implementation
 */
export async function createMCPServer() {
  // Initialize core components
  const authManager = new AuthManager();
  await authManager.load();

  const rateLimit = authManager.getRateLimit();
  const cacheTTL = authManager.getCacheTTL();
  const disableCache = process.env.REDDIT_BUDDY_NO_CACHE === 'true';

  console.error(`🚀 Reddit MCP Buddy Server v${SERVER_VERSION}`);
  console.error(`📊 Mode: ${authManager.getAuthMode()}`);
  console.error(`⏱️  Rate limit: ${rateLimit} requests/minute`);
  console.error(`💾 Cache: ${disableCache ? 'Disabled' : `TTL ${cacheTTL / 60000} minutes`}`);

  // Create cache manager with auth-based TTL
  const cacheManager = new CacheManager({
    defaultTTL: disableCache ? 0 : cacheTTL,
    maxSize: disableCache ? 0 : 50 * 1024 * 1024, // 50MB or 0 if disabled
  });
  
  // Create rate limiter
  const rateLimiter = new RateLimiter({
    limit: rateLimit,
    window: 60000, // 1 minute
    name: 'Reddit API',
  });
  
  // Create Reddit API client
  const redditAPI = new RedditAPI({
    authManager,
    rateLimiter,
    cacheManager,
  });
  
  // Create tools instance
  const tools = new RedditTools(redditAPI);
  
  // Create MCP server
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      description: `Reddit content browser and analyzer. Access posts, comments, and user data from Reddit.

KEY CONCEPTS:
- Subreddits: Communities like "technology", "science". Use without r/ prefix
- Special subreddits: "all" (entire Reddit), "popular" (trending/default)
- Sorting: "hot" (trending), "new" (recent), "top" (highest score), "rising" (gaining traction), "controversial" (disputed)
- Time ranges: For "top" sort - "hour", "day", "week", "month", "year", "all"
- Post IDs: Short codes like "abc123" from Reddit URLs
- Usernames: Without u/ prefix (use "spez" not "u/spez")

COMMON QUERIES:
- "What's trending on Reddit?" → browse_subreddit with subreddit="all" and sort="hot"
- "Top posts this week in technology" → browse_subreddit with subreddit="technology", sort="top", time="week"
- "Search for AI discussions" → search_reddit with query="artificial intelligence"
- "Get comments on a Reddit post" → get_post_details with URL or just post_id
- "Analyze a Reddit user" → user_analysis with username

Rate limits: ${rateLimit} requests/minute. Cache TTL: ${cacheTTL / 60000} minutes.`,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );
  
  // Define available tools with proper MCP format
  const toolDefinitions: Tool[] = [
    {
      name: 'browse_subreddit',
      description: 'Fetch posts from a subreddit sorted by your choice (hot/new/top/rising). Returns post list with content, scores, and metadata.',
      inputSchema: {
        type: 'object',
        properties: {
          subreddit: { type: 'string', description: 'Subreddit name without r/ prefix. Use specific subreddit (e.g., "technology"), "all" for Reddit-wide posts, or "popular" for trending across default subreddits' },
          sort: {
            type: 'string',
            enum: ['hot', 'new', 'top', 'rising', 'controversial'],
            description: 'How to sort posts: "hot" (trending), "new" (recent), "top" (highest score), "rising" (gaining traction). Default: hot'
          },
          time: {
            type: 'string',
            enum: ['hour', 'day', 'week', 'month', 'year', 'all'],
            description: 'Time range for "top" sort only: "hour", "day", "week", "month", "year", "all"'
          },
          limit: { type: 'number', description: 'Number of posts to return (1-100, default: 25)' },
          include_nsfw: { type: 'boolean', description: 'Include adult content posts (default: false)' },
          include_subreddit_info: { type: 'boolean', description: 'Include subreddit metadata like subscriber count and description (default: false)' }
        },
        required: ['subreddit']
      }
    },
    {
      name: 'search_reddit',
      description: 'Search for posts across Reddit or specific subreddits. Returns matching posts with content and metadata.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms (e.g., "machine learning", "climate change")' },
          subreddits: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of subreddits to search in. Leave empty to search all of Reddit (e.g., ["science", "technology"])'
          },
          sort: {
            type: 'string',
            enum: ['relevance', 'hot', 'top', 'new', 'comments'],
            description: 'Result ordering: "relevance" (best match), "hot", "top", "new", "comments" (most discussed)'
          },
          time: {
            type: 'string',
            enum: ['hour', 'day', 'week', 'month', 'year', 'all'],
            description: 'Time range filter: "hour", "day", "week", "month", "year", "all"'
          },
          limit: { type: 'number', description: 'Number of results (1-100, default: 25)' },
          author: { type: 'string', description: 'Filter by specific username (e.g., "spez")' },
          flair: { type: 'string', description: 'Filter by post flair/tag (e.g., "Discussion", "News")' }
        },
        required: ['query']
      }
    },
    {
      name: 'get_post_details',
      description: 'Fetch a Reddit post with its comments. Requires EITHER url OR post_id. IMPORTANT: When using post_id alone, an extra API call is made to fetch the subreddit first (2 calls total). For better efficiency, always provide the subreddit parameter when known (1 call total).',
      inputSchema: {
        type: 'object',
        properties: {
          post_id: { type: 'string', description: 'Reddit post ID (e.g., "abc123"). Can be used alone or with subreddit for better performance' },
          subreddit: { type: 'string', description: 'Optional subreddit name when using post_id. Providing it avoids an extra API call (e.g., "science")' },
          url: { type: 'string', description: 'Full Reddit post URL (e.g., "https://reddit.com/r/science/comments/abc123/...")' },
          comment_limit: { type: 'number', description: 'Maximum comments to fetch (1-500, default: 20)' },
          comment_sort: {
            type: 'string',
            enum: ['best', 'top', 'new', 'controversial', 'qa'],
            description: 'Comment ordering: "best" (algorithm-ranked), "top" (highest score), "new", "controversial", "qa" (Q&A style). Default: best'
          },
          comment_depth: { type: 'number', description: 'Levels of nested replies to include (1-10, default: 3)' },
          extract_links: { type: 'boolean', description: 'Extract all URLs mentioned in post and comments (default: false)' },
          max_top_comments: { type: 'number', description: 'Number of top comments to return (1-50, default: 5)' }
        }
      }
    },
    {
      name: 'user_analysis',
      description: 'Analyze a Reddit user\'s posting history, karma, and activity patterns. Returns posts, comments, and statistics.',
      inputSchema: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'Reddit username without u/ prefix (e.g., "spez", not "u/spez")' },
          posts_limit: { type: 'number', description: 'Number of recent posts to include (0-100, default: 10)' },
          comments_limit: { type: 'number', description: 'Number of recent comments to include (0-100, default: 10)' },
          time_range: {
            type: 'string',
            enum: ['day', 'week', 'month', 'year', 'all'],
            description: 'Period to analyze: "day", "week", "month", "year", "all". Note: "all" returns newest content, others return top-scored content from that period'
          },
          top_subreddits_limit: { type: 'number', description: 'Number of most-active subreddits to list (1-50, default: 10)' }
        },
        required: ['username']
      }
    },
    {
      name: 'reddit_explain',
      description: 'Get explanations of Reddit terms, slang, and culture. Returns definition, origin, usage, and examples.',
      inputSchema: {
        type: 'object',
        properties: {
          term: { type: 'string', description: 'Reddit term to explain (e.g., "karma", "cake day", "AMA", "ELI5")' }
        },
        required: ['term']
      }
    }
  ];
  
  // Store handlers for HTTP access
  const handlers = {
    'tools/list': async () => ({
      tools: toolDefinitions,
    }),
    'tools/call': async (params: any) => {
      const { name, arguments: args } = params;
    
    try {
      let result: any;
      
      // Validate and parse arguments based on tool
      switch (name) {
        case 'browse_subreddit':
          result = await tools.browseSubreddit(
            browseSubredditSchema.parse(args)
          );
          break;
        case 'search_reddit':
          result = await tools.searchReddit(
            searchRedditSchema.parse(args)
          );
          break;
        case 'get_post_details':
          result = await tools.getPostDetails(
            getPostDetailsSchema.parse(args)
          );
          break;
        case 'user_analysis':
          result = await tools.userAnalysis(
            userAnalysisSchema.parse(args)
          );
          break;
        case 'reddit_explain':
          result = await tools.redditExplain(
            redditExplainSchema.parse(args)
          );
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
    }
  };
  
  // Register handlers with the MCP server
  server.setRequestHandler(ListToolsRequestSchema, handlers['tools/list']);
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return handlers['tools/call'](request.params);
  });
  
  return { server, cacheManager, tools, handlers };
}

/**
 * Start server with stdio transport (for Claude Desktop)
 */
export async function startStdioServer() {
  const { server, cacheManager } = await createMCPServer();
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error('✅ Reddit MCP Buddy Server running (stdio mode)');
  console.error('💡 Reading from stdin, writing to stdout');
  
  // Cleanup on exit
  process.on('SIGINT', () => {
    cacheManager.destroy();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    cacheManager.destroy();
    process.exit(0);
  });
}

/**
 * Start server with streamable HTTP transport for Postman MCP
 */
export async function startHttpServer(port: number = 3000) {
  const { server, cacheManager } = await createMCPServer();
  
  // Create transport - stateless mode for simpler setup
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // Stateless mode - no session management
    enableJsonResponse: false // Use SSE for notifications
  });
  
  // Connect MCP server to transport
  await server.connect(transport);
  
  // Create HTTP server
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, MCP-Session-Id');
    res.setHeader('Access-Control-Expose-Headers', 'MCP-Session-Id');
    
    // Handle OPTIONS for CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    // Handle health check
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        server: SERVER_NAME,
        version: SERVER_VERSION,
        protocol: 'MCP',
        transport: 'streamable-http',
        features: {
          sessions: true,
          notifications: true,
          resumability: false
        }
      }));
      return;
    }
    
    // Handle root endpoint
    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Reddit MCP Buddy Server (Streamable HTTP)\n');
      return;
    }
    
    // Handle MCP endpoint - delegate to transport
    if (req.url === '/mcp') {
      // Parse body for POST requests
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
        });
        req.on('end', async () => {
          try {
            const parsedBody = JSON.parse(body);
            await transport.handleRequest(req, res, parsedBody);
          } catch (error) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: -32700,
                message: 'Parse error'
              },
              id: null
            }));
          }
        });
      } else {
        // GET or DELETE requests
        await transport.handleRequest(req, res);
      }
      return;
    }
    
    // 404 for other endpoints
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found\n');
  });
  
  // Start listening
  httpServer.listen(port, () => {
    console.error(`✅ Reddit MCP Buddy Server running (Streamable HTTP)`);
    console.error(`🌐 Base URL: http://localhost:${port}`);
    console.error(`📡 MCP endpoint: http://localhost:${port}/mcp`);
    console.error(`🔌 Connect with Postman MCP client`);
    console.error('💡 Tip: Run "reddit-mcp-buddy --auth" for 10x more requests\n');
  });
  
  // Cleanup on exit
  const cleanup = () => {
    cacheManager.destroy();
    httpServer.close();
    process.exit(0);
  };
  
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}