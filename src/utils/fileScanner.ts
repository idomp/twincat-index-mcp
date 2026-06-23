import fg from "fast-glob";
import { TWINCAT_GLOB, IGNORE_PATTERNS } from "./constants.js";

/**
 * Scan a directory recursively for TwinCAT source files.
 * Returns absolute paths to all matched files.
 */
export async function scanForTwincatFiles(rootPath: string): Promise<string[]> {
	return fg(TWINCAT_GLOB, {
		cwd: rootPath,
		absolute: true,
		caseSensitiveMatch: false, // TwinCAT uses mixed-case extensions
		ignore: IGNORE_PATTERNS,
	});
}

export interface FileManifestEntry {
	size: number;
	mtimeMs: number;
	sha: string;
}

/**
 * Per-file fingerprint keyed by project-relative posix path. Built during
 * indexing (in indexTool, from the exact bytes embedded) and compared on startup
 * to decide whether a reindex is actually needed (content-aware staleness).
 */
export type ProjectManifest = Record<string, FileManifestEntry>;
