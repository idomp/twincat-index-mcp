import { Parser, Language, Query, type Node as TSNode } from "web-tree-sitter";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MIN_CHUNK_CHARS, MAX_CHUNK_CHARS, FALLBACK_CHUNK_TARGET } from "../utils/constants.js";

let parser: Parser | null = null;
let language: Language | null = null;
let tsQuery: Query | null = null;
let initPromise: Promise<void> | null = null;

/** Tree-sitter query for ST definitions. */
const DEFINITIONS_QUERY = `
(function_block_declaration name: (identifier) @name.definition.class) @definition.class
(method_declaration name: (identifier) @name.definition.method) @definition.method
(program_declaration name: (identifier) @name.definition.program) @definition.program
(function_declaration name: (identifier) @name.definition.function) @definition.function
(property_declaration name: (identifier) @name.definition.method) @definition.method
(interface_declaration name: (identifier) @name.definition.interface) @definition.interface
(type_declaration name: (identifier) @name.definition.type) @definition.type
(action_declaration name: (identifier) @name.definition.action) @definition.action
`;

/**
 * Initialize the tree-sitter WASM parser. Safe to call multiple times.
 */
export async function initParser(): Promise<void> {
	if (parser && language && tsQuery) return;

	if (initPromise) return initPromise;

	initPromise = (async () => {
		const thisDir = path.dirname(fileURLToPath(import.meta.url));
		const projectRoot = path.resolve(thisDir, "..");
		const baseWasmPath = path.join(projectRoot, "..", "node_modules", "web-tree-sitter", "tree-sitter.wasm");

		await Parser.init({
			locateFile: (_scriptName: string, _scriptDirectory: string) => {
				return baseWasmPath;
			},
		});

		const p = new Parser();
		const wasmPath = path.join(projectRoot, "..", "wasm", "tree-sitter-structured_text.wasm");
		const lang = await Language.load(wasmPath);
		p.setLanguage(lang);
		const q = new Query(lang, DEFINITIONS_QUERY);

		// Only assign globals after everything succeeds
		parser = p;
		language = lang;
		tsQuery = q;
	})();

	try {
		await initPromise;
	} catch (err) {
		// Reset so next call retries
		initPromise = null;
		parser = null;
		language = null;
		tsQuery = null;
		throw err;
	}
}

export interface CodeChunk {
	name: string;
	/** Semantic type of this chunk. */
	type: string;
	/** The source text of the chunk. */
	content: string;
	startLine: number;
	endLine: number;
}

/**
 * Map a tree-sitter capture tag to a human-readable chunk type.
 */
function captureTagToType(tag: string): string {
	if (tag === "definition.class") return "function_block";
	if (tag === "definition.method") return "method";
	if (tag === "definition.function") return "function";
	if (tag === "definition.program") return "program";
	if (tag === "definition.interface") return "interface";
	if (tag === "definition.type") return "type";
	if (tag === "definition.action") return "action";
	return "unknown";
}

/**
 * Split a large text blob into chunks of approximately `target` characters,
 * breaking at blank lines or END_* keywords when possible.
 */
function splitLargeChunk(text: string, target: number): string[] {
	const lines = text.split("\n");
	const chunks: string[] = [];
	let current: string[] = [];
	let currentLen = 0;

	for (const line of lines) {
		current.push(line);
		currentLen += line.length + 1;

		if (currentLen >= target) {
			// Try to break at a blank line or END_* keyword
			const isBreakPoint = line.trim() === "" || /^END_/i.test(line.trim());
			if (isBreakPoint || currentLen >= target * 1.5) {
				chunks.push(current.join("\n"));
				current = [];
				currentLen = 0;
			}
		}
	}
	if (current.length > 0) {
		chunks.push(current.join("\n"));
	}
	return chunks;
}

/**
 * Parse Structured Text code using tree-sitter and extract semantic chunks.
 * Falls back to line-based chunking if parsing fails or yields no captures.
 */
export function parseStCode(code: string, filePath: string): CodeChunk[] {
	if (!parser || !language || !tsQuery) {
		// Parser not initialized — use fallback
		return fallbackChunk(code, filePath);
	}

	try {
		const tree = parser.parse(code);
		if (!tree) return fallbackChunk(code, filePath);
		const captures = tsQuery.captures(tree.rootNode);

		// Group definition captures. Names are read directly from the node's `name`
		// field, which is more reliable than pairing nested `@name` captures.
		const definitionCaptures: Map<number, { node: TSNode; tag: string }> = new Map();

		for (const capture of captures) {
			if (capture.name.startsWith("definition.")) {
				const id = capture.node.id;
				if (!definitionCaptures.has(id)) {
					definitionCaptures.set(id, { node: capture.node, tag: capture.name });
				}
			}
		}

		const chunks: CodeChunk[] = [];
		for (const [, def] of definitionCaptures) {
			const content = def.node.text;
			if (content.length < MIN_CHUNK_CHARS) continue;

			const directNameNode = def.node.childForFieldName("name");
			const name = directNameNode?.text ?? path.basename(filePath, path.extname(filePath));
			const chunkType = captureTagToType(def.tag);

			if (content.length > MAX_CHUNK_CHARS) {
				// Split oversized chunk
				const parts = splitLargeChunk(content, FALLBACK_CHUNK_TARGET);
				let lineOffset = def.node.startPosition.row;
				for (let i = 0; i < parts.length; i++) {
					const lineCount = parts[i].split("\n").length;
					chunks.push({
						name: parts.length > 1 ? `${name}_part${i + 1}` : name,
						type: chunkType,
						content: parts[i],
						startLine: lineOffset + 1,
						endLine: lineOffset + lineCount,
					});
					lineOffset += lineCount;
				}
			} else {
				chunks.push({
					name,
					type: chunkType,
					content,
					startLine: def.node.startPosition.row + 1,
					endLine: def.node.endPosition.row + 1,
				});
			}
		}

		if (chunks.length > 0) {
			tree.delete();
			return chunks;
		}

		// No semantic captures — fall back to line-based chunking
		tree.delete();
	} catch (err) {
		console.error(`[treeSitterParser] Error parsing ${filePath}:`, err instanceof Error ? err.message : err);
	}

	return fallbackChunk(code, filePath);
}

/**
 * Line-based fallback chunking: split at blank lines, group into ~2000 char chunks.
 */
function fallbackChunk(code: string, filePath: string): CodeChunk[] {
	if (code.length < MIN_CHUNK_CHARS) return [];

	const baseName = path.basename(filePath, path.extname(filePath));
	const parts = splitLargeChunk(code, FALLBACK_CHUNK_TARGET);
	const chunks: CodeChunk[] = [];
	let lineOffset = 0;

	for (let i = 0; i < parts.length; i++) {
		const text = parts[i];
		if (text.trim().length < MIN_CHUNK_CHARS) {
			lineOffset += text.split("\n").length;
			continue;
		}
		const lineCount = text.split("\n").length;
		chunks.push({
			name: parts.length > 1 ? `${baseName}_chunk${i + 1}` : baseName,
			type: "chunk",
			content: text,
			startLine: lineOffset + 1,
			endLine: lineOffset + lineCount,
		});
		lineOffset += lineCount;
	}
	return chunks;
}
