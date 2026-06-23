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
 * may be stolen. Fails OPEN: if the lock infrastructure itself errors, a no-op
 * lock is returned so indexing is never blocked by lock problems.
 */

const LOCK_DIR = path.join(os.tmpdir(), "twincat-index-locks");
const _ttlRaw = Number.parseInt(process.env.TWINCAT_LOCK_TTL_MS ?? "", 10);
const STALE_MS = Number.isFinite(_ttlRaw) && _ttlRaw > 0 ? _ttlRaw : 10 * 60 * 1000;

export interface ProjectLock {
	release(): Promise<void>;
}

const NOOP_LOCK: ProjectLock = { release: async () => {} };

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

function ownedLock(file: string): ProjectLock {
	let released = false;
	return {
		release: async () => {
			if (released) return;
			released = true;
			try {
				const raw = await fsp.readFile(file, "utf-8");
				const data = JSON.parse(raw) as { pid?: number };
				// Only delete if it's still ours — never remove another process's lock.
				if (data.pid === process.pid) {
					await fsp.rm(file, { force: true });
				}
			} catch {
				// Unreadable/corrupt — leave it; the TTL will reclaim it.
			}
		},
	};
}

/**
 * Try to acquire the project lock. Returns a ProjectLock on success (the caller
 * MUST release it), or null when another live process holds it (the caller
 * should skip). Never throws.
 */
export async function acquireProjectLock(projectPath: string): Promise<ProjectLock | null> {
	const file = lockPath(projectPath);
	const payload = JSON.stringify({
		pid: process.pid,
		host: os.hostname(),
		ts: Date.now(),
		project: path.resolve(projectPath),
	});

	try {
		await fsp.mkdir(LOCK_DIR, { recursive: true });
	} catch {
		return NOOP_LOCK; // can't create the lock dir — fail open
	}

	const first = await tryCreate(file, payload);
	if (first === "ok") return ownedLock(file);
	if (first === "error") return NOOP_LOCK; // unexpected FS error — fail open

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

	// Steal the stale lock.
	await fsp.rm(file, { force: true }).catch(() => {});
	const second = await tryCreate(file, payload);
	if (second === "ok") return ownedLock(file);
	if (second === "exists") return null; // someone else grabbed it first
	return NOOP_LOCK; // unexpected error — fail open
}
