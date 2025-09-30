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
import { zodToJsonSchema } from 'zod-to-json-schema';

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
export const SERVER_VERSION = '1.1.10';

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
  
  // Generate tool definitions from Zod schemas
  const toolDefinitions: Tool[] = [
    {
      name: 'browse_subreddit',
      description: 'Fetch posts from a subreddit sorted by your choice (hot/new/top/rising). Returns post list with content, scores, and metadata.',
      inputSchema: zodToJsonSchema(browseSubredditSchema) as any
    },
    {
      name: 'search_reddit',
      description: 'Search for posts across Reddit or specific subreddits. Returns matching posts with content and metadata.',
      inputSchema: zodToJsonSchema(searchRedditSchema) as any
    },
    {
      name: 'get_post_details',
      description: 'Fetch a Reddit post with its comments. Requires EITHER url OR post_id. IMPORTANT: When using post_id alone, an extra API call is made to fetch the subreddit first (2 calls total). For better efficiency, always provide the subreddit parameter when known (1 call total).',
      inputSchema: zodToJsonSchema(getPostDetailsSchema) as any
    },
    {
      name: 'user_analysis',
      description: 'Analyze a Reddit user\'s posting history, karma, and activity patterns. Returns posts, comments, and statistics.',
      inputSchema: zodToJsonSchema(userAnalysisSchema) as any
    },
    {
      name: 'reddit_explain',
      description: 'Get explanations of Reddit terms, slang, and culture. Returns definition, origin, usage, and examples.',
      inputSchema: zodToJsonSchema(redditExplainSchema) as any
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