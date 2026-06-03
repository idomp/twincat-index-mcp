import { listCollections } from "../services/qdrantStore.js";

/**
 * List all indexed TwinCAT projects with stats.
 */
export async function handleStatus(): Promise<string> {
	const collections = await listCollections();

	if (collections.length === 0) {
		return "No indexed TwinCAT projects found. Use twincat_index to index a project directory.";
	}

	const rows = collections.map((c) => {
		const indexed = c.indexedAt ? new Date(c.indexedAt).toLocaleString() : "unknown";
		return [
			`📁 ${c.projectPath}`,
			`   Collection: ${c.collectionName}`,
			`   Files: ${c.fileCount} | Chunks: ${c.indexedAt ? Math.max(0, c.pointCount - 1) : c.pointCount}`,
			`   Indexed at: ${indexed}`,
		].join("\n");
	});

	return [`TwinCAT Indexing Status — ${collections.length} project(s)`, "", ...rows].join("\n");
}
