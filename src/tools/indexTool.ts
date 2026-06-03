import fs from "node:fs/promises";
import path from "node:path";
import { scanForTwincatFiles } from "../utils/fileScanner.js";
import { XML_EXTENSIONS, HMI_EXTENSIONS } from "../utils/constants.js";
import { extractStFromXml } from "../services/xmlExtractor.js";
import { extractTextList, extractFromTcVIS, extractFromTcVMO } from "../services/hmiExtractor.js";
import { initParser, parseStCode, type CodeChunk } from "../services/treeSitterParser.js";
import { embedTexts } from "../services/embedder.js";
import {
	projectCollectionName,
	ensureCollection,
	clearCollection,
	upsertChunks,
	storeMetadata,
	physicalCollectionName,
	atomicSwapCollection,
	type ChunkWithEmbedding,
} from "../services/qdrantStore.js";

/**
 * Index a TwinCAT project directory: scan → extract → parse → embed → store.
 */
export async function handleIndex(args: { path: string }): Promise<string> {
	const projectPath = path.resolve(args.path);

	// 1. Validate path
	const stat = await fs.stat(projectPath).catch(() => null);
	if (!stat || !stat.isDirectory()) {
		throw new Error(`"${projectPath}" is not a valid directory.`);
	}

	// 2. Scan for TwinCAT files
	const files = await scanForTwincatFiles(projectPath);
	if (files.length === 0) {
		throw new Error(`No TwinCAT files found in "${projectPath}".`);
	}

	// 3. Extract and parse all files (parser initialized lazily)
	const allChunks: Array<CodeChunk & { filePath: string; absolutePath: string }> = [];
	let parseErrors = 0;

	for (const filePath of files) {
		try {
			let content = await fs.readFile(filePath, "utf-8");
			const ext = path.extname(filePath).slice(1).toLowerCase();

			// HMI files: extract directly, skip tree-sitter entirely
			if (HMI_EXTENSIONS.has(ext)) {
				let hmiChunks: Array<{ name: string; type: string; content: string; startLine: number; endLine: number }>;
				if (ext === "tctlo" || ext === "tcgtlo") {
					hmiChunks = extractTextList(content, path.basename(filePath));
				} else if (ext === "tcvis") {
					hmiChunks = extractFromTcVIS(content, path.basename(filePath));
				} else {
					hmiChunks = extractFromTcVMO(content, path.basename(filePath));
				}

				const relPath = path.relative(projectPath, filePath).replace(/\\/g, "/");
				for (const chunk of hmiChunks) {
					allChunks.push({
						...chunk,
						filePath: relPath,
						absolutePath: filePath.replace(/\\/g, "/"),
					});
				}
				continue; // Skip XML extraction + tree-sitter path
			}

			// Extract ST from XML wrappers
			if (XML_EXTENSIONS.has(ext)) {
				content = extractStFromXml(content);
			}

			if (!content.trim()) continue;

			// Lazy parser init before tree-sitter parsing
			try {
				await initParser();
			} catch {
				// Parser unavailable — parseStCode will use fallback chunking
			}
			const chunks = parseStCode(content, filePath);
			const relPath = path.relative(projectPath, filePath).replace(/\\/g, "/");

			for (const chunk of chunks) {
				allChunks.push({
					...chunk,
					filePath: relPath,
					absolutePath: filePath.replace(/\\/g, "/"),
				});
			}
		} catch {
			parseErrors++;
		}
	}

	if (allChunks.length === 0) {
		throw new Error(`Found ${files.length} TwinCAT files but extracted 0 indexable chunks.${parseErrors > 0 ? ` (${parseErrors} parse errors)` : ""}`);
	}

	// 5. Embed all chunks
	const texts = allChunks.map((c) => c.content);
	const embeddings = await embedTexts(texts);

	// 6. Build in a temp physical collection and atomic swap
	const aliasName = projectCollectionName(projectPath);
	const tempName = physicalCollectionName(aliasName);

	try {
		await ensureCollection(tempName);

		// 7. Upsert chunks with embeddings
		const chunksWithEmbeddings: ChunkWithEmbedding[] = allChunks.map((chunk, i) => ({
			filePath: chunk.filePath,
			absolutePath: chunk.absolutePath,
			projectPath: projectPath.replace(/\\/g, "/"),
			codeChunk: chunk.content,
			chunkType: chunk.type,
			name: chunk.name,
			startLine: chunk.startLine,
			endLine: chunk.endLine,
			embedding: embeddings[i],
		}));

		await upsertChunks(tempName, chunksWithEmbeddings);

		// 8. Store metadata
		await storeMetadata(tempName, projectPath.replace(/\\/g, "/"), files.length);

		// 9. Atomic swap: alias → new collection, delete old
		await atomicSwapCollection(aliasName, tempName);
	} catch (err) {
		// Clean up temp collection on failure
		await clearCollection(tempName).catch(() => {});
		throw err;
	}

	// 10. Summary
	const typeBreakdown = new Map<string, number>();
	for (const c of allChunks) {
		typeBreakdown.set(c.type, (typeBreakdown.get(c.type) ?? 0) + 1);
	}
	const breakdownStr = [...typeBreakdown.entries()]
		.map(([type, count]) => `${type}: ${count}`)
		.join(", ");

	return [
		`✅ Indexed ${files.length} files → ${allChunks.length} chunks in collection "${aliasName}"`,
		`   Project: ${projectPath}`,
		`   Breakdown: ${breakdownStr}`,
		parseErrors > 0 ? `   ⚠️  ${parseErrors} files had parse errors (skipped)` : "",
	]
		.filter(Boolean)
		.join("\n");
}
