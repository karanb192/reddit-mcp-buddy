# Building the `.mcpb` Desktop Extension — Windows / macOS / Linux

This guide shows how to build `reddit-mcp-buddy.mcpb` from this codebase. A `.mcpb` ("MCP Bundle") is a **ZIP file** containing the compiled server, its production dependencies, and a `manifest.json` at the root — installable into Claude Desktop with one click, no Node.js required by the end user.

---

## What goes inside the bundle

| Item | Source | Required |
|---|---|---|
| `manifest.json` | repo root | ✅ must be at ZIP **root** |
| `dist/` | `npm run build` output | ✅ |
| `package.json` | repo root | ✅ |
| `node_modules/` | production deps only (`--omit=dev`) | ✅ |
| `assets/` | repo root (icon) | ✅ (manifest references `assets/...png`) |
| `README.md`, `LICENSE` | repo root | optional |

The end-user's Claude Desktop runs `node dist/index.js` (per `manifest.json` → `server.mcp_config`), so production `node_modules` **must** be bundled.

---

## Prerequisites (all OS)

- **Node.js ≥ 18** and **npm** — check: `node --version`
- Repo cloned, terminal at repo root (the folder with `package.json`, `manifest.json`, `src/`)

> **Tip — sync the version first.** `manifest.json` `version` should match `package.json` `version`. If they differ, edit `manifest.json` → `"version"` before building.

---

## Step 1 — Build the TypeScript (all OS, identical)

```bash
npm install
npm run build
```

Produces `dist/`. Confirm `dist/index.js` and `dist/cli.js` exist before continuing.

---

## Step 2 — Pack the `.mcpb` (pick ONE method)

### Method A — Official `mcpb` CLI ⭐ Recommended (Windows / macOS / Linux)

Cross-platform, no system `zip` needed, handles the ZIP structure correctly.

```bash
# Build prod deps into the repo so they get bundled
npm install --omit=dev

# Pack (uses Anthropic's official bundler; respects .mcpbignore)
npx @anthropic-ai/mcpb pack . reddit-mcp-buddy.mcpb
```

Output: `reddit-mcp-buddy.mcpb` in the repo root.

> After packing, restore dev deps for further development: `npm install`

---

### Method B — macOS / Linux (repo bash script)

The repo ships `scripts/build-mcpb.sh`. It builds `dist/` if missing, copies files into a temp dir, installs production deps, and zips. **Requires the `zip` utility.**

```bash
# Ensure zip is installed:
#   macOS  -> preinstalled (or: brew install zip)
#   Debian/Ubuntu -> sudo apt-get install zip
#   Fedora -> sudo dnf install zip

chmod +x scripts/build-mcpb.sh   # first time only
./scripts/build-mcpb.sh
```

Output: `reddit-mcp-buddy.mcpb` with a verification step confirming `manifest.json` is at root.

---

### Method C — Windows (PowerShell, no `zip` needed)

Windows usually lacks the `zip` CLI, so the bash script fails. Use PowerShell's built-in `Compress-Archive` instead. Run this block from the repo root in **PowerShell 7+**:

```powershell
$ErrorActionPreference = 'Stop'
$tmp = "bundle-temp"
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory $tmp | Out-Null

# Copy bundle contents
Copy-Item dist,manifest.json,package.json,README.md,LICENSE -Destination $tmp -Recurse
Copy-Item assets -Destination $tmp -Recurse

# Install production-only dependencies into the bundle
Push-Location $tmp
npm install --omit=dev --silent
Pop-Location

# Zip it (Compress-Archive puts $tmp\* at the archive ROOT — manifest.json ends up at root, as required)
if (Test-Path reddit-mcp-buddy.mcpb) { Remove-Item reddit-mcp-buddy.mcpb }
Compress-Archive -Path "$tmp\*" -DestinationPath reddit-mcp-buddy.zip -Force
Move-Item reddit-mcp-buddy.zip reddit-mcp-buddy.mcpb

# Clean up
Remove-Item -Recurse -Force $tmp
Get-Item reddit-mcp-buddy.mcpb | Select-Object Name,@{n='SizeMB';e={[math]::Round($_.Length/1MB,2)}}
```

Output: `reddit-mcp-buddy.mcpb` (~9 MB) in the repo root.

> **Alternative on Windows:** Method A (`npx @anthropic-ai/mcpb pack`) also works and is simpler — prefer it if you have network access.

---

## Step 3 — Verify the bundle

`manifest.json` **must** sit at the ZIP root or Claude Desktop rejects it.

**macOS / Linux:**
```bash
unzip -l reddit-mcp-buddy.mcpb | grep -E " manifest\.json$| dist/index\.js$"
```

**Windows (PowerShell):**
```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path reddit-mcp-buddy.mcpb))
$z.Entries | Where-Object { $_.FullName -in @('manifest.json','dist/index.js') } | Select-Object FullName
$z.Dispose()
```

Expect to see `manifest.json` and `dist/index.js`. If `manifest.json` shows under a subfolder, repack (don't zip the parent directory — zip the *contents*).

---

## Step 4 — Install in Claude Desktop

1. Open **Claude Desktop** → **Settings → Extensions**
2. Drag `reddit-mcp-buddy.mcpb` into the window (or double-click the file)
3. The config UI appears:
   - **Leave blank** → anonymous mode (10 req/min)
   - **Client ID + Secret** → app-only (60 req/min)
   - **+ Username + Password** → full auth (100 req/min, private-sub access)
4. Restart Claude Desktop if prompted. Reddit tools are now available.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `zip: command not found` (bash script) | `zip` not installed (common on Windows) | Use Method A or Method C |
| Claude Desktop "invalid extension / manifest not found" | `manifest.json` not at ZIP root | Repack zipping folder *contents*, not the folder itself |
| Tools missing after install | `dist/` not built or prod deps absent | Re-run Step 1, then `npm install --omit=dev` before packing |
| Version looks wrong in Extensions list | `manifest.json` `version` ≠ `package.json` | Sync `manifest.json` version, rebuild |
| Auth seems ignored / `auth.json` not found on disk | **Store (MSIX) Claude Desktop** sandboxes the filesystem; the extension's `auth.json` is redirected inside the package container | Don't rely on disk inspection — verify auth **behaviorally** in-app (ask Claude for a `browse_subreddit` result and check `data_source: "api"` vs `"rss"`) |
| Build very large / slow | dev deps leaked into bundle | Ensure `npm install --omit=dev` (not plain `npm install`) when populating the bundle |

---

## Optional — add an npm script

To make the Windows build repeatable, you can add to `package.json` `scripts`:

```json
"build:mcpb:win": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-mcpb.ps1"
```

(Then move the Method C PowerShell block into `scripts/build-mcpb.ps1`.) For macOS/Linux, `scripts/build-mcpb.sh` already exists.

---

## Quick reference

```text
build TypeScript  ->  npm install && npm run build
pack (any OS)     ->  npm install --omit=dev && npx @anthropic-ai/mcpb pack . reddit-mcp-buddy.mcpb
pack (mac/linux)  ->  ./scripts/build-mcpb.sh
pack (windows)    ->  PowerShell Compress-Archive block (Method C)
verify            ->  manifest.json must be at ZIP root
install           ->  Claude Desktop > Settings > Extensions > drag .mcpb
```
