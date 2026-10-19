// The welcome card's writes to the store on their own (lib/welcome.ts): one
// at a time, the greeting first, then the landing and the close, each with
// the card as it is by then, the close once and never undone. In a file of
// its own, so welcome.test.ts also runs against code without the queue.

import { expect, test } from 'claude-code/testing'

import { PLUGIN_VERSION } from '../hooks/lib/config.ts'
import { CardRecords, type Welcome } from '../hooks/lib/welcome.ts'

import { SESSION_ID } from './helpers.ts'

const HERE = 'my-gcp-project.agent_analytics.agent_events (US)'
const OWN = `welcome:${PLUGIN_VERSION}:${SESSION_ID}`

// A store whose writes answer when the test says.
function heldStore(): { writes: [string, unknown][]; pending: () => number; answer: () => Promise<void>; save: (key: string, value: unknown) => Promise<void> } {
  const writes: [string, unknown][] = []
  const held: (() => void)[] = []
  return {
    writes,
    pending: () => held.length,
    answer: async () => {
      held.shift()?.()
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
    },
    save: (key, value) =>
      new Promise(resolve =>
        held.push(() => {
          writes.push([key, value])
          resolve()
        }),
      ),
  }
}

const CARD: Welcome = { version: PLUGIN_VERSION, previous: null, sessionId: SESSION_ID, landedAt: null, landedTo: null, closed: false, sent: 0 }

test("a card's writes go one at a time, each with the card as it is by then, and a close is written once, never undone", async () => {
  const store = heldStore()
  const records = new CardRecords(store.save, CARD, true)
  // While the greeting is written: rows land, the card is closed, and a
  // stale copy of it, from before the close, comes after.
  records.update({ ...CARD, landedAt: 5, landedTo: HERE, sent: 1 })
  records.update({ ...CARD, landedAt: 5, landedTo: HERE, sent: 1, closed: true })
  records.update({ ...CARD, landedAt: 5, landedTo: HERE, sent: 3 })
  expect(store.pending()).toBe(1)
  for (let i = 0; i < 3; i += 1) await store.answer()
  expect(store.pending()).toBe(0)
  expect(store.writes).toEqual([
    [`welcome:${PLUGIN_VERSION}`, { sessionId: SESSION_ID, previous: null }],
    [OWN, { landedAt: 5, landedTo: HERE }],
    [`${OWN}:closed`, true],
  ])
  expect(records.card.closed).toBe(true)
})

test('a resumed card writes no greeting, and only what changed', async () => {
  const store = heldStore()
  const records = new CardRecords(store.save, { ...CARD, landedAt: 5, landedTo: HERE }, false)
  expect(store.pending()).toBe(0)
  records.update({ ...CARD, landedAt: 5, landedTo: HERE, sent: 2 })
  expect(store.pending()).toBe(0)
  records.update({ ...CARD, landedAt: 5, landedTo: HERE, sent: 2, closed: true })
  await store.answer()
  expect(store.writes).toEqual([[`${OWN}:closed`, true]])
})
