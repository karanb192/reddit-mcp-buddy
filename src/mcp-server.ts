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
export const SERVER_VERSION = '1.1.12';

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
export async function createMCPServer() {
  // Initialize core components
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
  
  // Generate tool definitions from Zod schemas with proper type conversion
  const toolDefinitions: Tool[] = [
    {
      name: 'browse_subreddit',
      description: 'Fetch posts from a subreddit sorted by your choice (hot/new/top/rising). Returns post list with content, scores, and metadata.',
      inputSchema: zodSchemaToMCPInputSchema(browseSubredditSchema, 'browse_subreddit'),
      readOnlyHint: true
    },
    {
      name: 'search_reddit',
      description: 'Search for posts across Reddit or specific subreddits. Returns matching posts with content and metadata.',
      inputSchema: zodSchemaToMCPInputSchema(searchRedditSchema, 'search_reddit'),
      readOnlyHint: true
    },
    {
      name: 'get_post_details',
      description: 'Fetch a Reddit post with its comments. Requires EITHER url OR post_id. IMPORTANT: When using post_id alone, an extra API call is made to fetch the subreddit first (2 calls total). For better efficiency, always provide the subreddit parameter when known (1 call total).',
      inputSchema: zodSchemaToMCPInputSchema(getPostDetailsSchema, 'get_post_details'),
      readOnlyHint: true
    },
    {
      name: 'user_analysis',
      description: 'Analyze a Reddit user\'s posting history, karma, and activity patterns. Returns posts, comments, and statistics.',
      inputSchema: zodSchemaToMCPInputSchema(userAnalysisSchema, 'user_analysis'),
      readOnlyHint: true
    },
    {
      name: 'reddit_explain',
      description: 'Get explanations of Reddit terms, slang, and culture. Returns definition, origin, usage, and examples.',
      inputSchema: zodSchemaToMCPInputSchema(redditExplainSchema, 'reddit_explain'),
      readOnlyHint: true
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
  httpServer.listen(port, () => {
    console.error(`✅ Reddit MCP Buddy Server running (Streamable HTTP)`);
    console.error(`🌐 Base URL: http://localhost:${port}`);
    console.error(`📡 MCP endpoint: http://localhost:${port}/mcp`);
    console.error(`🔌 Connect with Postman MCP client`);
    console.error('💡 Tip: Run "reddit-mcp-buddy --auth" for 10x more requests\n');
  });
}