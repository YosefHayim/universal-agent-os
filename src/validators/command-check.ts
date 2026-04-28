import { spawn } from "node:child_process";

import { aggregateValidatorOutcomes, type ValidatorOutcome } from "./types.js";

export interface CommandValidatorSpec {
  id: string;
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
}

export async function runCommandValidators(specs: CommandValidatorSpec[]) {
  const outcomes: ValidatorOutcome[] = [];

  for (const spec of specs) {
    outcomes.push(await runCommandValidator(spec));
  }

  return aggregateValidatorOutcomes(outcomes);
}

async function runCommandValidator(spec: CommandValidatorSpec): Promise<ValidatorOutcome> {
  const result = await runProcess(spec);

  if (result.exitCode === 0) {
    return {
      id: `command:${spec.id}`,
      status: "passed",
    };
  }

  return {
    id: `command:${spec.id}`,
    status: "failed",
    message: `command failed with exit code ${result.exitCode}: ${trimOutput(result.stderr || result.stdout)}`,
  };
}

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runProcess(spec: CommandValidatorSpec): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, spec.timeoutMs ?? 30_000);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ exitCode: 1, stdout: "", stderr: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: signal ? `terminated by ${signal}` : Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function trimOutput(output: string): string {
  const trimmed = output.trim();
  return trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed;
}
