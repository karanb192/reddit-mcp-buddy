#!/usr/bin/env node

/**
 * Reddit MCP Buddy CLI
 * Handle authentication setup and server startup
 */

import { AuthManager } from './core/auth.js';
import { SERVER_VERSION } from './mcp-server.js';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import readline from 'readline/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function setupAuth() {
  console.log('\n🚀 Reddit MCP Buddy Authentication Setup\n');
  console.log('This will help you set up authentication for 10x more requests.\n');

  console.log('Step 1: Create a Reddit App');
  console.log('  1. Open: https://www.reddit.com/prefs/apps');
  console.log('  2. Click "Create App" or "Create Another App"');
  console.log('  3. Fill in:');
  console.log('     • Name: Reddit MCP Buddy (or anything)');
  console.log('     • Type: Select "script" (IMPORTANT!)');
  console.log('     • Description: Personal use');
  console.log('     • Redirect URI: http://localhost:8080');
  console.log('  4. Click "Create app"\n');

  console.log('Step 2: Find your credentials');
  console.log('  • Client ID: Look under "personal use script" (e.g., XaBcDeFgHiJkLm)');
  console.log('  • Client Secret: The secret string shown on the app page\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // Collect all credentials
    const clientId = await rl.question('Enter your Client ID: ');

    // Validate Client ID format
    if (!/^[A-Za-z0-9_-]{10,30}$/.test(clientId)) {
      console.error('\n❌ Invalid Client ID format. Should be 10-30 characters, alphanumeric.');
      process.exit(1);
    }

    const clientSecret = await rl.question('Enter your Client Secret: ');

    // Validate Client Secret
    if (!clientSecret || clientSecret.length < 20) {
      console.error('\n❌ Invalid Client Secret. Please check your Reddit app settings.');
      process.exit(1);
    }

    console.log('\nFor full authentication (100 requests/minute), enter your Reddit account details.');
    console.log('Leave blank for app-only auth (still better than anonymous).\n');

    const username = await rl.question('Reddit Username (optional): ');
    let password = '';

    if (username) {
      // Hide password input
      const passwordQuestion = 'Reddit Password: ';
      process.stdout.write(passwordQuestion);

      // Disable echo for password
      process.stdin.setRawMode(true);
      process.stdin.resume();

      password = await new Promise<string>((resolve) => {
        let pwd = '';
        process.stdin.on('data', (char) => {
          const charStr = char.toString('utf8');
          switch (charStr) {
            case '\n':
            case '\r':
            case '\u0004':
              process.stdin.setRawMode(false);
              process.stdin.pause();
              process.stdout.write('\n');
              resolve(pwd);
              break;
            case '\u0003':
              process.exit();
              break;
            case '\u007f':
              if (pwd.length > 0) {
                pwd = pwd.slice(0, -1);
                process.stdout.write('\b \b');
              }
              break;
            default:
              pwd += charStr;
              process.stdout.write('*');
              break;
          }
        });
      });
    }

    // Test the credentials
    console.log('\n🔄 Testing authentication...');

    const authManager = new AuthManager();
    const config = {
      clientId,
      clientSecret,
      username: username || undefined,
      password: password || undefined,
      userAgent: 'RedditBuddy/1.0 (by /u/karanb192)'
    };

    // Set password temporarily for token retrieval
    authManager['config'] = config;

    try {
      // Get access token to verify credentials
      await authManager.refreshAccessToken();

      console.log('✅ Success! Authentication configured.');

      if (username && password) {
        console.log('📊 Authenticated mode: 100 requests per minute');
      } else {
        console.log('📊 App-only mode: Better than anonymous, but limited');
        console.log('💡 Tip: Provide username/password for full 100 req/min rate limit');
      }

      console.log('\nTo start using Reddit MCP Buddy, run:');
      console.log('  reddit-mcp-buddy\n');
    } catch (error: any) {
      console.error('\n❌ Failed to authenticate. Please check:');
      console.error('  • Client ID and Secret are correct');
      console.error('  • App type is "script"');

      if (username) {
        console.error('  • Username and password are correct');
      }

      console.error('\nError:', error.message);

      // Clear invalid config
      await authManager.clear();
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

async function startServer() {
  // Check if running in development
  const isDev = process.env.NODE_ENV === 'development';
  
  if (isDev) {
    // Development mode - run TypeScript directly
    const serverPath = join(__dirname, 'index.ts');
    const child = spawn('tsx', [serverPath], {
      stdio: 'inherit',
      env: { ...process.env },
    });
    
    child.on('error', (error) => {
      console.error('Failed to start server:', error);
      process.exit(1);
    });
    
    child.on('exit', (code) => {
      process.exit(code || 0);
    });
  } else {
    // Production mode - run compiled JavaScript
    const serverPath = join(__dirname, 'index.js');
    
    // Dynamic import to run the server
    try {
      await import(serverPath);
    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.includes('--auth') || args.includes('-a')) {
  // Run authentication setup
  setupAuth().catch((error) => {
    console.error('Setup failed:', error);
    process.exit(1);
  });
} else if (args.includes('--help') || args.includes('-h')) {
  console.log('Reddit MCP Buddy - Your AI assistant\'s best friend for browsing Reddit\n');
  console.log('Usage:');
  console.log('  reddit-mcp-buddy           Start the MCP server');
  console.log('  reddit-mcp-buddy --auth    Set up Reddit authentication (optional)');
  console.log('  reddit-mcp-buddy --help    Show this help message\n');
  console.log('Features:');
  console.log('  • Browse subreddits with smart summaries');
  console.log('  • Search Reddit with advanced filters');
  console.log('  • Analyze trends and sentiment');
  console.log('  • Compare opinions across subreddits');
  console.log('  • And much more!\n');
  console.log('Learn more: https://github.com/karanb192/reddit-mcp-buddy');
} else if (args.includes('--version') || args.includes('-v')) {
  console.log(`Reddit MCP Buddy v${SERVER_VERSION}`);
} else {
  // Start the server
  startServer().catch((error) => {
    console.error('Failed to start:', error);
    process.exit(1);
  });
}