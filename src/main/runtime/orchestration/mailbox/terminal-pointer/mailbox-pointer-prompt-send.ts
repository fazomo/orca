import type {
  AgentPromptExpectedBinding,
  RuntimeAgentPromptWriteOptions
} from '../../../terminal/input/agent-prompt-write-options'

/** How far a notice got: `held` means it was pasted but its Enter was refused for someone's input. */
export type MailboxPointerPromptOutcome =
  | { kind: 'refused'; composerOccupied: boolean }
  | { kind: 'held' }
  | { kind: 'ambiguous' }
  | { kind: 'submitted' }

export type MailboxPointerPromptRequest = {
  handle: string
  ptyId: string
  prompt: string
  requestId: string
  /** Throws to refuse the paste; runs with nothing written yet. */
  beforePaste: () => void
  /** Throws to refuse the first Enter; runs once, before it is written. */
  beforeEnter: () => void
}

export type MailboxPointerPromptHost = {
  getBinding: (handle: string) => AgentPromptExpectedBinding
  sendPrompt: (
    handle: string,
    prompt: string,
    options: RuntimeAgentPromptWriteOptions
  ) => Promise<unknown>
  composerHoldsDraft: (ptyId: string) => boolean
  readTypedInputAt: (ptyId: string) => number | null
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
  let enterChecked = false
  let enterWritten = false
  let enterHeld = false
  let pastedAt = 0
  let settled = false
  try {
    const expectedBinding = host.getBinding(request.handle)
    if (expectedBinding.ptyId !== ptyId) {
      return { kind: 'refused', composerOccupied: false }
    }
    await host.sendPrompt(request.handle, request.prompt, {
      inputKind: 'orchestration',
      // Delivery admitted a settled agent, so Enter follows the paste without a render wait.
      composerReady: true,
      expectedBinding,
      // Delivery needs only the written Enter and its re-sends; waiting for the turn would hold
      // this terminal's other prompts behind a notice mid-turn, where no new turn starts.
      acceptQueued: true,
      requestId: request.requestId,
      observationTimeoutMs: 0,
      onSubmitWritten: () => {
        enterWritten = true
      },
      beforeWrite: async () => {
        // A retry still running after the send settled no longer owns the composer.
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
        // The composer was empty at the paste, so with nobody typing since it holds only the notice;
        // a screen match would add only ways to misread a reflowed composer.
        const typedAt = host.readTypedInputAt(ptyId)
        if (typedAt !== null && typedAt >= pastedAt) {
          enterHeld = !enterWritten
          throw new Error('mailbox_pointer_composer_changed')
        }
        if (!enterChecked) {
          enterChecked = true
          try {
            request.beforeEnter()
          } catch (error) {
            enterHeld = true
            throw error
          }
        }
      }
    })
  } catch {
    // The outcome is how far the write got; a stalled turn after Enter still took the notice.
  }
  settled = true
  if (enterWritten) {
    return { kind: 'submitted' }
  }
  if (!pasting) {
    return { kind: 'refused', composerOccupied }
  }
  return enterHeld ? { kind: 'held' } : { kind: 'ambiguous' }
}
