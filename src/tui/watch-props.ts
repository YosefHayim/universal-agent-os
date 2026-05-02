/** Props for the WatchDashboard component; lives in its own module so the .ts entrypoint can import without pulling .tsx into the typecheck program. */
export type WatchDashboardProps = {
  intervalMs: number;
  taskIdFilter?: string;
};
