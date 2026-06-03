import path from "node:path";
import { embedQuery } from "../services/embedder.js";
import {
	projectCollectionName,
	searchChunks,
	listCollections,
	type SearchFilters,
	type SearchResult,
} from "../services/qdrantStore.js";

function normalizeChunkTypes(values?: string[]): string[] | undefined {
	if (!values?.length) {
		return undefined;
	}

	const normalized = [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeFileTypes(values?: string[]): string[] | undefined {
	if (!values?.length) {
		return undefined;
	}

	const normalized = [
		...new Set(
			values
				.map((value) => value.trim().toLowerCase().replace(/^\./, ""))
				.filter(Boolean),
		),
	];
	return normalized.length > 0 ? normalized : undefined;
}

function formatSearchScope(filters: SearchFilters): string {
	const parts: string[] = [];

	if (filters.chunkTypes?.length) {
		parts.push(`chunkTypes=${filters.chunkTypes.join(", ")}`);
	}

	if (filters.fileTypes?.length) {
		parts.push(`fileTypes=${filters.fileTypes.map((value) => `.${value}`).join(", ")}`);
	}

	return parts.length > 0 ? ` (${parts.join(" | ")})` : "";
}

function matchesFileType(result: SearchResult, fileTypes?: string[]): boolean {
	if (!fileTypes?.length) {
		return true;
	}

	const normalized = (result.payload.fileExtension ?? path.extname(result.payload.filePath).slice(1)).toLowerCase();
	return fileTypes.includes(normalized);
}

async function searchCollection(
	collectionName: string,
	queryVector: number[],
	limit: number,
	filters: SearchFilters,
): Promise<Array<SearchResult & { collection: string }>> {
	const candidateLimit = filters.fileTypes?.length ? Math.max(limit * 5, 20) : limit;
	let hits = await searchChunks(collectionName, queryVector, candidateLimit, filters);

	if (hits.length === 0 && filters.fileTypes?.length) {
		hits = await searchChunks(collectionName, queryVector, candidateLimit, {
			chunkTypes: filters.chunkTypes,
		});
		hits = hits.filter((hit) => matchesFileType(hit, filters.fileTypes));
	}

	return hits.slice(0, limit).map((hit) => ({ ...hit, collection: collectionName }));
}

/**
 * Semantic search across indexed TwinCAT projects.
 */
export async function handleSearch(args: {
	query: string;
	project?: string;
	limit?: number;
	chunkTypes?: string[];
	fileTypes?: string[];
}): Promise<string> {
	const limit = args.limit ?? 10;
	const filters: SearchFilters = {
		chunkTypes: normalizeChunkTypes(args.chunkTypes),
		fileTypes: normalizeFileTypes(args.fileTypes),
	};

	// 1. Embed the query
	const queryVector = await embedQuery(args.query);

	// 2. Determine which collections to search
	let results: Array<SearchResult & { collection: string }> = [];

	if (args.project) {
		// Search a specific project
		const collectionName = projectCollectionName(path.resolve(args.project));
		try {
			results = await searchCollection(collectionName, queryVector, limit, filters);
		} catch {
			throw new Error(`No index found for project "${args.project}". Run twincat_index first.`);
		}
	} else {
		// Search ALL tc-* collections and merge results
		const collections = await listCollections();
		if (collections.length === 0) {
			return "No indexed TwinCAT projects found. Run twincat_index first.";
		}

		for (const col of collections) {
			try {
				const hits = await searchCollection(col.collectionName, queryVector, limit, filters);
				results.push(...hits);
			} catch {
				// Skip collections that error
			}
		}

		// Sort by score descending and take top `limit`
		results.sort((a, b) => b.score - a.score);
		results = results.slice(0, limit);
	}

	if (results.length === 0) {
		return `No results found for "${args.query}"${formatSearchScope(filters)}.`;
	}

	// 3. Format results
	const HMI_CHUNK_TYPES = new Set(["text_list", "visualization", "visualization_action", "visu_manager"]);

	const formatted = results.map((r, i) => {
		const p = r.payload;
		const isHmi = HMI_CHUNK_TYPES.has(p.chunkType);
		const fileType = p.fileExtension ? `.${p.fileExtension}` : path.extname(p.filePath).toLowerCase();
		const fence = isHmi ? "" : "```st\n";
		const fenceEnd = isHmi ? "" : "\n```";
		return [
			`--- Result ${i + 1} (score: ${r.score.toFixed(3)}) ---`,
			`📄 ${p.filePath}`,
			`Project: ${p.projectPath}`,
			`Type: ${p.chunkType} | File Type: ${fileType} | Name: ${p.name} | Lines: ${p.startLine}-${p.endLine}`,
			`${fence}${p.codeChunk}${fenceEnd}`,
		].join("\n");
	});

	return formatted.join("\n\n");
}
