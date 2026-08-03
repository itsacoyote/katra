#!/usr/bin/env node
/**
 * The `katra` binary.
 *
 * Deliberately almost empty: it hands `process.argv` to `run` and turns the
 * returned number into an exit status. Everything else — parsing, dispatch,
 * formatting, error mapping — lives in `src/cli/`, and all the logic lives in
 * `src/core/`.
 */

import { run } from "./cli/program.js";

process.exitCode = await run(process.argv.slice(2));
