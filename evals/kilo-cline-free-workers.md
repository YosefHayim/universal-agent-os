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
| Kilo | Scorecard implementation | Pass | `task-20260429-014511-88cf4ad7` initially timed out after globbing a missing `eval-output/**` directory. After the missing-target prompt rule, rerun completed in 128s and independent grading passed. |
| Kilo | Exact multi-file ledger | Pass | `task-20260429-014632-fee20d3c` initially added prose punctuation and then pipe separators. After exact-content separator rules, rerun completed in 13s and independent grading passed. |
| Cline | Auth retry | Pass | Headless `cline task` now reaches provider inference instead of returning Unauthorized. |
| Cline | Official free model smoke | Blocked | `minimax/minimax-m2.5`, `kwaipilot/kat-coder-pro`, and `z-ai/glm-5` all return `402 Insufficient balance. Your Cline Credits balance is $-0.08`; old `qwen/qwen3.6-plus-preview:free` returns no endpoint. Live rerun with `kwaipilot/kat-coder-pro` on 2026-04-29 still returns `402 insufficient_credits`. |
| Cline | Scorecard implementation | Blocked | `task-20260429-014511-88cf4ad7` routed to `kwaipilot/kat-coder-pro` after docs-based free classification, then hit the same Cline Credits 402. |

## Research Findings Applied

Official docs point to the same pattern that fixed the local failures:

- Cline rules: keep rules focused, scannable, specific, example-backed, and short enough not to waste context (`https://docs.cline.bot/customization/cline-rules`).
- Kilo prompt engineering: use clear, specific instructions, break down tasks, provide examples, specify output format, and iterate from observed failures (`https://kilo.ai/docs/customize/prompt-engineering`).
- Kilo custom instructions: use project/root `AGENTS.md`, global instructions, and per-directory rules for persistent behavior across CLI and editor use (`https://kilo.ai/docs/customize/custom-instructions`).
- OpenAI prompt engineering: put instructions first, separate instructions from context, give desired output formats, use examples, and reduce imprecise wording (`https://help.openai.com/en/articles/6654000-best-practices-for-prompt-engineering-with-the-openai-api`).
- Anthropic prompt engineering: wrap instructions/context/examples in descriptive XML tags and use relevant edge-case examples (`https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#structure-prompts-with-xml-tags`).
- Gemini prompt design: clear task instructions, response-format constraints, few-shot examples, and consistent example formatting improve reliability (`https://ai.google.dev/gemini-api/docs/prompting-strategies`).

## Prompt Hardening Applied

Kilo and Cline now use a structured low-cost/free worker system prompt. It sharpens:

- Evidence boundaries: do not claim files, commands, tests, docs, APIs, errors, or results unless observed.
- Scope boundaries: only edit files allowed by the bundle; fail with `changedFiles: []` when the request is outside scope.
- Missing targets: allowed globs can point at files/directories that do not exist yet; create requested files inside the allowed scope.
- Exactness: preserve requested content exactly for exact-file tasks; do not add punctuation, grammar fixes, or inferred formatting.
- Exact separators: when pipes are separators and the task says to use real newlines, split on `|` and remove pipe characters.
- Prose punctuation: sentence punctuation after an exact item is not file content unless it is inside quotes, code, JSON, or an explicit fenced block.
- Engineering principles: KISS, YAGNI, DRY, reuse existing code, and avoid speculative abstractions.
- Deslop pass: no TODOs, placeholders, filler prose, dead code, or unrelated cleanup.
- Verification honesty: do not claim tests passed unless the worker ran them and saw passing output; blank output is not passing evidence.
- Output contract: raw JSON only with `status`, `summary`, and `changedFiles`; no markdown fences.

## Remaining Cline Blocker

`cline --version` and model discovery only prove the binary/config surface exists. Sign-in is now working, but Cline free-model behavior still cannot be judged as a worker until the account can run official free models without a Cline Credits 402.

Agent OS now labels Kilo/Cline provider health as binary availability plus launch-smoke verification, unwraps nested Cline errors into concise failure summaries, and classifies Cline's documented free `kwaipilot/kat-coder-pro` model as free even though its ID does not contain `free`.
