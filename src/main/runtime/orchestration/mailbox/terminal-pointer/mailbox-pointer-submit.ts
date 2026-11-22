import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  MAILBOX_POINTER_ENTER_ATTEMPTED,
  MAILBOX_POINTER_RESERVED,
  MAILBOX_POINTER_WRITE_ATTEMPTED
} from '../../db/messages/mailbox-pointer-enter-state'
import {
  isMailboxTerminalTakingInput,
  type OrchestrationMailboxOwner,
  type OrchestrationMailboxTerminal
} from '../routing/mailbox-owner'
import type {
  OrchestrationMailboxDeliveryFlight,
  OrchestrationMailboxPointerState
} from './mailbox-pointer-state'
import type {
  MailboxPointerPromptOutcome,
  MailboxPointerPromptRequest
} from './mailbox-pointer-prompt-send'

type PointerSubmitDependencies = {
  mailboxOwner: OrchestrationMailboxOwner
  state: OrchestrationMailboxPointerState
  getDb: () => OrchestrationDb | null
  resolveSubmitTarget: (ptyId: string) => OrchestrationMailboxPointerSubmitTarget | null
  isLeafPtyProvenAbsent: (ptyId: string) => Promise<boolean>
  isPtyAwaitingUserInput: (ptyId: string) => boolean
  sendPrompt: (request: MailboxPointerPromptRequest) => Promise<MailboxPointerPromptOutcome>
  settle: (ptyId: string, flight: OrchestrationMailboxDeliveryFlight) => void
  redrive: (mailboxHandle: string, force?: boolean) => void
}

export type OrchestrationMailboxPointerSubmitTarget = {
  terminal: OrchestrationMailboxTerminal
  processIncarnation: string
}

/** What a finished attempt does with its rows: give them back, mark them delivered to this
 *  terminal, or keep the claim because the notice may have landed. */
type PointerFinish = 'release' | 'settle' | 'preserve'

export function submitOrchestrationMailboxPointer(
  deps: PointerSubmitDependencies,
  input: {
    mailboxHandle: string
    messages: readonly { id: string; type: string }[]
    newestSequence: number
    ptyId: string
    flight: OrchestrationMailboxDeliveryFlight
    expectedTarget: OrchestrationMailboxPointerSubmitTarget
    prompt: string
  }
): void {
  let finish: PointerFinish | null = null
  let redrive: 'drain' | 'force' | null = null
  let deferredUntilIdle = false
  let phase = MAILBOX_POINTER_RESERVED
  const messageIds = input.messages.map((message) => message.id)
  const reservationTarget = {
    ptyId: input.ptyId,
    processIncarnation: input.expectedTarget.processIncarnation
  }
  const isCurrentFlight = (): boolean => deps.state.isCurrentFlight(input.ptyId, input.flight)
  // The same process, still reading this mailbox; a replaced process gets nothing.
  const sameTerminal = (): OrchestrationMailboxTerminal | null => {
    const target = deps.resolveSubmitTarget(input.ptyId)
    const terminal =
      target?.terminal.handle === input.expectedTarget.terminal.handle &&
      target.processIncarnation === input.expectedTarget.processIncarnation
        ? target.terminal
        : null
    return terminal &&
      deps.mailboxOwner.resolve(terminal, input.mailboxHandle) === input.mailboxHandle
      ? terminal
      : null
  }
  const assertWritable = (): void => {
    const terminal = isCurrentFlight() ? sameTerminal() : null
    if (
      !terminal ||
      !isMailboxTerminalTakingInput(terminal) ||
      deps.isPtyAwaitingUserInput(input.ptyId)
    ) {
      throw new Error('mailbox_pointer_target_changed')
    }
  }
  void deps
    .isLeafPtyProvenAbsent(input.ptyId)
    .then(async (absent) => {
      if (absent) {
        finish = 'release'
        redrive = 'force'
        return
      }
      if (!isCurrentFlight()) {
        return
      }
      const terminal = sameTerminal()
      if (!terminal) {
        finish = 'release'
        redrive = 'force'
        return
      }
      if (
        (terminal.lastAgentStatusObservedLive && terminal.lastAgentStatus === null) ||
        deps.isPtyAwaitingUserInput(input.ptyId)
      ) {
        // A neutral title can outlive the foreground check, and an open dialog would take the
        // Enter as its answer; nothing has been written yet.
        deps.state.deferFlightUntilIdle(input.ptyId)
        input.flight.submit = () => submitOrchestrationMailboxPointer(deps, input)
        deferredUntilIdle = true
        return
      }
      if (!isMailboxTerminalTakingInput(terminal)) {
        // Nothing was written; the terminal's next input edge redelivers.
        finish = 'release'
        return
      }
      const db = deps.getDb()
      const outcome = await deps.sendPrompt({
        handle: input.expectedTarget.terminal.handle,
        ptyId: input.ptyId,
        prompt: input.prompt,
        requestId: `mailbox-pointer:${messageIds.join(',')}`,
        beforePaste: () => {
          assertWritable()
          if (!db?.markMailboxPointerWriteAttempted(messageIds, reservationTarget)) {
            throw new Error('mailbox_pointer_reservation_changed')
          }
          phase = MAILBOX_POINTER_WRITE_ATTEMPTED
        },
        beforeEnter: () => {
          assertWritable()
          if (db?.markMailboxPointerEnterAttempted(messageIds, reservationTarget)) {
            phase = MAILBOX_POINTER_ENTER_ATTEMPTED
          } else if (db?.areUnreadMessages(input.mailboxHandle, messageIds) !== false) {
            // Unread mail lost its claim to an earlier Enter or a release; read mail still gets its Enter.
            throw new Error('mailbox_pointer_reservation_changed')
          }
        }
      })
      if (!isCurrentFlight()) {
        return
      }
      if (outcome.kind === 'submitted') {
        finish = 'settle'
        redrive = 'drain'
      } else if (outcome.kind === 'refused') {
        finish = 'release'
        redrive = 'drain'
      } else if (outcome.kind === 'held') {
        // The notice sits in this composer for whoever typed there; a replaced process lost it.
        if (sameTerminal()) {
          finish = 'settle'
        } else {
          finish = 'release'
          redrive = 'force'
        }
      } else {
        // Neither delivery nor a safe resend is proven.
        finish = 'preserve'
        redrive = 'drain'
      }
    })
    .catch(() => {
      const written = phase !== MAILBOX_POINTER_RESERVED
      finish = written ? 'preserve' : 'release'
      redrive = written ? 'drain' : null
    })
    .finally(() => {
      if (deferredUntilIdle) {
        return
      }
      let released = false
      let rollbackPersisted = true
      if (finish) {
        try {
          if (finish === 'release') {
            deps.getDb()?.releaseMailboxPointerEnter(messageIds, reservationTarget, [phase])
          } else if (finish === 'settle') {
            deps.getDb()?.settleMailboxPointerEnter(messageIds, reservationTarget, [phase], {
              kind: 'terminal',
              handle: input.expectedTarget.terminal.handle
            })
          }
        } catch {
          // Runtime teardown can close the DB while this submit is settling.
          rollbackPersisted = finish !== 'release'
        }
        released =
          finish === 'preserve'
            ? deps.state.deactivateWatermark(input.mailboxHandle, input.newestSequence, input.ptyId)
            : deps.state.clearWatermark(input.mailboxHandle, input.newestSequence, input.ptyId)
      }
      deps.settle(input.ptyId, input.flight)
      if (released && rollbackPersisted && redrive) {
        deps.redrive(input.mailboxHandle, redrive === 'force')
      }
    })
}
