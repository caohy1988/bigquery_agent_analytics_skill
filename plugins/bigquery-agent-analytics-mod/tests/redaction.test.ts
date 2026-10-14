// Round five's probes, end to end. Each payload reaches the mod through a
// tool, BigQuery refuses the batch, so every row goes out once in the request
// and is then parked on disk; the canary must be in neither. The canary is
// built at run time and has no known credential shape: only the key it sits
// under, or the JSON it sits in, can give it away.

import { expect, test } from 'claude-code/testing'

import { OPTIONS, type Row, type World, deadLetterRows, setUp, startSession } from './helpers.ts'

const CANARY = ['canary', 'value', 'r'.repeat(12)].join('-')
const REFUSED = { status: 403, text: '{"error":{"message":"permission denied","errors":[{"reason":"accessDenied"}]}}' }
const PAD = 'x'.repeat(30_000)
const DROPPED = /^\[TRUNCATED: \d+ chars of JSON text that could not be parsed and checked\]$/

// What went out in insertAll requests and what was parked, for one event type.
function rows(world: World, eventType: string): { sent: Row[]; parked: Row[] } {
  return { sent: world.sentRows().filter(r => r.event_type === eventType), parked: deadLetterRows(world).filter(r => r.event_type === eventType) }
}

// JSON past the parse budget that opens with a scalar, its credential on a
// later line than its name (the reviewer's probe).
for (const first of ['0', 'true', 'null']) {
  test(`an oversized list opening with ${first} is dropped, never sent or parked with its credential`, { options: OPTIONS }, async ($, on) => {
    const world = setUp(on)
    const payload = `[${first}, {"password": [\n  "${CANARY}"\n], "padding": "${PAD}"}]`
    expect((JSON.parse(payload) as [unknown, { password: string[] }])[1].password[0]).toBe(CANARY)
    world.toolReply = () => ({ result: payload, text: payload })
    world.replies = [REFUSED]
    await startSession($)
    await $.tool.call({ tool: 'Read', file_path: 'synthetic.json' })
    await world.clock.advance(5000)
    const { sent, parked } = rows(world, 'TOOL_COMPLETED')
    expect([sent.length, parked.length]).toEqual([1, 1])
    for (const row of [...sent, ...parked]) {
      expect(JSON.stringify(row).includes(CANARY)).toBe(false)
      expect(row.is_truncated).toBe(true)
      expect((JSON.parse(row.content ?? '{}') as { result: string }).result).toMatch(DROPPED)
    }
  })
}

test('an oversized JSON-encoded document is dropped, never sent or parked with its credential', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  const payload = JSON.stringify(JSON.stringify({ password: [CANARY], padding: PAD }, null, 2))
  world.toolReply = () => ({ result: payload, text: payload })
  world.replies = [REFUSED]
  await startSession($)
  await $.tool.call({ tool: 'Read', file_path: 'synthetic.json' })
  await world.clock.advance(5000)
  const { sent, parked } = rows(world, 'TOOL_COMPLETED')
  expect([sent.length, parked.length]).toEqual([1, 1])
  for (const row of [...sent, ...parked]) {
    expect(JSON.stringify(row).includes(CANARY)).toBe(false)
    expect((JSON.parse(row.content ?? '{}') as { result: string }).result).toMatch(DROPPED)
  }
})

// Plural and numbered credential names, each with its own canary, in every
// form the reviewers tried. A test fails naming the forms that leaked.
const NAMES = ['api_keys', 'access_tokens', 'signing_keys', 'decryption_keys', 'sessions', 'token2', 'secret1', 'passphrase2']
const canaryFor = (name: string): string => `${CANARY}-${name.replace(/_/g, '')}`

const leaked = (found: Row[]): string[] => NAMES.filter(name => JSON.stringify(found).includes(canaryFor(name)))

const RESULT_FORMS: [string, (name: string) => { result: unknown; text?: string }][] = [
  ['a structured tool result', name => ({ result: { [name]: canaryFor(name) } })],
  ['JSON text', name => ({ result: { type: 'text' }, text: JSON.stringify({ [name]: canaryFor(name) }) })],
  ['an assignment in text', name => ({ result: { type: 'text' }, text: `export ${name.toUpperCase()}=${canaryFor(name)}\nmode=fast` })],
  ['a URL query parameter', name => ({ result: { type: 'text' }, text: `GET https://api.example.test/v1/items?${name}=${canaryFor(name)}&page=2` })],
]

for (const [form, reply] of RESULT_FORMS) {
  test(`plural and numbered credential names: no value leaves in ${form}`, { options: OPTIONS }, async ($, on) => {
    const world = setUp(on)
    world.replies = [REFUSED]
    world.toolReply = e => reply((e as { tool: string; file_path?: string }).file_path ?? '')
    await startSession($)
    for (const name of NAMES) await $.tool.call({ tool: 'Read', file_path: name })
    await world.clock.advance(5000)
    const { sent, parked } = rows(world, 'TOOL_COMPLETED')
    expect([sent.length, parked.length]).toEqual([NAMES.length, NAMES.length])
    expect({ sent: leaked(sent), parked: leaked(parked) }).toEqual({ sent: [], parked: [] })
  })
}

test('plural and numbered credential names: no value leaves as a tool argument', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [REFUSED]
  await startSession($)
  for (const name of NAMES) await $.tool.call({ tool: 'mcp__vault__read', [name]: canaryFor(name), description: `read ${name}` })
  await world.clock.advance(5000)
  const { sent, parked } = rows(world, 'TOOL_STARTING')
  expect([sent.length, parked.length]).toEqual([NAMES.length, NAMES.length])
  expect({ sent: leaked(sent), parked: leaked(parked) }).toEqual({ sent: [], parked: [] })
  // A listed key keeps its value.
  expect((JSON.parse(sent[0]?.content ?? '{}') as { args: { description: string } }).args.description).toBe('read api_keys')
})
