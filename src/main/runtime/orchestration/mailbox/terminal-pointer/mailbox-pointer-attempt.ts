import type { OrchestrationDb } from '../../db/orchestration-db'
import { MAILBOX_POINTER_ENTER_ATTEMPTED } from '../../db/messages/mailbox-pointer-enter-state'
import {
  isMailboxTerminalTakingInput,
  type OrchestrationMailboxOwner,
  type OrchestrationMailboxTerminal
} from '../routing/mailbox-owner'
import type {
  OrchestrationMailboxDeliveryFlight,
  OrchestrationMailboxPointerState
} from './mailbox-pointer-state'
import type { MailboxPointerTerminal } from './mailbox-pointer-prompt-send'

export type PointerSubmitDependencies = {
  mailboxOwner: OrchestrationMailboxOwner
  state: OrchestrationMailboxPointerState
  getDb: () => OrchestrationDb | null
  resolveSubmitTarget: (ptyId: string) => OrchestrationMailboxPointerSubmitTarget | null
  isLeafPtyProvenAbsent: (ptyId: string) => Promise<boolean>
  isPtyAwaitingUserInput: (ptyId: string) => boolean
  terminal: MailboxPointerTerminal
  settle: (ptyId: string, flight: OrchestrationMailboxDeliveryFlight) => void
  redrive: (mailboxHandle: string, force?: boolean) => void
}

export type OrchestrationMailboxPointerSubmitTarget = {
  terminal: OrchestrationMailboxTerminal
  processIncarnation: string
}

export type PointerSubmitInput = {
  mailboxHandle: string
  messages: readonly { id: string; type: string }[]
  newestSequence: number
  ptyId: string
  flight: OrchestrationMailboxDeliveryFlight
  expectedTarget: OrchestrationMailboxPointerSubmitTarget
  prompt: string
}

/** What a finished attempt does with its rows: give them back, mark them delivered to this
 *  terminal, or keep the claim because the notice may have landed. */
type PointerFinish = 'release' | 'settle' | 'preserve'

export type PointerAttempt = {
  finish: PointerFinish | null
  redrive: 'drain' | 'force' | null
  deferred: boolean
  phase: number
  messageIds: string[]
  reservationTarget: { ptyId: string; processIncarnation: string }
}

export function beginPointerAttempt(input: PointerSubmitInput, phase: number): PointerAttempt {
  return {
    finish: null,
    redrive: null,
    deferred: false,
    phase,
    messageIds: input.messages.map((message) => message.id),
    reservationTarget: {
      ptyId: input.ptyId,
      processIncarnation: input.expectedTarget.processIncarnation
    }
  }
}

// The same process, still reading this mailbox; a replaced process gets nothing.
export function sameTerminal(
  deps: PointerSubmitDependencies,
  input: PointerSubmitInput
): OrchestrationMailboxTerminal | null {
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

export function assertWritable(deps: PointerSubmitDependencies, input: PointerSubmitInput): void {
  const terminal = deps.state.isCurrentFlight(input.ptyId, input.flight)
    ? sameTerminal(deps, input)
    : null
  if (
    !terminal ||
    !isMailboxTerminalTakingInput(terminal) ||
    deps.isPtyAwaitingUserInput(input.ptyId)
  ) {
    throw new Error('mailbox_pointer_target_changed')
  }
}

export function markEnterAttempted(
  db: OrchestrationDb | null,
  input: PointerSubmitInput,
  attempt: PointerAttempt
): void {
  const { messageIds, reservationTarget } = attempt
  if (db?.markMailboxPointerEnterAttempted(messageIds, reservationTarget)) {
    attempt.phase = MAILBOX_POINTER_ENTER_ATTEMPTED
  } else if (db?.areUnreadMessages(input.mailboxHandle, messageIds) !== false) {
    // Unread mail lost its claim to an earlier Enter or a release; read mail still gets its Enter.
    throw new Error('mailbox_pointer_reservation_changed')
  }
}

export function finishAttempt(
  deps: PointerSubmitDependencies,
  input: PointerSubmitInput,
  attempt: PointerAttempt
): void {
  const { messageIds, reservationTarget } = attempt
  if (attempt.deferred) {
    return
  }
  let released = false
  let rollbackPersisted = true
  if (attempt.finish) {
    try {
      if (attempt.finish === 'release') {
        deps.getDb()?.releaseMailboxPointerEnter(messageIds, reservationTarget, [attempt.phase])
      } else if (attempt.finish === 'settle') {
        deps.getDb()?.settleMailboxPointerEnter(messageIds, reservationTarget, [attempt.phase], {
          kind: 'terminal',
          handle: input.expectedTarget.terminal.handle
        })
      }
    } catch {
      // Runtime teardown can close the DB while this submit is settling.
      rollbackPersisted = attempt.finish !== 'release'
    }
    released =
      attempt.finish === 'preserve'
        ? deps.state.deactivateWatermark(input.mailboxHandle, input.newestSequence, input.ptyId)
        : deps.state.clearWatermark(input.mailboxHandle, input.newestSequence, input.ptyId)
  }
  deps.settle(input.ptyId, input.flight)
  if (released && rollbackPersisted && attempt.redrive) {
    deps.redrive(input.mailboxHandle, attempt.redrive === 'force')
  }
}
