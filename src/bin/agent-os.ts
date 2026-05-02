#!/usr/bin/env node
import { createProgram } from "../cli/commands.js";
import { installSignalHandlers } from "../core/worker-cleanup.js";

async function main(): Promise<void> {
  installSignalHandlers();
  await createProgram().parseAsync(normalizeArgv(process.argv));
}

main().catch((error) => {
  console.error(`[agent-os] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

function normalizeArgv(argv: string[]): string[] {
  const [node, bin, first, ...rest] = argv;
  return first === "--" ? [node, bin, ...rest] : argv;
}
