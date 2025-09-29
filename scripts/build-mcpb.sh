#!/bin/bash

# Build script for creating Claude Desktop Extension (.mcpb file)
# Creates a clean 5.3MB bundle with manifest.json at root level

echo "🔨 Building Reddit MCP Buddy Desktop Extension..."

# Clean up any previous builds
rm -f reddit-mcp-buddy.mcpb
rm -rf bundle-temp

# Create temp directory
mkdir -p bundle-temp
cd bundle-temp

# Copy necessary files (manifest must be at root)
cp -r ../dist .
cp ../package.json .
cp ../manifest.json .
cp -r ../assets .
cp ../README.md .
cp ../LICENSE .

# Install production dependencies
echo "📦 Installing production dependencies..."
npm install --production --silent

# Create the .mcpb file
echo "🎁 Creating .mcpb bundle..."
zip -r ../reddit-mcp-buddy.mcpb . -q

# Clean up
cd ..
rm -rf bundle-temp

# Show result
echo "✅ Desktop Extension created successfully!"
ls -lh reddit-mcp-buddy.mcpb