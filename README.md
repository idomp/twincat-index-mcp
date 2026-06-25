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

- [Node.js](https://nodejs.org/) 18+ (on **Node 26+** see [Node.js compatibility](#nodejs-compatibility))
- [Qdrant](https://qdrant.tech/) running locally (default: `http://localhost:6333`)
- An [OpenAI API key](https://platform.openai.com/api-keys) — **or** any OpenAI-compatible embeddings endpoint (e.g. a local [Ollama](https://ollama.com) server; see [Local embeddings with Ollama](#local-embeddings-with-ollama))

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
| `OPENAI_API_KEY` | — | **Required.** API key for embeddings. For a local Ollama server any non-empty value works (e.g. `ollama`). |
| `OPENAI_BASE_URL` | OpenAI default | Optional. Point the OpenAI SDK at any OpenAI-compatible endpoint, e.g. `http://localhost:11434/v1` for Ollama. |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model name |
| `VECTOR_SIZE` | `1536` | Must match the embedding model's output dimension |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant server URL |

### Local embeddings with Ollama

The server uses the OpenAI Node SDK, which honors the `OPENAI_BASE_URL` environment variable — so you can run **fully local, no API key, no cloud** by pointing it at an [Ollama](https://ollama.com) server's OpenAI-compatible endpoint. No code changes required.

1. Pull an embedding model, e.g. `ollama pull qwen3-embedding:8b` (dim 4096) or the smaller `qwen3-embedding:4b` (dim 2560) / `qwen3-embedding:0.6b` (dim 1024).
2. Set these env vars in your MCP client config:

```jsonc
"env": {
  "OPENAI_BASE_URL": "http://localhost:11434/v1",
  "OPENAI_API_KEY": "ollama",                 // any non-empty placeholder
  "OPENAI_EMBEDDING_MODEL": "qwen3-embedding:8b",
  "VECTOR_SIZE": "4096",                       // MUST match the model's output dim
  "QDRANT_URL": "http://localhost:6333"
}
```

`VECTOR_SIZE` must equal the model's embedding dimension or indexing fails fast with a dimension-mismatch error. Verify a model's dimension with:

```bash
curl -s http://localhost:11434/v1/embeddings -H "Content-Type: application/json" \
  -d '{"model":"qwen3-embedding:8b","input":"test"}' | jq '.data[0].embedding | length'
```

### Node.js compatibility

`@qdrant/js-client-rest` depends on **undici 6** and passes its own undici `Agent` as a `dispatcher` to the global `fetch`. On **Node.js 26+** (which bundles undici 8) this cross-major mismatch makes every Qdrant call fail with `fetch failed` / `UND_ERR_INVALID_ARG: invalid onError method` (embeddings are unaffected, so indexing appears to run, then dies at the Qdrant upsert/search step). Two options:

- **Run on Node.js 22 LTS** (bundles a matching undici), or
- Keep the included [`patch-package`](https://www.npmjs.com/package/patch-package) patch (`patches/@qdrant+js-client-rest+*.patch`), which neutralizes the custom dispatcher so native `fetch` handles pooling. It is applied automatically by the `postinstall` script after `npm install`.

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
