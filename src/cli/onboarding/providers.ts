import { spawn } from "node:child_process";

/**
 * Provider CLIs we look for during onboarding. The list intentionally
 * mirrors the direct-CLI providers documented in `agent-os guide` —
 * extending it requires updating both places.
 */
export interface ProviderProbe {
  /** Provider id used by `agent-os providers ...`. */
  id: string;
  /** Executable name expected on PATH. */
  bin: string;
  /** Short tagline shown in the walkthrough. */
  blurb: string;
  /** Public install/docs URL surfaced when the CLI is missing. */
  docsUrl: string;
}

export const PROVIDER_PROBES: ProviderProbe[] = [
  { id: "gemini", bin: "gemini", blurb: "Google Gemini CLI", docsUrl: "https://github.com/google-gemini/gemini-cli" },
  { id: "codex", bin: "codex", blurb: "OpenAI Codex CLI", docsUrl: "https://github.com/openai/codex" },
  { id: "claude", bin: "claude", blurb: "Anthropic Claude Code", docsUrl: "https://docs.anthropic.com/claude/docs/claude-code" },
  { id: "opencode", bin: "opencode", blurb: "OpenCode CLI", docsUrl: "https://opencode.ai" },
  { id: "kilo", bin: "kilo", blurb: "Kilo Code CLI", docsUrl: "https://kilocode.ai" },
];

export interface ProbeResult {
  probe: ProviderProbe;
  found: boolean;
}

/** Check PATH for each provider CLI in parallel. */
export async function probeProviders(): Promise<ProbeResult[]> {
  return Promise.all(
    PROVIDER_PROBES.map(async (probe) => ({ probe, found: await hasBinary(probe.bin) })),
  );
}

/**
 * Detect a binary by spawning `command -v` (POSIX) or `where` (Windows).
 *
 * We prefer this over reading PATH ourselves because it picks up
 * shell aliases, asdf shims, and Homebrew symlinks the same way the
 * user's terminal would.
 */
function hasBinary(bin: string): Promise<boolean> {
  const isWindows = process.platform === "win32";
  const cmd = isWindows ? "where" : "command";
  const args = isWindows ? [bin] : ["-v", bin];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore", shell: !isWindows });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}
