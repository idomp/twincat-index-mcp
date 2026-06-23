import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Cross-process advisory lock per TwinCAT project. Stops two MCP server
 * instances (e.g. Claude Code + VS Code Copilot) from reindexing the same
 * project at the same time and racing the Qdrant alias swap.
 *
 * Implementation: an exclusive lock file under the OS temp dir, keyed by a hash
 * of the resolved project path, holding {pid, host, ts}. A lock older than
 * TWINCAT_LOCK_TTL_MS (default 10 min) is treated as stale (crashed holder) and
 * may be stolen. Fails OPEN: if the lock infrastructure errors, a no-op lock is
 * returned so indexing is never blocked by lock problems.
 *
 * Correctness note: two processes that both observe a stale lock can both steal
 * and proceed to index. That is harmless because the irreversible step — the
 * alias swap in handleIndex — first calls isValid(), and only the process that
 * currently owns the lock file (matching pid + ts) performs the swap.
 */

const LOCK_DIR = path.join(os.tmpdir(), "twincat-index-locks");
const _ttlRaw = Number.parseInt(process.env.TWINCAT_LOCK_TTL_MS ?? "", 10);
const STALE_MS = Number.isFinite(_ttlRaw) && _ttlRaw > 0 ? _ttlRaw : 10 * 60 * 1000;

export interface ProjectLock {
	release(): Promise<void>;
	/** True while THIS process still owns the lock file (re-reads it; pid + ts). */
	isValid(): Promise<boolean>;
}

const NOOP_LOCK: ProjectLock = { release: async () => {}, isValid: async () => true };

function log(msg: string): void {
	console.error(`[lock] ${msg}`);
}

function lockPath(projectPath: string): string {
	const norm = path.resolve(projectPath).replace(/\\/g, "/").toLowerCase();
	const hash = crypto.createHash("sha256").update(norm).digest("hex").slice(0, 16);
	return path.join(LOCK_DIR, `${hash}.lock`);
}

async function tryCreate(file: string, payload: string): Promise<"ok" | "exists" | "error"> {
	try {
		const fd = await fsp.open(file, "wx"); // exclusive create — fails if it exists
		try {
			await fd.writeFile(payload);
		} finally {
			await fd.close();
		}
		return "ok";
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return "exists";
		return "error";
	}
}

function makeLock(file: string, myTs: number): ProjectLock {
	let released = false;
	const owns = async (): Promise<boolean> => {
		try {
			const raw = await fsp.readFile(file, "utf-8");
			const data = JSON.parse(raw) as { pid?: number; ts?: number };
			return data.pid === process.pid && data.ts === myTs;
		} catch {
			return false; // missing/corrupt — we no longer own it
		}
	};
	return {
		isValid: owns,
		release: async () => {
			if (released) return;
			released = true;
			// Only remove the lock if it is still ours — never delete a new owner's lock.
			if (await owns()) {
				await fsp.rm(file, { force: true }).catch(() => {});
			}
		},
	};
}

/**
 * Try to acquire the project lock. Returns a ProjectLock on success (the caller
 * MUST release it and SHOULD call isValid() before any irreversible step), or
 * null when another live process holds it (the caller should skip). Never throws.
 */
export async function acquireProjectLock(projectPath: string): Promise<ProjectLock | null> {
	const file = lockPath(projectPath);
	const myTs = Date.now();
	const payload = JSON.stringify({ pid: process.pid, host: os.hostname(), ts: myTs, project: path.resolve(projectPath) });

	try {
		await fsp.mkdir(LOCK_DIR, { recursive: true });
	} catch (err) {
		log(`lock dir unavailable, proceeding unlocked: ${err instanceof Error ? err.message : String(err)}`);
		return NOOP_LOCK;
	}

	const first = await tryCreate(file, payload);
	if (first === "ok") return makeLock(file, myTs);
	if (first === "error") {
		log(`lock create failed, proceeding unlocked: ${file}`);
		return NOOP_LOCK;
	}

	// Lock exists — is it stale?
	let stale = false;
	try {
		const raw = await fsp.readFile(file, "utf-8");
		const data = JSON.parse(raw) as { ts?: number };
		stale = Date.now() - (Number(data.ts) || 0) >= STALE_MS;
	} catch {
		stale = true; // unreadable/corrupt lock — treat as stale
	}
	if (!stale) return null; // held by a live owner — caller should skip

	// Steal the stale lock. (See "Correctness note" above: the pre-swap isValid()
	// check makes a double-steal harmless — at most one process swaps.)
	await fsp.rm(file, { force: true }).catch(() => {});
	const second = await tryCreate(file, payload);
	if (second === "ok") return makeLock(file, myTs);
	if (second === "exists") return null; // someone else grabbed it first
	log(`lock re-create failed after stale steal, proceeding unlocked: ${file}`);
	return NOOP_LOCK;
}
