// The replay that runs by itself at the paced retries while nothing is
// queued (a session left idle). It goes on until every row waiting for it
// has landed, a replay that lands only some included, and it starts for rows
// parked while a table the mod just made was not visible yet. A file another
// session holds, or one that cannot be read, listed or rewritten, keeps its
// rows due. Rows BigQuery refuses on it move to `rejected` files, as a send's
// refused rows do, and wait for /bqaa-backfill: no replay that runs by itself
// sends them again, and no request or file follows for them.

import { type Engine, expect, test } from 'claude-code/testing'

import { resolveConfig } from '../hooks/lib/config.ts'
import { parseFile, packFiles } from '../hooks/lib/deadletter.ts'
import { buildRow } from '../hooks/lib/rows.ts'
import { type Io, Writer } from '../hooks/lib/writer.ts'

import { COMMAND, OK_INSERT, OPTIONS, PARTITION_DIR, TABLE_REF, type World, deadLetterRows, setUp, startSession } from './helpers.ts'

const PLUGIN = 'bigquery-agent-analytics-mod'

const BAND = {
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 115, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const DATASET_MISSING = {
  status: 404,
  text: '{"error":{"code":404,"message":"Not found: Dataset my-gcp-project:agent_analytics","errors":[{"reason":"notFound"}],"status":"NOT_FOUND"}}',
}
const TABLE_MISSING = {
  status: 404,
  text: '{"error":{"code":404,"message":"Not found: Table my-gcp-project:agent_analytics.agent_events","errors":[{"reason":"notFound"}],"status":"NOT_FOUND"}}',
}
const TABLE_CREATED = { status: 200, text: '{"kind":"bigquery#table"}' }
// insertAll took every row of the request but the first, which it asks for
// again; and insertAll refused the first row.
const FIRST_AGAIN = { status: 200, text: JSON.stringify({ insertErrors: [{ index: 0, errors: [{ reason: 'backendError', message: 'try again' }] }] }) }
const FIRST_REFUSED = { status: 200, text: JSON.stringify({ insertErrors: [{ index: 0, errors: [{ reason: 'invalid', message: 'no such field: extra' }] }] }) }
const DENIED = {
  status: 403,
  text: '{"error":{"code":403,"message":"Access Denied: Table my-gcp-project:agent_analytics.agent_events: Permission bigquery.tables.updateData denied","errors":[{"reason":"accessDenied"}],"status":"PERMISSION_DENIED"}}',
}
const INVALID = { status: 400, text: '{"error":{"code":400,"message":"Invalid value for the table schema","errors":[{"reason":"invalid"}],"status":"INVALID_ARGUMENT"}}' }
const UNAUTHENTICATED = { status: 401, text: '{"error":{"code":401,"message":"Request had invalid authentication credentials.","status":"UNAUTHENTICATED"}}' }

const statusText = async ($: Engine): Promise<string> => (await $.command.run({ command: 'bqaa-status', args: '', ...COMMAND })).text ?? ''

async function band($: Engine): Promise<{ line?: string; waiting?: string }> {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  const line = (await ui.find({ type: 'Text', text: /^rows are not being written/ }))?.text
  const waiting = (await ui.find({ type: 'Text', text: /row\(s\) waiting/ }))?.text
  await ui.unmount()
  return { line, waiting }
}

// The event ids parked in this table's files of one kind.
const parkedIn = (world: World, kind: 'spill' | 'retry' | 'rejected'): string[] =>
  [...world.files]
    .filter(([path, text]) => path.startsWith(`${PARTITION_DIR}/${kind}-`) && text.length > 0)
    .flatMap(([, text]) => parseFile(text).lines.map(line => line.row.event_id))

const idsOf = (body: string): string[] => (JSON.parse(body) as { rows: { json: { event_id: string } }[] }).rows.map(r => r.json.event_id)

// Until no row is queued and the rows are parked: a session left idle.
async function leaveIdle($: Engine, world: World): Promise<void> {
  for (let t = 0; t < 30 && !(/queue: 0 rows/.test(await statusText($)) && deadLetterRows(world).length > 0); t += 1) await world.clock.advance(5000)
}

async function idleFor(world: World, minutes: number): Promise<void> {
  for (let t = 0; t < minutes * 12; t += 1) await world.clock.advance(5000)
}

test('an idle replay that lands only some rows goes on by itself until the rest land, rewriting no file for a row asked for again', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [DATASET_MISSING]
  await startSession($)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await leaveIdle($, world)
  const parked = parkedIn(world, 'retry')
  expect(parked.length).toBe(3)
  // The dataset is made. BigQuery takes two of the rows, asks for the first
  // again, and goes on asking for it.
  world.replies = [FIRST_AGAIN]
  for (let t = 0; t < 4; t += 1) await world.clock.advance(5000)
  expect(parkedIn(world, 'retry')).toEqual([parked[0]])
  // BigQuery found the dataset: no notice, and the row still waits.
  expect((await band($)).line).toBeUndefined()
  const requests = world.insertCalls().length
  const files = world.files.size
  await idleFor(world, 1)
  expect(world.insertCalls().length > requests).toBe(true)
  expect(world.files.size).toBe(files)
  world.replies = [OK_INSERT]
  await idleFor(world, 3)
  expect(deadLetterRows(world).length).toBe(0)
  expect(idsOf(world.insertCalls().at(-1)?.body ?? '{"rows":[]}')).toEqual([parked[0]])
})

test('a row BigQuery refuses on an idle replay moves to a rejected file: no replay by itself sends it again, and no request or file follows', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [DATASET_MISSING]
  await startSession($)
  await leaveIdle($, world)
  const parked = parkedIn(world, 'retry')
  expect(parked.length).toBe(1)
  world.replies = [FIRST_REFUSED]
  for (let t = 0; t < 4; t += 1) await world.clock.advance(5000)
  expect(parkedIn(world, 'retry')).toEqual([])
  expect(parkedIn(world, 'rejected')).toEqual(parked)
  const requests = world.insertCalls().length
  const files = world.files.size
  await idleFor(world, 10)
  expect(world.insertCalls().length).toBe(requests)
  expect(world.files.size).toBe(files)
  // BigQuery found the dataset: no notice; the refusal is on the status line
  // and in /bqaa-status, as a send's is.
  expect((await band($)).line).toBeUndefined()
  expect(world.statusLines.at(-1)).toBe('BQAA: 1 row(s) refused (invalid: no such field: extra); fix, then /bqaa-backfill')
  expect(await statusText($)).toMatch(/last backfill \(recovery, [^)]*\): 1 file\(s\), 0 rows sent, 1 left, 1 of them refused/)
  // Once the cause is fixed, /bqaa-backfill sends it.
  world.replies = [OK_INSERT]
  await $.command.run({ command: 'bqaa-backfill', args: '', ...COMMAND })
  await world.clock.advance(1000)
  expect(idsOf(world.insertCalls().at(-1)?.body ?? '{"rows":[]}')).toEqual(parked)
  expect(deadLetterRows(world).length).toBe(0)
})

test('a request BigQuery refuses whole on an idle replay parks its rows for /bqaa-backfill; access denied is the notice', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [DATASET_MISSING]
  await startSession($)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await leaveIdle($, world)
  const parked = parkedIn(world, 'retry')
  expect(parked.length).toBe(3)
  world.replies = [DENIED]
  for (let t = 0; t < 4; t += 1) await world.clock.advance(5000)
  expect(parkedIn(world, 'retry')).toEqual([])
  expect(parkedIn(world, 'rejected').sort()).toEqual([...parked].sort())
  const shown = await band($)
  expect(shown.line).toBe('rows are not being written: BigQuery denied the identity access to the dataset. To fix, ask for roles/bigquery.dataEditor on my-gcp-project:agent_analytics, then run /bqaa-backfill.')
  expect(shown.waiting).toBe(' 3 row(s) waiting.')
  const requests = world.insertCalls().length
  const files = world.files.size
  await idleFor(world, 10)
  expect(world.insertCalls().length).toBe(requests)
  expect(world.files.size).toBe(files)
})

test('a request BigQuery refuses whole as invalid on an idle replay parks its rows for /bqaa-backfill, and nothing follows', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [DATASET_MISSING]
  await startSession($)
  await leaveIdle($, world)
  const parked = parkedIn(world, 'retry')
  world.replies = [INVALID]
  for (let t = 0; t < 4; t += 1) await world.clock.advance(5000)
  expect(parkedIn(world, 'rejected')).toEqual(parked)
  expect(world.statusLines.at(-1) ?? '').toMatch(/1 row\(s\) refused \(HTTP 400: Invalid value for the table schema\); fix, then \/bqaa-backfill/)
  const requests = world.insertCalls().length
  await idleFor(world, 10)
  expect(world.insertCalls().length).toBe(requests)
})

test('rows parked while a table the mod just made is not visible yet go out once it is, with nothing new queued', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [TABLE_MISSING, TABLE_CREATED, TABLE_MISSING]
  await startSession($)
  await idleFor(world, 2)
  // Made once; the row's retries ran out while the table was new.
  expect(world.fetches.filter(f => f.url.endsWith('/tables')).length).toBe(1)
  const parked = parkedIn(world, 'retry')
  expect(parked.length).toBe(1)
  world.replies = [OK_INSERT]
  await idleFor(world, 3)
  expect(deadLetterRows(world).length).toBe(0)
  expect(idsOf(world.insertCalls().at(-1)?.body ?? '{"rows":[]}')).toEqual(parked)
})

// A dead-letter line for this table, of `kind`.
const line = (eventId: string, kind: 'spill' | 'retry' | 'rejected'): string =>
  JSON.stringify({
    v: 1,
    kind,
    reason: kind === 'rejected' ? 'invalid: no such field: extra' : 'retries ran out',
    attempts: 4,
    failed_at: '2026-10-13T20:01:02.003Z',
    table: TABLE_REF,
    row: buildRow({ eventType: 'STATE_DELTA', timestampMs: 0, eventId, agent: 'coding-agent', sessionId: 'earlier', invocationId: null, userId: 'dev', traceId: null, spanId: null, parentSpanId: null, content: {}, attributes: {}, maxPayloadChars: 16384 }).row,
  })

test('a refused row in a retry file, as earlier versions rewrote them, is never sent by a replay that runs by itself; /bqaa-backfill sends it', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  const refused = 'a'.repeat(32)
  const waiting = 'b'.repeat(32)
  world.files.set(`${PARTITION_DIR}/retry-20261013T200102003Z-earlier-1.jsonl`, packFiles([line(refused, 'rejected'), line(waiting, 'retry')])[0] as string)
  await startSession($)
  // The replay 15 s after the start sends the waiting row; the refused one
  // stays, now in a rejected file.
  await world.clock.advance(20_000)
  const sent = () => world.sentRows().map(r => r.event_id)
  expect(sent()).toContain(waiting)
  expect(sent()).not.toContain(refused)
  expect(parkedIn(world, 'rejected')).toEqual([refused])
  expect(parkedIn(world, 'retry')).toEqual([])
  await idleFor(world, 10)
  expect(sent()).not.toContain(refused)
  await $.command.run({ command: 'bqaa-backfill', args: '', ...COMMAND })
  await world.clock.advance(1000)
  expect(sent()).toContain(refused)
  expect(deadLetterRows(world).length).toBe(0)
})

test('rows parked for one table stay due while another table is configured, and go out once theirs is again', async () => {
  // A writer built by hand, whose configuration the test changes in place.
  let config = resolveConfig({ project: 'my-gcp-project', dataset: 'agent_analytics', deadLetterDir: '/dl' }, {})
  let now = 0
  let answer = DATASET_MISSING
  const timers: { at: number; fn: () => void; live: boolean }[] = []
  const files = new Map<string, string>()
  const urls: string[] = []
  const io: Io = {
    now: () => now,
    after: (ms, fn) => {
      const timer = { at: now + ms, fn, live: true }
      timers.push(timer)
      return { cancel: () => (timer.live = false) }
    },
    fetch: async url => {
      urls.push(url)
      return answer
    },
    runCommand: async () => ({ exitCode: 0, stdout: `${'a'.repeat(24)}\n`, stderr: '' }),
    envToken: async () => undefined,
    writeFile: async (path, text) => {
      files.set(path, text)
    },
    readFile: async path => files.get(path) ?? '',
    listDir: async dir => [...files].filter(([path]) => path.startsWith(`${dir}/`)).map(([path, text]) => ({ name: path.slice(dir.length + 1), kind: 'file', size: text.length })),
    storeGet: async () => undefined,
    storeSet: async () => undefined,
    storeDelete: async () => undefined,
    status: () => undefined,
    debug: () => undefined,
  }
  const writer = new Writer(io, () => config, () => 'hand-built-session')
  const tick = async (): Promise<void> => {
    now += 5000
    for (const timer of timers.filter(t => t.live && t.at <= now).sort((a, b) => a.at - b.at)) {
      timer.live = false
      timer.fn()
    }
    await writer.flush()
  }
  const waiting = (): number => [...files.values()].reduce((rows, text) => rows + parseFile(text).lines.length, 0)
  writer.enqueue(buildRow({ eventType: 'STATE_DELTA', timestampMs: 0, eventId: 'c'.repeat(32), agent: 'coding-agent', sessionId: 'hand-built-session', invocationId: null, userId: 'dev', traceId: null, spanId: null, parentSpanId: null, content: {}, attributes: {}, maxPayloadChars: 16384 }).row, 0)
  for (let t = 0; t < 12 && writer.queue.length > 0; t += 1) await tick()
  expect(waiting()).toBe(1)
  // Another table, where nothing is parked: its empty replays leave the row due.
  config = resolveConfig({ project: 'my-gcp-project', dataset: 'another_dataset', deadLetterDir: '/dl' }, {})
  answer = OK_INSERT
  for (let t = 0; t < 24; t += 1) await tick()
  expect(urls.some(u => u.includes('another_dataset'))).toBe(false)
  expect(waiting()).toBe(1)
  config = resolveConfig({ project: 'my-gcp-project', dataset: 'agent_analytics', deadLetterDir: '/dl' }, {})
  for (let t = 0; t < 24; t += 1) await tick()
  expect(waiting()).toBe(0)
})

test('a file another session holds while an idle replay runs stays due: once that lease ends, an idle replay here sends its rows', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [DATASET_MISSING]
  await startSession($)
  await leaveIdle($, world)
  const parked = parkedIn(world, 'retry')
  expect(parked.length).toBe(1)
  const name = ([...world.files.keys()].find(path => path.startsWith(`${PARTITION_DIR}/retry-`)) ?? '').split('/').pop()
  // Another session is replaying the file, and holds its lease.
  const lease = `lease:${TABLE_REF}/${name}`
  world.store.set(lease, { by: 'another-session', until: Date.now() + 600_000 })
  world.replies = [OK_INSERT]
  const requests = world.insertCalls().length
  await idleFor(world, 2)
  expect(world.insertCalls().length).toBe(requests)
  expect(parkedIn(world, 'retry')).toEqual(parked)
  // That session stopped part-way, and its lease ran out (ended here: the
  // test clock leaves Date.now alone).
  world.store.set(lease, { by: 'another-session', until: 0 })
  await idleFor(world, 2)
  expect(deadLetterRows(world).length).toBe(0)
  expect(idsOf(world.insertCalls().at(-1)?.body ?? '{"rows":[]}')).toEqual(parked)
})

test('a replay that cannot empty its file once the rows land sends nothing again; once writes work, a replay empties it', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [DATASET_MISSING]
  await startSession($)
  await leaveIdle($, world)
  const parked = parkedIn(world, 'retry')
  expect(parked.length).toBe(1)
  world.replies = [OK_INSERT]
  world.failWrites = true
  await idleFor(world, 2)
  // Sent once; the file could not be emptied, and nothing goes again.
  const landed = () => world.insertCalls().filter(f => f.answered === 200).length
  expect(landed()).toBe(1)
  expect(parkedIn(world, 'retry')).toEqual(parked)
  expect(await statusText($)).toMatch(/last error \([^)]*\): could not empty .* after its replay \(its rows landed or are in newer files\)/)
  world.failWrites = false
  await idleFor(world, 2)
  expect(landed()).toBe(1)
  expect(deadLetterRows(world).length).toBe(0)
})

test('a replay that cannot list the dead-letter directory leaves the rows due and says why; the next one sends them', { options: OPTIONS }, async ($, on) => {
  let failLists = false
  on('fs.list', { path: PARTITION_DIR }, ($, e, next) => (failLists ? { deny: `EIO: ${e.path}` } : next(e)))
  const world = setUp(on)
  world.replies = [DATASET_MISSING]
  await startSession($)
  await leaveIdle($, world)
  const parked = parkedIn(world, 'retry')
  world.replies = [OK_INSERT]
  failLists = true
  await idleFor(world, 1)
  expect(parkedIn(world, 'retry')).toEqual(parked)
  expect(await statusText($)).toMatch(/last backfill \(recovery, [^)]*\): 0 file\(s\), 0 rows sent, 0 left; stopped: cannot list .*EIO/)
  failLists = false
  await idleFor(world, 2)
  expect(deadLetterRows(world).length).toBe(0)
})

test('rows refused on a send, then on a replay whose answer lands none, all count on the status line', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [DATASET_MISSING]
  await startSession($)
  await leaveIdle($, world)
  expect(parkedIn(world, 'retry').length).toBe(1)
  // The tool call's two rows are refused whole on their send; then the
  // replay's answer refuses the parked row. No row has landed.
  world.replies = [INVALID, FIRST_REFUSED]
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await idleFor(world, 2)
  expect(parkedIn(world, 'retry')).toEqual([])
  expect(parkedIn(world, 'rejected').length).toBe(3)
  expect(await statusText($)).toMatch(/rows: captured 3, sent 0,/)
  expect(world.statusLines.at(-1)).toBe('BQAA: 3 row(s) refused (invalid: no such field: extra); fix, then /bqaa-backfill')
})

test('a replay whose rows BigQuery only asks for again leaves the refused count on the status line, until rows land', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [DATASET_MISSING]
  await startSession($)
  await leaveIdle($, world)
  world.replies = [INVALID, FIRST_AGAIN]
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await idleFor(world, 2)
  expect(parkedIn(world, 'retry').length).toBe(1)
  expect(world.statusLines.at(-1) ?? '').toMatch(/^BQAA: 2 row\(s\) refused \(HTTP 400: Invalid value for the table schema\); fix, then \/bqaa-backfill$/)
  world.replies = [OK_INSERT]
  await idleFor(world, 2)
  expect(parkedIn(world, 'retry')).toEqual([])
  expect(world.statusLines.at(-1)).toBeUndefined()
})

test('a replay BigQuery answers with a 401, and again with a fresh token, is the credentials notice, as a send is', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [DATASET_MISSING]
  await startSession($)
  await leaveIdle($, world)
  expect((await band($)).line ?? '').toMatch(/BigQuery cannot find the dataset/)
  world.replies = [UNAUTHENTICATED]
  const requests = world.insertCalls().length
  await idleFor(world, 1)
  expect((await band($)).line ?? '').toMatch(/^rows are not being written: no working Google credentials\. /)
  // Each replay tries once more with a fresh token.
  expect((world.insertCalls().length - requests) % 2).toBe(0)
  expect(parkedIn(world, 'retry').length).toBe(1)
})

test('/bqaa-backfill run again while access is denied counts the rows it refuses again once', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [DENIED]
  await startSession($)
  await world.clock.advance(5000)
  expect((await band($)).waiting).toBe(' 1 row(s) waiting.')
  for (let i = 0; i < 2; i += 1) {
    await $.command.run({ command: 'bqaa-backfill', args: '', ...COMMAND })
    await world.clock.advance(1000)
  }
  expect(world.insertCalls().length).toBe(3)
  expect((await band($)).waiting).toBe(' 1 row(s) waiting.')
  expect(parkedIn(world, 'rejected').length).toBe(1)
})

test('an idle replay of many parked rows stops between requests for rows queued meanwhile: they go first, then the replay goes on', async () => {
  // A writer built by hand. Its rows are parked after one try, all in one
  // file; the replay then sends one row a request.
  const base = resolveConfig({ project: 'my-gcp-project', dataset: 'agent_analytics', deadLetterDir: '/dl' }, {})
  let config = { ...base, maxRetries: 0 }
  let now = 0
  let answer = DATASET_MISSING
  let holdNext = false
  let release: (() => void) | null = null
  const timers: { at: number; fn: () => void; live: boolean }[] = []
  const files = new Map<string, string>()
  const sent: string[][] = []
  const io: Io = {
    now: () => now,
    after: (ms, fn) => {
      const timer = { at: now + ms, fn, live: true }
      timers.push(timer)
      return { cancel: () => (timer.live = false) }
    },
    fetch: async (url, init) => {
      if (answer === OK_INSERT) sent.push(idsOf(init.body ?? '{"rows":[]}'))
      if (holdNext) {
        holdNext = false
        await new Promise<void>(resolve => (release = resolve))
      }
      return answer
    },
    runCommand: async () => ({ exitCode: 0, stdout: `${'a'.repeat(24)}\n`, stderr: '' }),
    envToken: async () => undefined,
    writeFile: async (path, text) => {
      files.set(path, text)
    },
    readFile: async path => files.get(path) ?? '',
    listDir: async dir => [...files].filter(([path]) => path.startsWith(`${dir}/`)).map(([path, text]) => ({ name: path.slice(dir.length + 1), kind: 'file', size: text.length })),
    storeGet: async () => undefined,
    storeSet: async () => undefined,
    storeDelete: async () => undefined,
    status: () => undefined,
    debug: () => undefined,
  }
  const writer = new Writer(io, () => config, () => 'hand-built-session')
  const tick = async (): Promise<void> => {
    now += 31_000
    for (const timer of timers.filter(t => t.live && t.at <= now).sort((a, b) => a.at - b.at)) {
      timer.live = false
      timer.fn()
    }
    await writer.flush()
  }
  const row = (n: number) => buildRow({ eventType: 'STATE_DELTA', timestampMs: 0, eventId: String(n).repeat(32), agent: 'coding-agent', sessionId: 'hand-built-session', invocationId: null, userId: 'dev', traceId: null, spanId: null, parentSpanId: null, content: {}, attributes: {}, maxPayloadChars: 16384 }).row
  for (const n of [1, 2, 3]) writer.enqueue(row(n), 0)
  await tick()
  expect(writer.queue.length).toBe(0)
  config = { ...base, maxBatchRows: 1 }
  answer = OK_INSERT
  // The replay's first request takes a while; a row is queued meanwhile.
  holdNext = true
  const flushing = tick()
  for (let i = 0; i < 10 && release === null; i += 1) await Promise.resolve()
  writer.enqueue(row(4), 0)
  ;(release as (() => void) | null)?.()
  await flushing
  // It stopped for the queued row, which is no failure: no backoff.
  expect(writer.snapshot().consecutiveFailures).toBe(0)
  for (let t = 0; t < 4; t += 1) await tick()
  expect(sent).toEqual([['1'.repeat(32)], ['4'.repeat(32)], ['2'.repeat(32)], ['3'.repeat(32)]])
  expect([...files.values()].reduce((rows, text) => rows + parseFile(text).lines.length, 0)).toBe(0)
})

// insertAll refused the first row of the request and asked for the second again.
const FIRST_REFUSED_SECOND_AGAIN = {
  status: 200,
  text: JSON.stringify({
    insertErrors: [
      { index: 0, errors: [{ reason: 'invalid', message: 'no such field: extra' }] },
      { index: 1, errors: [{ reason: 'backendError', message: 'try again' }] },
    ],
  }),
}

test('a refused row whose file cannot be emptied is sent once: no further request or file, and the file is emptied once it can be', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [DATASET_MISSING]
  await startSession($)
  await leaveIdle($, world)
  const source = [...world.files.keys()].find(path => path.startsWith(`${PARTITION_DIR}/retry-`)) ?? ''
  const parked = parkedIn(world, 'retry')
  // The file can be read, but not emptied; new files can be written.
  world.refuseWrite = (path, text) => path === source && text === ''
  world.replies = [FIRST_REFUSED]
  const requests = world.insertCalls().length
  await idleFor(world, 5)
  expect(world.insertCalls().length).toBe(requests + 1)
  expect(parkedIn(world, 'rejected')).toEqual(parked)
  expect([...world.files].filter(([path, text]) => path.includes('/rejected-') && text !== '').length).toBe(1)
  expect(world.files.get(source) !== '').toBe(true)
  // The record that its rows are written out: a new writer (the next
  // session.start) sends none of it either.
  expect(world.store.get(`replayed:${TABLE_REF}/${source.split('/').pop()}`)).toEqual({ size: new TextEncoder().encode(world.files.get(source) ?? '').length })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/my-repo' })
  await idleFor(world, 2)
  expect(world.insertCalls().length).toBe(requests + 1)
  expect([...world.files].filter(([path, text]) => path.includes('/rejected-') && text !== '').length).toBe(1)
  world.refuseWrite = null
  await idleFor(world, 2)
  expect(world.files.get(source)).toBe('')
  expect(world.insertCalls().length).toBe(requests + 1)
  expect(parkedIn(world, 'rejected')).toEqual(parked)
  expect([...world.store.keys()].some(key => key.startsWith('replayed:'))).toBe(false)
})

test('a replay that can write only part of what it left sends nothing again, writes the rest under the same names once it can, then the rows left go on', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  const source = `${PARTITION_DIR}/retry-20261013T200102003Z-earlier-1.jsonl`
  const refused = 'a'.repeat(32)
  const asked = 'b'.repeat(32)
  world.files.set(source, packFiles([line(refused, 'retry'), line(asked, 'retry')])[0] as string)
  // New retry files cannot be written; rejected ones can.
  world.refuseWrite = (path, text) => path !== source && path.startsWith(`${PARTITION_DIR}/retry-`) && text !== ''
  world.replies = [FIRST_REFUSED_SECOND_AGAIN]
  await startSession($)
  await world.clock.advance(20_000)
  const sent = (id: string) => world.sentRows().filter(row => row.event_id === id).length
  expect(sent(refused)).toBe(1)
  expect(parkedIn(world, 'rejected')).toEqual([refused])
  const files = world.files.size
  await idleFor(world, 5)
  expect(sent(refused)).toBe(1)
  expect(sent(asked)).toBe(1)
  expect(world.files.size).toBe(files)
  // Writes work again: the rest is written, the source emptied, and the row
  // asked for again goes on, the refused one never.
  world.refuseWrite = null
  world.replies = [OK_INSERT]
  await idleFor(world, 3)
  expect(world.files.get(source)).toBe('')
  expect(sent(refused)).toBe(1)
  expect(sent(asked)).toBe(2)
  expect(parkedIn(world, 'retry')).toEqual([])
  expect(parkedIn(world, 'rejected')).toEqual([refused])
})

test('a file whose rows a replay of another session already wrote out is not sent again: it is only emptied', { options: OPTIONS }, async ($, on) => {
  const source = `${PARTITION_DIR}/retry-20261013T200102003Z-earlier-1.jsonl`
  const text = packFiles([line('c'.repeat(32), 'retry')])[0] as string
  const written = packFiles([line('c'.repeat(32), 'rejected')])[0] as string
  const world = setUp(on, {}, { [`replayed:${TABLE_REF}/retry-20261013T200102003Z-earlier-1.jsonl`]: { size: new TextEncoder().encode(text).length } })
  world.files.set(source, text)
  world.files.set(`${PARTITION_DIR}/rejected-20261013T200103003Z-earlier-2.jsonl`, written)
  await startSession($)
  await world.clock.advance(20_000)
  expect(world.sentRows().some(row => row.event_id === 'c'.repeat(32))).toBe(false)
  expect(world.files.get(source)).toBe('')
  expect([...world.store.keys()].some(key => key.startsWith('replayed:'))).toBe(false)
  expect(parkedIn(world, 'rejected')).toEqual(['c'.repeat(32)])
})

test("a row an earlier session refused, refused again by /bqaa-backfill while access is denied, counts once in the band", { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.files.set(`${PARTITION_DIR}/rejected-20261013T200102003Z-earlier-1.jsonl`, packFiles([line('d'.repeat(32), 'rejected')])[0] as string)
  await startSession($)
  await world.clock.advance(5000)
  world.replies = [DENIED]
  await $.command.run({ command: 'bqaa-backfill', args: '', ...COMMAND })
  await world.clock.advance(1000)
  expect((await band($)).waiting).toBe(' 1 row(s) waiting.')
})

test('a later request of the same replay that lands rows ends the refused count of the requests before it', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.files.set(`${PARTITION_DIR}/retry-20261013T200102003Z-earlier-1.jsonl`, packFiles([line('e'.repeat(32), 'retry')])[0] as string)
  world.files.set(`${PARTITION_DIR}/retry-20261013T200102003Z-earlier-2.jsonl`, packFiles([line('f'.repeat(32), 'retry')])[0] as string)
  await startSession($)
  await world.clock.advance(5000)
  world.replies = [FIRST_REFUSED, OK_INSERT]
  await $.command.run({ command: 'bqaa-backfill', args: '', ...COMMAND })
  await world.clock.advance(1000)
  expect(parkedIn(world, 'rejected')).toEqual(['e'.repeat(32)])
  expect(world.statusLines.at(-1)).toBeUndefined()
})

test('a row refused again after rows landed counts again: the count is of rows refused since rows last landed', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [INVALID]
  await startSession($)
  await world.clock.advance(5000)
  expect(parkedIn(world, 'rejected').length).toBe(1)
  expect(world.statusLines.at(-1) ?? '').toMatch(/^BQAA: 1 row\(s\) refused/)
  // Rows land, then /bqaa-backfill sends the refused row, refused again.
  world.replies = [OK_INSERT]
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await world.clock.advance(5000)
  expect(world.statusLines.at(-1)).toBeUndefined()
  world.replies = [INVALID]
  await $.command.run({ command: 'bqaa-backfill', args: '', ...COMMAND })
  await world.clock.advance(1000)
  expect(world.statusLines.at(-1) ?? '').toMatch(/^BQAA: 1 row\(s\) refused/)
})

test('a row denied again under a later access-denied notice counts in that notice', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [DENIED]
  await startSession($)
  await world.clock.advance(5000)
  expect((await band($)).waiting).toBe(' 1 row(s) waiting.')
  // Access comes back (rows land), then goes again.
  world.replies = [OK_INSERT]
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await world.clock.advance(5000)
  expect((await band($)).line).toBeUndefined()
  world.replies = [DENIED]
  await $.command.run({ command: 'bqaa-backfill', args: '', ...COMMAND })
  await world.clock.advance(1000)
  expect((await band($)).waiting).toBe(' 1 row(s) waiting.')
})

test('/bqaa-backfill run again with BigQuery still refusing a row counts it once on the status line', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [INVALID]
  await startSession($)
  await world.clock.advance(5000)
  for (let i = 0; i < 2; i += 1) {
    await $.command.run({ command: 'bqaa-backfill', args: '', ...COMMAND })
    await world.clock.advance(1000)
  }
  expect(world.insertCalls().length).toBe(3)
  expect(world.statusLines.at(-1) ?? '').toMatch(/^BQAA: 1 row\(s\) refused/)
})

test('a file written out under a kept outcome is never written again: one /bqaa-backfill sent and emptied meanwhile stays empty', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  const source = `${PARTITION_DIR}/retry-20261013T200102003Z-earlier-1.jsonl`
  const refused = 'a'.repeat(32)
  world.files.set(source, packFiles([line(refused, 'retry'), line('b'.repeat(32), 'retry')])[0] as string)
  world.refuseWrite = (path, text) => path !== source && path.startsWith(`${PARTITION_DIR}/retry-`) && text !== ''
  world.replies = [FIRST_REFUSED_SECOND_AGAIN]
  await startSession($)
  await world.clock.advance(20_000)
  const rejectedFile = [...world.files.keys()].find(path => path.startsWith(`${PARTITION_DIR}/rejected-`)) ?? ''
  expect(parkedIn(world, 'rejected')).toEqual([refused])
  // The refused row's cause is fixed, and /bqaa-backfill sends its file.
  world.replies = [OK_INSERT]
  await $.command.run({ command: 'bqaa-backfill', args: '', ...COMMAND })
  await world.clock.advance(1000)
  expect(world.files.get(rejectedFile)).toBe('')
  world.refuseWrite = null
  await idleFor(world, 3)
  expect(world.files.get(rejectedFile)).toBe('')
  expect(world.files.get(source)).toBe('')
  expect(parkedIn(world, 'rejected')).toEqual([])
  expect(world.sentRows().filter(row => row.event_id === refused).length).toBe(2)
})
