/**
 * Concept slides shown during onboarding.
 *
 * Each slide is a small, self-contained block of copy. Keeping them as
 * data (not inline strings in the runner) means the user can iterate
 * on copy without touching control flow, and tests can assert against
 * the slide list directly.
 *
 * Copy here is a first scaffold pass — expect refinement before ship.
 */
export interface Slide {
  /** Short title rendered as a header. */
  title: string;
  /** Body paragraphs rendered with blank lines between them. */
  body: string[];
}

export const CONCEPT_SLIDES: Slide[] = [
  {
    title: "Orchestrator vs Worker",
    body: [
      "You (or your top-level agent) are the orchestrator: you describe the goal, set scope, and decide what to accept.",
      "Workers are isolated provider runs that actually edit code. Each worker gets a copy of the project, a budget, and a narrow allow-list of files.",
      "The split keeps your main context clean. The orchestrator never burns tokens on file edits — it delegates and reviews.",
    ],
  },
  {
    title: "Task lifecycle",
    body: [
      "Every change flows through four steps: create, run, validate, accept.",
      "create   defines the goal, allowed files, and risk level.",
      "run      spawns a worker with a chosen provider/model and captures the diff, logs, and usage.",
      "validate runs the project's checks against the captured diff.",
      "accept   records the decision. Reject and rollback are first-class too — nothing lands in your tree until you say so.",
    ],
  },
  {
    title: "Guard rails",
    body: [
      "Workers run inside an isolated worker copy of the repo, so a bad diff never touches your working tree.",
      "The orchestrator-guard blocks top-level Edit/Write/MultiEdit calls so you cannot accidentally bypass the worker flow.",
      "Validation runs against the captured diff before you accept. Risk levels (low / medium / high) tune how strict the validators are.",
    ],
  },
  {
    title: "Where data lives",
    body: [
      "Per-project runtime state lives in `.agent-os/` inside the target repo: tasks, queue, worker copies, and logs.",
      "User-level state (this onboarding marker, future prefs) lives in `~/.config/agent-os/`.",
      "Run `agent-os upgrade` after pulling a new release to migrate the per-project layout.",
    ],
  },
];
