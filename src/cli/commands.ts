import { Command } from "commander";
import { MissingModelRouteError } from "../routing/broker.js";
import { DEFAULT_PROVIDERS } from "../config/defaults.js";
import type { ProviderAvailability, ProviderId, RiskLevel } from "../core/types.js";
import { Controller } from "../core/controller.js";
import { printJson, printTable } from "./format.js";
import { runInteractive } from "./interactive.js";
import { writeAgentOsProgress } from "./progress.js";
import { notifyWorkerFinished } from "../core/notifications.js";
import { readGuardState, writeGuardState } from "../core/orchestrator-guard.js";
import { parseCsv } from "./prompts.js";
import { isFirstRun } from "./onboarding/marker.js";
import { runOnboarding } from "./onboarding/runner.js";

export function createProgram(): Command {
  const program = new Command();
  program.name("agent-os").description("Local TypeScript controller for cloud coding agents").version("0.1.0").showHelpAfterError();
  program.option("--json", "print JSON output");
  program.addHelpText("after", `

Fast path:
  agent-os guide
  agent-os
  agent-os task create "create src/example.txt with exactly this content: ok" --allowed-files "src/**" --risk low
  agent-os task run <taskId> --provider gemini --model gemini-2.5-flash-lite
  agent-os task validate <taskId>
  agent-os task logs <taskId>
  agent-os queue status
  agent-os usage
  agent-os upgrade
`);
  program.action(async () => {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      if (await isFirstRun()) {
        await runOnboarding({ autoTriggered: true });
        return;
      }
      await runInteractive();
      return;
    }
    program.outputHelp();
  });

  program.command("onboarding")
    .description("Interactive first-run walkthrough (orchestrator/worker model, providers, demo task)")
    .option("--skip-handson", "skip the live demo task and only show concepts")
    .action(async (opts: { skipHandson?: boolean }) => {
      await runOnboarding({ skipHandson: Boolean(opts.skipHandson) });
    });

  program.command("interactive").alias("ui").description("Open the interactive Agent OS terminal").action(async () => {
    await runInteractive();
  });
  program.command("watch")
    .description("Live cross-repo agent-os worker dashboard (Ink TUI)")
    .option("--task <taskId>", "filter to one task")
    .option("--interval <ms>", "poll interval ms", "1000")
    .option("--no-alt-screen", "render without alternate screen")
    .action(async (opts) => {
      const { runWatchTui } = await import("../tui/index.js");
      await runWatchTui({
        taskId: opts.task,
        intervalMs: Number(opts.interval) || 1000,
        altScreen: opts.altScreen !== false,
      });
    });


  program.command("doctor").description("Check runtime health").action(async () => {
    printJson(await controller(program).doctor());
  });

  program.command("status").description("Show Agent OS runtime status").action(async () => {
    printJson(await controller(program).status());
  });

  program.command("upgrade").description("Upgrade the project .agent-os runtime layout").action(async () => {
    printJson(await controller(program).upgrade());
  });

  program.command("usage").description("Show provider token usage summary").action(async () => {
    printJson(await controller(program).usageSummary());
  });

  program.command("guide").description("Print the short runbook for agents").action(() => {
    console.log(agentGuide());
  });

  program.command("notifications")
    .description("Test worker completion notifications")
    .command("test")
    .action(async () => {
      const paths = (new Controller({ rootDir: process.cwd() })).paths;
      const syntheticEvent = {
        taskId: "test",
        workerId: "test",
        provider: "manual",
        status: "completed",
        durationMs: 0,
        message: "notification test",
      };
      const result = await notifyWorkerFinished(
        { rootDir: paths.rootDir },
        syntheticEvent,
      );
      printJson({ ok: true, ...result });
    });

  const guard = program.command("orchestrator-guard").description("Block top-level Edit/Write/MultiEdit calls so file work is delegated to agent-os workers");
  guard.command("status").description("Show current guard state").action(async () => {
    printJson(await readGuardState());
  });
  guard.command("on").description("Enable the orchestrator edit guard").action(async () => {
    printJson(await writeGuardState(true));
  });
  guard.command("off").description("Disable the orchestrator edit guard").action(async () => {
    printJson(await writeGuardState(false));
  });
  guard.command("toggle").description("Flip the guard between on and off").action(async () => {
    const current = await readGuardState();
    printJson(await writeGuardState(!current.enabled));
  });

  addProviders(program);
  addModels(program);
  addQueue(program);
  addTasks(program);
  return program;
}

function addProviders(program: Command): void {
  const providers = program.command("providers").description("Provider status and overrides");
  providers.command("status").description("Show live provider health").action(async () => printJson(await controller(program).providersDoctor()));
  providers.command("doctor").action(async () => printJson(await controller(program).providersDoctor()));
  providers.command("overrides").description("Show persisted provider availability overrides").action(async () => printJson(await controller(program).providersStatus()));
  providers.command("credentials").description("Show configured provider API key sources without revealing secrets").action(async () => printJson(await controller(program).providerCredentials()));
  providers.command("clear-key").argument("<provider>", DEFAULT_PROVIDERS.join("|")).description("Remove a stored Agent OS provider API key").action(async (provider) => {
    printJson(await controller(program).clearProviderCredential(asProvider(provider)));
  });
  providers.command("set-status").argument("<provider>", DEFAULT_PROVIDERS.join("|")).argument("<availability>", "available|unavailable|limited|unknown").action(async (provider, availability) => {
    printJson(await controller(program).setProviderStatus(asProvider(provider), asAvailability(availability)));
  });
}

function addModels(program: Command): void {
  const models = program.command("models").description("Dynamic model catalog");
  models.command("refresh").description("Refresh dynamic provider model cache").option("--provider <provider>", "refresh one provider").action(async (opts) => printJson(await controller(program).modelsRefresh(opts.provider ? asProvider(opts.provider) : undefined)));
  models.command("list")
    .description("List cached models")
    .option("--provider <provider>", "filter by provider")
    .option("--free", "show free/free-quota models")
    .option("--paid", "show paid/subscription models")
    .option("--coding", "show coding-eligible models")
    .option("--stale", "include stale cache entries")
    .option("--json", "print raw JSON")
    .action(async (opts) => {
      const entries = await controller(program).modelsList({
        provider: opts.provider ? asProvider(opts.provider) : undefined,
        free: Boolean(opts.free),
        paid: Boolean(opts.paid),
        coding: Boolean(opts.coding),
        stale: Boolean(opts.stale),
      });
      if (opts.json || program.opts().json) {
        printJson(entries);
        return;
      }
      printTable(entries.map((entry) => ({
        provider: entry.provider,
        id: entry.id,
        cost: entry.costCategory,
        coding: entry.capabilities.coding ? "yes" : "no",
        gate: entry.codingGate.eligible ? entry.codingGate.smoke : entry.codingGate.reasons.join("; "),
        approval: entry.requiresApproval ? "yes" : "no",
      })));
    });
  models.command("doctor").description("Show model cache health").action(async () => printJson(await controller(program).modelsDoctor()));
}

function addQueue(program: Command): void {
  const queue = program.command("queue").description("Persisted task queue status and controls");
  queue.command("status").alias("list").description("Show persisted task queue").action(async () => {
    printJson(await controller(program).queueStatus());
  });
  queue.command("pause").description("Mark a queued task as paused").argument("[taskId]", "defaults to latest task").action(async (taskId) => {
    printJson(await controller(program).queuePause(taskId));
  });
  queue.command("resume").description("Mark a paused task ready to resume").argument("[taskId]", "defaults to latest task").action(async (taskId) => {
    printJson(await controller(program).queueResume(taskId));
  });
  queue.command("cancel").description("Cancel a queued task").argument("[taskId]", "defaults to latest task").action(async (taskId) => {
    printJson(await controller(program).queueCancel(taskId));
  });
}

function addTasks(program: Command): void {
  const task = program.command("task").description("Task lifecycle");
  task.command("create")
    .description("Create a task in the current project")
    .argument("<goal>", "literal task goal")
    .option("--allowed-files <csv>", "comma-separated edit scope such as src/**", "**/*")
    .option("--risk <risk>", "low|medium|high", "medium")
    .action(async (goal, opts) => {
    printJson(await controller(program).taskCreate(goal, { allowedFiles: parseCsv(opts.allowedFiles), risk: asRisk(opts.risk) }));
  });
  task.command("list").description("List recent tasks").action(async () => printJson(await controller(program).taskList()));
  task.command("status").description("Show one task state").argument("[taskId]", "defaults to latest task").action(async (taskId) => printJson(await controller(program).taskStatus(taskId)));
  task.command("events").alias("logs").description("Show persisted task event logs").argument("[taskId]", "defaults to latest task").action(async (taskId) => printJson(await controller(program).taskEvents(taskId)));
  task.command("plan").description("Show generated task plan").argument("[taskId]", "defaults to latest task").action(async (taskId) => printJson(await controller(program).taskPlan(taskId)));
  task.command("dry-run").description("Build context and launch preview without running provider").argument("[taskId]", "defaults to latest task").option("--provider <provider>", "provider id").option("--model <model>", "exact model id; direct CLIs allow uncached ids").action(async (taskId, opts) => {
    printJson(await controller(program).taskDryRun(taskId, opts.provider ? asProvider(opts.provider) : undefined, opts.model));
  });
  task.command("run").description("Run provider in an isolated worker copy and capture diff/logs/usage").argument("[taskId]", "defaults to latest task").option("--provider <provider>", "provider id", "manual").option("--model <model>", "exact model id; for Gemini prefer gemini-2.5-flash-lite if default is capacity limited").action(async (taskId, opts) => {
    try {
      printJson(await controller(program).taskRun(taskId, asProvider(opts.provider), opts.model, { onProgress: writeAgentOsProgress }));
    } catch (error) {
      if (error instanceof MissingModelRouteError) {
        console.error(`error: ${error.message}`);
        console.error(`hint: agent-os models list --provider ${error.provider}`);
        process.exit(2);
      }
      throw error;
    }
  });
  task.command("diff").description("Print captured worker diff").argument("[taskId]", "defaults to latest task").action(async (taskId) => console.log(await controller(program).taskDiff(taskId)));
  task.command("validate").description("Run validators on captured worker output").argument("[taskId]", "defaults to latest task").action(async (taskId) => printJson(await controller(program).taskValidate(taskId)));
  task.command("review").description("Create reviewer packet from diff/log evidence").argument("[taskId]", "defaults to latest task").action(async (taskId) => printJson(await controller(program).taskReview(taskId)));
  task.command("accept").description("Record accepted validation decision").argument("[taskId]", "defaults to latest task").action(async (taskId) => printJson(await controller(program).taskAccept(taskId)));
  task.command("reject").description("Record rejection").argument("[taskId]", "defaults to latest task").action(async (taskId) => printJson(await controller(program).taskReject(taskId)));
  task.command("pause").description("Pause a task until it is resumed").argument("[taskId]", "defaults to latest task").action(async (taskId) => printJson(await controller(program).taskPause(taskId)));
  task.command("cancel").description("Record cancellation").argument("[taskId]", "defaults to latest task").action(async (taskId) => printJson(await controller(program).taskCancel(taskId)));
  task.command("resume").description("Mark task ready to resume").argument("[taskId]", "defaults to latest task").action(async (taskId) => printJson(await controller(program).taskResume(taskId)));
  task.command("recover")
    .description("Scan running task heartbeats and restore completed or stale state")
    .argument("[taskId]", "scan all tasks when omitted")
    .option("--stale-after-ms <ms>", "milliseconds without heartbeat before stale", String(5 * 60 * 1000))
    .action(async (taskId, opts) => printJson(await controller(program).taskRecover(taskId, { staleAfterMs: parsePositiveInt(opts.staleAfterMs, "stale-after-ms") })));
  task.command("rollback").description("Record rollback intent; worker workspace remains for inspection").argument("[taskId]", "defaults to latest task").action(async (taskId) => printJson(await controller(program).taskRollback(taskId)));
}

function agentGuide(): string {
  return [
    "Agent OS quick runbook",
    "",
    "Use from the target project directory. Runtime files live under .agent-os/ in that project.",
    "",
    "Interactive path:",
    "  agent-os",
    "  choose Create + run task",
    "  pick provider/model",
    "  use Task logs and Usage summary after the run",
    "  live task runs print [universal-agent-os] progress to stderr; if the tag is absent, the caller is not using Agent OS",
    "",
    "Scripted path:",
    "  task_id=$(agent-os task create \"create src/example.txt with exactly this content: ok\" --allowed-files \"src/**\" --risk low | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d);process.stdin.on(\"end\",()=>console.log(JSON.parse(s).id))')",
    "  agent-os task run \"$task_id\" --provider gemini --model gemini-2.5-flash-lite",
    "  agent-os task validate \"$task_id\"",
    "  agent-os task diff \"$task_id\"",
    "  agent-os task logs \"$task_id\"",
    "  agent-os task recover \"$task_id\"",
    "  agent-os queue status",
    "  agent-os usage",
    "  agent-os upgrade",
    "",
    "Provider notes:",
    "  direct CLIs: manual, codex, claude, zai, gemini, opencode, kilo, cline",
    "  Gemini default can hit capacity on auto-gemini-3; use --model gemini-2.5-flash-lite when needed.",
    "  Cloud API providers need credentials: agent-os providers credentials, or the TUI Provider API keys menu.",
    "",
    "Important behavior:",
    "  Providers edit an isolated worker copy. Agent OS captures the diff, logs, validation, and usage.",
    "  The context bundle is ranked by task relevance, saves lower-ranked files as summaries when the byte budget is tight, and is announced in [universal-agent-os] progress output.",
    "  Use agent-os task pause <taskId>, agent-os task resume <taskId>, and agent-os task recover [taskId] to keep task progress recoverable across interrupted runs.",
    "  Runtime metadata lives in .agent-os/runtime.json; run agent-os upgrade after pulling a newer Agent OS release.",
    "  Inspect changes with agent-os task diff <taskId> and the worker path in task logs/status.",
  ].join("\n");
}

function controller(_program: Command): Controller {
  return new Controller({ rootDir: process.cwd() });
}

function asProvider(value: string): ProviderId {
  if ((DEFAULT_PROVIDERS as string[]).includes(value)) return value as ProviderId;
  throw new Error(`Unknown provider: ${value}`);
}

function asAvailability(value: string): ProviderAvailability {
  if (["available", "unavailable", "limited", "unknown"].includes(value)) return value as ProviderAvailability;
  throw new Error(`Unknown availability: ${value}`);
}

function asRisk(value: string): RiskLevel {
  if (["low", "medium", "high"].includes(value)) return value as RiskLevel;
  throw new Error(`Unknown risk: ${value}`);
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  throw new Error(`${label} must be a positive integer`);
}
