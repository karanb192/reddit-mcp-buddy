#!/bin/bash

# Build script for creating Claude Desktop Extension (.mcpb file)
# Creates a clean 5.3MB bundle with manifest.json at root level

# Check if script is being run from repository root
if [ ! -f "package.json" ] || [ ! -d "src" ] || [ ! -f "manifest.json" ]; then
    echo "❌ Error: This script must be run from the repository root!"
    echo ""
    echo "Please run from the repository root directory:"
    echo "  ./scripts/build-mcpb.sh"
    echo ""
    echo "NOT from:"
    echo "  cd scripts && ./build-mcpb.sh  ❌"
    echo ""
    echo "Current directory: $(pwd)"
    exit 1
fi

echo "🔨 Building Reddit MCP Buddy Desktop Extension..."

# Check if dist folder exists, build if not
if [ ! -d "dist" ]; then
    echo "📚 Building TypeScript (dist folder not found)..."
    echo "📦 Installing all dependencies (including TypeScript)..."
    npm install  # This installs ALL dependencies including dev dependencies

    echo "🔨 Compiling TypeScript..."
    npm run build

    # Verify build succeeded
    if [ ! -d "dist" ]; then
        echo "❌ Error: Build failed - dist folder still not found after npm run build"
        echo "Try running these commands manually:"
        echo "  npm install"
        echo "  npm run build"
        echo "And check for TypeScript compilation errors"
        exit 1
    fi
    echo "✅ TypeScript compilation successful"
fi

# Clean up any previous builds
rm -f reddit-mcp-buddy.mcpb
rm -rf bundle-temp

# Create temp directory
mkdir -p bundle-temp
cd bundle-temp

# Copy necessary files (manifest must be at root)
cp -r ../dist . || { echo "❌ Error: dist folder not found. Run 'npm run build' first"; exit 1; }
cp ../package.json . || { echo "❌ Error: package.json not found"; exit 1; }
cp ../manifest.json . || { echo "❌ Error: manifest.json not found"; exit 1; }
cp -r ../assets . || { echo "❌ Error: assets folder not found"; exit 1; }
cp ../README.md .
cp ../LICENSE . 2>/dev/null || echo "⚠️  Warning: LICENSE file not found (optional)"

# Install production dependencies
echo "📦 Installing production dependencies..."
npm install --production --silent

# Create the .mcpb file
echo "🎁 Creating .mcpb bundle..."
zip -r ../reddit-mcp-buddy.mcpb . -q

# Clean up
cd ..
rm -rf bundle-temp

# Verify the bundle structure
echo "🔍 Verifying bundle structure..."
if unzip -l reddit-mcp-buddy.mcpb | grep -q "^\s*[0-9]*\s*[0-9-]*\s*[0-9:]*\s*manifest.json$"; then
    echo "✅ manifest.json found at root level"
else
    echo "❌ Error: manifest.json not at root level in bundle!"
    echo "Bundle contents:"
    unzip -l reddit-mcp-buddy.mcpb | head -20
    exit 1
fi

# Show result
echo "✅ Desktop Extension created successfully!"
ls -lh reddit-mcp-buddy.mcpb