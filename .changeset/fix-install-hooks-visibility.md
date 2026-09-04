---
"@itsacoyote/katra": patch
---

Fix `install-hooks` reporting "shared with your team" for a target that git ignores, and document guard's tool-scope limit. In a repo whose `.gitignore` excludes `.claude/` (or `.codex/`), `install-hooks` wrote the settings file successfully but claimed it was committed and team-shared — the hooks fire locally, but nothing is committable. The install report now detects a gitignored target (best-effort `git check-ignore`) and says so instead, and `--json` carries an `ignored` field with the real visibility. Separately, `AGENTS.md` and the F11 traceability now record a known limit surfaced by live use: guard's `PreToolUse` matcher covers the file-editing tools (`Edit`/`Write`/`NotebookEdit`; `apply_patch` on Codex), so a file change routed through the Bash tool (`echo >`, `sed -i`, `tee`) is not guarded — inherent to tool-matched enforcement, with the practical guidance being to edit through the Write/Edit tools in a guarded repo.
