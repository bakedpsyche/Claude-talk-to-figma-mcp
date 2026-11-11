# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP (Model Context Protocol) server that bridges Cursor AI IDE with Figma. Three components communicate in a pipeline:

```
Cursor AI ←(stdio)→ MCP Server ←(WebSocket)→ WebSocket Relay ←(WebSocket)→ Figma Plugin
```

## Build & Development Commands

```bash
bun install              # Install dependencies
bun run build            # Build MCP server (tsup → dist/)
bun run dev              # Build in watch mode
bun socket               # Start WebSocket relay server (port 3055)
bun run start            # Run built MCP server
bun setup                # Full setup (install + write .cursor/mcp.json + .mcp.json)
```

There is no test suite or linter configured.

## Architecture

### MCP Server (`src/talk_to_figma_mcp/server.ts`)
The main server implementing the MCP protocol via `@modelcontextprotocol/sdk`. Exposes 50+ tools (create shapes, modify text, manage layouts, export images, etc.) and several AI prompts (design strategies). Communicates with Cursor over stdio and with the WebSocket relay via `ws`. Each request gets a UUID, is tracked in a `pendingRequests` Map with timeout/promise callbacks, and resolves when the plugin responds.

### WebSocket Relay (`src/socket.ts`)
Lightweight Bun WebSocket server on port 3055 (configurable via `PORT` env). Routes messages between MCP server and Figma plugin using channel-based isolation. Clients call `join` to enter a channel; messages broadcast only within the same channel.

### Figma Plugin (`src/cursor_mcp_plugin/`)
Runs inside Figma. `code.js` is the plugin main thread handling 30+ commands via a dispatcher. `ui.html` is the plugin UI for WebSocket connection management. `manifest.json` declares permissions (dynamic-page access, localhost network). The plugin is **not built/bundled** — `code.js` is written directly as the runtime artifact.

## Key Patterns

- **Colors**: Figma uses RGBA 0-1 range. The MCP tools accept 0-1 floats and the filter converts to hex for display.
- **Logging**: All logs go to stderr. Stdout is reserved for MCP protocol messages.
- **Timeouts**: 30s default per command. Progress updates from the plugin reset the inactivity timer.
- **Chunking**: Large operations (scanning 100+ nodes) are chunked with progress updates to prevent Figma UI freezing.
- **Reconnection**: WebSocket auto-reconnects after 2 seconds on disconnect.
- **Zod validation**: All tool parameters are validated with Zod schemas.

## Fork: Local Additions

This checkout is the fork `bakedpsyche/Claude-talk-to-figma-mcp`. `origin` is the fork (push here); `upstream` is `grab/cursor-talk-to-figma-mcp`, fetch only (its push URL is disabled on purpose). Pull upstream updates with `git fetch upstream && git merge upstream/main`, then push to `origin`. Never push to upstream.

Plugin commands added in `code.js` (Plugin API, no plan limits): `get_plugin_version`, `get_variables`, `create_variable`, `set_variable_value`, `set_variable_scopes`, `delete_variable`, `bind_variable`, `get_bound_variables`, `delete_style`, `execute_code`. Variables are found by id or by name (pass `collection` when a name exists in several); colour values are hex, and `{"alias": "<variable>"}` makes an alias. Each is also an MCP tool (registered through `pluginTool()` in `server.ts`, returning the plugin's JSON). Without the MCP server, send them with the relay client:

```bash
bun scripts/figma.ts get_variables '{"collection":"Website (DesignPrem)"}'
bun scripts/figma.ts bind_variable '{"nodeId":"1:2","variable":"text/on-dark-display","field":"fills"}'
```

`execute_code` runs Plugin API JavaScript as the body of an async function with `figma` and `log(...)` in scope, and returns `{ result, logs }` (nodes in the result become `{id, name, type}`). It covers what the fixed tools don't: ellipses, polygons, stars, lines and vectors, components and variants, effects, font styling, boolean operations. Whichever file has the plugin open runs the code, so the one-file rule below matters more here.

**Fixed channel:** the fork's plugin always joins channel `prem` (`FIXED_CHANNEL` in `ui.html`), and the script uses it by default (`FIGMA_CHANNEL` overrides). The relay listens on 127.0.0.1 only, so the name can't collide with other people; but every Figma file with the plugin open joins the same channel and receives each command, so keep the plugin open in one file at a time. The MCP server joins `prem` by itself on connect (`DEFAULT_CHANNEL` in `server.ts`), so `join_channel` isn't needed.

**Claude Code runs the server from source**, the README's local-development form, so no build step: `claude mcp add -s user TalkToFigma -- bun <workspace>/Claude-talk-to-figma-mcp/src/talk_to_figma_mcp/server.ts`. Server changes load when Claude Code restarts; plugin changes hot-reload in Figma.

**Build version:** `PLUGIN_VERSION` at the top of `code.js` (format `<upstream version>-prem.<n>`) is shown in the plugin panel header and returned by `get_plugin_version`. Bump it on every plugin change, so the running build can be told apart. A panel without a "Build:" line is an upstream or Community build.

The plugin running in Figma must be the dev plugin linked from this checkout's `src/cursor_mcp_plugin/manifest.json`; the Community build answers "Unknown command".

## Setup

1. Run `bun setup` — installs dependencies and writes MCP config for both Cursor (`.cursor/mcp.json`) and Claude Code (`.mcp.json`)
2. `bun socket` in one terminal (WebSocket relay)
3. In Figma: Plugins → Development → Link existing plugin → select `src/cursor_mcp_plugin/manifest.json`
4. Run plugin in Figma, join a channel, then use tools from Cursor or Claude Code

The MCP config written by `bun setup` uses the published package:

```json
{
  "mcpServers": {
    "TalkToFigma": {
      "command": "bunx",
      "args": ["cursor-talk-to-figma-mcp@latest"]
    }
  }
}
```

You can also add it manually for Claude Code via the CLI:

```bash
claude mcp add TalkToFigma -- bunx cursor-talk-to-figma-mcp@latest
```
