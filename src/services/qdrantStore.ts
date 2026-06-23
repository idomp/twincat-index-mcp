import { QdrantClient } from "@qdrant/js-client-rest";
import crypto from "node:crypto";
import path from "node:path";
import { QDRANT_URL, VECTOR_SIZE } from "../utils/constants.js";
import type { ProjectManifest } from "../utils/fileScanner.js";

const client = new QdrantClient({ url: QDRANT_URL });

/** Metadata point UUID — reserved for collection metadata. */
const METADATA_POINT_ID = "00000000-0000-0000-0000-000000000000";

export interface ChunkPayload {
	filePath: string;
	absolutePath: string;
	projectPath: string;
	fileExtension?: string;
	codeChunk: string;
	chunkType: string;
	name: string;
	startLine: number;
	endLine: number;
}

export interface ChunkWithEmbedding extends ChunkPayload {
	embedding: number[];
}

export interface SearchResult {
	score: number;
	payload: ChunkPayload;
}

export interface SearchFilters {
	chunkTypes?: string[];
	fileTypes?: string[];
}

export interface CollectionInfo {
	collectionName: string;
	projectPath: string;
	pointCount: number;
	indexedAt: string;
	fileCount: number;
}

/**
 * Derive a deterministic Qdrant collection name from a project path.
 */
export function projectCollectionName(projectPath: string): string {
	const normalized = projectPath.replace(/\\/g, "/").toLowerCase();
	const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
	return `tc-${hash}`;
}

/**
 * Generate a deterministic UUID v5-like ID for a chunk based on file path, type, name, and line range.
 */
function chunkPointId(filePath: string, chunkType: string, name: string, startLine: number, endLine: number): string {
	const input = `${filePath}:${chunkType}:${name}:${startLine}:${endLine}`;
	const hash = crypto.createHash("sha256").update(input).digest("hex");
	// Format as UUID
	return [
		hash.slice(0, 8),
		hash.slice(8, 12),
		hash.slice(12, 16),
		hash.slice(16, 20),
		hash.slice(20, 32),
	].join("-");
}

/**
 * Ensure a Qdrant collection exists with the correct vector configuration.
 */
export async function ensureCollection(collectionName: string): Promise<void> {
	try {
		await client.getCollection(collectionName);
		// Collection already exists
	} catch {
		// Collection doesn't exist — create it
		await client.createCollection(collectionName, {
			vectors: {
				size: VECTOR_SIZE,
				distance: "Cosine",
			},
		});

		// Create payload indices for efficient filtering
		await client.createPayloadIndex(collectionName, {
			field_name: "projectPath",
			field_schema: "keyword",
		});
		await client.createPayloadIndex(collectionName, {
			field_name: "filePath",
			field_schema: "keyword",
		});
		await client.createPayloadIndex(collectionName, {
			field_name: "chunkType",
			field_schema: "keyword",
		});
		await client.createPayloadIndex(collectionName, {
			field_name: "fileExtension",
			field_schema: "keyword",
		});
	}
}

/**
 * Delete all points in a collection (full re-index).
 */
export async function clearCollection(collectionName: string): Promise<void> {
	try {
		await client.deleteCollection(collectionName);
	} catch {
		// Collection might not exist — that's fine
	}
}

/**
 * Upsert chunk points into a Qdrant collection.
 */
export async function upsertChunks(
	collectionName: string,
	chunks: ChunkWithEmbedding[],
): Promise<void> {
	const BATCH_SIZE = 100;

	for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
		const batch = chunks.slice(i, i + BATCH_SIZE);
		const points = batch.map((chunk) => ({
			id: chunkPointId(chunk.absolutePath, chunk.chunkType, chunk.name, chunk.startLine, chunk.endLine),
			vector: chunk.embedding,
			payload: {
				filePath: chunk.filePath,
				absolutePath: chunk.absolutePath,
				projectPath: chunk.projectPath,
				fileExtension: path.extname(chunk.filePath).slice(1).toLowerCase(),
				codeChunk: chunk.codeChunk,
				chunkType: chunk.chunkType,
				name: chunk.name,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
			},
		}));
		await client.upsert(collectionName, { points });
	}
}

/**
 * Store collection metadata as a reserved point.
 */
export async function storeMetadata(
	collectionName: string,
	projectPath: string,
	fileCount: number,
	manifest?: ProjectManifest,
): Promise<void> {
	await client.upsert(collectionName, {
		points: [
			{
				id: METADATA_POINT_ID,
				vector: new Array(VECTOR_SIZE).fill(0), // Zero vector — not used for search
				payload: {
					type: "metadata",
					projectPath,
					indexedAt: new Date().toISOString(),
					fileCount,
					...(manifest ? { manifest } : {}),
				},
			},
		],
	});
}

/**
 * Retrieve the stored per-file manifest for a project (from its metadata point),
 * resolving via the project's alias. Returns null when absent.
 */
export async function getProjectManifest(projectPath: string): Promise<ProjectManifest | null> {
	const alias = projectCollectionName(projectPath);
	try {
		const points = await client.retrieve(alias, {
			ids: [METADATA_POINT_ID],
			with_payload: true,
		});
		if (points.length === 0) return null;
		const payload = points[0].payload as Record<string, unknown> | null;
		const manifest = payload?.manifest;
		if (manifest && typeof manifest === "object" && !Array.isArray(manifest)) {
			return manifest as ProjectManifest;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Search for similar chunks in a collection.
 */
export async function searchChunks(
	collectionName: string,
	queryVector: number[],
	limit: number,
	filters?: SearchFilters,
): Promise<SearchResult[]> {
	const must: Array<Record<string, unknown>> = [];

	if (filters?.chunkTypes?.length) {
		must.push({
			key: "chunkType",
			match: { any: filters.chunkTypes },
		});
	}

	if (filters?.fileTypes?.length) {
		must.push({
			key: "fileExtension",
			match: { any: filters.fileTypes },
		});
	}

	const results = await client.search(collectionName, {
		vector: queryVector,
		limit,
		score_threshold: 0.3,
		with_payload: true,
		filter: {
			...(must.length > 0 ? { must } : {}),
			must_not: [
				{
					key: "type",
					match: { value: "metadata" },
				},
			],
		},
	});

	return results.map((r) => ({
		score: r.score,
		payload: r.payload as unknown as ChunkPayload,
	}));
}

/**
 * Generate a timestamped physical collection name for atomic swap.
 */
export function physicalCollectionName(aliasName: string): string {
	return `${aliasName}-${Date.now()}`;
}

/**
 * Atomically swap alias to point to new collection, cleaning up the old one.
 */
export async function atomicSwapCollection(aliasName: string, newPhysicalName: string): Promise<void> {
	type AliasOp =
		| { create_alias: { collection_name: string; alias_name: string } }
		| { delete_alias: { alias_name: string } };

	const actions: AliasOp[] = [];
	let oldPhysicalName: string | null = null;

	// Find existing alias mapping
	try {
		const { aliases } = await client.getAliases();
		const existing = aliases.find((a) => a.alias_name === aliasName);
		if (existing) {
			oldPhysicalName = existing.collection_name;
			actions.push({ delete_alias: { alias_name: aliasName } });
		}
	} catch {
		// No aliases exist
	}

	// If no alias exists, check for a legacy direct collection
	if (!oldPhysicalName) {
		try {
			await client.getCollection(aliasName);
			// Direct collection exists — delete it to free the name for aliasing
			await client.deleteCollection(aliasName);
		} catch {
			// No legacy collection
		}
	}

	// Create alias pointing to new collection
	actions.push({ create_alias: { collection_name: newPhysicalName, alias_name: aliasName } });
	await client.updateCollectionAliases({ actions });

	// Clean up old physical collection
	if (oldPhysicalName) {
		try {
			await client.deleteCollection(oldPhysicalName);
		} catch {
			// Best effort
		}
	}
}

/**
 * List all tc-* collections and their metadata.
 * Supports both alias-based (new) and direct (legacy) collections.
 */
export async function listCollections(): Promise<CollectionInfo[]> {
	// Get alias-based collections
	const aliasedNames = new Set<string>();
	try {
		const { aliases } = await client.getAliases();
		for (const a of aliases) {
			if (a.alias_name.startsWith("tc-")) {
				aliasedNames.add(a.alias_name);
			}
		}
	} catch {
		// Alias API not available or no aliases
	}

	// Also find legacy direct collections (tc-{16hex} without timestamp suffix)
	const { collections } = await client.getCollections();
	for (const col of collections) {
		if (col.name.startsWith("tc-") && !col.name.match(/^tc-[a-f0-9]{16}-\d+$/)) {
			aliasedNames.add(col.name);
		}
	}

	const infos: CollectionInfo[] = [];
	for (const name of aliasedNames) {
		try {
			const colInfo = await client.getCollection(name);
			const pointCount = colInfo.points_count ?? 0;

			// Try to retrieve metadata point
			let projectPath = "(unknown)";
			let indexedAt = "";
			let fileCount = 0;
			try {
				const metaPoints = await client.retrieve(name, {
					ids: [METADATA_POINT_ID],
					with_payload: true,
				});
				if (metaPoints.length > 0) {
					const payload = metaPoints[0].payload as Record<string, unknown>;
					projectPath = (payload.projectPath as string) ?? projectPath;
					indexedAt = (payload.indexedAt as string) ?? "";
					fileCount = (payload.fileCount as number) ?? 0;
				}
			} catch {
				// No metadata point — use defaults
			}

			infos.push({
				collectionName: name,
				projectPath,
				pointCount,
				indexedAt,
				fileCount,
			});
		} catch {
			// Skip inaccessible
		}
	}

	return infos;
}
