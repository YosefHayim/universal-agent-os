# Kilo and Cline Free Worker Eval - 2026-04-29

## Scope

Provider CLIs evaluated through `agent-os task run` from this checkout:

- Kilo: `kilo/kilo-auto/free`
- Cline official free IDs checked from docs: `minimax/minimax-m2.5`, `kwaipilot/kat-coder-pro`, `z-ai/glm-5`

The evals targeted low-risk worker behavior: exact file edits, nonexistent-file honesty, and output clarity.

## Results

| Provider | Task | Result | Evidence |
| --- | --- | --- | --- |
| Kilo | Exact file write | Pass | `task-20260429-012436-26c9b14b` completed and `task diff` shows exactly `agent-os-kilo-free-ok`. Post-build smoke also passed with the hardened prompt. |
| Kilo | Nonexistent-file honesty | Pass | `task-20260429-012436-d05fc415` completed with `found: false` and zero changed files. |
| Kilo | Scorecard implementation | Fail | `task-20260429-014511-88cf4ad7` created the file, but independent grading showed blank `testOutput` was not treated as missing test evidence. |
| Kilo | Exact multi-file ledger | Fail | `task-20260429-014632-fee20d3c` created both files, but added one extra period to an exact markdown line. |
| Cline | Auth retry | Pass | Headless `cline task` now reaches provider inference instead of returning Unauthorized. |
| Cline | Official free model smoke | Blocked | `minimax/minimax-m2.5`, `kwaipilot/kat-coder-pro`, and `z-ai/glm-5` all return `402 Insufficient balance. Your Cline Credits balance is $-0.08`; old `qwen/qwen3.6-plus-preview:free` returns no endpoint. |
| Cline | Scorecard implementation | Blocked | `task-20260429-014511-88cf4ad7` routed to `kwaipilot/kat-coder-pro` after docs-based free classification, then hit the same Cline Credits 402. |

## Prompt Hardening Applied

Kilo and Cline now use a separate low-cost/free worker system prompt. It sharpens:

- Evidence boundaries: do not claim files, commands, tests, docs, APIs, errors, or results unless observed.
- Scope boundaries: only edit files allowed by the bundle; fail with `changedFiles: []` when the request is outside scope.
- Exactness: preserve requested content exactly for exact-file tasks; do not add punctuation, grammar fixes, or inferred formatting.
- Engineering principles: KISS, YAGNI, DRY, reuse existing code, and avoid speculative abstractions.
- Deslop pass: no TODOs, placeholders, filler prose, dead code, or unrelated cleanup.
- Verification honesty: do not claim tests passed unless the worker ran them and saw passing output; blank output is not passing evidence.
- Output contract: raw JSON only with `status`, `summary`, and `changedFiles`; no markdown fences.

## Remaining Cline Blocker

`cline --version` and model discovery only prove the binary/config surface exists. Sign-in is now working, but Cline free-model behavior still cannot be judged as a worker until the account can run official free models without a Cline Credits 402.

Agent OS now labels Kilo/Cline provider health as binary availability plus launch-smoke verification, unwraps nested Cline errors into concise failure summaries, and classifies Cline's documented free `kwaipilot/kat-coder-pro` model as free even though its ID does not contain `free`.
