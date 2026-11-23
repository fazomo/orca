import type {
  AgentPromptExpectedBinding,
  RuntimeAgentPromptWriteOptions
} from '../../../terminal/input/agent-prompt-write-options'
import type { WriteSettlement } from '../../../../../shared/terminal/pty/lifecycle/pty-write-settlement'

/** How far a notice got. `held`: pasted, but its first Enter was refused, for someone's typing or
 *  for a dialog or a terminal that stopped taking input. */
export type MailboxPointerPromptOutcome =
  | { kind: 'refused'; composerOccupied: boolean }
  | { kind: 'held'; for: 'typing' | 'target'; pastedAt: number }
  | { kind: 'ambiguous' }
  | { kind: 'submitted' }

export type MailboxPointerPromptRequest = {
  handle: string
  ptyId: string
  prompt: string
  requestId: string
  /** Throws to refuse the paste; runs with nothing written yet. */
  beforePaste: () => void
  /** Throws to refuse an Enter; runs before every one, `first` before the first. */
  beforeEnter: (first: boolean) => void
  /** Marks the Enter attempted when it was written with the paste and no check ran first. */
  enterWrittenUnchecked: () => void
}

/** How mailbox delivery writes to an agent terminal. */
export type MailboxPointerTerminal = {
  /** A whole notice; a refusal for an occupied composer arms the delivery recheck. */
  sendPrompt: (request: MailboxPointerPromptRequest) => Promise<MailboxPointerPromptOutcome>
  /** A held notice's lone Enter; `typed` when someone typed since `pastedAt`. `beforeEnter`
   *  throws to refuse it at the write; a refusal arms the delivery recheck. */
  sendHeldEnter: (
    handle: string,
    ptyId: string,
    pastedAt: number,
    beforeEnter: () => void
  ) => Promise<WriteSettlement['outcome'] | 'typed'>
}

export type MailboxPointerPromptHost = {
  getBinding: (handle: string) => AgentPromptExpectedBinding & { generation: number }
  sendPrompt: (
    handle: string,
    prompt: string,
    options: RuntimeAgentPromptWriteOptions
  ) => Promise<unknown>
  forgetPromptRequest: (ptyId: string, generation: number, requestId: string) => void
  composerHoldsDraft: (ptyId: string) => boolean
  readTypedInputAt: (ptyId: string) => number | null
}

/** Whether someone typed into the terminal at or after `since`. */
export function typedSince(
  readTypedInputAt: (ptyId: string) => number | null,
  ptyId: string,
  since: number
): boolean {
  const typedAt = readTypedInputAt(ptyId)
  return typedAt !== null && typedAt >= since
}

/** Sends a mailbox notice the way every agent prompt is sent: pasted only into an empty composer,
 *  and each Enter, re-sends included, only while nobody has typed since the paste. */
export async function sendMailboxPointerPrompt(
  host: MailboxPointerPromptHost,
  request: MailboxPointerPromptRequest
): Promise<MailboxPointerPromptOutcome> {
  const { ptyId } = request
  let pasting = false
  let composerOccupied = false
  let enterReached = false
  let enterWritten = false
  let heldFor: 'typing' | 'target' | null = null
  let pastedAt = 0
  let settled = false
  // A box: the retry is set from a callback, which control-flow narrowing cannot see.
  const heldRetry: { current: Promise<void> | null } = { current: null }
  let generation: number | null = null
  try {
    const binding = host.getBinding(request.handle)
    if (binding.ptyId !== ptyId) {
      return { kind: 'refused', composerOccupied: false }
    }
    generation = binding.generation
    await host.sendPrompt(request.handle, request.prompt, {
      inputKind: 'orchestration',
      // Delivery admitted a settled agent, so Enter follows the paste without a render wait.
      composerReady: true,
      expectedBinding: { ptyId: binding.ptyId, processIncarnation: binding.processIncarnation },
      // Delivery needs only the written Enter and its re-sends; waiting for the turn would hold
      // this terminal's other prompts behind a notice mid-turn, where no new turn starts.
      acceptQueued: true,
      requestId: request.requestId,
      observationTimeoutMs: 0,
      onSubmitWritten: () => {
        enterWritten = true
        if (!enterReached) {
          request.enterWrittenUnchecked()
        }
      },
      onHeldPromptRetry: (retry) => {
        heldRetry.current = retry
      },
      beforeWrite: async () => {
        // Nothing after the send, its held retry included, may still type here.
        if (settled) {
          throw new Error('mailbox_pointer_send_settled')
        }
        if (!pasting) {
          if (host.composerHoldsDraft(ptyId)) {
            composerOccupied = true
            throw new Error('mailbox_pointer_composer_occupied')
          }
          pastedAt = Date.now()
          request.beforePaste()
          pasting = true
          return
        }
        const first = !enterReached
        enterReached = true
        // The composer was empty at the paste, so with nobody typing since it holds only the notice;
        // a screen match would add only ways to misread a reflowed composer.
        if (typedSince(host.readTypedInputAt, ptyId, pastedAt)) {
          heldFor ??= 'typing'
          throw new Error('mailbox_pointer_composer_changed')
        }
        try {
          request.beforeEnter(first)
        } catch (error) {
          heldFor ??= 'target'
          throw error
        }
      }
    })
    // An OpenCode paste retry outlives the send and still needs this guard.
    await heldRetry.current
  } catch {
    // The outcome is how far the write got; a stalled turn after Enter still took the notice.
  } finally {
    settled = true
    if (generation !== null) {
      // A notice observes no turn, so its turn-start registration must not outlive it.
      host.forgetPromptRequest(ptyId, generation, request.requestId)
    }
  }
  if (enterWritten) {
    return { kind: 'submitted' }
  }
  // A failure before the first Enter check is a refusal before the paste, or the PTY ending under it.
  if (!pasting || !enterReached) {
    return { kind: 'refused', composerOccupied }
  }
  return heldFor ? { kind: 'held', for: heldFor, pastedAt } : { kind: 'ambiguous' }
}
