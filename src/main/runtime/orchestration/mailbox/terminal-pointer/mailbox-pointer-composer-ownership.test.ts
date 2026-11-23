import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBoundRun,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  pointerCount,
  PTY_ID,
  temporaryDirectories,
  TERMINAL_HANDLE
} from './orchestration-mailbox-notification-test-harness'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

const ELEVEN_MINUTES_MS = 11 * 60_000
// Codex's composer holding typed text, its dim footer below, the cursor after the text.
const CODEX_DRAFT =
  '\x1b[2J\x1b[H\x1b[1m›\x1b[22m my own draft\r\n\r\n\x1b[2m  gpt-5 default · ~/work\x1b[22m\x1b[1;16H'
const CODEX_EMPTY =
  '\x1b[2J\x1b[H\x1b[1m›\x1b[22m \r\n\r\n\x1b[2m  gpt-5 default · ~/work\x1b[22m\x1b[1;3H'

async function idleCodexWithMail() {
  vi.useFakeTimers()
  const db = new OrchestrationDb(':memory:')
  const harness = await createRuntime(db)
  await driveToLiveIdle(harness.runtime)
  const run = createBoundRun(db, 'Composer ownership Run')
  const message = insertDirectRunMessage(db, run.id, 'Reply')
  return { db, message, ...harness }
}

function enterCount(write: ReturnType<typeof vi.fn>): number {
  return write.mock.calls.filter(([, payload]) => payload === '\r').length
}

// A notice must never type into, or submit, text someone else put in the composer.
describe('mailbox notice composer ownership', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('leaves a draft alone after the delivery hold expires, and delivers once it clears', async () => {
    const { db, message, runtime, write } = await idleCodexWithMail()
    runtime.terminalRunFacts.recordInput(PTY_ID, 'driving', 'draft', Date.now() - ELEVEN_MINUTES_MS)
    runtime.onPtyData(PTY_ID, CODEX_DRAFT, 2)
    await runtime.serializeMainTerminalBuffer(PTY_ID)

    runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(write).not.toHaveBeenCalled()
    expect(db.getMessageById(message.id)).toMatchObject({ delivered_at: null, read: 0 })

    // Clearing the draft fires no status edge; the mail must still reach the agent.
    runtime.onPtyData(PTY_ID, CODEX_EMPTY, 3)
    await runtime.serializeMainTerminalBuffer(PTY_ID)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(pointerCount(write)).toBe(1)
    db.close()
  })

  it('leaves no turn-start registration behind for a later prompt to trip on', async () => {
    const { db, runtime, write } = await idleCodexWithMail()
    runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(enterCount(write)).toBeGreaterThan(0)

    // SAFETY: the correlation methods are protected; the test drives them as the prompt path does.
    const correlation = runtime as unknown as {
      getPtyLifecycleGeneration: (ptyId: string) => number
      registerAgentPromptRequest: (...args: [string, number, string, number, number | null]) => void
      acceptAgentPromptTurnStart: (
        ...args: [
          string,
          number,
          string,
          number,
          number | null,
          { kind: 'hook'; workingStartedAt: number }
        ]
      ) => boolean
    }
    const generation = correlation.getPtyLifecycleGeneration(PTY_ID)
    correlation.registerAgentPromptRequest(PTY_ID, generation, 'later-send', 0, null)
    expect(
      correlation.acceptAgentPromptTurnStart(PTY_ID, generation, 'later-send', 0, null, {
        kind: 'hook',
        workingStartedAt: Date.now() + 1_000
      })
    ).toBe(true)
    db.close()
  })

  it('withholds Enter when someone types after the notice is pasted', async () => {
    const { db, runtime, write } = await idleCodexWithMail()
    write.mockImplementation((_ptyId: string, payload: string) => {
      if (String(payload).includes(' orchestration check')) {
        runtime.terminalRunFacts.recordInput(PTY_ID, 'driving', 'x')
      }
      return true
    })

    runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(pointerCount(write)).toBe(1)
    expect(enterCount(write)).toBe(0)
    db.close()
  })
})
