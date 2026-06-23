import fg from "fast-glob";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
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

/** Per-file fingerprint keyed by project-relative posix path. */
export type ProjectManifest = Record<string, FileManifestEntry>;

/**
 * Build a content fingerprint of the project's TwinCAT files (size + mtime +
 * sha256 of UTF-8 content). Stored at index time and compared on startup to
 * decide whether a reindex is actually needed (content-aware staleness).
 */
export async function computeManifest(rootPath: string, files: string[]): Promise<ProjectManifest> {
	const manifest: ProjectManifest = {};
	for (const f of files) {
		try {
			const [s, content] = await Promise.all([fs.stat(f), fs.readFile(f, "utf-8")]);
			const rel = path.relative(rootPath, f).replace(/\\/g, "/");
			manifest[rel] = {
				size: s.size,
				mtimeMs: s.mtimeMs,
				sha: crypto.createHash("sha256").update(content).digest("hex"),
			};
		} catch {
			// unreadable file — skip (its absence counts as "changed" on next compare)
		}
	}
	return manifest;
}
