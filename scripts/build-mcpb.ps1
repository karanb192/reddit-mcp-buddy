#!/usr/bin/env pwsh
# Build script for creating the Claude Desktop Extension (.mcpb file) on Windows.
# PowerShell equivalent of scripts/build-mcpb.sh — uses Compress-Archive so the
# `zip` CLI (absent on most Windows installs) is NOT required.
#
# Usage (from repository root):
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/build-mcpb.ps1
#   # or:  npm run build:mcpb:win

$ErrorActionPreference = 'Stop'

# --- Must run from repository root ---
if (-not (Test-Path 'package.json') -or -not (Test-Path 'src') -or -not (Test-Path 'manifest.json')) {
    Write-Host "[ERROR] This script must be run from the repository root!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Current directory: $(Get-Location)"
    Write-Host "Expected files: package.json, manifest.json, src/"
    Write-Host "  cd path\to\reddit-mcp-buddy"
    Write-Host "  pwsh -File scripts/build-mcpb.ps1"
    exit 1
}

Write-Host "Building Reddit MCP Buddy Desktop Extension..." -ForegroundColor Cyan

# --- Build TypeScript if dist/ is missing ---
if (-not (Test-Path 'dist')) {
    Write-Host "dist/ not found - installing deps and compiling TypeScript..."
    npm install
    npm run build
    if (-not (Test-Path 'dist')) {
        Write-Host "[ERROR] Build failed - dist/ still missing after 'npm run build'." -ForegroundColor Red
        Write-Host "Run manually and check for TS errors:  npm install; npm run build"
        exit 1
    }
    Write-Host "TypeScript compilation successful" -ForegroundColor Green
}

# --- Clean previous artifacts ---
$tmp = 'bundle-temp'
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
if (Test-Path 'reddit-mcp-buddy.mcpb') { Remove-Item -Force 'reddit-mcp-buddy.mcpb' }
New-Item -ItemType Directory $tmp | Out-Null

# --- Copy bundle contents (manifest.json must end up at archive root) ---
Copy-Item dist, manifest.json, package.json -Destination $tmp -Recurse
Copy-Item assets -Destination $tmp -Recurse
if (Test-Path 'README.md') { Copy-Item README.md -Destination $tmp }
if (Test-Path 'LICENSE')   { Copy-Item LICENSE   -Destination $tmp } else { Write-Host "[WARN] LICENSE not found (optional)" -ForegroundColor Yellow }

# --- Install production-only dependencies into the bundle ---
Write-Host "Installing production dependencies..."
Push-Location $tmp
npm install --omit=dev --silent
Pop-Location

# --- Create the .mcpb (a ZIP). Path "$tmp\*" puts contents at the archive ROOT. ---
Write-Host "Creating .mcpb bundle..."
$zip = 'reddit-mcp-buddy.zip'
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path "$tmp\*" -DestinationPath $zip -Force
Move-Item $zip 'reddit-mcp-buddy.mcpb'

# --- Clean up temp dir ---
Remove-Item -Recurse -Force $tmp

# --- Verify manifest.json is at the archive root ---
Write-Host "Verifying bundle structure..."
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path 'reddit-mcp-buddy.mcpb'))
$hasManifest = $archive.Entries | Where-Object { $_.FullName -eq 'manifest.json' }
$hasEntry    = $archive.Entries | Where-Object { $_.FullName -eq 'dist/index.js' }
$archive.Dispose()

if (-not $hasManifest) {
    Write-Host "[ERROR] manifest.json is NOT at the archive root!" -ForegroundColor Red
    exit 1
}
if (-not $hasEntry) {
    Write-Host "[ERROR] dist/index.js missing from bundle - did the build succeed?" -ForegroundColor Red
    exit 1
}
Write-Host "manifest.json found at root; dist/index.js present" -ForegroundColor Green

# --- Report ---
$mcpb = Get-Item 'reddit-mcp-buddy.mcpb'
$sizeMB = [math]::Round($mcpb.Length / 1MB, 2)
Write-Host "Desktop Extension created successfully!" -ForegroundColor Green
Write-Host ("  {0}  ({1} MB)" -f $mcpb.Name, $sizeMB)
