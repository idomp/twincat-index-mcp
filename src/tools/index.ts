import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleIndex } from "./indexTool.js";
import { handleSearch } from "./searchTool.js";
import { handleStatus } from "./statusTool.js";

const SEARCH_CHUNK_TYPES = [
	"function_block",
	"method",
	"function",
	"program",
	"interface",
	"type",
	"action",
	"chunk",
	"text_list",
	"visualization",
	"visualization_action",
	"visu_manager",
] as const;

const SEARCH_FILE_TYPES = ["tcpou", "tcgvl", "tcdut", "st", "tcvis", "tctlo", "tcgtlo", "tcvmo", "tcio"] as const;

/**
 * Register all TwinCAT indexing tools on the MCP server.
 */
export function registerTools(server: McpServer): void {
	// --- twincat_index ---
	server.tool(
		"twincat_index",
		"Scan a TwinCAT project directory, parse all .TcPOU/.TcGVL/.TcDUT/.st files using tree-sitter and .TcVIS/.TcTLO/.TcGTLO HMI visualization files, embed the code chunks, and store them in Qdrant for semantic search.",
		{
			path: z.string().describe("Absolute path to the TwinCAT project directory to index"),
		},
		async (args) => {
			try {
				const result = await handleIndex(args);
				return { content: [{ type: "text" as const, text: result }] };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Error indexing: ${msg}` }],
					isError: true,
				};
			}
		},
	);

	// --- twincat_search ---
	server.tool(
		"twincat_search",
		"Preferred first tool for locating TwinCAT behavior in PLC/HMI code. Semantic search across indexed TwinCAT Structured Text and HMI projects; searches PLC code, HMI visualization screens, text lists, and PLC-HMI variable bindings, and returns the most relevant chunks.",
		{
			query: z.string().describe("Natural language search query"),
			project: z
				.string()
				.optional()
				.describe("Absolute path to limit search to a specific project"),
			chunkTypes: z
				.array(z.enum(SEARCH_CHUNK_TYPES))
				.optional()
				.describe("Optional semantic chunk-type filter, for example function_block, method, visualization, or text_list"),
			fileTypes: z
				.array(z.enum(SEARCH_FILE_TYPES))
				.optional()
				.describe("Optional TwinCAT file-type filter by lowercase extension without dot, for example tcpou, st, tcvis, or tcgtlo"),
			limit: z
				.number()
				.optional()
				.default(10)
				.describe("Maximum number of results to return (default: 10)"),
		},
		async (args) => {
			try {
				const result = await handleSearch(args);
				return { content: [{ type: "text" as const, text: result }] };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Error searching: ${msg}` }],
					isError: true,
				};
			}
		},
	);

	// --- twincat_status ---
	server.tool(
		"twincat_status",
		"List all indexed TwinCAT projects with stats (number of files, chunks, last indexed time).",
		{},
		async () => {
			try {
				const result = await handleStatus();
				return { content: [{ type: "text" as const, text: result }] };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Error getting status: ${msg}` }],
					isError: true,
				};
			}
		},
	);
}
