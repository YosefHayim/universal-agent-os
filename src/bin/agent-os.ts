#!/usr/bin/env node
import { createProgram } from "../cli/commands.js";

async function main(): Promise<void> {
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
