import React from "react";
import { render } from "ink";
import type { WatchDashboardProps } from "./watch-props.js";

type RunWatchTuiOptions = {
  rootDir?: string;
  taskId?: string;
  intervalMs?: number;
  altScreen?: boolean;
};

/** Mounts the live worker dashboard and restores terminal state on normal exit or process signals. */
export async function runWatchTui(opts: RunWatchTuiOptions): Promise<void> {
  const intervalMs = opts.intervalMs ?? 1000;
  const altScreen = opts.altScreen ?? true;
  if (altScreen) process.stdout.write("\u001b[?1049h\u001b[?25l");

  const watchModule = (await import(new URL("./watch.js", import.meta.url).href)) as { default: React.ComponentType<WatchDashboardProps> };
  const WatchDashboard = watchModule.default;
  const app = render(React.createElement(WatchDashboard, { intervalMs, taskIdFilter: opts.taskId }));
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    app.unmount();
    process.stdout.write("\u001b[?25h");
    if (altScreen) process.stdout.write("\u001b[?1049l");
  };
  const exitCleanly = (): void => {
    cleanup();
    process.exit(0);
  };

  process.once("SIGINT", exitCleanly);
  process.once("SIGTERM", exitCleanly);

  try {
    await app.waitUntilExit();
  } finally {
    process.off("SIGINT", exitCleanly);
    process.off("SIGTERM", exitCleanly);
    cleanup();
  }
}
