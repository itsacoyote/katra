/**
 * Reading a bounded, untrusted export file from disk.
 *
 * Lifted out of `cli/commands/migrate.ts` (F10 T3, `katra-9aw.67.3`) so
 * `snapshot/restore.ts` can reuse the same stat-first, size-capped,
 * ENOENT/EACCES-aware reading discipline without core importing from the CLI
 * layer — a boundary this codebase never crosses in the other direction.
 *
 * Every piece of wording below is a caller-supplied option rather than a
 * literal, because migrate's beads-flavoured refusals ("run `bd export
 * ...`", "--from needs a bd export...") must survive this lift byte for
 * byte — migrate.ts's own tests, untouched by this change, are the check
 * that they did. Restore passes its own snapshot-flavoured wording and a
 * much larger `maxBytes`: a growing, append-only events table needs
 * headroom a beads-sized cap was never meant to give it.
 */

import { readFileSync, statSync } from "node:fs";
import { KatraException } from "../errors.js";

export interface ReadBoundedExportFileOptions {
  /** The structured `field` every refusal's `KatraException` carries. */
  readonly field: string;
  /** Hard ceiling on the file's size, refused before the file is read at all. */
  readonly maxBytes: number;
  /**
   * The ENOENT refusal's text after "no " — e.g. migrate's own `beads
   * export at <path> — run \`bd export -o <path>\` to create one, or point
   * --from at an existing export`. A function of the resolved path, since a
   * remedy may need to repeat it (migrate's does, inside a shell command
   * example).
   */
  readonly notFoundHint: (path: string) => string;
  /** Named in the "not a regular file" refusal: "`${flagLabel}` needs `${kindHint}`". */
  readonly kindHint: string;
  /** The flag or argument named in the stat/read/not-a-regular-file prose ("--from", "the snapshot file", …). */
  readonly flagLabel: string;
  /** What reads this file, named in the over-the-limit refusal ("katra migrate beads", "katra restore", …). */
  readonly readerHint: string;
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Stats and reads a bounded export file, refusing a missing file, a
 * non-regular file (fifo, device, directory — reading one of those could
 * otherwise hang forever or reach `readFileSync` as an opaque `EISDIR`
 * `internal` fault), or one over `options.maxBytes`.
 *
 * Every refusal is scoped to `options.field` and never echoes file content —
 * only the path, byte counts, and the caller's own fixed wording ever reach
 * a message.
 */
export function readBoundedExportFile(path: string, options: ReadBoundedExportFileOptions): string {
  const { field, maxBytes, notFoundHint, kindHint, flagLabel, readerHint } = options;

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new KatraException({
        code: "not_found",
        message: `no ${notFoundHint(path)}`,
        id: path,
      });
    }
    // Anything other than "does not exist" — permission denied, a broken
    // symlink, an I/O error — is a distinct refusal that names the errno
    // rather than being folded into the same "go create one" hint.
    throw new KatraException({
      code: "validation",
      message: `could not stat ${flagLabel} ${path}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
      field,
      value: path,
    });
  }

  if (!stats.isFile()) {
    throw new KatraException({
      code: "validation",
      message: `${path} is not a regular file — ${flagLabel} needs ${kindHint}`,
      field,
      value: path,
    });
  }

  if (stats.size > maxBytes) {
    throw new KatraException({
      code: "validation",
      message: `${path} is ${mib(stats.size)} — over the ${mib(maxBytes)} limit ${readerHint} reads at once`,
      field,
      value: stats.size,
    });
  }

  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    // Stat succeeding proves the path exists and is a regular file, but not
    // that this process can read it — a mode-000 file (or a permission
    // change between the stat and this read) would otherwise let an EACCES
    // escape as an unhandled fault (exit 4, "katra broke") for what is
    // really a user-fixable permissions problem.
    throw new KatraException({
      code: "validation",
      message: `could not read ${flagLabel} ${path}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
      field,
      value: path,
    });
  }
}
