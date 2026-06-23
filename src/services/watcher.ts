import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import type { Stats } from "node:fs";
import { listCollections, getProjectManifest } from "./qdrantStore.js";
import { scanForTwincatFiles } from "../utils/fileScanner.js";
import { TWINCAT_EXTENSIONS } from "../utils/constants.js";

/**
 * W1 auto-reindex file watcher.
 *
 * Watches each indexed TwinCAT project folder and, when source files change,
 * re-runs the full project index (handleIndex) after a debounce. handleIndex
 * builds a temp Qdrant collection and atomic-swaps the alias, so search is
 * never offline during a reindex. See WATCHER.md for the design and the W2
 * (incremental) follow-up plan.
 *
 * Lifecycle: runs for the life of the MCP process (= the client session).
 * Config (env): TWINCAT_WATCH=0 disables it; TWINCAT_WATCH_DEBOUNCE_MS sets the
 * settle window (default 20000, 0 = no debounce); TWINCAT_WATCH_STARTUP_REINDEX=0
 * skips the boot-time "reindex if changed since last index" catch-up.
 */

type ReindexFn = (args: { path: string }) => Promise<string>;

// Minimal structural type for the bits of the chokidar watcher we use.
interface ChokidarWatcher {
	on(event: string, cb: (...args: unknown[]) => void): ChokidarWatcher;
	close(): Promise<void>;
}

const IGNORE_DIR_SEGMENTS = ["_Build", "_CompileInfo", "node_modules", ".git", ".vs", ".twincat-index"];
const TWINCAT_EXT_SET = new Set(TWINCAT_EXTENSIONS.map((e) => e.toLowerCase()));

// Parse the debounce; allow 0 (no debounce) but reject negative/NaN, which would
// otherwise produce setTimeout(<0) that fires immediately and defeats debouncing.
const _debounceRaw = Number.parseInt(process.env.TWINCAT_WATCH_DEBOUNCE_MS ?? "", 10);
const DEBOUNCE_MS = Number.isFinite(_debounceRaw) && _debounceRaw >= 0 ? _debounceRaw : 20000;

interface ProjectWatchState {
	watcher: ChokidarWatcher | null;
	timer: NodeJS.Timeout | null;
	running: boolean;
	pending: boolean;
}

const watched = new Map<string, ProjectWatchState>(); // key: resolved project path
let reindexFn: ReindexFn | null = null;

/** All logs MUST go to stderr — stdout is the MCP JSON-RPC channel. */
function log(msg: string): void {
	console.error(`[watcher] ${msg}`);
}

function disabled(): boolean {
	return process.env.TWINCAT_WATCH === "0";
}

function normalize(p: string): string {
	return path.resolve(p);
}

/**
 * Ignore build/vcs dirs and any non-TwinCAT *file*. Never ignore directories
 * (so chokidar can recurse). When chokidar omits stats, fall back to the path's
 * extension: a path with a non-TwinCAT extension is treated as a file to ignore,
 * while an extensionless path (likely a directory) is kept.
 */
function isIgnored(p: string, stats?: Stats): boolean {
	const segs = p.split(/[\\/]/);
	if (segs.some((s) => IGNORE_DIR_SEGMENTS.includes(s))) return true;
	const ext = path.extname(p).slice(1).toLowerCase();
	if (stats?.isFile()) return !TWINCAT_EXT_SET.has(ext);
	if (!stats && ext) return !TWINCAT_EXT_SET.has(ext);
	return false;
}

function scheduleReindex(key: string): void {
	const st = watched.get(key);
	if (!st) return;
	// A reindex is already in flight — queue exactly one trailing pass instead of
	// churning a timer that would only set `pending` when it fires.
	if (st.running) {
		if (st.timer) {
			clearTimeout(st.timer);
			st.timer = null;
		}
		st.pending = true;
		return;
	}
	if (st.timer) clearTimeout(st.timer);
	st.timer = setTimeout(() => {
		st.timer = null;
		void runReindex(key);
	}, DEBOUNCE_MS);
}

async function runReindex(key: string): Promise<void> {
	const st = watched.get(key);
	if (!st || !reindexFn) return;
	if (st.running) {
		st.pending = true;
		return;
	}
	st.running = true;
	try {
		log(`reindexing ${key} ...`);
		const result = await reindexFn({ path: key });
		const firstLine = (result ?? "").split("\n")[0] ?? "";
		log(`reindexed ${key}: ${firstLine}`);
	} catch (err) {
		log(`reindex failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		st.running = false;
		if (st.pending) {
			st.pending = false;
			scheduleReindex(key);
		}
	}
}

/**
 * Start watching a project folder for changes. Idempotent; no-op when already
 * watching or when TWINCAT_WATCH=0. chokidar is imported dynamically so a
 * missing/broken dependency degrades gracefully instead of crashing the server.
 */
export async function watchProject(projectPath: string): Promise<void> {
	if (disabled()) return;
	const key = normalize(projectPath);
	if (watched.has(key)) return;
	// Reserve the slot up front so concurrent calls don't double-watch.
	watched.set(key, { watcher: null, timer: null, running: false, pending: false });

	let watch: (paths: string, opts?: Record<string, unknown>) => ChokidarWatcher;
	try {
		({ watch } = (await import("chokidar")) as unknown as {
			watch: (paths: string, opts?: Record<string, unknown>) => ChokidarWatcher;
		});
	} catch (err) {
		watched.delete(key);
		log(`chokidar unavailable, not watching ${key}: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	try {
		const w = watch(key, {
			ignored: (p: string, stats?: Stats) => isIgnored(p, stats),
			ignoreInitial: true,
			persistent: true,
			awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
		});
		const st = watched.get(key);
		if (!st) {
			await w.close();
			return;
		}
		st.watcher = w;
		const onEvent = (filePath: unknown) => {
			if (typeof filePath !== "string") return;
			const ext = path.extname(filePath).slice(1).toLowerCase();
			if (!TWINCAT_EXT_SET.has(ext)) return; // only TwinCAT source triggers a reindex
			log(`change: ${path.relative(key, filePath)}`);
			scheduleReindex(key);
		};
		w.on("add", onEvent)
			.on("change", onEvent)
			.on("unlink", onEvent)
			.on("error", (e: unknown) => log(`watch error on ${key}: ${e instanceof Error ? e.message : String(e)}`));
		log(`watching ${key} (debounce ${DEBOUNCE_MS}ms)`);
	} catch (err) {
		watched.delete(key);
		log(`failed to watch ${key}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Start watchers for every already-indexed project. Best-effort: any failure is
 * logged and swallowed so the MCP server keeps running. Also performs an
 * optional startup catch-up reindex for projects changed while offline.
 */
export async function startWatchers(fn: ReindexFn): Promise<void> {
	if (disabled()) {
		log("disabled via TWINCAT_WATCH=0");
		return;
	}
	reindexFn = fn;

	let projectPaths: string[] = [];
	try {
		const cols = await listCollections();
		projectPaths = cols
			.filter((c) => c.projectPath && c.projectPath !== "(unknown)")
			.map((c) => c.projectPath);
	} catch (err) {
		log(`could not list indexed projects: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	if (projectPaths.length === 0) {
		log("no indexed projects yet — index one with twincat_index to start watching");
		return;
	}

	const startupReindex = process.env.TWINCAT_WATCH_STARTUP_REINDEX !== "0";
	for (const projectPath of projectPaths) {
		const key = normalize(projectPath);
		try {
			const s = await fs.stat(key);
			if (!s.isDirectory()) {
				log(`skip ${key} (not a directory)`);
				continue;
			}
		} catch {
			log(`skip ${key} (path no longer exists)`);
			continue;
		}
		await watchProject(key);
		if (startupReindex && (await isStale(key))) {
			log(`changed since last index — reindexing ${key} on startup`);
			void runReindex(key);
		}
	}
}

/**
 * A project is stale if its current files differ from the manifest stored at the
 * last index. Comparison is content-aware: size first (cheap), then mtime as a
 * fast "unchanged" path, and only a content hash when mtime moved but size is
 * unchanged — so a `git pull` that bumps mtimes without changing bytes does NOT
 * trigger a needless reindex. Also detects added and removed files.
 */
async function isStale(projectPath: string): Promise<boolean> {
	const manifest = await getProjectManifest(projectPath).catch(() => null);
	if (!manifest) return false; // no manifest (older index / no metadata) — live watcher still covers edits

	let files: string[];
	try {
		files = await scanForTwincatFiles(projectPath);
	} catch (err) {
		log(`staleness scan failed for ${projectPath}: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}

	const seen = new Set<string>();
	for (const f of files) {
		const rel = path.relative(projectPath, f).replace(/\\/g, "/");
		seen.add(rel);
		const entry = manifest[rel];
		if (!entry) {
			log(`new file: ${rel}`);
			return true;
		}
		let s: Stats;
		try {
			s = await fs.stat(f);
		} catch {
			continue; // unreadable — ignore
		}
		if (s.size !== entry.size) {
			log(`changed (size): ${rel}`);
			return true;
		}
		if (s.mtimeMs === entry.mtimeMs) continue; // fast path: untouched
		// mtime moved but size identical — confirm via content hash before reindexing.
		try {
			const content = await fs.readFile(f, "utf-8");
			const sha = crypto.createHash("sha256").update(content).digest("hex");
			if (sha !== entry.sha) {
				log(`changed (content): ${rel}`);
				return true;
			}
		} catch {
			continue;
		}
	}
	for (const rel of Object.keys(manifest)) {
		if (!seen.has(rel)) {
			log(`removed file: ${rel}`);
			return true;
		}
	}
	return false;
}

/** Stop watching one project: clear its debounce timer and close its watcher. */
export async function stopWatcher(projectPath: string): Promise<void> {
	const key = normalize(projectPath);
	const st = watched.get(key);
	if (!st) return;
	if (st.timer) {
		clearTimeout(st.timer);
		st.timer = null;
	}
	if (st.watcher) {
		try {
			await st.watcher.close();
		} catch {
			// best effort
		}
	}
	watched.delete(key);
}

/** Stop all watchers (graceful shutdown / tests). */
export async function stopWatchers(): Promise<void> {
	await Promise.all([...watched.keys()].map((k) => stopWatcher(k)));
}
