import React, {useEffect, useMemo, useRef, useState} from "react";
import {Box, Text, render, useApp, useFocus, useInput, useStdout} from "ink";
import chalk from "chalk";

const colors = {
  bg: "#0a0e14",
  green: "#4ade80",
  cyan: "#22d3ee",
  yellow: "#fbbf24",
  red: "#ef4444",
  magenta: "#c084fc",
  blue: "#60a5fa",
  dim: "#6b7280",
  orange: "#f97316",
  border: "#1f2937",
  white: "#e5e7eb",
};

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const actions = ["editing", "analyzing", "refactoring", "writing", "waiting", "searching", "implementing", "testing", "documenting"];
const models = ["claude-3.5-sonnet", "gpt-4o", "claude-3-haiku"] as const;
const projects = ["/home/user/project-alpha", "/home/user/project-beta", "/home/user/project-gamma", "/home/user/project-delta"];
const targets = [
  "src/runtime/worker-pool.ts",
  "src/agents/context-loader.ts",
  "src/ui/watch-dashboard.tsx",
  "tests/runtime/queue.test.ts",
  "docs/agent-os/runtime.md",
  "src/tools/repository-index.ts",
  "src/config/project-settings.ts",
  "src/prompts/worker-system.ts",
  "src/bin/agent-os.ts",
  "README.md",
  "src/runtime/scheduler.ts",
  "src/runtime/task-state.ts",
  "tests/fixtures/project-alpha.ts",
  "src/instrumentation/events.ts",
  "src/tools/apply-patch.ts",
  "src/runtime/model-router.ts",
  "docs/design/worker-monitor.md",
  "src/runtime/sandbox.ts",
];

type Status = "running" | "queued" | "failed";
type Model = (typeof models)[number];

type Worker = {
  id: string;
  status: Status;
  action: string;
  file: string;
  model: Model;
  spawnedFrom: string;
  context: "codebase" | "docs";
  tokensIn: number;
  tokensOut: number;
  runtimeSeconds: number;
  task: number;
  totalTasks: number;
  progress: number;
};

type LogLine = {
  id: number;
  text: string;
  color: string;
};

type Kpi = {
  label: string;
  value: string;
  delta: string;
  color: string;
};

type Simulation = {
  now: Date;
  uptimeSeconds: number;
  spinnerIndex: number;
  workers: Worker[];
  selected: number;
  setSelected: React.Dispatch<React.SetStateAction<number>>;
  toast: string | null;
  setToast: React.Dispatch<React.SetStateAction<string | null>>;
  logs: LogLine[];
  load: number[];
  tokensIn: number[];
  tokensOut: number[];
};

const formatTime = (date: Date) => date.toTimeString().slice(0, 8);
const formatUptime = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
};
const runtime = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
};
const compact = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : n.toString();
const fit = (value: string, width: number) => value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value.padEnd(width);
const sparkline = (values: number[]) => values.map((value) => blocks[Math.min(blocks.length - 1, Math.max(0, Math.floor(value * blocks.length)))]).join("");
const rand = (min: number, max: number) => Math.floor(min + Math.random() * (max - min + 1));
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const makeWorkers = (): Worker[] => Array.from({length: 18}, (_, index) => {
  const status: Status = index === 7 ? "failed" : index % 6 === 0 ? "queued" : "running";
  return {
    id: `W-${(index + 1).toString().padStart(3, "0")}`,
    status,
    action: status === "failed" ? "error" : actions[index % actions.length],
    file: targets[index % targets.length],
    model: models[index % models.length],
    spawnedFrom: projects[index % projects.length],
    context: index % 4 === 0 ? "docs" : "codebase",
    tokensIn: 8200 + index * 1370,
    tokensOut: 15400 + index * 2210,
    runtimeSeconds: 92 + index * 173,
    task: (index % 5) + 1,
    totalTasks: (index % 4) + 4,
    progress: status === "queued" ? 0 : status === "failed" ? 66 : 20 + (index * 7) % 75,
  };
});

const makeLog = (id: number, workers: Worker[]): LogLine => {
  const worker = workers[rand(0, workers.length - 1)];
  const stamp = formatTime(new Date());
  const systemRoll = Math.random();
  if (systemRoll > 0.84) {
    return {id, color: colors.green, text: `${stamp} [SYSTEM] ✓ Worker ${worker.id} completed task ${worker.task}/${worker.totalTasks}`};
  }
  if (systemRoll > 0.72) {
    return {id, color: colors.cyan, text: `${stamp} [SYSTEM] + Spawned 3 new workers`};
  }
  if (worker.status === "failed" || systemRoll < 0.12) {
    return {id, color: colors.red, text: `${stamp} [${worker.id}] ● error ${worker.file.split("/").pop()} (${worker.model}) - Syntax error`};
  }
  return {id, color: worker.status === "queued" ? colors.yellow : colors.green, text: `${stamp} [${worker.id}] ● ${worker.action} ${worker.file.split("/").pop()} (${worker.model})`};
};

/** Simulates the worker dashboard runtime with hardcoded data and timed visual updates. */
const useSimulation = (): Simulation => {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(() => new Date());
  const [spinnerIndex, setSpinnerIndex] = useState(0);
  const [workers, setWorkers] = useState(makeWorkers);
  const [selected, setSelected] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [load, setLoad] = useState(() => Array.from({length: 60}, () => Math.random()));
  const [tokensIn, setTokensIn] = useState(() => Array.from({length: 60}, () => Math.random()));
  const [tokensOut, setTokensOut] = useState(() => Array.from({length: 60}, () => Math.random()));
  const [logs, setLogs] = useState<LogLine[]>(() => Array.from({length: 18}, (_, index) => makeLog(index, makeWorkers())));
  const workersRef = useRef(workers);

  useEffect(() => {
    workersRef.current = workers;
  }, [workers]);

  useEffect(() => {
    const spinnerTimer = setInterval(() => setSpinnerIndex((value) => (value + 1) % spinnerFrames.length), 80);
    const metricsTimer = setInterval(() => {
      setNow(new Date());
      setLoad((values) => [...values.slice(1), Math.random()]);
      setTokensIn((values) => [...values.slice(1), Math.random()]);
      setTokensOut((values) => [...values.slice(1), Math.random()]);
      setWorkers((items) => items.map((worker) => worker.status === "running" ? {
        ...worker,
        tokensIn: worker.tokensIn + rand(60, 760),
        tokensOut: worker.tokensOut + rand(120, 1100),
        runtimeSeconds: worker.runtimeSeconds + 1,
        progress: clamp(worker.progress + rand(-1, 3), 8, 99),
      } : worker.status === "queued" ? worker : {...worker, runtimeSeconds: worker.runtimeSeconds + 1}));
    }, 1000);
    const logTimer = setInterval(() => {
      setLogs((items) => [makeLog(Date.now(), workersRef.current), ...items].slice(0, 24));
    }, rand(1500, 2000));
    return () => {
      clearInterval(spinnerTimer);
      clearInterval(metricsTimer);
      clearInterval(logTimer);
    };
  }, []);

  useEffect(() => {
    if (toast === null) {
      return;
    }
    const timer = setTimeout(() => setToast(null), 1000);
    return () => clearTimeout(timer);
  }, [toast]);

  return {now, uptimeSeconds: Math.floor((Date.now() - start) / 1000), spinnerIndex, workers, selected, setSelected, toast, setToast, logs, load, tokensIn, tokensOut};
};

const Progress = ({worker, width = 12}: {worker: Worker; width?: number}) => {
  if (worker.status === "failed") {
    return <Text color={colors.red}>{`${"X".padEnd(width, " ")} failed`}</Text>;
  }
  if (worker.status === "queued") {
    return <Text color={colors.dim}>{`${"░".repeat(width)} queued`}</Text>;
  }
  const filled = Math.round((worker.progress / 100) * width);
  const bar = "█".repeat(Math.max(0, filled - 2)) + (filled > 1 ? "▓" : "") + (filled > 0 ? "▒" : "") + "░".repeat(Math.max(0, width - filled));
  return <Text color={colors.green}>{`${bar} ${worker.progress.toString().padStart(2, " ")}%`}</Text>;
};

const StatusText = ({worker, spin}: {worker: Worker; spin: string}) => {
  if (worker.status === "failed") {
    return <Text color={colors.red}>● failed</Text>;
  }
  if (worker.status === "queued") {
    return <Text color={colors.yellow}>◐ queued</Text>;
  }
  return <Text color={colors.green}>{spin} running</Text>;
};

const KpiBox = ({kpi, width}: {kpi: Kpi; width: number}) => (
  <Box borderStyle="single" borderColor={colors.border} width={width} height={5} paddingX={1} flexDirection="column">
    <Text color={colors.dim}>{fit(kpi.label, Math.max(1, width - 4))}</Text>
    <Text color={kpi.color} bold>{fit(kpi.value, Math.max(1, width - 4))}</Text>
    <Text color={kpi.color}>{fit(kpi.delta, Math.max(1, width - 4))}</Text>
  </Box>
);

const TopBar = ({sim, columns}: {sim: Simulation; columns: number}) => {
  const spin = spinnerFrames[sim.spinnerIndex];
  const right = `${formatTime(sim.now)}  uptime ${formatUptime(sim.uptimeSeconds)}  ● live`;
  const center = `${spin} syncing every 1s`;
  const left = `${spin} agent-os  REAL-TIME AGENT WORKER MONITOR`;
  const gap = Math.max(1, columns - left.length - center.length - right.length - 2);
  return (
    <Box height={1}>
      <Text color={colors.cyan}>{left}</Text>
      <Text>{" ".repeat(Math.floor(gap / 2))}</Text>
      <Text color={colors.dim}>{center}</Text>
      <Text>{" ".repeat(Math.ceil(gap / 2))}</Text>
      <Text color={colors.white}>{right.replace("● live", "")}</Text>
      <Text color={colors.green}>● live</Text>
    </Box>
  );
};

const KpiRow = ({sim, columns}: {sim: Simulation; columns: number}) => {
  const kpis: Kpi[] = [
    {label: "WORKERS", value: "18", delta: "+3 vs last min", color: colors.cyan},
    {label: "ACTIVE", value: "14", delta: "77%", color: colors.cyan},
    {label: "IDLE", value: "2", delta: "11%", color: colors.yellow},
    {label: "COMPLETED", value: "247", delta: "+23", color: colors.green},
    {label: "FAILED", value: "3", delta: "+1", color: colors.red},
    {label: "TOKENS IN", value: "45.6K", delta: "+45.6K", color: colors.magenta},
    {label: "TOKENS OUT", value: "89.3K", delta: "+89.3K", color: colors.cyan},
    {label: "TOTAL TASKS", value: "326", delta: "+32", color: colors.blue},
  ];
  const sparkWidth = Math.max(18, Math.min(68, Math.floor(columns * 0.22)));
  const width = Math.max(11, Math.floor((columns - sparkWidth - 1) / 8));
  return (
    <Box height={5}>
      {kpis.map((kpi) => <KpiBox key={kpi.label} kpi={kpi} width={width} />)}
      <Box borderStyle="single" borderColor={colors.border} width={sparkWidth} height={5} paddingX={1} flexDirection="column">
        <Text color={colors.dim}>SYSTEM LOAD</Text>
        <Text color={colors.orange}>{fit(sparkline(sim.load), Math.max(1, sparkWidth - 4))}</Text>
        <Text color={colors.green}>77%</Text>
      </Box>
    </Box>
  );
};

const WorkerTable = ({sim, columns}: {sim: Simulation; columns: number}) => {
  const rows = sim.workers.slice(0, 10);
  const fileW = Math.max(16, Math.floor(columns * 0.13));
  const projectW = Math.max(20, Math.floor(columns * 0.16));
  const taskW = 6;
  const spin = spinnerFrames[(sim.spinnerIndex + 2) % spinnerFrames.length];
  return (
    <Box borderStyle="double" borderColor={colors.border} height={15} flexDirection="column" paddingX={1}>
      <Text color={colors.orange} bold>ACTIVE WORKERS</Text>
      <Box>
        <Text color={colors.dim}>{`${fit("ID", 7)} ${fit("STATUS", 10)} ${fit("ACTION", 13)} ${fit("FILE/TARGET", fileW)} ${fit("MODEL", 18)} ${fit("SPAWNED FROM", projectW)} ${fit("CONTEXT", 8)} ${fit("TOKENS IN", 10)} ${fit("TOKENS OUT", 11)} ${fit("RUNTIME", 8)} ${fit("TASK", taskW)} PROGRESS`}</Text>
      </Box>
      {rows.map((worker, index) => (
        <Box key={worker.id} backgroundColor={index === sim.selected ? colors.border : undefined}>
          <Text color={colors.white}>{fit(worker.id, 7)} </Text>
          <Box width={10}><StatusText worker={worker} spin={spin} /></Box>
          <Text>{` ${fit(worker.action, 13)} ${fit(worker.file, fileW)} ${fit(worker.model, 18)} ${fit(worker.spawnedFrom, projectW)} ${fit(worker.context, 8)} ${fit(compact(worker.tokensIn), 10)} ${fit(compact(worker.tokensOut), 11)} ${fit(runtime(worker.runtimeSeconds), 8)} ${fit(`${worker.task}/${worker.totalTasks}`, taskW)} `}</Text>
          <Progress worker={worker} width={10} />
        </Box>
      ))}
      <Text color={colors.dim}>... 8 more workers</Text>
    </Box>
  );
};

const WorkerDetails = ({worker}: {worker: Worker}) => (
  <Box borderStyle="double" borderColor={colors.border} flexDirection="column" paddingX={1} width="25%" minWidth={34}>
    <Text color={colors.orange} bold>WORKER DETAILS</Text>
    <Text>ID: <Text color={colors.cyan}>{worker.id}</Text></Text>
    <Text>Status: <StatusText worker={worker} spin={worker.status === "running" ? "●" : "◐"} /></Text>
    <Text>Action: {worker.action}</Text>
    <Text>File: {fit(worker.file, 28)}</Text>
    <Text>Model: {worker.model}</Text>
    <Text>Spawned from: {fit(worker.spawnedFrom, 22)}</Text>
    <Text>Context: {worker.context} ({worker.context === "codebase" ? "128k" : "42k"} tokens)</Text>
    <Text>Tokens In: <Text color={colors.magenta}>{compact(worker.tokensIn)}</Text></Text>
    <Text>Tokens Out: <Text color={colors.cyan}>{compact(worker.tokensOut)}</Text></Text>
    <Text>Runtime: {runtime(worker.runtimeSeconds)}</Text>
    <Text>Task {worker.task} of {worker.totalTasks}</Text>
    <Box><Progress worker={worker} width={18} /></Box>
    <Text color={colors.orange}>Current Prompt / Context:</Text>
    <Box borderStyle="single" borderColor={colors.border} paddingX={1} flexDirection="column">
      <Text color={colors.white}>Update the worker runtime to stream</Text>
      <Text color={colors.white}>status, token usage, and task progress.</Text>
      <Text color={colors.white}>Preserve CLI ergonomics and avoid</Text>
      <Text color={colors.white}>touching unrelated modules.</Text>
    </Box>
    <Text color={colors.orange}>Files in context:</Text>
    <Text color={colors.dim}>• src/runtime/worker-pool.ts</Text>
    <Text color={colors.dim}>• src/runtime/scheduler.ts</Text>
    <Text color={colors.dim}>• src/tools/repository-index.ts</Text>
    <Text color={colors.dim}>• tests/runtime/queue.test.ts</Text>
    <Text color={colors.dim}>... and 8 more</Text>
  </Box>
);

const ActivityLog = ({logs}: {logs: LogLine[]}) => (
  <Box borderStyle="double" borderColor={colors.border} flexDirection="column" paddingX={1} flexGrow={1}>
    <Text color={colors.orange} bold>REAL-TIME ACTIVITY LOG</Text>
    <Text color={colors.dim}>...</Text>
    {logs.slice(0, 14).map((line) => <Text key={line.id} color={line.color}>{line.text}</Text>)}
  </Box>
);

const TokenPanel = ({sim}: {sim: Simulation}) => (
  <Box borderStyle="single" borderColor={colors.border} flexDirection="column" paddingX={1} height={6}>
    <Text color={colors.orange} bold>TOKEN USAGE <Text color={colors.dim}>(last 60s)</Text></Text>
    <Box>
      <Text color={colors.magenta}>{fit(`In  ${sparkline(sim.tokensIn)}`, 40)}</Text>
      <Text color={colors.magenta}>In: 45.6K tok/s</Text>
    </Box>
    <Box>
      <Text color={colors.cyan}>{fit(`Out ${sparkline(sim.tokensOut)}`, 40)}</Text>
      <Text color={colors.cyan}>Out: 89.3K tok/s</Text>
    </Box>
  </Box>
);

const ModelPanel = () => (
  <Box borderStyle="single" borderColor={colors.border} flexDirection="column" paddingX={1} height={8}>
    <Text color={colors.orange} bold>MODEL USAGE</Text>
    <Text color={colors.cyan}>   ◜██◝</Text>
    <Text color={colors.magenta}>   ◟██◞</Text>
    <Text><Text color={colors.cyan}>■</Text> claude-3.5-sonnet 50% (9)</Text>
    <Text><Text color={colors.blue}>■</Text> gpt-4o 33% (6)</Text>
    <Text><Text color={colors.magenta}>■</Text> claude-3-haiku 17% (3)</Text>
  </Box>
);

const ProjectsPanel = () => (
  <Box borderStyle="single" borderColor={colors.border} flexDirection="column" paddingX={1} flexGrow={1}>
    <Text color={colors.orange} bold>TOP PROJECTS</Text>
    <Text><Text color={colors.green}>████████░░</Text> /home/user/project-alpha 44% (8)</Text>
    <Text><Text color={colors.cyan}>█████░░░░░</Text> /home/user/project-beta 28% (5)</Text>
    <Text><Text color={colors.yellow}>███░░░░░░░</Text> /home/user/project-gamma 17% (3)</Text>
    <Text><Text color={colors.blue}>██░░░░░░░░</Text> /home/user/project-delta 11% (2)</Text>
  </Box>
);

const RightColumn = ({sim}: {sim: Simulation}) => (
  <Box flexDirection="column" width="27%" minWidth={44}>
    <TokenPanel sim={sim} />
    <ModelPanel />
    <ProjectsPanel />
  </Box>
);

const Footer = ({columns}: {columns: number}) => {
  const text = "q Quit  r Refresh  f Filter  s Sort  p Pause  d Details  l Logs  t Tasks  m Models  ? Help    Auto-refresh: ON";
  return <Box height={1}><Text color={colors.dim}>{text.padStart(columns)}</Text></Box>;
};

/** Renders the standalone Ink mock of the agent-os real-time worker dashboard. */
const App = () => {
  const sim = useSimulation();
  const {exit} = useApp();
  const {stdout} = useStdout();
  const {isFocused} = useFocus({autoFocus: true});
  const [size, setSize] = useState({columns: stdout.columns ?? 160, rows: stdout.rows ?? 48});
  const selectedWorker = sim.workers[sim.selected] ?? sim.workers[0];
  const topHeight = 1;
  const kpiHeight = 5;
  const tableHeight = 15;
  const footerHeight = 1;
  const bottomHeight = Math.max(20, size.rows - topHeight - kpiHeight - tableHeight - footerHeight);

  useEffect(() => {
    process.stdout.write("\u001b[?1049h\u001b[?25l");
    return () => {
      process.stdout.write("\u001b[?25h\u001b[?1049l");
    };
  }, []);

  useEffect(() => {
    const onResize = () => setSize({columns: stdout.columns ?? 160, rows: stdout.rows ?? 48});
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (input === "j" || key.downArrow) {
      sim.setSelected((value) => Math.min(9, value + 1));
      return;
    }
    if (input === "k" || key.upArrow) {
      sim.setSelected((value) => Math.max(0, value - 1));
      return;
    }
    if (["r", "f", "s", "p", "d", "l", "t", "m", "?"].includes(input)) {
      sim.setToast(`${input} pressed`);
    }
  });

  const focusedBorder = useMemo(() => isFocused ? colors.border : colors.dim, [isFocused]);
  const styleProbe = chalk.hex(colors.green)("●");

  return (
    <Box flexDirection="column" width={size.columns} height={size.rows} backgroundColor={colors.bg}>
      <TopBar sim={sim} columns={size.columns} />
      <KpiRow sim={sim} columns={size.columns} />
      <WorkerTable sim={sim} columns={size.columns} />
      <Box height={bottomHeight} borderColor={focusedBorder}>
        <WorkerDetails worker={selectedWorker} />
        <ActivityLog logs={sim.logs} />
        <RightColumn sim={sim} />
      </Box>
      <Footer columns={size.columns} />
      {sim.toast === null ? null : (
        <Box position="absolute" right={2} top={1} borderStyle="single" borderColor={colors.orange} paddingX={1}>
          <Text color={colors.orange}>{sim.toast} {styleProbe}</Text>
        </Box>
      )}
    </Box>
  );
};

render(<App />);
