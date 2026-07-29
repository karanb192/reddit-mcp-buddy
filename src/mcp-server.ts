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
import { z } from 'zod';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { zodToJsonSchema, JsonSchema7Type } from 'zod-to-json-schema';

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
export const SERVER_VERSION = '1.1.14';

// MCP Response validation schemas (per MCP spec)
const ContentBlockSchema = z.object({
  type: z.enum(['text', 'image']),
  text: z.string().optional(),
  data: z.string().optional(), // For base64 encoded images
  mimeType: z.string().optional(), // For images
}).refine(
  (obj) => obj.type === 'text' ? !!obj.text : (!!obj.data && !!obj.mimeType),
  'text type requires text field, image type requires data and mimeType fields'
);

const ToolResultResponseSchema = z.object({
  content: z.array(ContentBlockSchema).min(1, 'content must have at least one block'),
  isError: z.boolean().optional(),
}).strict();

// Type for validated MCP responses
type ToolResultResponse = z.infer<typeof ToolResultResponseSchema>;

/**
 * Convert Zod schema to MCP-compatible JSON Schema with proper typing
 * Ensures the output is valid for MCP tool definitions
 */
function zodSchemaToMCPInputSchema(schema: z.ZodTypeAny, schemaName: string): Tool['inputSchema'] {
  try {
    const jsonSchema = zodToJsonSchema(schema, {
      name: schemaName,
      target: 'jsonSchema7',
      $refStrategy: 'none', // Inline all refs for MCP compatibility
    }) as JsonSchema7Type & { properties?: Record<string, unknown> };

    // Validate that the schema has required properties for MCP
    if (typeof jsonSchema !== 'object' || jsonSchema === null) {
      throw new Error(`Invalid schema output for ${schemaName}`);
    }

    // MCP expects an object schema with properties
    // Extract the inner schema if zodToJsonSchema wrapped it
    if ('definitions' in jsonSchema && schemaName in (jsonSchema as any).definitions) {
      return (jsonSchema as any).definitions[schemaName] as Tool['inputSchema'];
    }

    return jsonSchema as Tool['inputSchema'];
  } catch (error) {
    console.error(`Failed to convert schema ${schemaName}:`, error);
    // Return a minimal valid schema as fallback
    return {
      type: 'object',
      properties: {},
      additionalProperties: true,
    } as Tool['inputSchema'];
  }
}

/**
 * Helper function to create a validated MCP response
 */
function createValidatedResponse(text: string, isError: boolean = false): ToolResultResponse {
  const response = {
    content: [
      {
        type: 'text' as const,
        text,
      },
    ],
    ...(isError && { isError }),
  };

  // Validate against MCP spec
  try {
    return ToolResultResponseSchema.parse(response);
  } catch (error) {
    if (error instanceof z.ZodError) {
      // If validation fails, return a safe error response
      console.error('MCP response validation failed:', error.errors);
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Internal error: Invalid response format',
          },
        ],
        isError: true,
      };
    }
    throw error;
  }
}

/**
 * Create MCP server with proper protocol implementation
 */
export interface SharedServices {
  cacheManager: CacheManager;
  tools: RedditTools;
  rateLimit: number;
  cacheTTL: number;
}

/**
 * Build the long-lived services (auth, cache, rate limiter, Reddit client).
 * These are created ONCE per process and shared by every MCP server instance,
 * so the stateless HTTP path can mint a fresh Server per request without
 * throwing away the cache or resetting the rate limiter.
 */
export async function createSharedServices(): Promise<SharedServices> {
  const authManager = new AuthManager();
  await authManager.load();

  const rateLimit = authManager.getRateLimit();
  const cacheTTL = authManager.getCacheTTL();
  // Parse boolean env var (supports various formats: true, 1, yes, on)
  const disableCache = ['true', '1', 'yes', 'on'].includes(
    (process.env.REDDIT_BUDDY_NO_CACHE || '').toLowerCase().trim()
  );

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

  return { cacheManager, tools: new RedditTools(redditAPI), rateLimit, cacheTTL };
}

export async function createMCPServer(shared?: SharedServices) {
  const services = shared ?? await createSharedServices();
  const { cacheManager, tools, rateLimit, cacheTTL } = services;

  // Create MCP server
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
      // Guidance the client shows the model. This must be `instructions` —
      // a `description` field on serverInfo is dropped by the protocol.
      instructions: `Reddit content browser and analyzer. Access posts, comments, and user data from Reddit.

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
    }
  );


  // Generate tool definitions from Zod schemas with proper type conversion
  const toolDefinitions: Tool[] = [
    {
      name: 'browse_subreddit',
      description: 'Fetch posts from a subreddit sorted by your choice (hot/new/top/rising/controversial). Returns a post list with content, metadata, and a data_source field. With Reddit credentials (data_source "api") posts include score, num_comments, and upvote_ratio; without credentials, results come from Reddit\'s public RSS feed (data_source "rss") and those fields plus nsfw are null — see the response note and do not infer popularity from them.',
      inputSchema: zodSchemaToMCPInputSchema(browseSubredditSchema, 'browse_subreddit'),
      annotations: { readOnlyHint: true }
    },
    {
      name: 'search_reddit',
      description: 'Search for posts across Reddit or specific subreddits. Returns matching posts with content and metadata.',
      inputSchema: zodSchemaToMCPInputSchema(searchRedditSchema, 'search_reddit'),
      annotations: { readOnlyHint: true }
    },
    {
      name: 'get_post_details',
      description: 'Fetch a Reddit post with its comments. Requires EITHER url OR post_id. IMPORTANT: When using post_id alone, an extra API call is made to fetch the subreddit first (2 calls total). For better efficiency, always provide the subreddit parameter when known (1 call total).',
      inputSchema: zodSchemaToMCPInputSchema(getPostDetailsSchema, 'get_post_details'),
      annotations: { readOnlyHint: true }
    },
    {
      name: 'user_analysis',
      description: 'Analyze a Reddit user\'s posting history, karma, and activity patterns. Returns posts, comments, and statistics.',
      inputSchema: zodSchemaToMCPInputSchema(userAnalysisSchema, 'user_analysis'),
      annotations: { readOnlyHint: true }
    },
    {
      name: 'reddit_explain',
      description: 'Get explanations of Reddit terms, slang, and culture. Returns definition, origin, usage, and examples.',
      inputSchema: zodSchemaToMCPInputSchema(redditExplainSchema, 'reddit_explain'),
      annotations: { readOnlyHint: true }
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
      
      return createValidatedResponse(JSON.stringify(result, null, 2), false);
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return createValidatedResponse(`Error: ${errorMessage}`, true);
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

  // Cleanup on exit with proper signal handler management
  let isExiting = false;

  const cleanup = () => {
    if (isExiting) return; // Prevent multiple cleanup calls
    isExiting = true;

    try {
      // Cleanup in proper order
      cacheManager.destroy();
      process.exit(0);
    } catch (error) {
      console.error('Error during cleanup:', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

/**
 * Start server with streamable HTTP transport for Postman MCP
 */
export async function startHttpServer(port: number = 3000) {
  // Long-lived services (cache, rate limiter, Reddit client) are created once;
  // the MCP Server and transport are created PER REQUEST below.
  const shared = await createSharedServices();
  const { cacheManager } = shared;

  // Bind loopback by default. HTTP mode has no authentication, so exposing it
  // on other interfaces must be an explicit, deliberate choice (e.g. Docker).
  const host = (process.env.REDDIT_BUDDY_HOST || '127.0.0.1').trim();

  // IPv6 literals need brackets in a Host header or URL (::1 -> [::1]).
  const hostForUrl = host.includes(':') ? `[${host}]` : host;
  const isLoopbackBind = host === '127.0.0.1' || host === 'localhost' || host === '::1';

  // Host allow-list for DNS-rebinding protection. Loopback binds get a safe
  // built-in list. When the operator deliberately binds a routable interface
  // (e.g. the Docker image sets 0.0.0.0), clients legitimately arrive with a
  // container IP, service name or published port in the Host header, and
  // pinning it protects nothing that the bind choice did not already concede -
  // so honour REDDIT_BUDDY_ALLOWED_HOSTS if given, and otherwise skip the check
  // rather than rejecting every real client.
  const configuredHosts = (process.env.REDDIT_BUDDY_ALLOWED_HOSTS || '')
    .split(',')
    .map(h => h.trim())
    .filter(Boolean);
  const allowedHosts = configuredHosts.length > 0
    ? configuredHosts
    : (isLoopbackBind
      ? [`${hostForUrl}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]
      : []);
  const dnsRebindingProtection = allowedHosts.length > 0;

  // Browsers may only reach this server from origins the operator allow-lists.
  // Non-browser clients (Postman, curl, MCP clients) send no Origin header and
  // are unaffected.
  const allowedOrigins = (process.env.REDDIT_BUDDY_ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  // Create HTTP server
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS: echo back only allow-listed origins, never a wildcard. Without
    // this, any website the user visits could drive their local MCP server.
    const origin = req.headers.origin;
    if (origin) {
      if (!allowedOrigins.includes(origin)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Origin not allowed\n');
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, MCP-Session-Id, MCP-Protocol-Version, Last-Event-ID');
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
          sessions: false,
          notifications: false,
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
        const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB limit
        const DATA_TIMEOUT_MS = 30000; // 30 second timeout for receiving data

        // Set timeout for data event to prevent hanging
        const dataTimeoutId = setTimeout(() => {
          res.writeHead(408, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Request timeout: no data received within 30 seconds'
            },
            id: null
          }));
          req.destroy();
        }, DATA_TIMEOUT_MS);

        req.on('data', chunk => {
          // Check size limit before appending
          if (body.length + chunk.length > MAX_BODY_SIZE) {
            clearTimeout(dataTimeoutId);
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: -32603,
                message: 'Payload too large (max 10MB)'
              },
              id: null
            }));
            req.destroy();
            return;
          }
          body += chunk.toString();
        });

        req.on('end', async () => {
          clearTimeout(dataTimeoutId);
          try {
            const parsedBody = JSON.parse(body);
            // Fresh Server + transport per request. Sharing one stateless
            // transport across clients causes cross-client response
            // misrouting (GHSA-345p-7cg4-v4c7), and a client closing it
            // would otherwise disable the endpoint for everyone.
            const { server } = await createMCPServer(shared);
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: undefined, // Stateless mode - no session management
              enableJsonResponse: false, // Use SSE for notifications
              enableDnsRebindingProtection: dnsRebindingProtection,
              ...(dnsRebindingProtection && { allowedHosts }),
              ...(allowedOrigins.length > 0 && { allowedOrigins }),
            });
            res.on('close', () => {
              transport.close().catch(() => {});
              server.close().catch(() => {});
            });
            await server.connect(transport);
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

        req.on('error', () => {
          clearTimeout(dataTimeoutId);
        });
      } else {
        // Stateless mode has no session to resume or terminate, so GET (SSE)
        // and DELETE are not applicable. Reject them rather than handing them
        // to a transport that would tear itself down.
        res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'POST, OPTIONS' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32601,
            message: `Method ${req.method} not supported on /mcp (stateless mode accepts POST only)`
          },
          id: null
        }));
      }
      return;
    }
    
    // 404 for other endpoints
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found\n');
  });
  
  // Cleanup on exit with proper signal handler management
  let isExiting = false;

  const cleanup = () => {
    if (isExiting) return; // Prevent multiple cleanup calls
    isExiting = true;

    try {
      // Close HTTP server first (proper cleanup order)
      httpServer.close(() => {
        // Then destroy cache
        cacheManager.destroy();
        process.exit(0);
      });

      // Timeout: if close doesn't complete in 10 seconds, force exit
      const forceExitTimeout = setTimeout(() => {
        console.error('⚠️ Server close timeout, forcing exit');
        cacheManager.destroy();
        process.exit(1);
      }, 10000);

      // Clear timeout if close completes
      httpServer.on('close', () => clearTimeout(forceExitTimeout));
    } catch (error) {
      console.error('Error during cleanup:', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Handle server errors
  httpServer.on('error', (error: any) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`❌ Port ${port} is already in use`);
      console.error(`Try a different port: REDDIT_BUDDY_PORT=${port + 1} npm start`);
      console.error(`Or kill the process using port ${port}: lsof -ti:${port} | xargs kill -9`);
    } else if (error.code === 'EACCES') {
      console.error(`❌ Permission denied. Port ${port} requires elevated privileges`);
      console.error(`Try a higher port number (>1024): REDDIT_BUDDY_PORT=3001 npm start`);
    } else {
      console.error(`❌ Server error: ${error.message}`);
    }
    process.exit(1);
  });

  // Start listening
  httpServer.listen(port, host, () => {
    console.error(`✅ Reddit MCP Buddy Server running (Streamable HTTP)`);
    console.error(`🌐 Base URL: http://${hostForUrl}:${port}`);
    console.error(`📡 MCP endpoint: http://${hostForUrl}:${port}/mcp`);
    console.error(`🔌 Connect with Postman MCP client`);
    if (!isLoopbackBind) {
      console.error(`⚠️  Bound to ${host} - this server has NO authentication. Only do this on a trusted network.`);
      if (!dnsRebindingProtection) {
        console.error(`   Set REDDIT_BUDDY_ALLOWED_HOSTS (comma-separated host:port) to restrict which Host headers are accepted.`);
      }
    }
    console.error('💡 Tip: Run "reddit-mcp-buddy --auth" for 10x more requests\n');
  });
}