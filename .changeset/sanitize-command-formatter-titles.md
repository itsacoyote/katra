---
"@itsacoyote/katra": patch
---

Sanitize stored titles and close-reasons in `delete`, `dep`, `close`, `cancel`, and `reopen` output. These command-local formatters previously rendered stored task titles (and the close reason) to the terminal without the control-character/bidi/zero-width sanitization every other command already applied, so a hostile title could inject an ANSI escape or forge a fake row via an embedded newline. `--json` output is unchanged. A meta-test now guards against the class recurring in any command-local formatter.
