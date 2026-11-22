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

  it('leaves a draft alone after the delivery hold expires', async () => {
    const { db, message, runtime, write } = await idleCodexWithMail()
    runtime.terminalRunFacts.recordInput(PTY_ID, 'driving', 'draft', Date.now() - ELEVEN_MINUTES_MS)
    runtime.onPtyData(PTY_ID, CODEX_DRAFT, 2)
    await runtime.serializeMainTerminalBuffer(PTY_ID)

    runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(write).not.toHaveBeenCalled()
    expect(db.getMessageById(message.id)).toMatchObject({ delivered_at: null, read: 0 })
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
