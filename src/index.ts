/**
 * Reddit MCP Buddy Server
 * Main entry point
 */

import { setupProxy } from './core/proxy.js';
import { startStdioServer, startHttpServer } from './mcp-server.js';

setupProxy();

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