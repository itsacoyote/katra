#!/usr/bin/env node
/**
 * katra — CLI entry point.
 *
 * Deliberately thin: parse args, call into the library core, format output.
 * No business logic belongs in this file.
 */

import { Command } from "commander";
import { describe, VERSION } from "./index.js";

const program = new Command();

program
  .name("katra")
  .description(describe())
  .version(VERSION, "-v, --version", "print the katra version");

program.parse();
