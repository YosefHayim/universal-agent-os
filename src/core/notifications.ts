import { promises as fs } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'

export type NotificationConfig = {
  wakeFiles?: boolean
  bell?: boolean
  commands?: string[]
}

const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  wakeFiles: true,
  bell: true,
  commands: [],
}

/**
 * Loads the notification configuration from the agent-os config directory.
 * If the file is missing or invalid, it falls back to default values.
 * @param paths An object containing rootDir and configDir paths.
 * @returns A Promise that resolves to the NotificationConfig.
 */
export async function loadNotificationConfig(paths: {
  rootDir: string
  configDir: string
}): Promise<NotificationConfig> {
  const configPath = join(paths.configDir, 'notifications.json')
  try {
    const content = await fs.readFile(configPath, 'utf-8')
    const parsed = JSON.parse(content)
    return { ...DEFAULT_NOTIFICATION_CONFIG, ...parsed }
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      // File not found, return defaults
      return DEFAULT_NOTIFICATION_CONFIG
    }
    // Log parsing errors but return defaults
    console.error(
      `[Agent OS] Warning: Invalid notifications.json at ${configPath}. Using defaults. Error: ${error.message}`,
    )
    return DEFAULT_NOTIFICATION_CONFIG
  }
}

/**
 * Notifies about a worker finishing or a task completing based on the provided configuration.
 * @param paths An object containing rootDir for creating wake files.
 * @param event The event payload, e.g., { taskId, workerId, provider, status, durationMs, message }.
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
): Promise<{ wroteWakeFile: string | null; ranBell: boolean; ranCommands: number }> {
  const config = await loadNotificationConfig({
    rootDir: paths.rootDir,
    configDir: join(paths.rootDir, '.agent-os', 'config'), // Assuming .agent-os/config within rootDir
  })

  let wroteWakeFile: string | null = null
  let ranBell: boolean = false
  let ranCommands: number = 0

  if (config.wakeFiles) {
    try {
      const wakeupsDir = join(paths.rootDir, '.agent-os', 'wakeups')
      await fs.mkdir(wakeupsDir, { recursive: true })
      const filename = `${event.taskId}-${event.workerId}.json`
      const filePath = join(wakeupsDir, filename)
      const payload = { ...event, finishedAt: new Date().toISOString() }
      await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8')
      wroteWakeFile = filePath
    } catch (error: any) {
      console.error(
        `[Agent OS] Error writing wakeup file for task ${event.taskId}, worker ${event.workerId}: ${error.message}`,
      )
    }
  }

  if (config.bell && process.stderr.isTTY) {
    process.stderr.write('\u0007') // BEL character
    ranBell = true
  }

  for (const command of config.commands || []) {
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
      const child = spawn(command, {
        shell: true,
        stdio: 'ignore',
        detached: true,
        env,
      })
      child.unref()
      ranCommands++
    } catch (error: any) {
      console.error(
        `[Agent OS] Error spawning notification command "${command}" for task ${event.taskId}: ${error.message}`,
      )
    }
  }

  return { wroteWakeFile, ranBell, ranCommands }
}
