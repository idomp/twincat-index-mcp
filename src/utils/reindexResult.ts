/**
 * Stable markers for reindex result strings that mean "another instance handled
 * (or is handling) this project, so this run did not write the index." The
 * watcher uses isDeferredReindex() to decide to retry instead of treating the
 * skip as a successful reindex. Kept in its own module so both indexTool and
 * watcher can import it without a circular dependency.
 */

export const LOCK_DEFERRED_NOTE = "Skipped — another process is already indexing";
export const LOCK_SUPERSEDED_NOTE = "Superseded — another process reindexed during this run";

/** True if a handleIndex result string means the work was deferred (lock held/lost). */
export function isDeferredReindex(result: string): boolean {
	return result.startsWith(LOCK_DEFERRED_NOTE) || result.startsWith(LOCK_SUPERSEDED_NOTE);
}
