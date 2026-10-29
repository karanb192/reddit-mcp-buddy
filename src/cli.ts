#!/usr/bin/env node

/**
 * Reddit MCP Buddy CLI
 * Handle authentication setup and server startup
 */

import { AuthManager } from './core/auth.js';
import { SERVER_VERSION } from './mcp-server.js';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import readline from 'readline/promises';
import { parseOAuthArgs, parseLoopbackRedirect, runOAuthConsent, scopesFor, writeTokenFile } from './core/oauth-consent.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function setupAuth() {
  console.log('\n🚀 Reddit MCP Buddy Authentication Setup\n');
  console.log('Use credentials for a Reddit app and use case that Reddit has approved.\n');

  console.log('Step 1: Obtain Reddit API approval');
  console.log('  Policy: https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy');
  console.log('  Start with Devvit: https://developers.reddit.com/');
  console.log('  If Devvit does not support your use case, request access:');
  console.log('  https://support.reddithelp.com/hc/en-us/requests/new?tf_42139884615700=api_request_type_developer_clone&ticket_form_id=14868593862164');
  console.log('  Creating an app does not guarantee API access. This server cannot grant approval.');
  console.log('  Once approved, open your app at https://www.reddit.com/prefs/apps');
  console.log('  If Reddit directs you to create an app, use:');
  console.log('     • Name: Reddit MCP Buddy (or anything)');
  console.log('     • Type: Select "script" for username/password authentication');
  console.log('     • Description: Personal use');
  console.log('     • Redirect URI: http://localhost:8080');
  console.log('  If app creation is unavailable, follow up through Reddit\'s access request process.\n');

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

    console.log('\nFor password-grant authentication with an approved script app, enter your Reddit account details.');
    console.log('The 60/100 requests-per-minute caps are local limits, not guaranteed Reddit quotas.');
    console.log('Leave blank for app-only auth (still better than anonymous).\n');

    const username = await rl.question('Reddit Username (optional): ');
    let password = '';

    if (username) {
      // Hide password input with proper error handling and cleanup
      const passwordQuestion = 'Reddit Password: ';
      process.stdout.write(passwordQuestion);

      password = await new Promise<string>((resolve, reject) => {
        const PASSWORD_TIMEOUT_MS = 60000; // 60 second timeout to prevent hanging
        const MAX_PASSWORD_LENGTH = 256; // Reasonable password length limit
        let pwd = '';
        let isResolved = false;
        let timeoutId: NodeJS.Timeout | null = null;

        // Set timeout to prevent hanging if user doesn't respond
        timeoutId = setTimeout(() => {
          if (!isResolved) {
            isResolved = true;
            try {
              process.stdin.setRawMode(false);
            } catch {
              // Raw mode might already be disabled
            }
            process.stdin.pause();
            process.stdin.removeAllListeners('data');
            process.stdout.write('\n');
            reject(new Error('Password input timeout'));
          }
        }, PASSWORD_TIMEOUT_MS);

        const dataHandler = (char: Buffer) => {
          if (isResolved) return;

          const charStr = char.toString('utf8');
          switch (charStr) {
            case '\n':
            case '\r':
            case '\u0004': // EOF
              if (timeoutId) clearTimeout(timeoutId);
              isResolved = true;
              try {
                process.stdin.setRawMode(false);
              } catch {
                // Raw mode might already be disabled
              }
              process.stdin.pause();
              process.stdin.removeAllListeners('data');
              process.stdout.write('\n');
              // Clear pwd reference and resolve
              const result = pwd;
              pwd = ''; // Try to clear from memory
              resolve(result);
              break;
            case '\u0003': // Ctrl+C
              if (timeoutId) clearTimeout(timeoutId);
              try {
                process.stdin.setRawMode(false);
              } catch {
                // Raw mode might already be disabled
              }
              process.stdin.pause();
              process.stdin.removeAllListeners('data');
              pwd = ''; // Clear password
              process.exit();
              break;
            case '\u007f': // Backspace
              if (pwd.length > 0) {
                pwd = pwd.slice(0, -1);
                process.stdout.write('\b \b');
              }
              break;
            default:
              // Prevent excessively long passwords
              if (pwd.length < MAX_PASSWORD_LENGTH) {
                pwd += charStr;
                process.stdout.write('*');
              }
              break;
          }
        };

        try {
          process.stdin.setRawMode(true);
          process.stdin.resume();
          process.stdin.on('data', dataHandler);
        } catch (error) {
          if (timeoutId) clearTimeout(timeoutId);
          pwd = ''; // Clear password
          reject(error);
        }
      }).catch((error) => {
        console.error('\n❌ Password input error:', error.message);
        process.exit(1);
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
        console.log('📊 Authenticated mode: local cap of 100 requests per minute');
      } else {
        console.log('📊 App-only mode: local cap of 60 requests per minute');
        console.log('Username/password authentication uses a local cap of 100 req/min; Reddit applies its own limits.');
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

      // Clear invalid config and password from memory
      await authManager.clear();
      password = ''; // Clear password from memory
      process.exit(1);
    } finally {
      // Always clear password from memory after use
      password = '';
    }
  } finally {
    rl.close();
  }
}

async function setupOAuth(argv: string[]) {
  const options = parseOAuthArgs(argv);
  parseLoopbackRedirect(options.redirectUri);
  const scopes = scopesFor(options.write);

  console.log('\n🔐 Reddit MCP Buddy OAuth Setup\n');
  console.log('This authorizes an approved Reddit web app to act for your account and prints a refresh token.');
  console.log('It needs a "web app" whose redirect URI is exactly: ' + options.redirectUri);
  console.log('Consent does not grant Reddit API approval or extend your approved use case.\n');

  let clientId = process.env.REDDIT_CLIENT_ID?.trim();
  let clientSecret = process.env.REDDIT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      clientId = clientId || (await rl.question('Enter your web app Client ID: ')).trim();
      clientSecret = clientSecret || (await rl.question('Enter your web app Client Secret: ')).trim();
    } finally {
      rl.close();
    }
  }
  if (!clientId || !clientSecret) {
    throw new Error('A client ID and client secret are required.');
  }

  const result = await runOAuthConsent({
    clientId,
    clientSecret,
    scopes,
    redirectUri: options.redirectUri,
    onAuthorizeUrl: url => {
      console.log(`Requesting scopes: ${scopes.join(' ')}`);
      console.log('Open this link in a browser where you are signed in to Reddit, then click Allow:\n');
      console.log(url + '\n');
      console.log('Waiting up to 5 minutes for Reddit to redirect back...');
    },
  });

  console.log(`\n✅ Authorized as u/${result.username} with scopes: ${result.scopes.join(' ')}`);
  if (options.out) {
    await writeTokenFile(options.out, result.refreshToken);
    console.log(`Refresh token saved to ${options.out} (readable only by you).`);
  } else {
    console.log('Add this to the server environment. Treat it like a password:\n');
    console.log(`REDDIT_REFRESH_TOKEN=${result.refreshToken}\n`);
  }
  console.log('Keep REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET set, and leave REDDIT_PASSWORD unset.');
  if (options.write) {
    console.log('Posting also needs REDDIT_BUDDY_WRITE=true and stdio transport.');
  }
  console.log('Revoke access any time under "authorized apps" at https://www.reddit.com/prefs/apps');
}

async function startServer() {
  // Check if running in development
  const isDev = process.env.NODE_ENV === 'development';

  if (isDev) {
    // Development mode - run TypeScript directly
    const serverPath = join(__dirname, 'index.ts');

    // Improved child process error handling
    let child: any;
    try {
      child = spawn('tsx', [serverPath], {
        stdio: 'inherit',
        env: { ...process.env },
      });

      // Verify child process was created successfully
      if (!child || !child.pid) {
        throw new Error('Failed to create child process');
      }
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('❌ Failed to spawn development server:', errorMsg);

      // Check if tsx is not installed
      if (errorMsg.includes('ENOENT') || errorMsg.includes('not found')) {
        console.error('\nNote: Development mode requires tsx to be installed.');
        console.error('Run: npm install');
      }
      process.exit(1);
    }

    // Handle errors after spawn
    child.on('error', (error: any) => {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('❌ Child process error:', errorMsg);
      process.exit(1);
    });

    // Handle unexpected exit
    child.on('exit', (code: number | null, signal: string | null) => {
      if (code && code !== 0) {
        console.error(`❌ Server exited with code ${code}`);
      } else if (signal) {
        console.error(`❌ Server terminated by signal ${signal}`);
      }
      process.exit(code || 0);
    });
  } else {
    // Production mode - run compiled JavaScript with improved error handling
    const serverPath = join(__dirname, 'index.js');
    const serverUrl = pathToFileURL(serverPath).href;

    // Improved dynamic import error handling
    try {
      // Check if the file exists first
      const { promises: fs } = await import('fs');
      try {
        await fs.access(serverPath);
      } catch {
        throw new Error(`Server file not found: ${serverPath}. Run: npm run build`);
      }

      // Attempt dynamic import
      await import(serverUrl);
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (errorMsg.includes('not found') || errorMsg.includes('ENOENT')) {
        console.error('❌ Server file not found. Run: npm run build');
      } else if (errorMsg.includes('Cannot find module')) {
        console.error('❌ Module import error:', errorMsg);
        console.error('Try running: npm install');
      } else if (errorMsg.includes('Unexpected token')) {
        console.error('❌ Syntax error in server code:', errorMsg);
        console.error('Try running: npm run typecheck');
      } else {
        console.error('❌ Failed to start server:', errorMsg);
      }

      process.exit(1);
    }
  }
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.includes('--oauth')) {
  setupOAuth(args).catch((error) => {
    console.error('\n❌ OAuth setup failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
} else if (args.includes('--auth') || args.includes('-a')) {
  // Run authentication setup
  setupAuth().catch((error) => {
    console.error('Setup failed:', error);
    process.exit(1);
  });
} else if (args.includes('--help') || args.includes('-h')) {
  console.log('Reddit MCP Buddy - Your AI assistant\'s best friend for browsing Reddit\n');
  console.log('Usage:');
  console.log('  reddit-mcp-buddy           Start the MCP server (stdio mode)');
  console.log('  reddit-mcp-buddy --http    Start the MCP server (HTTP mode)');
  console.log('  reddit-mcp-buddy --auth    Set up Reddit authentication (optional)');
  console.log('  reddit-mcp-buddy --oauth   Get a refresh token for an approved web app (--write adds posting scopes)');
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
  // Support --http flag as shorthand for REDDIT_BUDDY_HTTP=true
  if (args.includes('--http')) {
    process.env.REDDIT_BUDDY_HTTP = 'true';
  }
  // Start the server
  startServer().catch((error) => {
    console.error('Failed to start:', error);
    process.exit(1);
  });
}
