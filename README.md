# Universal Agent OS

Standalone TypeScript controller for cloud coding agents.

## Quick Start For Agents

Run from the project you want to operate on:

```bash
agent-os guide
agent-os
```

The TUI path is:

1. Choose `Create + run task`.
2. Enter a literal task goal and an allowed file scope such as `src/**`.
3. Pick a provider and model. For Gemini, use `gemini-2.5-flash-lite` if the default `auto-gemini-3` route is capacity limited.
4. Watch `[universal-agent-os]` live run phases in the terminal.
5. Use `Task logs`, `Task status`, `Task diff`, and `Usage summary` after the run.
6. If a terminal or provider process exits mid-run, use `agent-os task recover` to reconcile running tasks from saved heartbeat/result artifacts.

Scripted flow:

```bash
task_id=$(agent-os task create "create src/example.txt with exactly this content: ok" --allowed-files "src/**" --risk low \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.parse(s).id))')

agent-os task run "$task_id" --provider gemini --model gemini-2.5-flash-lite
agent-os task validate "$task_id"
agent-os task diff "$task_id"
agent-os task recover "$task_id"
agent-os task logs "$task_id"
agent-os task pause "$task_id"
agent-os task resume "$task_id"
agent-os usage
agent-os upgrade
```

`agent-os task run` writes tagged progress to stderr while preserving the final JSON result on stdout. If a worker run is happening and no `[universal-agent-os]` tag appears, that caller is not using Agent OS for the context bundle and isolated worker handoff.

Direct CLI providers currently wired for worker launch:

- `manual`
- `codex`
- `claude`
- `zai`
- `gemini`
- `opencode`
- `kilo`
- `cline`

Cloud API catalog providers need credentials through `agent-os providers credentials` or the TUI `Provider API keys` menu.

Important behavior: providers edit an isolated worker copy. Agent OS saves a task-ranked context bundle before launch, uses file summaries when the byte budget is tight, captures diff, logs, validation, and token usage under `.agent-os/`, and announces those phases with the `[universal-agent-os]` tag; inspect the captured patch with `agent-os task diff <taskId>`.

## Worker completion notifications

Agent OS can notify external orchestrators when a worker or task finishes.

- **Configuration:** Notifications are configured in `.agent-os/config/notifications.json`. The default configuration is:
  ```json
  {
    "wakeFiles": true,
    "bell": true,
    "commands": []
  }
  ```
- **Wake Files:** If `wakeFiles` is `true`, a JSON file is written to `.agent-os/wakeups/<taskId>-<workerId>.json` upon worker completion. This file contains the event payload and a `finishedAt` timestamp.
- **Bell:** If `bell` is `true` and the terminal is TTY, the BEL character (`\u0007`) is written to stderr.
- **Commands:** Commands listed in the `commands` array are spawned as detached processes with environment variables `AGENT_OS_TASK_ID`, `AGENT_OS_WORKER_ID`, `AGENT_OS_PROVIDER`, `AGENT_OS_STATUS`, `AGENT_OS_DURATION_MS`, and `AGENT_OS_MESSAGE`.
- **Test Command:** Use `agent-os notifications test` to fire a synthetic notification and view the results.

Pause/recovery behavior: `agent-os task pause <taskId>` persists a paused task state and blocks accidental reruns until `agent-os task resume <taskId>` is called. `agent-os task recover [taskId]` scans running task heartbeats, restores completed/failed state when a worker `result.json` survived a controller crash, and marks stale running workers as `stale` with explicit resume/run commands in the JSON report.

Runtime metadata lives at `.agent-os/runtime.json`. Run `agent-os upgrade` after pulling a newer Agent OS release to apply local runtime migrations explicitly.

## Orchestrator edit guard

The orchestrator edit guard feature blocks direct file-mutating operations at the orchestrator level: Claude Edit/Write/MultiEdit/NotebookEdit, Codex apply_patch, and shell commands that directly write files. This ensures that file modifications are delegated to agent-os workers and subagents.

- **State file path:** The guard's state is stored in `$XDG_CONFIG_HOME/agent-os/orchestrator-block.json` (or `~/.config/agent-os/orchestrator-block.json`).
- **Default:** The guard is enabled by default.
- **CLI commands:** Use `agent-os orchestrator-guard {status,on,off,toggle}` to manage the guard.
- **Per-process bypass:** Set the environment variable `AGENT_OS_GUARD_BYPASS=1` to bypass the guard for a specific process.
- **Hook script:** A matching hook script is available in `universal-agent-toolkit/hooks/orchestrator-edit-guard.sh`.

## Development

```bash
pnpm install
pnpm exec tsx src/bin/agent-os.ts doctor
pnpm test
pnpm run build
```

The implementation plan lives in `plan.md`.
