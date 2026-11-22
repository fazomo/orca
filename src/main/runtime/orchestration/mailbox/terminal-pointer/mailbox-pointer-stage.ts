import { formatMessagePointer } from '../formatting/message-formatting'
import type {
  OrchestrationMailboxPointerMessage,
  PointerDeliveryDependencies
} from './mailbox-pointer-delivery-contract'
import {
  shouldReleaseOrchestrationPointer,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxTerminal } from '../routing/mailbox-owner'
import type {
  OrchestrationMailboxDeliveryFlight,
  OrchestrationMailboxPointerState
} from './mailbox-pointer-state'
import { submitOrchestrationMailboxPointer } from './mailbox-pointer-submit'

type StagePointerArgs<TWaiter extends OrchestrationMessageWaiter> = {
  deps: PointerDeliveryDependencies<TWaiter>
  state: OrchestrationMailboxPointerState
  terminal: OrchestrationMailboxTerminal
  mailboxHandle: string
  messages: readonly OrchestrationMailboxPointerMessage[]
  heldDeliveryId?: string
  newestSequence: number
  settle: (ptyId: string, flight: OrchestrationMailboxDeliveryFlight) => void
  redrive: (mailboxHandle: string, force?: boolean) => void
}

export function stageOrchestrationMailboxPointer<TWaiter extends OrchestrationMessageWaiter>(
  args: StagePointerArgs<TWaiter>
): void {
  const { ptyId } = args.terminal
  const expectedTarget = args.deps.resolveSubmitTarget(ptyId)
  if (!expectedTarget) {
    return
  }
  const db = args.deps.getDb()
  const reservationTarget = {
    ptyId,
    processIncarnation: expectedTarget.processIncarnation
  }
  if (
    !db ||
    shouldReleaseOrchestrationPointer(
      db,
      args.mailboxHandle,
      args.messages,
      args.deps.getMessageWaiters(args.mailboxHandle)
    )
  ) {
    return
  }
  const flight = args.state.beginFlight(ptyId)
  flight.processIncarnation = expectedTarget.processIncarnation
  flight.stagedMessageIds = args.messages.map((message) => message.id)
  try {
    if (!db.stageMailboxPointerEnter(flight.stagedMessageIds, reservationTarget)) {
      args.settle(ptyId, flight)
      // A reservation conflict must still drain parks left by earlier flights.
      args.redrive(args.mailboxHandle)
      return
    }
  } catch {
    // The reservation may already be durable; recovery decides whether redrive is safe.
    args.settle(ptyId, flight)
    return
  }
  // The watermark must not outlive its DB reservation or concurrent delivery stays parked.
  args.state.setWatermark(args.mailboxHandle, args.newestSequence, ptyId)
  submitOrchestrationMailboxPointer(
    {
      mailboxOwner: args.deps.mailboxOwner,
      state: args.state,
      getDb: args.deps.getDb,
      resolveSubmitTarget: args.deps.resolveSubmitTarget,
      isLeafPtyProvenAbsent: args.deps.isLeafPtyProvenAbsent,
      isPtyAwaitingUserInput: args.deps.isPtyAwaitingUserInput,
      sendPrompt: args.deps.sendPrompt,
      settle: args.settle,
      redrive: args.redrive
    },
    {
      mailboxHandle: args.mailboxHandle,
      messages: args.messages,
      newestSequence: args.newestSequence,
      ptyId,
      flight,
      expectedTarget,
      prompt: formatMessagePointer(
        args.messages.length,
        args.mailboxHandle,
        args.deps.getCliCommand(expectedTarget.terminal.handle),
        args.heldDeliveryId,
        expectedTarget.terminal.handle
      ).trim()
    }
  )
}
