# Auto-reindex file watcher

`twincat-index` can watch your indexed project folders and re-index automatically
when source files change, so search results stay fresh without manually re-running
`twincat_index`. This mirrors the document watcher in the `knowledge-rag` MCP.

---

## W1 — debounced full reindex (IMPLEMENTED)

### What it does
- On startup the server reads the list of already-indexed projects via
  `listCollections()` (the same source `twincat_status` uses) and starts a
  [chokidar](https://github.com/paulmillr/chokidar) watcher on each project folder.
- It reacts only to TwinCAT source files
  (`.TcPOU .TcGVL .TcDUT .TcIO .st .TcVIS .TcTLO .TcGTLO .TcVMO`) and ignores
  `_Build/`, `_CompileInfo/`, `node_modules/`, `.git/`, `.vs/`, `.twincat-index/`.
- When files change it waits for edits to settle (debounce), then calls the
  existing `handleIndex()` for that project: full scan → embed → **atomic
  alias-swap**. Because the alias only flips once the new collection is durable,
  **search is never offline during a reindex**.
- Projects indexed during the session (`twincat_index`) are added to the watcher
  live — no restart needed.
- Optional startup catch-up: on boot, each project is compared against a per-file
  manifest (size + mtime + sha256) stored at index time; the project is reindexed
  once only if a file's content actually changed, or files were added/removed.
  This covers edits made while the MCP was not running, and a `git pull` that only
  bumps mtimes (without changing bytes) does **not** trigger a reindex.
- Cross-process safety: a per-project lock file (OS temp dir) prevents two server
  instances (e.g. Claude Code + VS Code Copilot) from reindexing the same project
  at once and racing the alias swap; the second instance skips with a log line.

### Lifecycle
The watcher runs for the life of the MCP process (= your editor/Claude Code
session), exactly like the knowledge-rag watcher. Closing the client stops it.

### Why full reindex (not incremental)?
The embedder is GPU-backed Ollama (`qwen3-embedding:8b`). On a GPU a full reindex
of a typical project is seconds, and the atomic swap means zero search downtime —
so the simplest, lowest-risk option (reuse the proven `handleIndex` path) is good
enough. See the decision note at the bottom.

### Config (environment variables)
| Variable | Default | Effect |
|---|---|---|
| `TWINCAT_WATCH` | on | Set `0` to disable the watcher entirely. |
| `TWINCAT_WATCH_DEBOUNCE_MS` | `20000` | Quiet period (ms) after the last change before a reindex fires. `0` = reindex immediately. |
| `TWINCAT_WATCH_STARTUP_REINDEX` | on | Set `0` to skip the boot-time "reindex if changed since last index" catch-up. |
| `TWINCAT_LOCK_TTL_MS` | `600000` | Age after which a project lock from a crashed instance is treated as stale and may be stolen. |

### Files
- `src/services/watcher.ts` — the watcher: boot list, ignore rules, debounce,
  re-entrancy guard, content-aware startup staleness check, `stopWatchers()`.
  chokidar is imported dynamically so a missing dependency degrades gracefully.
- `src/services/lock.ts` — per-project cross-process lock (OS temp lock file).
- `src/utils/fileScanner.ts` — `computeManifest()` (size + mtime + sha256 per file).
- `src/services/qdrantStore.ts` — stores the manifest in the metadata point and
  exposes `getProjectManifest()`.
- `src/index.ts` — calls `startWatchers(handleIndex)` after connect (non-blocking)
  and closes watchers on SIGINT/SIGTERM.
- `src/tools/indexTool.ts` — `handleIndex()` takes the project lock, then
  `indexProject()` does the work and stores the manifest; registers the watch live.

### Known limitations
- Full reindex re-embeds the **whole** project per change-burst, so cost grows
  with project size (fine for current projects; see W2 if they get large).
- Live changes are caught while the MCP process is running; offline edits are
  caught by the manifest-based startup catch-up.
- If the GPU is shared with local LLM inference, a reindex burst competes for it;
  the debounce keeps this to occasional short bursts.
- The per-file manifest is stored in the project's Qdrant metadata point, so that
  payload grows with file count (negligible for typical projects, ~tens of KB).

---

## W2 — incremental per-file reindex (PLANNED / OPTIONAL)

### Goal
Re-embed only the files that actually changed (and drop points for deleted files)
instead of the whole project. This is what makes the knowledge-rag watcher feel
instant, and it matters once a project grows large or the GPU is contended.

### Why deferred
With GPU Ollama, W1's full reindex is already fast (seconds) and the atomic swap
avoids downtime, so the extra code and risk aren't justified yet.

### Implementation sketch
1. **`qdrantStore.ts` — add `deletePointsByFilePath(collectionName, filePath)`**
   using Qdrant's filtered delete on the existing `filePath` keyword payload index:
   ```ts
   await client.delete(collectionName, {
     filter: { must: [{ key: "filePath", match: { value: filePath } }] },
   });
   ```
2. **Resolve the live (aliased) physical collection** for a project so we can write
   into the *current* collection instead of building a temp one. The alias name is
   `projectCollectionName(projectPath)`; resolve it via `getAliases()`.
3. **Add `reindexFiles(projectPath, changedRelPaths, deletedRelPaths)`** that:
   - for each deleted file → `deletePointsByFilePath`;
   - for each changed file → re-extract/parse/embed just that file's chunks →
     `deletePointsByFilePath` then `upsertChunks` into the live collection;
   - refresh the metadata point (`storeMetadata`) so `indexedAt` advances.
4. **`watcher.ts`** — collect per-event file paths (add/change/unlink) during the
   debounce window and call `reindexFiles(project, changed, deleted)` instead of the
   full `handleIndex`.

### Trade-offs
- Writes into the **live** collection (bypasses the safe build-then-swap), so a
  mid-write crash could leave a file partially indexed until the next full reindex.
- Chunk IDs are deterministic (`absolutePath:type:name:lines`), so renamed/removed
  symbols can leave orphan points unless we delete-by-`filePath` first (the sketch
  does this).
- Keep `twincat_index` (full rebuild + atomic swap) as the authoritative repair path.

### When to build W2
Projects grow into the thousands of chunks, edits are very frequent, or the
embedding GPU is shared and full reindexes cause noticeable contention.

---

## Decision note
**Chose W1 (2026-06-23).** GPU-backed Ollama makes full reindex fast and the atomic
alias-swap gives zero search downtime, so the minimal, low-risk path (reuse
`handleIndex`) delivers the auto-monitor behavior without touching the indexing or
storage internals. W2 (incremental) is documented above as a ready follow-up if
reindex cost ever becomes noticeable.

**Post-review hardening (2026-06-23).** After a Codex + GLM review, added: a
per-project cross-process lock (`lock.ts`) so duplicate client instances can't race
reindexes; content-aware startup staleness (per-file manifest) so a `git pull` no
longer triggers needless reindexes; `stopWatchers()` + SIGINT/SIGTERM shutdown; and
smaller fixes (debounce parse, ignore-on-undefined-stats, fire-and-forget `.catch`).
W2 (incremental per-file reindex) remains the open follow-up — the manifest now
stored at index time can drive it.
