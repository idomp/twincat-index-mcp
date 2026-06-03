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
