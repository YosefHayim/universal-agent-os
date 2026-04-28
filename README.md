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
4. Watch live run phases in the terminal.
5. Use `Task logs`, `Task status`, `Task diff`, and `Usage summary` after the run.

Scripted flow:

```bash
task_id=$(agent-os task create "create src/example.txt with exactly this content: ok" --allowed-files "src/**" --risk low \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.parse(s).id))')

agent-os task run "$task_id" --provider gemini --model gemini-2.5-flash-lite
agent-os task validate "$task_id"
agent-os task diff "$task_id"
agent-os task logs "$task_id"
agent-os usage
```

Direct CLI providers currently wired for worker launch:

- `manual`
- `codex`
- `claude`
- `zai`
- `gemini`
- `opencode`

Cloud API catalog providers need credentials through `agent-os providers credentials` or the TUI `Provider API keys` menu.

Important behavior: providers edit an isolated worker copy. Agent OS captures diff, logs, validation, and token usage under `.agent-os/`; inspect the captured patch with `agent-os task diff <taskId>`.

## Development

```bash
pnpm install
pnpm exec tsx src/bin/agent-os.ts doctor
pnpm test
pnpm run build
```

The implementation plan lives in `plan.md`.
