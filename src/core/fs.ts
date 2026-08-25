/**
 * Atomic file writes — the one place katra writes a file to disk in a way
 * that must never leave a torn or partially-written result at the target
 * path.
 *
 * The write goes to a temp file in the SAME directory as the target — never
 * `os.tmpdir()`, since a rename across filesystems is not atomic — is
 * `fsync`ed before the rename (so the bytes are actually on disk, not just
 * the OS's write cache, before the rename that makes them visible), and is
 * renamed into place only once. A failure at any step cleans up the temp
 * file and leaves the target path exactly as it was: absent if this is the
 * first write, or holding the previous content if this is a repeat.
 * `renameSync` on one filesystem is POSIX's own atomic-replace primitive, so
 * no observer can ever see a torn or partially-written file at the target
 * path. (On win32, `renameSync` replaces via `MOVEFILE_REPLACE_EXISTING`
 * rather than POSIX `rename(2)` — already correct here, and it throws
 * `EPERM`/`EBUSY` instead of succeeding if the target is open elsewhere,
 * which this module's existing catch-and-cleanup already handles as an
 * ordinary failure.) **The durability claim is scoped to the data, not the
 * rename's own directory entry**: `fsyncSync` guarantees the temp file's
 * bytes are on disk before the rename, but the rename itself is not
 * separately synced — a power loss at the wrong instant can still lose the
 * rename, never the bytes. Either way the outcome is one of the two files
 * that were ever fully written: the previous content if the rename did not
 * survive, the new one if it did — never a torn file, because nothing was
 * ever written to the target path directly.
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * A temp file older than this is stranded, not in flight: no atomic write
 * stays open for an hour.
 */
const STALE_TEMP_AGE_MS = 60 * 60 * 1000;

/**
 * Sweeps this target's own stale temp files before writing a new one — a
 * `SIGKILL`-stranded temp from a run that never reached its own cleanup
 * (nothing runs a `finally` across a kill signal). Left behind, a stray temp
 * file sitting beside its target is noise the caller's own format never
 * meant to produce — and if the directory it lands in is tracked by git, one
 * `git add -A` away from being committed as such.
 *
 * **Age-gated by `STALE_TEMP_AGE_MS`, not swept on name match alone.** A
 * concurrent writer's own in-flight temp matches the identical prefix, and
 * unlinking it out from under that writer would not stop its already-open
 * file descriptor from finishing the write — POSIX keeps the inode alive
 * past an `unlink` — but it removes the directory entry that writer's own
 * `renameSync` needs, so that writer's rename throws `ENOENT` for a file it
 * just finished writing (reviewer-reproduced probe). Skipping anything
 * young enough to plausibly still be in flight is what keeps this sweep
 * from being the exact bug it exists to prevent.
 *
 * Best-effort per entry: a name that matches but is gone by the time this
 * calls `statSync`/`unlinkSync` (another process racing the identical
 * cleanup, or the age check above simply losing a race with that writer's
 * own rename) is not this call's problem to report.
 */
function sweepStaleTemp(dir: string, tempPrefix: string): void {
  const cutoff = Date.now() - STALE_TEMP_AGE_MS;
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith(tempPrefix)) continue;
    const entryPath = join(dir, entry);
    try {
      // Recent enough to plausibly still be in flight — unlinking it would
      // strand that writer's own rename on ENOENT (function docs above).
      if (statSync(entryPath).mtimeMs > cutoff) continue;
      unlinkSync(entryPath);
    } catch {
      // Raced or already gone — see the function docs above.
    }
  }
}

/**
 * Writes `content` to `outPath` atomically: a temp file beside the target,
 * `fsync`ed, then `renameSync`. Assumes `outPath`'s directory already
 * exists — the caller owns creating it, the same division `openStore`/
 * `store.ts` draws between "ensure the directory" and "write the file".
 *
 * Every failure path — the open, the write, the `fsync`, or the rename —
 * removes the temp file before rethrowing, so nothing observable is ever
 * left behind except the target path in whatever state it was already in.
 */
export function writeAtomic(outPath: string, content: string): void {
  const dir = dirname(outPath);
  const tempPrefix = `.${basename(outPath)}.tmp-`;

  sweepStaleTemp(dir, tempPrefix);

  const tempPath = join(
    dir,
    `${tempPrefix}${String(process.pid)}-${String(Date.now())}-${Math.random().toString(36).slice(2)}`,
  );

  try {
    const fd = openSync(tempPath, "w");
    try {
      writeFileSync(fd, content, "utf8");
      // fsync before rename, not after: the artifact's stated purpose is
      // surviving a dead machine, so its bytes must reach disk — not just
      // the OS's write cache — before the rename that makes them visible at
      // the target path.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, outPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup — openSync/writeFileSync themselves may have
      // failed before the temp file ever existed, in which case
      // unlinkSync's own ENOENT here is expected and not itself worth
      // surfacing over the original error.
    }
    throw error;
  }
}
