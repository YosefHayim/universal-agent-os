import React from "react";
import { Box, Text } from "ink";
import { type ProviderRow, type ProviderUsageStat, PROVIDER_LIMITS } from "../runtime/provider-limits.js";

const colors = {
  green: "#4ade80",
  yellow: "#fbbf24",
  red: "#ef4444",
  dim: "#6b7280",
  orange: "#f97316",
  border: "#1f2937",
};

const h = React.createElement;
const WINDOW_COLUMNS = ["5h", "weekly", "24h", "monthly"] as const;

const compact = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return value.toString();
};

const padLeft = (value: string, width: number): string => value.length >= width ? value.slice(0, width) : `${" ".repeat(width - value.length)}${value}`;
const padRight = (value: string, width: number): string => value.length >= width ? value.slice(0, width) : `${value}${" ".repeat(width - value.length)}`;

const percentColor = (percent: number | undefined): string => {
  if (percent === undefined) return colors.dim;
  if (percent >= 80) return colors.red;
  if (percent >= 50) return colors.yellow;
  return colors.green;
};

const hasWindow = (provider: string, window: string): boolean => {
  const limit = PROVIDER_LIMITS.find((item) => item.provider === provider);
  if (!limit) return false;
  return limit.windows.some((item) => item.label === window);
};

const asRowsFromStats = (stats: ProviderUsageStat[]): ProviderRow[] => {
  const grouped = new Map<string, ProviderUsageStat[]>();
  for (const stat of stats) {
    const rows = grouped.get(stat.provider) ?? [];
    rows.push(stat);
    grouped.set(stat.provider, rows);
  }

  return PROVIDER_LIMITS.map((limit) => {
    const providerStats = grouped.get(limit.provider) ?? [];
    const windows: ProviderRow["windows"] = {};
    for (const row of providerStats) {
      windows[row.window] = {
        tokensUsed: row.tokensUsed,
        runs: row.runs,
        cap: row.tokenCap,
        percent: row.percent,
      };
    }
    return {
      provider: limit.provider,
      subscription: {
        active: providerStats.some((row) => row.runs > 0 || row.tokensUsed > 0),
        plan: "unknown",
        source: "compat-stats",
      },
      windows,
    };
  });
};

/** Renders provider limits with one row per provider and window columns for quick quota scanning. */
export default function UsageLimitsPanel(props: { rows?: ProviderRow[]; width?: number; stats?: ProviderUsageStat[] }): React.ReactElement {
  const width = props.width ?? 58;
  const rows = (props.rows && props.rows.length > 0) ? props.rows : asRowsFromStats(props.stats ?? []);

  const header = `${padRight("PROVIDER", 9)} ${padRight("PLAN", 9)} ${padLeft("5h", 5)} ${padLeft("WEEKLY", 7)} ${padLeft("24h", 5)} ${padLeft("MONTH", 6)} ${padRight("ON", 2)}`;
  const hardMax = Math.max(24, width - 4);

  const lines: React.ReactElement[] = [h(Text, { key: "header", color: colors.dim }, header.slice(0, hardMax))];

  for (const row of rows) {
    const planRaw = row.subscription.plan === "Pending" ? "Pending*" : row.subscription.plan ?? "unknown";
    const plan = padRight(planRaw.slice(0, 9), 9);
    const baseLeft = `${padRight(row.provider, 9)} ${plan}`;

    const cells: Array<{ text: string; color: string }> = [];
    for (const window of WINDOW_COLUMNS) {
      const applicable = hasWindow(row.provider, window);
      if (!applicable) {
        cells.push({ text: window === "weekly" ? padLeft("—", 7) : window === "monthly" ? padLeft("—", 6) : padLeft("—", 5), color: colors.dim });
        continue;
      }

      const data = row.windows[window];
      if (!data) {
        const widthFor = window === "weekly" ? 7 : window === "monthly" ? 6 : 5;
        cells.push({ text: padLeft("—", widthFor), color: colors.dim });
        continue;
      }

      if (typeof data.percent === "number") {
        const widthFor = window === "weekly" ? 7 : window === "monthly" ? 6 : 5;
        cells.push({ text: padLeft(`${Math.round(data.percent)}%`, widthFor), color: percentColor(data.percent) });
      } else if (data.tokensUsed > 0 || data.runs > 0) {
        const widthFor = window === "weekly" ? 7 : window === "monthly" ? 6 : 5;
        cells.push({ text: padLeft(compact(data.tokensUsed), widthFor), color: colors.dim });
      } else {
        const widthFor = window === "weekly" ? 7 : window === "monthly" ? 6 : 5;
        cells.push({ text: padLeft("—", widthFor), color: colors.dim });
      }
    }

    const statusText = row.subscription.active ? "●" : "○";
    const statusColor = row.subscription.active ? colors.green : colors.dim;

    lines.push(
      h(
        Text,
        { key: `${row.provider}-base` },
        h(Text, null, `${baseLeft} `),
        h(Text, { color: cells[0]?.color ?? colors.dim }, `${cells[0]?.text ?? ""} `),
        h(Text, { color: cells[1]?.color ?? colors.dim }, `${cells[1]?.text ?? ""} `),
        h(Text, { color: cells[2]?.color ?? colors.dim }, `${cells[2]?.text ?? ""} `),
        h(Text, { color: cells[3]?.color ?? colors.dim }, `${cells[3]?.text ?? ""} `),
        h(Text, { color: statusColor }, statusText),
      ),
    );
  }

  return h(
    Box,
    { borderStyle: "single", borderColor: colors.border, flexDirection: "column", paddingX: 1, width },
    h(Text, { color: colors.orange, bold: true }, "PROVIDER LIMITS"),
    ...lines.map((line, index) => h(Box, { key: `line-${index}` }, line)),
  );
}
