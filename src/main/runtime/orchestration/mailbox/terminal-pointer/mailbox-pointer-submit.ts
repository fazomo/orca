import {
  MAILBOX_POINTER_ENTER_ATTEMPTED,
  MAILBOX_POINTER_RESERVED,
  MAILBOX_POINTER_WRITE_ATTEMPTED
} from '../../db/messages/mailbox-pointer-enter-state'
import {
  isMailboxTerminalTakingInput,
  type OrchestrationMailboxTerminal
} from '../routing/mailbox-owner'
import {
  assertWritable,
  beginPointerAttempt,
  finishAttempt,
  markEnterAttempted,
  sameTerminal,
  type PointerAttempt,
  type PointerSubmitDependencies,
  type PointerSubmitInput
} from './mailbox-pointer-attempt'
import { submitHeldMailboxPointerEnter } from './mailbox-pointer-held-enter'

export type { OrchestrationMailboxPointerSubmitTarget } from './mailbox-pointer-attempt'

export function submitOrchestrationMailboxPointer(
  deps: PointerSubmitDependencies,
  input: PointerSubmitInput
): void {
  const attempt = beginPointerAttempt(input, MAILBOX_POINTER_RESERVED)
  const { messageIds, reservationTarget } = attempt
  const rerun = (): void => submitOrchestrationMailboxPointer(deps, input)
  void Promise.resolve()
    .then(async () => {
      const terminal = await openTarget(deps, input, attempt, rerun)
      if (!terminal) {
        return
      }
      const db = deps.getDb()
      const outcome = await deps.terminal.sendPrompt({
        handle: input.expectedTarget.terminal.handle,
        ptyId: input.ptyId,
        prompt: input.prompt,
        requestId: `mailbox-pointer:${messageIds.join(',')}`,
        beforePaste: () => {
          assertWritable(deps, input)
          if (!db?.markMailboxPointerWriteAttempted(messageIds, reservationTarget)) {
            throw new Error('mailbox_pointer_reservation_changed')
          }
          attempt.phase = MAILBOX_POINTER_WRITE_ATTEMPTED
        },
        beforeEnter: (first) => {
          assertWritable(deps, input)
          if (first) {
            markEnterAttempted(db, input, attempt)
          }
        },
        enterWrittenUnchecked: () => {
          if (db?.markMailboxPointerEnterAttempted(messageIds, reservationTarget)) {
            attempt.phase = MAILBOX_POINTER_ENTER_ATTEMPTED
          }
        }
      })
      if (!deps.state.isCurrentFlight(input.ptyId, input.flight)) {
        return
      }
      if (outcome.kind === 'submitted') {
        attempt.finish = 'settle'
        attempt.redrive = 'drain'
      } else if (outcome.kind === 'refused') {
        attempt.finish = 'release'
        attempt.redrive = 'drain'
      } else if (outcome.kind === 'held') {
        holdPastedNotice(deps, input, attempt, outcome.for, outcome.pastedAt)
      } else {
        // Neither delivery nor a safe resend is proven.
        attempt.finish = 'preserve'
        attempt.redrive = 'drain'
      }
    })
    .catch(() => {
      const written = attempt.phase !== MAILBOX_POINTER_RESERVED
      attempt.finish = written ? 'preserve' : 'release'
      attempt.redrive = written ? 'drain' : null
    })
    .finally(() => finishAttempt(deps, input, attempt))
}

/** The terminal to type into, or null when this attempt ends or waits for its agent to rest. */
async function openTarget(
  deps: PointerSubmitDependencies,
  input: PointerSubmitInput,
  attempt: PointerAttempt,
  rerun: () => void
): Promise<OrchestrationMailboxTerminal | null> {
  if (await deps.isLeafPtyProvenAbsent(input.ptyId)) {
    attempt.finish = 'release'
    attempt.redrive = 'force'
    return null
  }
  if (!deps.state.isCurrentFlight(input.ptyId, input.flight)) {
    return null
  }
  const terminal = sameTerminal(deps, input)
  if (!terminal) {
    attempt.finish = 'release'
    attempt.redrive = 'force'
    return null
  }
  if (
    (terminal.lastAgentStatusObservedLive && terminal.lastAgentStatus === null) ||
    deps.isPtyAwaitingUserInput(input.ptyId)
  ) {
    // A neutral title can outlive the foreground check, and an open dialog would take the
    // Enter as its answer; nothing has been written yet.
    deps.state.deferFlightUntilIdle(input.ptyId)
    input.flight.submit = rerun
    attempt.deferred = true
    return null
  }
  // A cold-parked terminal that started working while this attempt was checking waits for rest.
  if (deps.state.holdUntilIdle(input.flight, rerun)) {
    attempt.deferred = true
    return null
  }
  if (!isMailboxTerminalTakingInput(terminal)) {
    // Nothing was written; the terminal's next input edge redelivers.
    attempt.finish = 'release'
    return null
  }
  return terminal
}

/** A pasted notice whose first Enter was refused: someone typed, so it is theirs now; or a dialog
 *  opened, so its Enter waits for the agent to rest, as before the paste. */
function holdPastedNotice(
  deps: PointerSubmitDependencies,
  input: PointerSubmitInput,
  attempt: PointerAttempt,
  heldFor: 'typing' | 'target',
  pastedAt: number
): void {
  if (!sameTerminal(deps, input)) {
    attempt.finish = 'release'
    attempt.redrive = 'force'
    return
  }
  if (heldFor === 'typing') {
    attempt.finish = 'settle'
    return
  }
  deps.state.deferFlightUntilIdle(input.ptyId)
  input.flight.submit = () => submitHeldMailboxPointerEnter(deps, input, pastedAt)
  attempt.deferred = true
}
