import type { AgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-types'
import { botGroupOperationSubmission, type GroupJournal } from './bot-group'

/** Whether a turn's rows the room needs are further back: one with no loaded rows whose send was
 *  admitted on this page or that ended (a long turn's send can be older than the page), or an ended
 *  turn with a reply whose loaded rows hold none of its text yet. Queued or refused ones have none.
 *  `ended` maps each ended turn to whether it left a reply. */
export function botGroupTurnsOlderThanPage(
  snapshot: GroupJournal,
  operationIds: readonly string[],
  ended: ReadonlyMap<string, boolean>,
  loaded: (operationId: string) => readonly AgentJournalRenderItem[]
): boolean {
  return operationIds.some((id) => {
    const rows = loaded(id)
    if (rows.length > 0) {
      return ended.get(id) === true && !rows.some(isAssistantText)
    }
    return ended.has(id) || botGroupOperationSubmission(snapshot, id)?.dispatchState === 'accepted'
  })
}

function isAssistantText(item: AgentJournalRenderItem): boolean {
  return (
    item.body.kind === 'message' &&
    item.body.role === 'assistant' &&
    item.body.blocks.some((block) => block.type === 'text' && block.text.trim() !== '')
  )
}
