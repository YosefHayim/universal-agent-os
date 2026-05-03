import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { notifyWorkerFinished } from '../src/core/notifications.js'

const originalIsTTY = process.stderr.isTTY
const originalStderrWrite = process.stderr.write
const originalStdoutWrite = process.stdout.write
let stderrOutput = ''
let stdoutOutput = ''

afterEach(() => {
  process.stderr.isTTY = originalIsTTY
  process.stderr.write = originalStderrWrite
  process.stdout.write = originalStdoutWrite
  stderrOutput = ''
  stdoutOutput = ''
})

test('notifyWorkerFinished creates wake file when wakeFiles is true', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'agent-os-test-'))
  try {
    const rootDir = tmpDir
    const taskId = 'test-task-1'
    const workerId = 'test-worker-1'
    const event = {
      taskId,
      workerId,
      provider: 'manual',
      status: 'completed',
      durationMs: 100,
      message: 'test message',
    }

    const result = await notifyWorkerFinished({ rootDir }, event)

    assert.ok(result.wroteWakeFile, 'should have written a wake file')
    const expectedWakeFilePath = join(rootDir, '.agent-os', 'wakeups', `${taskId}-${workerId}.json`)
    assert.equal(result.wroteWakeFile, expectedWakeFilePath, 'wake file path should match')

    const fileContent = await readFile(expectedWakeFilePath, 'utf-8')
    const parsedContent = JSON.parse(fileContent)

    assert.equal(parsedContent.taskId, taskId)
    assert.equal(parsedContent.workerId, workerId)
    assert.equal(parsedContent.provider, event.provider)
    assert.equal(parsedContent.status, event.status)
    assert.equal(parsedContent.durationMs, event.durationMs)
    assert.equal(parsedContent.message, event.message)
    assert.ok(parsedContent.finishedAt, 'should have finishedAt timestamp')
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test('notifyWorkerFinished calls commands when commands are specified', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'agent-os-test-'))
  try {
    const rootDir = tmpDir
    const taskId = 'test-task-2'
    const workerId = 'test-worker-2'
    const event = {
      taskId,
      workerId,
      provider: 'manual',
      status: 'completed',
      durationMs: 200,
      message: 'test command message',
    }

    const configDir = join(rootDir, '.agent-os', 'config')
    await rm(configDir, { recursive: true, force: true }).catch(() => {})
    await mkdir(configDir, { recursive: true })

    const notificationsConfigPath = join(configDir, 'notifications.json')
    await writeFile(
      notificationsConfigPath,
      JSON.stringify({ commands: ['true'], osNotify: false }),
      'utf-8',
    )

    const result = await notifyWorkerFinished({ rootDir }, event)

    assert.equal(result.ranCommands, 1, 'should have run one command')
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test('notifyWorkerFinished rings bell even when stderr is not a TTY', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'agent-os-test-'))
  try {
    const rootDir = tmpDir
    const event = {
      taskId: 'test-task-3',
      workerId: 'test-worker-3',
      provider: 'manual',
      status: 'completed',
      durationMs: 300,
      message: 'test bell message',
    }

    // Force non-TTY: this is the regression case (bell used to silently no-op
    // whenever the parent piped stderr, e.g. orchestrators and hooks).
    process.stderr.isTTY = false
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrOutput += chunk.toString()
      return true
    }) as typeof process.stderr.write
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutOutput += chunk.toString()
      return true
    }) as typeof process.stdout.write

    const configDir = join(rootDir, '.agent-os', 'config')
    await rm(configDir, { recursive: true, force: true }).catch(() => {})
    await mkdir(configDir, { recursive: true })
    const notificationsConfigPath = join(configDir, 'notifications.json')
    await writeFile(
      notificationsConfigPath,
      JSON.stringify({ bell: true, osNotify: false, wakeFiles: false }),
      'utf-8',
    )

    const result = await notifyWorkerFinished({ rootDir }, event)

    assert.ok(result.ranBell, 'should have rung the bell')
    const sawBell = stderrOutput.includes('\u0007') || stdoutOutput.includes('\u0007')
    assert.ok(sawBell, 'BEL character should be written to stderr or stdout')
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test('AGENT_OS_NOTIFY_BELL=0 disables the bell', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'agent-os-test-'))
  const previous = process.env.AGENT_OS_NOTIFY_BELL
  process.env.AGENT_OS_NOTIFY_BELL = '0'
  try {
    const result = await notifyWorkerFinished(
      { rootDir: tmpDir },
      {
        taskId: 't',
        workerId: 'w',
        provider: 'manual',
        status: 'completed',
        durationMs: 0,
        message: '',
      },
    )
    assert.equal(result.ranBell, false, 'env override should disable bell')
  } finally {
    if (previous === undefined) delete process.env.AGENT_OS_NOTIFY_BELL
    else process.env.AGENT_OS_NOTIFY_BELL = previous
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test('notifyWorkerFinished is a no-op when all options are off', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'agent-os-test-'))
  try {
    const rootDir = tmpDir
    const event = {
      taskId: 'test-task-4',
      workerId: 'test-worker-4',
      provider: 'manual',
      status: 'completed',
      durationMs: 400,
      message: 'test no-op message',
    }

    const configDir = join(rootDir, '.agent-os', 'config')
    await rm(configDir, { recursive: true, force: true }).catch(() => {})
    await mkdir(configDir, { recursive: true })
    const notificationsConfigPath = join(configDir, 'notifications.json')
    await writeFile(
      notificationsConfigPath,
      JSON.stringify({ wakeFiles: false, bell: false, osNotify: false, commands: [] }),
      'utf-8',
    )

    const result = await notifyWorkerFinished({ rootDir }, event)

    assert.equal(result.wroteWakeFile, null, 'should not have written a wake file')
    assert.equal(result.ranBell, false, 'should not have rung the bell')
    assert.equal(result.ranOsNotify, false, 'should not have fired OS notification')
    assert.equal(result.ranCommands, 0, 'should not have run any commands')

    let wakeupsDirExists = false
    try {
      await readFile(join(rootDir, '.agent-os', 'wakeups'))
      wakeupsDirExists = true
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException
      assert.equal(err.code, 'ENOENT', 'wakeups directory should not exist')
    }
    assert.equal(wakeupsDirExists, false, 'wakeups directory should not exist')
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})
