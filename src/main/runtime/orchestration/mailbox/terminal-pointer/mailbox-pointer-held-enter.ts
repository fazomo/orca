import { MAILBOX_POINTER_WRITE_ATTEMPTED } from '../../db/messages/mailbox-pointer-enter-state'
import { isMailboxTerminalTakingInput } from '../routing/mailbox-owner'
import {
  beginPointerAttempt,
  finishAttempt,
  assertWritable,
  markEnterAttempted,
  sameTerminal,
  type PointerSubmitDependencies,
  type PointerSubmitInput
} from './mailbox-pointer-attempt'

/** The held notice's Enter, once its agent rests: only into the same process, and only while
 *  nobody has typed since the paste. */
export function submitHeldMailboxPointerEnter(
  deps: PointerSubmitDependencies,
  input: PointerSubmitInput,
  pastedAt: number,
  phase = MAILBOX_POINTER_WRITE_ATTEMPTED
): void {
  const attempt = beginPointerAttempt(input, phase)
  const holdUntilIdle = (): void => {
    deps.state.deferFlightUntilIdle(input.ptyId)
    input.flight.submit = () => submitHeldMailboxPointerEnter(deps, input, pastedAt, attempt.phase)
    attempt.deferred = true
  }
  void Promise.resolve()
    .then(async () => {
      if (!deps.state.isCurrentFlight(input.ptyId, input.flight)) {
        return
      }
      const terminal = sameTerminal(deps, input)
      if (!terminal) {
        attempt.finish = 'release'
        attempt.redrive = 'force'
        return
      }
      if (deps.isPtyAwaitingUserInput(input.ptyId) || !isMailboxTerminalTakingInput(terminal)) {
        holdUntilIdle()
        return
      }
      if (attempt.phase === MAILBOX_POINTER_WRITE_ATTEMPTED) {
        markEnterAttempted(deps.getDb(), input, attempt)
      }
      const outcome = await deps.terminal.sendHeldEnter(
        input.expectedTarget.terminal.handle,
        input.ptyId,
        pastedAt,
        () => assertWritable(deps, input)
      )
      if (!deps.state.isCurrentFlight(input.ptyId, input.flight)) {
        return
      }
      if (outcome === 'refused') {
        // Nothing left, and the notice still waits in the composer: try its Enter again at rest.
        holdUntilIdle()
        return
      }
      // Someone's typing makes the notice theirs.
      attempt.finish = outcome === 'unverifiable' ? 'preserve' : 'settle'
      attempt.redrive = outcome === 'accepted' ? 'drain' : null
    })
    .catch(() => {
      attempt.finish = 'preserve'
    })
    .finally(() => finishAttempt(deps, input, attempt))
}
