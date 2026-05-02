# 1. Executive summary
- **BLOCKER**: Requested reconciliation command (`import { buildSnapshot } from './dist/src/tui/runtime/aggregator.js'`) cannot run in this workspace because `dist` is absent and `pnpm -s build` fails (missing `@types/node`), so formal runtime proof is blocked.
- **HIGH**: KPI semantics are mixed and partially relabeled in UI (`COMPLETED/FAILED` shown as `lifetime`, tokens shown as `all tasks`) while aggregator is actually filtered to last 24h by default (`buildSnapshot` cutoff), creating source-of-truth mismatch risk.
- **HIGH**: UI recomputes core counts/totals (`filterSnapshot`, `KpiRow` idle formula) instead of consuming aggregator truth directly, creating drift risk.
- **MEDIUM**: Activity log is synthetic diff-based (`logChanges`) and not sourced from `events.ndjson`, so heartbeat/file/model/idle/recovered/stale event classes are not represented and transition fidelity is lossy.
- **MEDIUM**: Layout is fragile under narrow terminals due to fixed-height panels, heavy string concatenation with `fit(...)`, and truecolor hardcoding that degrades unpredictably on 16-color terminals.

# 2. Counter-by-counter accuracy audit
Observed live snapshot basis (from latest registry + task files in `~/.local/share/agent-os/registry.ndjson` and `/Applications/Github/*/.agent-os/tasks/*`): workers `13`, active `1`, idle `3`, completed `7`, failed `2`, tokensIn `5,744,568`, tokensOut `44,186`, totalTasks `13`, projects `3`, models `5`.

- **WORKERS**
  - Computed: `src/tui/runtime/aggregator.ts:232`, displayed `src/tui/watch.tsx:215`.
  - Sources: registry entries (`src/core/global-registry.ts:45-73`) + task worker folders (`aggregator.ts:107-157`, `273-279`).
  - Scope: live/session-hybrid (default last 24h via `buildSnapshot` `sinceMs`, `aggregator.ts:63`).
  - Risks: 24h truncation not labeled in UI; workerless tasks synthesize one row (`workerId="—"`, `aggregator.ts:117-130`).

- **ACTIVE**
  - Computed: `aggregator.ts:238`, displayed `watch.tsx:216`.
  - Sources: `state.json`, `heartbeat.json`, `result.json` via `workerStatus` (`aggregator.ts:204-222`).
  - Scope: live-only.
  - Risks: running state inferred from heartbeat/status precedence; stale only applied if caller passes `excludeStaleAfterMs`, which watch path does not (`watchSnapshots` calls `buildSnapshot()` no options, `aggregator.ts:80`).

- **IDLE**
  - Computed twice: aggregator (`queued|paused|stale`, `aggregator.ts:239`) and UI recompute (`workers-active-completed-failed`, `watch.tsx:211,143`).
  - Sources: same status derivation but semantics differ.
  - Scope: live-only.
  - Risks: semantic drift between aggregator and UI formulas; UI label `queued` in KPI delta (`watch.tsx:217`) ignores paused/stale inclusion.

- **COMPLETED**
  - Computed: `aggregator.ts:240`; displayed `watch.tsx:218` as `lifetime`.
  - Sources: `result.json.status`, `state.json.status` (`workerStatus`, `aggregator.ts:214`).
  - Scope: 24h-filtered session/historical mix, not lifetime.
  - Risks: incorrect label (`lifetime`) vs actual cutoff.

- **FAILED**
  - Computed: `aggregator.ts:241` includes `failed` + `cancelled`; displayed `watch.tsx:219` as `lifetime`.
  - Sources: `result.json.status`, `state.json.status`.
  - Scope: 24h-filtered.
  - Risks: cancellation collapsed into failed bucket (label ambiguity).

- **TOKENS IN**
  - Computed per worker from `usage.json` (`inputTokens ?? estimatedInputTokens`, `aggregator.ts:175`) and summed (`aggregator.ts:242`); displayed `watch.tsx:220`.
  - Sources: `workers/*/usage.json`.
  - Scope: summed across filtered tasks, not all-time.
  - Risks: mixed exact/estimated fields across providers; zero `inputTokens` with nonzero estimates exists (example zai usage file) and precedence may undercount.

- **TOKENS OUT**
  - Computed similarly (`aggregator.ts:176,243`), displayed `watch.tsx:221`.
  - Sources: `usage.json` output fields.
  - Scope: filtered.
  - Risks: same precedence/mixed semantics risk.

- **TOTAL TASKS**
  - Computed from filtered registry count (`aggregate(..., filtered.length)`, `aggregator.ts:73,233`), displayed `watch.tsx:222` as `registry`.
  - Sources: `registry.ndjson` latest-by-task (`aggregator.ts:92-96`).
  - Scope: global-ish but actually filtered 24h and deduped by taskId.
  - Risks: taskCreate + taskRun both append registry entries (`controller.ts:240-245`, `454-461`); dedupe by taskId avoids row duplication but createdAt from run can overwrite “create” chronology.

- **SYSTEM LOAD**
  - Computed in UI-only rolling array from active count (`watch.tsx:399,451`), rendered `watch.tsx:233-236`.
  - Sources: derived from snapshot count, not persisted.
  - Scope: local-process ephemeral.
  - Risks: not source-of-truth metric; resets on UI restart; label does not indicate synthetic nature.

# 3. Active workers table accuracy
Columns in `src/tui/watch.tsx:250-257`:
- ID: `shortWorkerId` first 6 chars or `—` (`watch.tsx:91-92,121`). Formatting drift vs true `workerId` by truncation.
- STATUS: visual mapping in `StatusText` (`watch.tsx:164-171`) from aggregator status.
- ACTION: `actionFrom(status)` (`watch.tsx:93-104`), synthetic categorical text, not file-backed.
- FILE/TARGET: first changed file or `—` (`watch.tsx:105`). Can differ from active target because `changedFiles` comes from `result.json` typically post-run.
- MODEL: `modelId ?? provider ?? —` (`watch.tsx:106`, model can be sniffed stdout in aggregator `187,263-266`).
- SPAWNED FROM: `task.spawnedFromPath` fallback `repoRoot` (`aggregator.ts:184`, displayed with left-fit `watch.tsx:83,256`).
- CONTEXT: extension heuristics from changed files (`watch.tsx:107-118`), semantic interpretation drift vs task context.
- TOKENS IN/OUT: compact formatting (`watch.tsx:76-81,256`); `—` if undefined.
- RUNTIME: from `runtimeMs` (`aggregator.ts:198,224-229`; rendered `watch.tsx:69-75`).
- TASK: hardcoded `—` (`watch.tsx:256`) always wrong/empty.
- PROGRESS: purely status animation (`watch.tsx:173-181`), not real completion percentage.

Known wrongness:
- `TASK` column is placeholder (`—`) for all rows.
- `ACTION`, `CONTEXT`, `PROGRESS` are synthesized, not state-backed.
- `FILE/TARGET` can remain `—` for running workers with no `result.json.changedFiles` yet.

# 4. Worker details panel
Mapped fields (`watch.tsx:263-295`):
- ID/status/action/file/model/spawnedFrom/context/tokens/runtime all map to `UiWorker` fields, ultimately from aggregator outputs.
- Prompt/context text uses `worker.goal` from task goal (`aggregator.ts:185`) and wraps via `lineParts`.
- Files in context uses `changedFiles` from result.

Spec-requested fields not tracked yet:
- `PID`: **NOT TRACKED YET**. Proposed source: write process pid into `workers/*/workspace.json` during `worker_prepared` in runner path.
- `parent_worker_id`: **NOT TRACKED YET**. Proposed source: task metadata/event payload at spawn in controller/runner.
- `files touched live`: **NOT TRACKED YET** (only final `changedFiles`). Proposed source: incremental diff events or filesystem watcher emitted to `events.ndjson`.
- `prompt summary` (separate concise field): **NOT TRACKED YET** (only full goal and result summary).
- `last event received`: **NOT TRACKED YET** in dashboard model; could read tail of `events.ndjson` per task.
- `current error`: partially in `state.message`/`result.summary`, not normalized field.

# 5. Real-time activity log
- Derived from synthetic diff between previous and current worker maps (`watch.tsx:368-384`, consumed `455-457`).
- It does **not** read `events.ndjson`.

Risks:
- Duplicate emission risk if worker key changes or snapshots reorder around transient `workerId="—"` states.
- Missed transitions between polling ticks (`watchSnapshots` interval, `aggregator.ts:77-89`).
- Timestamp order uses `Date.now()` insertion plus local stamp, not event timestamps.
- Missing spec event types: heartbeat received, file/action change, model change, idle, stale, recovered (none explicitly emitted).

# 6. Token accounting integrity
Path:
- Worker usage read from `workers/*/usage.json` (`aggregator.ts:138`) with precedence exact->estimated (`175-178`).
- Summed at aggregate (`242-243`).

Usage shape evidence:
- Example codex usage has both exact and estimated fields.
- Example zai usage has `inputTokens:0/outputTokens:0` but nonzero estimates, `exact:true`.
- Because precedence chooses exact first, such rows contribute `0` tokens and can undercount if provider writes zero exact placeholders.

Reconciliation (live data read directly from current registry/task tree):
- Global totals: tokensIn `5,744,568`, tokensOut `44,186`.
- Sum(per-worker tokensIn/out) using same precedence: equal to above (PASS for internal consistency).
- Per-project worker counts: `{/Applications/Github/universal-agent-os:10, /Applications/Github/api-service-marketplace-publisher:2, /Applications/Github/genshot:1}` (sum 13, PASS).
- Per-model counts: `{unknown:4, codex:2, zai:1, gpt-5.3-codex:5, gemini-2.5-flash-lite:1}` (sum 13, PASS).

Invariant violations:
- Semantic inconsistency risk: exact/estimated mixing can hide real usage depending on provider file conventions.

# 7. Multi-folder / multi-project correctness
- Grouping key is `repoRoot` absolute path (`aggregator.ts:244`, `global-registry.ts:96` resolve-normalized).
- Symlink handling: code uses `path.resolve`, not `realpath` (`global-registry.ts:4,54,96`; `aggregator.ts:64,68`). Test evidence: `resolve('/tmp/.../link-root')` differs from `realpath(...)` (`/tmp/...` vs `/private/tmp/...`).
- Same-basename collision: no merge in data model (`byProject` keyed by full path), but display truncation uses `fitLeft` (`watch.tsx:343`) and could visually collide.
- File path display inconsistency: `FILE/TARGET` from `changedFiles[0]` is often repo-relative; `SPAWNED FROM` uses absolute/possibly cwd path.

# 8. Worker spawning provenance
- Recorded today: `spawnedFromPath` in task, surfaced in aggregator (`aggregator.ts:184`), and `workerId/provider/model` in state/events (`controller.ts:480-516`).
- Missing: `spawned_by`, `parent_worker_id`, `parent_pid`, explicit inherited project-root lineage in worker metadata.
- Likely insertion points:
  - `src/core/controller.ts` around `taskRun` state/event writes (`499-516`, `543-544`).
  - provider runner event payload generation (`runExternalProvider` call site `496-541`; implementation in `src/providers/external-runner.ts`).

# 9. Real-time sync behavior
- Update interval: configurable `intervalMs` in watch (`watch.tsx:387,419`) default 1000ms from index (`src/tui/index.ts:18`).
- Jitter: none in snapshot polling (fixed interval), except provider-limits refresh every `max(5000, interval*5)` (`watch.tsx:435`).
- Max disk-write to UI latency: roughly one polling period + render cycle; no fs event subscription.
- Stale-worker threshold: supported in aggregator option `excludeStaleAfterMs` (`aggregator.ts:61,216`) but unused by watch path.
- Reconnection/row dedupe: dedupe only by latest registry entry per task (`aggregator.ts:92-96`) and map key in UI (`watch.tsx:90,403,456`); no explicit reconnect workflow.
- Pause/resume in dashboard: no functional pause key; `p` only toast (`watch.tsx:497`).

# 10. Layout fragility
- Breakpoints are implicit; widths are ratio-based plus mins (`fileW/projectW`, `watch.tsx:242-244`). Narrow widths force truncation and potential overlap in composed strings.
- Fixed heights: table `15` rows (`248`), KPI `5`, footer `1`; bottom forced `>=20` (`505`), risking overflow when terminal rows are small.
- Potential alignment breaks: concatenated row/header strings with many `fit(...)` cells (`250`, `256`, `359`) rely on fixed monospace assumptions and sufficient width.
- Truecolor hex palette throughout (`watch.tsx:8-20`, component colors) may degrade on 16-color terminals; no fallback palette detection.

# 11. Fake / mock / placeholder data audit
Scope limited to `src/` (excluding `scripts/mock-watch.tsx`).
- Hardcoded model names in prod TUI source: **none found**.
- `Math.random()` in prod `src/` TUI path: **none found**.
- Static project names in prod TUI source: **none found**.
- Hardcoded token counts in prod TUI source: **none found**.
- Generated progress values in prod TUI source: progress is animated/status-derived (`watch.tsx:173-181`) but not random placeholder rows.
- Placeholder `'running'` rows in prod source: **none found**.

Result: no BLOCKER findings under this specific fake-data pattern list in `src/`.

# 12. Source-of-truth architecture violations
- UI business calculations affecting totals:
  - `filterSnapshot` recalculates counts/totals/byProject/byModel (`watch.tsx:128-145`).
  - `KpiRow` recalculates idle (`watch.tsx:211`).
- Duplicated computation across aggregator + UI:
  - Active/completed/failed/token sums done in both `aggregator.ts:231-247` and `watch.tsx:134-143`.
- Semantic interpretation in UI:
  - `contextFrom` infers domain from file extensions (`watch.tsx:107-118`).
  - `actionFrom` maps statuses to verbs (`93-104`).
  - Both can bias perception away from underlying raw state.

# 13. Keyboard / interaction inventory
Currently bound:
- `q`, `Ctrl+C`: exit (`watch.tsx:478-480`)
- `j` / down arrow: next row (`482-485`)
- `k` / up arrow: previous row (`487-490`)
- `r`: refresh snapshot (`492-495`)
- `f,s,p,d,l,t,m,?`: toast only (`497`)

Spec keys status (`q, r, p, f, s, d, l, t, m, /, ?`):
- Functional: `q`, `r`.
- Toast-only: `p,f,s,d,l,t,m,?`.
- Not bound: `/`.

# 14. Reconciliation proof attempt
Required command attempted:
- `node -e "import('./dist/src/tui/runtime/aggregator.js')..."` -> **FAIL** (`Cannot find module .../dist/src/tui/runtime/aggregator.js`).
- Build attempt `pnpm -s build` -> **FAIL** (`TS2688 Cannot find type definition file for 'node'`).

Fallback manual reconciliation (same source files and precedence rules as aggregator):
- live workers: `13` (from latest-by-task registry filtered to last 24h + task worker dirs) -> likely PASS vs TUI if running now.
- active: `1` -> likely PASS.
- idle: `3` -> potentially PASS in unfiltered view, but filtered view recompute path introduces drift risk.
- completed: `7` -> likely PASS.
- failed: `2` -> likely PASS (includes cancelled by design).
- tokens in: `5,744,568` -> likely PASS if same precedence field selection.
- tokens out: `44,186` -> likely PASS.
- projects: `3` -> likely PASS.
- models: `5` -> likely PASS.

Source read paths:
- registry: `~/.local/share/agent-os/registry.ndjson`
- tasks: `/Applications/Github/*/.agent-os/tasks/*/{state.json,workers/*/{usage,heartbeat,workspace,result}.json}`

# 15. Risk-prioritized fix backlog
1. **BLOCKER: Dist snapshot proof not runnable in QA env**  
   Affected: runtime artifact path expectation (`dist/src/tui/runtime/aggregator.js`), build dependency state.  
   Proposed fix: ensure CI/local QA profile installs build deps and publishes `dist` before audit commands.  
   Phase: **4 reconciliation tests**.
2. **HIGH: KPI label semantics mismatch (`lifetime` vs 24h filtered)**  
   Affected: `src/tui/watch.tsx:218-223`, `src/tui/runtime/aggregator.ts:63`.  
   Proposed fix: either remove 24h default filter or relabel KPIs explicitly as `last 24h`.  
   Phase: **2 state-refactor**.
3. **HIGH: Duplicate count/total logic in UI and aggregator**  
   Affected: `src/tui/watch.tsx:128-145,211`, `src/tui/runtime/aggregator.ts:231-247`.  
   Proposed fix: consume aggregator counts directly; only filter rows in UI without recomputing totals.  
   Phase: **2 state-refactor**.
4. **HIGH: Failed KPI merges cancelled status without label**  
   Affected: `src/tui/runtime/aggregator.ts:241`, `src/tui/watch.tsx:219`.  
   Proposed fix: split `FAILED` and `CANCELLED` or relabel as `FAILED/CANCELLED`.  
   Phase: **2 state-refactor**.
5. **HIGH: Token undercount risk from exact-first precedence**  
   Affected: `src/tui/runtime/aggregator.ts:175-176`.  
   Proposed fix: if exact fields are zero and estimated fields are positive, define deterministic fallback rule.  
   Phase: **4 reconciliation tests**.
6. **MEDIUM: Activity log not sourced from canonical events**  
   Affected: `src/tui/watch.tsx:368-384,455-457`.  
   Proposed fix: ingest `events.ndjson` tail per task and render typed events with timestamp ordering.  
   Phase: **3 harness**.
7. **MEDIUM: Missing stale detection usage in watch path**  
   Affected: `src/tui/runtime/aggregator.ts:216`, `src/tui/watch.tsx:419`.  
   Proposed fix: pass `excludeStaleAfterMs` from watch config into `buildSnapshot`.  
   Phase: **3 harness**.
8. **MEDIUM: No real task/progress fields in table/details**  
   Affected: `src/tui/watch.tsx:256,288`.  
   Proposed fix: add task progress metadata to worker state and bind to columns.  
   Phase: **2 state-refactor**.
9. **MEDIUM: Symlink identity drift (`resolve` not `realpath`)**  
   Affected: `src/core/global-registry.ts:54,96`, `src/tui/runtime/aggregator.ts:64,68`.  
   Proposed fix: canonicalize repo roots with `realpath` on write/read paths.  
   Phase: **5 multi-folder**.
10. **MEDIUM: Keyboard feature gaps (`/` missing, many toast-only)**  
    Affected: `src/tui/watch.tsx:497`.  
    Proposed fix: implement real actions or remove hints from footer.  
    Phase: **6 layout-keyboard**.
11. **LOW: Layout overflow/truncation fragility on narrow terminals**  
    Affected: `src/tui/watch.tsx:242-257,505`.  
    Proposed fix: responsive column collapse and vertical pagination for small widths/heights.  
    Phase: **6 layout-keyboard**.
12. **LOW: Truecolor-only palette without fallback**  
    Affected: `src/tui/watch.tsx:8-20`, `src/tui/components/UsageLimitsPanel.tsx:5-12`.  
    Proposed fix: detect color depth and map to 16-color-safe palette.  
    Phase: **6 layout-keyboard**.
