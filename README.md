# twincat-index-mcp

An MCP (Model Context Protocol) server that indexes Beckhoff TwinCAT 3 PLC and HMI projects for semantic search. Gives AI assistants (GitHub Copilot, Claude, etc.) the ability to search a PLC codebase by meaning rather than text — "motor homing sequence", "actuator fault recovery", "safety interlock zone check".

## Features

- **Semantic search** over PLC and HMI code via OpenAI embeddings + Qdrant
- **ST parsing** — Function Blocks, Methods, Programs, Functions, Interfaces, Actions, Types extracted as individual searchable chunks using a tree-sitter grammar
- **XML-aware extraction** — reads `.TcPOU`/`.TcGVL`/`.TcDUT`/`.TcIO` files, strips the XML wrapper, synthesizes missing `END_*` keywords so the parser sees clean ST
- **HMI indexing** — `.TcVIS` screens (STSnippets, VAR interfaces, PLC bindings), `.TcTLO`/`.TcGTLO` text lists, `.TcVMO` visu managers — no tree-sitter needed for these
- **Atomic reindexing** — new index is built in a temp Qdrant collection and swapped in via alias; the old collection is never deleted until the new one is durable
- **Project isolation** — each project gets its own Qdrant collection (`tc-<hash>`); re-index one project without touching others

## File Types Indexed

| Extension | Content | Parser |
|-----------|---------|--------|
| `.TcPOU` | Function Blocks, Programs, Methods, Properties, Actions | tree-sitter ST |
| `.TcGVL` | Global Variable Lists | tree-sitter ST |
| `.TcDUT` | Structs, Enums, Unions, Aliases | tree-sitter ST |
| `.TcIO` | Interface declarations | tree-sitter ST |
| `.st` | Plain Structured Text | tree-sitter ST |
| `.TcVIS` | HMI visualization screens | Regex extraction |
| `.TcTLO` / `.TcGTLO` | Text lists | Regex extraction |
| `.TcVMO` | Visu manager objects | Regex extraction |

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Qdrant](https://qdrant.tech/) running locally (default: `http://localhost:6333`)
- An [OpenAI API key](https://platform.openai.com/api-keys)

Start Qdrant with Docker:

```bash
docker run -p 6333:6333 qdrant/qdrant
```

## Installation

```bash
git clone https://github.com/idomp/twincat-index-mcp.git
cd twincat-index-mcp
npm install
npm run build
```

## Configuration

Set the following environment variables (or add them to your MCP client config):

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | — | **Required.** OpenAI API key for embeddings |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model name |
| `VECTOR_SIZE` | `1536` | Must match the embedding model's output dimension |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant server URL |

## MCP Client Setup

### VS Code (GitHub Copilot)

Add to your VS Code `settings.json` or `.vscode/mcp.json`:

```json
{
  "mcp": {
    "servers": {
      "twincat-index": {
        "type": "stdio",
        "command": "node",
        "args": ["C:/path/to/twincat-index-mcp/dist/index.js"],
        "env": {
          "OPENAI_API_KEY": "sk-...",
          "QDRANT_URL": "http://localhost:6333"
        }
      }
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "twincat-index": {
      "command": "node",
      "args": ["C:/path/to/twincat-index-mcp/dist/index.js"],
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "QDRANT_URL": "http://localhost:6333"
      }
    }
  }
}
```

## Tools

### `twincat_index`

Index a TwinCAT project directory. Run once before searching, and re-run after significant code changes.

```
twincat_index(path: "C:/Projects/MyPlcProject")
```

### `twincat_search`

Semantic search across all indexed projects.

```
twincat_search(query: "axis homing sequence")
twincat_search(query: "error handling on drive fault", project: "C:/Projects/MyPlcProject")
twincat_search(query: "motor enable logic", chunkTypes: ["function_block", "method"])
twincat_search(query: "alarm text", fileTypes: ["tctlo", "tcgtlo"])
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Natural language search query |
| `project` | string (optional) | Absolute path to limit search to one project |
| `chunkTypes` | string[] (optional) | Filter by: `function_block`, `method`, `function`, `program`, `interface`, `type`, `action`, `visualization`, `text_list`, `visualization_action`, `visu_manager`, `chunk` |
| `fileTypes` | string[] (optional) | Filter by extension: `tcpou`, `tcgvl`, `tcdut`, `tcio`, `st`, `tcvis`, `tctlo`, `tcgtlo`, `tcvmo` |
| `limit` | number (optional) | Max results, default 10 |

### `twincat_status`

List all indexed projects with file counts and last-indexed timestamps.

```
twincat_status()
```

## Architecture

```
MCP client (Copilot / Claude)
        │ stdio
        ▼
  twincat-index-mcp
        │
  ┌─────┼────────┐
  ▼     ▼        ▼
tree-sitter  OpenAI    Qdrant
(WASM parse) (embed)  (store/search)
```

The WASM grammar (`wasm/tree-sitter-structured_text.wasm`) is built from [`idomp/tree-sitter-structured-text`](https://github.com/idomp/tree-sitter-structured-text) — a full TwinCAT 3 / IEC 61131-3 grammar.

## Known Limitations

- **Line numbers after XML extraction** — extracted ST content is concatenated from CDATA blocks so line numbers in results are relative to the extracted text, not the original `.TcPOU` file
- **No incremental indexing** — re-indexing always replaces the full project collection
- **GVL variables** — `VAR_GLOBAL` sections are indexed as fallback text chunks, not as individually named variable entries
