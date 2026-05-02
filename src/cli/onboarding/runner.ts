import { confirm, input, select } from "@inquirer/prompts";
import { Controller } from "../../core/controller.js";
import { markOnboarded } from "./marker.js";
import { probeProviders, type ProbeResult } from "./providers.js";
import { CONCEPT_SLIDES, type Slide } from "./slides.js";

/**
 * Options accepted by the onboarding runner.
 *
 * `skipHandson` is exposed so users who only want concepts can avoid
 * the live task spawn. `autoTriggered` lets the runner soften copy
 * when we launched it ourselves on first run instead of an explicit
 * `agent-os onboarding` invocation.
 */
export interface OnboardingOptions {
  skipHandson?: boolean;
  autoTriggered?: boolean;
}

const BANNER = [
  "",
  "   █████╗  ██████╗ ███████╗███╗   ██╗████████╗   ██████╗ ███████╗",
  "  ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝  ██╔═══██╗██╔════╝",
  "  ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║     ██║   ██║███████╗",
  "  ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║     ██║   ██║╚════██║",
  "  ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║     ╚██████╔╝███████║",
  "  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝      ╚═════╝ ╚══════╝",
  "",
  "  Local controller for cloud coding agents.  🚀",
  "",
].join("\n");

/** Top-level orchestration of the walkthrough. */
export async function runOnboarding(options: OnboardingOptions = {}): Promise<void> {
  printWelcome(options.autoTriggered ?? false);
  await pause("Press Enter to begin");

  await runProviderCheck();

  for (const slide of CONCEPT_SLIDES) {
    printSlide(slide);
    await pause("Press Enter for the next slide");
  }

  if (!options.skipHandson) {
    await runHandsOn();
  } else {
    console.log("\nSkipping the hands-on demo (--skip-handson).\n");
  }

  printWrapUp();
  await markOnboarded();
}

function printWelcome(autoTriggered: boolean): void {
  console.log(BANNER);
  if (autoTriggered) {
    console.log("Looks like this is your first run — quick tour first, then you're off to the races.\n");
  }
  console.log(
    "Agent OS turns your top-level agent into an orchestrator: you describe the goal, ",
  );
  console.log(
    "isolated provider workers do the editing, and you review captured diffs before anything lands.",
  );
  console.log("Your main context stays clean. Workers do the heavy lifting.\n");
}

async function runProviderCheck(): Promise<void> {
  console.log("Scanning your PATH for known provider CLIs...\n");
  const results = await probeProviders();
  for (const result of results) {
    const mark = result.found ? "[ok]   " : "[miss] ";
    console.log(`  ${mark}${result.probe.id.padEnd(10)} ${result.probe.blurb}`);
  }
  console.log("");

  const detected = results.filter((entry) => entry.found);
  if (detected.length === 0) {
    console.log("No provider CLIs detected. You can still run with `--provider manual` for dry runs.");
    await maybeOpenDocs(results);
  } else {
    console.log(`Found ${detected.length} provider CLI(s). You can use any of them with \`agent-os task run --provider <id>\`.`);
  }
  console.log("");
  await pause("Press Enter to continue");
}

async function maybeOpenDocs(results: ProbeResult[]): Promise<void> {
  const wantsDocs = await confirm({ message: "Show docs links for the providers we did not find?", default: true });
  if (!wantsDocs) return;
  for (const entry of results.filter((r) => !r.found)) {
    console.log(`  ${entry.probe.id.padEnd(10)} ${entry.probe.docsUrl}`);
  }
}

function printSlide(slide: Slide): void {
  console.log(`\n── ${slide.title} ──\n`);
  for (const paragraph of slide.body) {
    console.log(paragraph);
    console.log("");
  }
}

/**
 * Walk the user through a tiny manual-provider task so they see the
 * create -> run -> validate -> accept loop without spending tokens.
 *
 * We deliberately use `--provider manual` so this is free, offline,
 * and the captured diff is empty/visible — perfect for a tour.
 */
async function runHandsOn(): Promise<void> {
  console.log("\n── Hands-on: your first task ──\n");
  console.log("We'll create a tiny no-op task with the `manual` provider so nothing real runs.");
  const ready = await confirm({ message: "Ready to spawn the demo task?", default: true });
  if (!ready) {
    console.log("Skipping the demo. You can run it later with `agent-os onboarding`.");
    return;
  }

  const goal = await input({
    message: "Goal for the demo task:",
    default: "say hello from a manual worker",
  });

  const controller = new Controller({ rootDir: process.cwd() });
  const created = await controller.taskCreate(goal, { allowedFiles: ["**/*"], risk: "low" });
  const taskId = String(created.id);
  console.log(`\nCreated task ${taskId}.`);
  console.log("Next steps you would normally run:");
  console.log(`  agent-os task run ${taskId} --provider manual`);
  console.log(`  agent-os task validate ${taskId}`);
  console.log(`  agent-os task diff ${taskId}`);
  console.log(`  agent-os task accept ${taskId}`);
  console.log("");

  const choice = await select({
    message: "What would you like to do now?",
    choices: [
      { name: "Just show me the task status and finish the tour", value: "status" },
      { name: "Finish the tour without running anything", value: "skip" },
    ],
  });
  if (choice === "status") {
    const status = await controller.taskStatus(taskId);
    console.log(JSON.stringify(status, null, 2));
  }
}

function printWrapUp(): void {
  console.log("\n── You're set ──\n");
  console.log("Suggested next steps:");
  console.log("  agent-os guide              short runbook");
  console.log("  agent-os                    interactive TUI");
  console.log("  agent-os providers status   live provider health");
  console.log("  agent-os onboarding         re-run this tour any time");
  console.log("");
  console.log("Docs: https://github.com/YosefHayim/universal-agent-os");
  console.log("");
}

/** Inquirer's `input` doubles as a press-to-continue prompt. */
async function pause(message: string): Promise<void> {
  await input({ message, default: "" });
}
