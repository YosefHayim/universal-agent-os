import { promises as fs } from 'fs'
import { homedir } from 'node:os'
import { join } from 'path'
import { spawn } from 'child_process'

/**
 * Worker completion notification configuration.
 *
 * Layered resolution:
 * 1. Per-project file at `<rootDir>/.agent-os/config/notifications.json`
 * 2. User-level fallback at `$XDG_CONFIG_HOME/agent-os/notifications.json`
 *    (or `~/.config/agent-os/notifications.json`)
 * 3. Built-in defaults (everything on except custom commands)
 *
 * Env-var overrides (set to `0`/`false` to disable) take precedence:
 * - `AGENT_OS_NOTIFY_BELL`
 * - `AGENT_OS_NOTIFY_OS`
 * - `AGENT_OS_NOTIFY_WAKEFILES`
 */
export type NotificationConfig = {
  wakeFiles?: boolean
  bell?: boolean
  /** Fire a native OS notification (macOS osascript, Linux notify-send). */
  osNotify?: boolean
  commands?: string[]
}

const DEFAULT_NOTIFICATION_CONFIG: Required<NotificationConfig> = {
  wakeFiles: true,
  bell: true,
  osNotify: true,
  commands: [],
}

function userConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), '.config'), 'agent-os')
}

async function readJsonConfig(path: string): Promise<NotificationConfig | undefined> {
  try {
    const content = await fs.readFile(path, 'utf-8')
    return JSON.parse(content) as NotificationConfig
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return undefined
    console.error(
      `[agent-os] Warning: invalid notifications.json at ${path}. Ignored. ${err.message}`,
    )
    return undefined
  }
}

function envFlag(name: string): boolean | undefined {
  const raw = process.env[name]
  if (raw === undefined) return undefined
  const lowered = raw.trim().toLowerCase()
  if (lowered === '' || lowered === '0' || lowered === 'false' || lowered === 'no') return false
  return true
}

/**
 * Loads the notification configuration, layering project file over the
 * user-level fallback over hard-coded defaults. Env-var overrides win last.
 */
export async function loadNotificationConfig(paths: {
  rootDir: string
  configDir: string
}): Promise<Required<NotificationConfig>> {
  const projectCfg = await readJsonConfig(join(paths.configDir, 'notifications.json'))
  const globalCfg = await readJsonConfig(join(userConfigDir(), 'notifications.json'))
  const merged: Required<NotificationConfig> = {
    ...DEFAULT_NOTIFICATION_CONFIG,
    ...globalCfg,
    ...projectCfg,
  }

  const bellEnv = envFlag('AGENT_OS_NOTIFY_BELL')
  if (bellEnv !== undefined) merged.bell = bellEnv
  const osEnv = envFlag('AGENT_OS_NOTIFY_OS')
  if (osEnv !== undefined) merged.osNotify = osEnv
  const wakeEnv = envFlag('AGENT_OS_NOTIFY_WAKEFILES')
  if (wakeEnv !== undefined) merged.wakeFiles = wakeEnv

  return merged
}

/**
 * Fire a native desktop notification when the platform supports it without
 * extra setup. macOS uses `osascript`; Linux uses `notify-send` if present.
 * Returns `true` when a notifier process was spawned.
 *
 * The child is detached and its stdio ignored so a slow notification daemon
 * never blocks worker completion. Failures (missing binary, permission
 * denied) are swallowed — the bell and wake file remain as backup signals.
 */
function fireOsNotification(title: string, message: string): boolean {
  const safeTitle = title.replace(/["\\]/g, ' ')
  const safeMessage = message.replace(/["\\]/g, ' ')
  try {
    if (process.platform === 'darwin') {
      const script = `display notification "${safeMessage}" with title "${safeTitle}" sound name "Glass"`
      const child = spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true })
      child.unref()
      child.on('error', () => {})
      return true
    }
    if (process.platform === 'linux') {
      const child = spawn('notify-send', [safeTitle, safeMessage], { stdio: 'ignore', detached: true })
      child.unref()
      child.on('error', () => {})
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Notifies about a worker finishing or a task completing.
 *
 * The bell is written unconditionally when enabled — the previous TTY guard
 * silently dropped the BEL whenever agent-os ran under an orchestrator,
 * hook, or piped invocation, which is precisely when a wake-up signal
 * matters most. The byte is harmless in non-TTY streams; a TTY ancestor
 * upstream will still play it.
 */
export async function notifyWorkerFinished(
  paths: { rootDir: string },
  event: {
    taskId: string
    workerId: string
    provider: string
    status: string
    durationMs: number
    message: string
  },
): Promise<{
  wroteWakeFile: string | null
  ranBell: boolean
  ranOsNotify: boolean
  ranCommands: number
}> {
  const config = await loadNotificationConfig({
    rootDir: paths.rootDir,
    configDir: join(paths.rootDir, '.agent-os', 'config'),
  })

  let wroteWakeFile: string | null = null
  let ranBell = false
  let ranOsNotify = false
  let ranCommands = 0

  if (config.wakeFiles) {
    try {
      const wakeupsDir = join(paths.rootDir, '.agent-os', 'wakeups')
      await fs.mkdir(wakeupsDir, { recursive: true })
      const filePath = join(wakeupsDir, `${event.taskId}-${event.workerId}.json`)
      const payload = { ...event, finishedAt: new Date().toISOString() }
      await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8')
      wroteWakeFile = filePath
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(
        `[agent-os] error writing wakeup file for task ${event.taskId}, worker ${event.workerId}: ${message}`,
      )
    }
  }

  if (config.bell) {
    // BEL on stderr only - stdout is reserved for machine-readable CLI JSON,
    // so we never write the byte there. The previous isTTY gate has been
    // removed: the BEL byte is harmless in piped streams and a TTY ancestor
    // upstream still plays it - exactly the wake-up case orchestrators need.
    try { process.stderr.write('\u0007') } catch {}
    ranBell = true
  }

  if (config.osNotify) {
    const title = `agent-os: ${event.status}`
    const body = `${event.provider} ${event.taskId} (${Math.round(event.durationMs / 1000)}s)${event.message ? ` — ${event.message}` : ''}`
    ranOsNotify = fireOsNotification(title, body)
  }

  for (const command of config.commands ?? []) {
    try {
      const env = {
        ...process.env,
        AGENT_OS_TASK_ID: event.taskId,
        AGENT_OS_WORKER_ID: event.workerId,
        AGENT_OS_PROVIDER: event.provider,
        AGENT_OS_STATUS: event.status,
        AGENT_OS_DURATION_MS: event.durationMs.toString(),
        AGENT_OS_MESSAGE: event.message,
      }
      const child = spawn(command, { shell: true, stdio: 'ignore', detached: true, env })
      child.on('error', () => {})
      child.unref()
      ranCommands++
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(
        `[agent-os] error spawning notification command "${command}" for task ${event.taskId}: ${message}`,
      )
    }
  }

  return { wroteWakeFile, ranBell, ranOsNotify, ranCommands }
}
