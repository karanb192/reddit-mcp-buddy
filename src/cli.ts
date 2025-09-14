#!/usr/bin/env node

/**
 * Reddit Buddy CLI
 * Handle authentication setup and server startup
 */

import { AuthManager } from './core/auth.js';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import readline from 'readline/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function setupAuth() {
  console.log('\n🚀 Reddit Buddy Authentication Setup\n');
  console.log('This will help you set up authentication for 10x more requests.\n');
  
  console.log('Step 1: Create a Reddit App');
  console.log('  1. Open: https://www.reddit.com/prefs/apps');
  console.log('  2. Click "Create App" or "Create Another App"');
  console.log('  3. Fill in:');
  console.log('     • Name: Reddit Buddy (or anything)');
  console.log('     • Type: Select "script" (IMPORTANT!)');
  console.log('     • Description: Personal use');
  console.log('     • Redirect URI: http://localhost:8080');
  console.log('  4. Click "Create app"\n');
  
  console.log('Step 2: Find your Client ID');
  console.log('  • Look under "personal use script"');
  console.log('  • It looks like: XaBcDeFgHiJkLm\n');
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  try {
    const clientId = await rl.question('Enter your Client ID: ');
    
    // Validate format
    if (!/^[A-Za-z0-9_-]{10,30}$/.test(clientId)) {
      console.error('\n❌ Invalid Client ID format. Should be 10-30 characters, alphanumeric.');
      process.exit(1);
    }
    
    // Test the client ID
    console.log('\n🔄 Testing connection...');
    
    const authManager = new AuthManager();
    await authManager.save({
      clientId,
      deviceId: 'DO_NOT_TRACK',
    });
    
    // Try to get access token
    try {
      await authManager.load();
      await authManager.getAccessToken();
      console.log('✅ Success! Authentication configured.');
      console.log('📊 You now have access to 100 requests per minute.\n');
      console.log('To start using Reddit Buddy, run:');
      console.log('  reddit-buddy\n');
    } catch (error: any) {
      console.error('\n❌ Failed to authenticate. Please check:');
      console.error('  • Client ID is correct');
      console.error('  • App type is "script"');
      console.error('  • Reddit is accessible\n');
      console.error('Error:', error.message);
      
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
  console.log('Reddit Buddy - Your AI assistant\'s best friend for browsing Reddit\n');
  console.log('Usage:');
  console.log('  reddit-buddy           Start the MCP server');
  console.log('  reddit-buddy --auth    Set up Reddit authentication (optional)');
  console.log('  reddit-buddy --help    Show this help message\n');
  console.log('Features:');
  console.log('  • Browse subreddits with smart summaries');
  console.log('  • Search Reddit with advanced filters');
  console.log('  • Analyze trends and sentiment');
  console.log('  • Compare opinions across subreddits');
  console.log('  • And much more!\n');
  console.log('Learn more: https://github.com/karanb192/reddit-buddy');
} else if (args.includes('--version') || args.includes('-v')) {
  console.log('Reddit Buddy v1.0.3');
} else {
  // Start the server
  startServer().catch((error) => {
    console.error('Failed to start:', error);
    process.exit(1);
  });
}