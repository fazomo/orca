import type { AgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-types'
import { botGroupOperationSubmission, type GroupJournal } from './bot-group'

/** How long a room reader waits before asking again for a page whose last read added no rows. */
export const BOT_GROUP_PAGE_RETRY_MS = 30_000

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
      return ended.get(id) === true && !holdsText(rows)
    }
    return ended.has(id) || botGroupOperationSubmission(snapshot, id)?.dispatchState === 'accepted'
  })
}

// A turn's rows keep their array while unchanged (the journal indexer retains them), so each is
// scanned for text once, not on every journal update.
const textOf = new WeakMap<readonly AgentJournalRenderItem[], boolean>()

function holdsText(rows: readonly AgentJournalRenderItem[]): boolean {
  let found = textOf.get(rows)
  if (found === undefined) {
    found = rows.some(isAssistantText)
    textOf.set(rows, found)
  }
  return found
}

function isAssistantText(item: AgentJournalRenderItem): boolean {
  return (
    item.body.kind === 'message' &&
    item.body.role === 'assistant' &&
    item.body.blocks.some((block) => block.type === 'text' && block.text.trim() !== '')
  )
}
