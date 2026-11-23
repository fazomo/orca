import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useStructuredAgentSession } from '../native-chat/session/structured/use-structured-agent-session'
import {
  createBotGroupJournalIndexer,
  type indexBotGroupJournal,
  type BotGroupTurn
} from '../../../../shared/bots/bot-group'
import {
  BOT_GROUP_PAGE_RETRY_MS,
  botGroupTurnsOlderThanPage
} from '../../../../shared/bots/bot-group-journal-paging'
export type BotGroupSession = ReturnType<typeof useStructuredAgentSession> & {
  groupTurnItems: ReturnType<typeof indexBotGroupJournal>
}
export const BotGroupSessionReader = memo(function BotGroupSessionReader({
  target,
  turn,
  visible,
  report
}: {
  /** The group's host, which runs its members' sessions. */
  target: RuntimeClientTarget
  turn: Pick<BotGroupTurn, 'sessionId' | 'agent'> & {
    operationIds: readonly string[]
    ended: ReadonlyMap<string, boolean>
  }
  visible: boolean
  report: (sessionId: string, session: BotGroupSession | null) => void
}): null {
  const controller = useStructuredAgentSession({
    sessionId: turn.sessionId,
    agent: turn.agent,
    target,
    isVisible: visible,
    queueFollowUps: true
  })
  const indexJournal = useMemo(() => createBotGroupJournalIndexer(), [])
  const groupTurnItems = useMemo(
    () =>
      indexJournal(
        { items: controller.journalItems, submissions: controller.submissions },
        turn.operationIds
      ),
    [indexJournal, controller.journalItems, controller.submissions, turn.operationIds]
  )
  const { readCurrent, hasOlder, loadingOlder, loadOlder } = controller
  // The rows a page was last asked for at: a read that failed or added nothing asks again after a
  // pause, or at once when the rows change or the read restarts.
  const pagedAt = useRef<unknown>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!readCurrent) {
      pagedAt.current = null
      return undefined
    }
    if (
      !hasOlder ||
      loadingOlder ||
      !botGroupTurnsOlderThanPage(
        { items: controller.journalItems, submissions: controller.submissions },
        turn.operationIds,
        turn.ended,
        groupTurnItems
      )
    ) {
      return undefined
    }
    if (pagedAt.current === controller.journalItems) {
      const timer = setTimeout(() => {
        pagedAt.current = null
        setRetry((count) => count + 1)
      }, BOT_GROUP_PAGE_RETRY_MS)
      return () => clearTimeout(timer)
    }
    pagedAt.current = controller.journalItems
    void loadOlder()
    return undefined
  }, [
    retry,
    readCurrent,
    hasOlder,
    loadingOlder,
    loadOlder,
    turn.operationIds,
    turn.ended,
    groupTurnItems,
    controller.journalItems,
    controller.submissions
  ])
  const session = useMemo(() => ({ ...controller, groupTurnItems }), [controller, groupTurnItems])
  useEffect(() => {
    report(turn.sessionId, session)
  }, [turn.sessionId, report, session])
  useEffect(() => () => report(turn.sessionId, null), [turn.sessionId, report])
  return null
})
