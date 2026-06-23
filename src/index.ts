#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/index.js";
import { handleIndex } from "./tools/indexTool.js";
import { startWatchers, stopWatchers } from "./services/watcher.js";

const server = new McpServer({
	name: "twincat-index",
	version: "1.0.0",
});

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

// W1 auto-reindex watcher: watch indexed project folders and re-index on change.
// Best-effort and non-blocking — never block or crash the MCP server if it fails.
// Disable with TWINCAT_WATCH=0. See WATCHER.md.
void startWatchers(handleIndex).catch((err) => {
	console.error(`[watcher] startup failed: ${err instanceof Error ? err.message : String(err)}`);
});

// Graceful shutdown: close file watchers + clear timers before exiting.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => {
		void stopWatchers()
			.catch(() => {})
			.finally(() => process.exit(0));
	});
}
