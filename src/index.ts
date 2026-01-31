/**
 * Reddit MCP Buddy Server
 * Main entry point
 */

import { startStdioServer, startHttpServer } from './mcp-server.js';
import { setupProxyFromEnv } from './core/proxy.js';

// Determine transport mode from environment
const isHttpMode = process.env.REDDIT_BUDDY_HTTP === 'true';
const port = parseInt(process.env.REDDIT_BUDDY_PORT || '3000', 10);

// Handle unhandled errors
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

// Start the appropriate server
async function main() {
  try {
    setupProxyFromEnv();
    if (isHttpMode) {
      await startHttpServer(port);
    } else {
      await startStdioServer();
    }
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();