#!/usr/bin/env node

/**
 * Rate Limit Testing Script for Reddit MCP Buddy
 *
 * This script tests the three-tier rate limiting system:
 * - Anonymous: 10 requests/minute
 * - App-only: 60 requests/minute
 * - Authenticated: 100 requests/minute
 *
 * Usage:
 *   node scripts/test-rate-limit.js [mode] [requests]
 *
 * Examples:
 *   node scripts/test-rate-limit.js              # Test current auth mode
 *   node scripts/test-rate-limit.js anonymous 15 # Test anonymous mode with 15 requests
 *   node scripts/test-rate-limit.js app-only 70  # Test app-only mode with 70 requests
 *   node scripts/test-rate-limit.js auth 120     # Test authenticated mode with 120 requests
 */

const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// Try to load .env file from scripts directory
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      const value = valueParts.join('=').trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  });
  console.log('📁 Loaded credentials from scripts/.env file\n');
}

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

// Parse command line arguments
const args = process.argv.slice(2);
const mode = args[0] || 'current';
const requestCount = parseInt(args[1]) || 15;

// Test configuration
const testConfig = {
  anonymous: {
    env: {},
    expectedLimit: 10,
    description: 'Anonymous mode (no auth)',
  },
  'app-only': {
    env: {
      REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID || 'test_client_id',
      REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET || 'test_secret',
    },
    expectedLimit: 60,
    description: 'App-only mode (client credentials)',
  },
  auth: {
    env: {
      REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID || 'test_client_id',
      REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET || 'test_secret',
      REDDIT_USERNAME: process.env.REDDIT_USERNAME || 'test_user',
      REDDIT_PASSWORD: process.env.REDDIT_PASSWORD || 'test_pass',
    },
    expectedLimit: 100,
    description: 'Authenticated mode (full credentials)',
  },
  current: {
    env: process.env,
    expectedLimit: 0, // Will be determined at runtime
    description: 'Current environment settings',
  },
};

// Determine expected limit for current mode
if (mode === 'current') {
  if (process.env.REDDIT_USERNAME && process.env.REDDIT_PASSWORD &&
      process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET) {
    testConfig.current.expectedLimit = 100;
  } else if (process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET) {
    testConfig.current.expectedLimit = 60;
  } else {
    testConfig.current.expectedLimit = 10;
  }
}

const config = testConfig[mode];
if (!config) {
  console.error(`${colors.red}Invalid mode: ${mode}${colors.reset}`);
  console.error('Valid modes: anonymous, app-only, auth, current');
  process.exit(1);
}

// Helper function to format time
function formatTime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0
    ? `${minutes}m ${remainingSeconds}s`
    : `${remainingSeconds}s`;
}

// Helper function to create progress bar
function createProgressBar(current, total, width = 30) {
  const percentage = current / total;
  const filled = Math.floor(percentage * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `[${bar}] ${current}/${total}`;
}

// Start the MCP server
console.log(`${colors.bright}${colors.cyan}Reddit MCP Buddy - Rate Limit Tester${colors.reset}`);
console.log(`${colors.dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);

console.log(`${colors.yellow}Mode:${colors.reset} ${config.description}`);
console.log(`${colors.yellow}Expected limit:${colors.reset} ${config.expectedLimit || 'Auto-detect'} requests/minute`);
console.log(`${colors.yellow}Test requests:${colors.reset} ${requestCount} requests\n`);

// Set up environment
const serverEnv = {
  ...process.env,
  ...config.env,
  REDDIT_BUDDY_HTTP: 'true',
  REDDIT_BUDDY_PORT: '3010',
  REDDIT_BUDDY_NO_CACHE: 'true', // Disable cache for accurate rate limit testing
};

// Start the server
console.log(`${colors.blue}Starting MCP server...${colors.reset}`);
const server = spawn('npm', ['start'], {
  env: serverEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverReady = false;
let serverOutput = '';

// Monitor server output
server.stdout.on('data', (data) => {
  const text = data.toString();
  serverOutput += text;
  if (!serverReady && text.includes('Reddit MCP Buddy Server running')) {
    serverReady = true;
  }
});

server.stderr.on('data', (data) => {
  const text = data.toString();
  serverOutput += text;
  if (!serverReady && text.includes('Reddit MCP Buddy Server running')) {
    serverReady = true;
    startTest();
  }
});

// Test statistics
const stats = {
  successful: 0,
  rateLimited: 0,
  errors: 0,
  startTime: Date.now(),
  endTime: null,
  requestTimes: [],
};

// Make a test request
async function makeRequest(index) {
  const startTime = Date.now();

  try {
    const response = await fetch('http://localhost:3010/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: index,
        method: 'tools/call',
        params: {
          name: 'browse_subreddit',
          arguments: {
            subreddit: 'test',
            limit: 1,
          },
        },
      }),
    });

    const responseTime = Date.now() - startTime;
    stats.requestTimes.push(responseTime);

    const text = await response.text();
    let result;

    // Check if response is SSE format
    if (text.startsWith('event:')) {
      // Parse SSE format
      const lines = text.split('\n');
      const dataLine = lines.find(line => line.startsWith('data:'));
      if (dataLine) {
        try {
          result = JSON.parse(dataLine.substring(5).trim());
        } catch (e) {
          if (index === 1) {
            console.log(`\n[31mFirst response (SSE parse error): ${text.substring(0, 200)}...[0m\n`);
          }
          stats.errors++;
          return { status: 'error', message: 'Failed to parse SSE response', time: responseTime };
        }
      } else {
        stats.errors++;
        return { status: 'error', message: 'No data in SSE response', time: responseTime };
      }
    } else {
      // Try to parse as JSON
      try {
        result = JSON.parse(text);
      } catch (e) {
        if (index === 1) {
          console.log(`\n[31mFirst response (not JSON): ${text.substring(0, 200)}...[0m\n`);
        }
        stats.errors++;
        return { status: 'error', message: 'Invalid response format', time: responseTime };
      }
    }

    // Check for errors in different formats
    if (result.error) {
      if (result.error.message?.includes('Rate limit')) {
        stats.rateLimited++;
        return { status: 'rate_limited', time: responseTime };
      } else {
        stats.errors++;
        if (index === 1) {
          console.log(`\n[31mFirst error: ${result.error.message}[0m\n`);
        }
        return { status: 'error', message: result.error.message, time: responseTime };
      }
    }

    // Check if result has content with error text
    if (result.result?.content?.[0]?.text) {
      const text = result.result.content[0].text;
      if (text.includes('Rate limit')) {
        stats.rateLimited++;
        return { status: 'rate_limited', time: responseTime };
      } else if (text.includes('Error:') || text.includes('Failed')) {
        stats.errors++;
        if (index === 1) {
          console.log(`\n[31mFirst error: ${text.substring(0, 100)}...[0m\n`);
        }
        return { status: 'error', message: text, time: responseTime };
      }
    }

    stats.successful++;
    return { status: 'success', time: responseTime };
  } catch (error) {
    stats.errors++;
    return { status: 'error', message: error.message, time: 0 };
  }
}

// Run the test
async function startTest() {
  console.log(`${colors.green}✓ Server ready${colors.reset}\n`);
  console.log(`${colors.bright}Starting rate limit test...${colors.reset}\n`);

  const results = [];
  const startTime = Date.now();

  // Create readline interface for real-time updates
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  for (let i = 1; i <= requestCount; i++) {
    // Update progress
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);

    const progress = createProgressBar(i - 1, requestCount);
    const elapsed = formatTime(Date.now() - startTime);
    process.stdout.write(`${progress} | Elapsed: ${elapsed} | ✓ ${stats.successful} | ⚠ ${stats.rateLimited} | ✗ ${stats.errors}`);

    // Make request
    const result = await makeRequest(i);
    results.push({ request: i, ...result });

    // Small delay between requests to simulate real usage
    if (i < requestCount) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  stats.endTime = Date.now();

  // Clear the progress line
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  rl.close();

  // Display results
  console.log(`\n${colors.bright}Test Results${colors.reset}`);
  console.log(`${colors.dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);

  const duration = (stats.endTime - stats.startTime) / 1000;
  const avgResponseTime = stats.requestTimes.length > 0
    ? Math.round(stats.requestTimes.reduce((a, b) => a + b, 0) / stats.requestTimes.length)
    : 0;

  console.log(`${colors.green}✓ Successful:${colors.reset} ${stats.successful} requests`);
  console.log(`${colors.yellow}⚠ Rate limited:${colors.reset} ${stats.rateLimited} requests`);
  console.log(`${colors.red}✗ Errors:${colors.reset} ${stats.errors} requests`);
  console.log(`${colors.blue}⏱ Total time:${colors.reset} ${duration.toFixed(2)}s`);
  console.log(`${colors.blue}⚡ Avg response:${colors.reset} ${avgResponseTime}ms\n`);

  // Analyze rate limit behavior
  const expectedLimit = config.expectedLimit || testConfig.current.expectedLimit;
  const observedLimit = stats.successful;

  if (duration < 60) {
    // Test completed in under a minute
    console.log(`${colors.bright}Rate Limit Analysis:${colors.reset}`);
    console.log(`Expected: ${expectedLimit} req/min`);
    console.log(`Observed: ${observedLimit} successful requests in ${duration.toFixed(1)}s`);

    if (stats.rateLimited > 0) {
      const firstRateLimitIndex = results.findIndex(r => r.status === 'rate_limited');
      console.log(`First rate limit hit at request #${firstRateLimitIndex + 1}`);

      if (Math.abs(firstRateLimitIndex - expectedLimit) <= 2) {
        console.log(`${colors.green}✓ Rate limiting working correctly${colors.reset}`);
      } else {
        console.log(`${colors.yellow}⚠ Rate limit differs from expected${colors.reset}`);
      }
    } else if (requestCount <= expectedLimit) {
      console.log(`${colors.green}✓ All requests succeeded (within limit)${colors.reset}`);
    } else {
      console.log(`${colors.yellow}⚠ Expected rate limiting but none occurred${colors.reset}`);
    }
  } else {
    // Test took over a minute (rate limit window reset)
    console.log(`${colors.bright}Note:${colors.reset} Test duration exceeded 1 minute`);
    console.log('Rate limit window may have reset during test');
  }

  // Show sample of rate-limited responses
  if (stats.rateLimited > 0) {
    console.log(`\n${colors.dim}Sample rate limit messages:${colors.reset}`);
    const rateLimitedResults = results.filter(r => r.status === 'rate_limited').slice(0, 3);
    rateLimitedResults.forEach(r => {
      console.log(`  Request #${r.request}: Rate limited (${r.time}ms)`);
    });
  }

  // Clean up
  console.log(`\n${colors.blue}Shutting down server...${colors.reset}`);
  server.kill();
  process.exit(0);
}

// Handle errors
server.on('error', (error) => {
  console.error(`${colors.red}Server error: ${error.message}${colors.reset}`);
  process.exit(1);
});

// Handle Ctrl+C
process.on('SIGINT', () => {
  console.log(`\n${colors.yellow}Test interrupted${colors.reset}`);
  server.kill();
  process.exit(0);
});

// Timeout if server doesn't start
setTimeout(() => {
  if (!serverReady) {
    console.error(`${colors.red}Server failed to start${colors.reset}`);
    console.error('Server output:', serverOutput);
    server.kill();
    process.exit(1);
  }
}, 10000);