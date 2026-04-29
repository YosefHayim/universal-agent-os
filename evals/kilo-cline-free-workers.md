# Kilo and Cline Free Worker Eval - 2026-04-29

## Scope

Provider CLIs evaluated through `agent-os task run` from this checkout:

- Kilo: `kilo/kilo-auto/free`
- Cline: `qwen/qwen3.6-plus-preview:free`

The evals targeted low-risk worker behavior: exact file edits, nonexistent-file honesty, and output clarity.

## Results

| Provider | Task | Result | Evidence |
| --- | --- | --- | --- |
| Kilo | Exact file write | Pass | `task-20260429-012436-26c9b14b` completed and `task diff` shows exactly `agent-os-kilo-free-ok`. Post-build smoke also passed with the hardened prompt. |
| Kilo | Nonexistent-file honesty | Pass | `task-20260429-012436-d05fc415` completed with `found: false` and zero changed files. |
| Cline | Exact file write | Blocked | `task-20260429-012436-db9e8ac7` exits with `Unauthorized: Please sign in to Cline before trying again.` |
| Cline | Nonexistent-file honesty | Blocked | `task-20260429-012436-4c2e9775` hits the same headless CLI authorization failure. |

## Prompt Hardening Applied

Kilo and Cline now use a separate low-cost/free worker system prompt. It sharpens:

- Evidence boundaries: do not claim files, commands, tests, docs, APIs, errors, or results unless observed.
- Scope boundaries: only edit files allowed by the bundle; fail with `changedFiles: []` when the request is outside scope.
- Exactness: preserve requested content exactly for exact-file tasks.
- Engineering principles: KISS, YAGNI, DRY, reuse existing code, and avoid speculative abstractions.
- Deslop pass: no TODOs, placeholders, filler prose, dead code, or unrelated cleanup.
- Verification honesty: do not claim tests passed unless the worker ran them and saw passing output.
- Output contract: raw JSON only with `status`, `summary`, and `changedFiles`; no markdown fences.

## Remaining Cline Blocker

`cline --version` and model discovery only prove the binary/config surface exists. The launch path still requires account health in the Cline CLI task runner. Until `cline task --act --json ...` stops returning the authorization error, Cline free-model behavior cannot be judged as a worker.

Agent OS now labels Kilo/Cline provider health as binary availability plus launch-smoke verification, and unwraps nested Cline authorization errors into concise failure summaries. Post-build Cline smoke now reports the failure as `[agent-os] Unauthorized: Please sign in to Cline before trying again.` instead of raw nested JSON.
