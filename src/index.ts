/**
 * Reddit MCP Buddy Server
 * Main entry point
 */

import { startStdioServer, startHttpServer } from './mcp-server.js';

// Parse boolean environment variables (handles various truthy formats)
function parseEnvBoolean(envValue: string | undefined, defaultValue: boolean = false): boolean {
  if (!envValue) return defaultValue;
  return ['true', '1', 'yes', 'on'].includes(envValue.toLowerCase().trim());
}

// Determine transport mode from environment
const isHttpMode = parseEnvBoolean(process.env.REDDIT_BUDDY_HTTP);

// Parse and validate port number
function parsePort(portEnv: string | undefined): number {
  const defaultPort = 3000;
  if (!portEnv) return defaultPort;

  const parsed = parseInt(portEnv, 10);

  // Validate port number
  if (isNaN(parsed)) {
    console.error(`Invalid port number: "${portEnv}" is not a valid number. Using default port ${defaultPort}`);
    return defaultPort;
  }

  if (parsed < 1 || parsed > 65535) {
    console.error(`Invalid port number: ${parsed}. Port must be between 1 and 65535. Using default port ${defaultPort}`);
    return defaultPort;
  }

  return parsed;
}

const port = parsePort(process.env.REDDIT_BUDDY_PORT);

// Handle unhandled errors
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
  // In HTTP mode, don't crash the server for a single request failure.
  // In stdio mode, exit since the connection is 1:1 with the client.
  if (!isHttpMode) {
    process.exit(1);
  }
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