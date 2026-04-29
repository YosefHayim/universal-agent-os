import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises' // Added writeFile and mkdir
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { notifyWorkerFinished } from '../src/core/notifications.js'

// Mock process.stderr.isTTY for bell notification
const originalIsTTY = process.stderr.isTTY
let stderrOutput = ''
let originalStderrWrite = process.stderr.write

afterEach(() => {
  process.stderr.isTTY = originalIsTTY
  process.stderr.write = originalStderrWrite
  stderrOutput = ''
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

    // Create a mock config file to enable the command
    const configDir = join(rootDir, '.agent-os', 'config')
    await rm(configDir, { recursive: true, force: true }).catch(() => {}) // Ensure clean state
    await mkdir(configDir, { recursive: true }) // Create config directory recursively

    const notificationsConfigPath = join(configDir, 'notifications.json')
    await writeFile(notificationsConfigPath, JSON.stringify({ commands: ['true'] }), 'utf-8')

    const result = await notifyWorkerFinished({ rootDir }, event)

    assert.equal(result.ranCommands, 1, 'should have run one command')
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test('notifyWorkerFinished rings bell when bell is true and stderr is TTY', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'agent-os-test-'))
  try {
    const rootDir = tmpDir
    const taskId = 'test-task-3'
    const workerId = 'test-worker-3'
    const event = {
      taskId,
      workerId,
      provider: 'manual',
      status: 'completed',
      durationMs: 300,
      message: 'test bell message',
    }

    process.stderr.isTTY = true
    process.stderr.write = (chunk: string | Uint8Array) => {
      stderrOutput += chunk.toString()
      return true
    }

    // Create a mock config file to enable the bell
    const configDir = join(rootDir, '.agent-os', 'config')
    await rm(configDir, { recursive: true, force: true }).catch(() => {})
    await mkdir(configDir, { recursive: true })
    const notificationsConfigPath = join(configDir, 'notifications.json')
    await writeFile(notificationsConfigPath, JSON.stringify({ bell: true }), 'utf-8')


    const result = await notifyWorkerFinished({ rootDir }, event)

    assert.ok(result.ranBell, 'should have rung the bell')
    assert.equal(stderrOutput, '\u0007', 'stderr should contain the BEL character')
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test('notifyWorkerFinished is a no-op when all options are off', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'agent-os-test-'))
  try {
    const rootDir = tmpDir
    const taskId = 'test-task-4'
    const workerId = 'test-worker-4'
    const event = {
      taskId,
      workerId,
      provider: 'manual',
      status: 'completed',
      durationMs: 400,
      message: 'test no-op message',
    }

    // Create a mock config file to disable all options
    const configDir = join(rootDir, '.agent-os', 'config')
    await rm(configDir, { recursive: true, force: true }).catch(() => {})
    await mkdir(configDir, { recursive: true })
    const notificationsConfigPath = join(configDir, 'notifications.json')
    await writeFile(notificationsConfigPath, JSON.stringify({ wakeFiles: false, bell: false, commands: [] }), 'utf-8')

    const result = await notifyWorkerFinished({ rootDir }, event)

    assert.equal(result.wroteWakeFile, null, 'should not have written a wake file')
    assert.equal(result.ranBell, false, 'should not have rung the bell')
    assert.equal(result.ranCommands, 0, 'should not have run any commands')

    // Verify wakeups dir does not exist
    let wakeupsDirExists = false
    try {
      await readFile(join(rootDir, '.agent-os', 'wakeups'))
      wakeupsDirExists = true
    } catch (error: any) {
      assert.equal(error.code, 'ENOENT', 'wakeups directory should not exist')
    }
    assert.equal(wakeupsDirExists, false, 'wakeups directory should not exist')
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})
