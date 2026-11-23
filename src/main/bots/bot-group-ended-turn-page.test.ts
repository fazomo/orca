import { afterEach, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { type BotGroupTurn, withBotGroupTurnAnswer } from '../../shared/bots/bot-group'
import type { NativeChatMessage } from '../../shared/native-chat/native-chat-types'
import { botGroupTurnsOlderThanPage } from '../../shared/bots/bot-group-journal-paging'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { readBotGroup } from './bot-group-delivery'
import type { BotGroupRuntime } from './bot-group-runtime'
import { BotGroupStore } from './bot-group-store'

// A long member turn pushes its own send off the member chat's loaded page; once it ended the room
// must show its reply at once and page back for its rows, not read "Starting…" (#46084).

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

const turn = (operationId: string, reply?: string | null): BotGroupTurn => ({
  operationId,
  botId: 'bot-1',
  botName: 'Ada',
  avatar: 'A',
  agent: 'claude',
  sessionId: 'bot-group-member-1',
  ...(reply === undefined ? {} : { reply })
})

function room() {
  const orchestration = new OrchestrationDb(':memory:')
  databases.push(orchestration)
  const store = new BotGroupStore(orchestration.db)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a page read with no remote asks or mail turns touches only the store.
  const groups = { store, mailTurnChecks: new Map() } as unknown as BotGroupRuntime
  store.put({
    id: 'group-1',
    name: 'Crew',
    hostId: 'local',
    revision: 1,
    folder: 'group-crew',
    folderWorkspaceId: 'home-1',
    createdAt: 1,
    members: [{ botId: 'bot-1', sessionId: 'bot-group-member-1' }],
    replyMode: { kind: 'mentions' }
  })
  return { store, groups }
}

it('pages back for an ended turn whose send is older than the loaded page', () => {
  const { store, groups } = room()
  store.append({
    id: 'message-1',
    groupId: 'group-1',
    author: { kind: 'owner' },
    text: '@Ada audit the repo',
    createdAt: 2,
    turns: [turn('finished', 'Audit done.'), turn('quiet', null), turn('running')]
  })

  const [message] = readBotGroup(groups, 'group-1').messages
  expect(message.turns.map((t) => [t.operationId, t.ended, 'reply' in t])).toEqual([
    ['finished', { reply: 'Audit done.' }, false],
    ['quiet', {}, false],
    ['running', undefined, false]
  ])
  // With none of its rows loaded, the ended turn already shows its reply.
  const [finished, , running] = message.turns
  expect(withBotGroupTurnAnswer([], finished).flatMap((m) => m.blocks)).toEqual([
    { type: 'text', text: 'Audit done.' }
  ])
  expect(withBotGroupTurnAnswer([], running)).toEqual([])
  // Loaded rows that are only its last tool call still leave the reply showing.
  const toolOnly: NativeChatMessage = {
    id: 'tool',
    role: 'assistant',
    blocks: [{ type: 'tool-call', name: 'Bash', input: {} }],
    timestamp: null,
    source: 'transcript'
  }
  expect(withBotGroupTurnAnswer([toolOnly], finished).at(-1)?.blocks).toEqual([
    { type: 'text', text: 'Audit done.' }
  ])
  // A page marker is never saved back onto the post.
  store.update({ ...store.message('message-1')!, turns: message.turns })
  expect(store.message('message-1')!.turns.some((t) => 'ended' in t)).toBe(false)

  // The loaded page holds only the turn's newest rows: no prompt row, no submission.
  const tail: { items: AgentJournalRenderItem[]; submissions: [] } = { items: [], submissions: [] }
  const ended = new Map(
    message.turns.flatMap((t) =>
      t.ended ? [[t.operationId, t.ended.reply !== undefined] as const] : []
    )
  )
  const none = () => []
  expect(botGroupTurnsOlderThanPage(tail, ['finished'], ended, none)).toBe(true)
  // A turn with no submission on the page and no end may be queued; nothing older to find.
  expect(botGroupTurnsOlderThanPage(tail, ['running'], ended, none)).toBe(false)
  // Only its last tool call loaded: its text is further back, so the room keeps paging until it is.
  const row = (body: AgentJournalRenderItem['body']): AgentJournalRenderItem => ({
    itemId: 'row',
    revision: 1,
    body,
    sequence: 1,
    observedAt: 1
  })
  const call = row({
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'tool-call', name: 'Bash', input: {} }]
  })
  const said = row({
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Audit done.' }]
  })
  expect(botGroupTurnsOlderThanPage(tail, ['finished'], ended, () => [call])).toBe(true)
  expect(botGroupTurnsOlderThanPage(tail, ['finished'], ended, () => [said, call])).toBe(false)
  // A turn that ended without a reply has no text to find.
  expect(botGroupTurnsOlderThanPage(tail, ['quiet'], ended, () => [call])).toBe(false)
})

it('keeps a page of long replies far under the reply limit, newest posts first', () => {
  const { store, groups } = room()
  const long = 'x'.repeat(5_000)
  for (let post = 0; post < 40; post++) {
    store.append({
      id: `message-${post}`,
      groupId: 'group-1',
      author: { kind: 'owner' },
      text: '@all go',
      createdAt: post + 2,
      turns: Array.from({ length: 32 }, (_, index) => turn(`op-${post}-${index}`, long))
    })
  }
  const { messages } = readBotGroup(groups, 'group-1')
  const replies = messages.flatMap((m) => m.turns.map((t) => t.ended?.reply))
  expect(JSON.stringify(messages).length).toBeLessThan(1_000_000)
  // Every turn still reads as ended with a reply; the newest posts carry its text.
  expect(replies.every((reply) => reply !== undefined)).toBe(true)
  expect(messages.at(-1)!.turns[0].ended?.reply?.length).toBe(4_001)
  expect(messages[0].turns[0].ended?.reply).toBe('')
})
