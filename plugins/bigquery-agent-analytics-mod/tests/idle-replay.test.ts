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
import { parseFile, packFiles, sealFile } from '../hooks/lib/deadletter.ts'
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
  expect(shown.line).toBe('rows are not being written: BigQuery denied the identity access to the dataset. To fix, ask for roles/bigquery.dataEditor on my-gcp-project.agent_analytics, then run /bqaa-backfill.')
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
  expect(world.store.get(`replayed:${TABLE_REF}/${source.split('/').pop()}`)).toMatchObject({ size: new TextEncoder().encode(world.files.get(source) ?? '').length, fates: 'R', written: [true] })
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

test('a file whose replay record cannot be read stays due: the replays that run by themselves send none of it, and empty it once the record can be read', { options: OPTIONS }, async ($, on) => {
  const name = 'retry-20261013T200102003Z-earlier-1.jsonl'
  let unreadable = false
  on('store.get', { key: `replayed:${TABLE_REF}/${name}` }, ($, e, next) => (unreadable ? { deny: 'the store could not be read' } : next(e)))
  const world = setUp(on)
  const source = `${PARTITION_DIR}/${name}`
  world.files.set(source, packFiles([line('a'.repeat(32), 'retry')])[0] as string)
  world.refuseWrite = (path, text) => path === source && text === ''
  world.replies = [FIRST_REFUSED]
  await startSession($)
  await world.clock.advance(20_000)
  const requests = world.insertCalls().length
  const copies = () => parkedIn(world, 'rejected').filter(id => id === 'a'.repeat(32)).length
  expect(copies()).toBe(1)
  unreadable = true
  world.refuseWrite = null
  await idleFor(world, 5)
  expect(world.insertCalls().length).toBe(requests)
  expect(world.files.get(source) !== '').toBe(true)
  unreadable = false
  await idleFor(world, 3)
  expect(world.insertCalls().length).toBe(requests)
  expect(world.files.get(source)).toBe('')
  expect(copies()).toBe(1)
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
  const record = { size: new TextEncoder().encode(text).length, fates: 'R', reasons: ['invalid: no such field: extra'], refusals: [0], files: [`${PARTITION_DIR}/rejected-20261013T200103003Z-earlier-2.jsonl`], written: [true], waits: false }
  const world = setUp(on, {}, { [`replayed:${TABLE_REF}/retry-20261013T200102003Z-earlier-1.jsonl`]: record })
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

test('what a replay left, only partly written, is finished by the next session.start\'s writer: the refused row is never sent again, nor copied', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  const source = `${PARTITION_DIR}/retry-20261013T200102003Z-earlier-1.jsonl`
  const refused = 'a'.repeat(32)
  const asked = 'b'.repeat(32)
  world.files.set(source, packFiles([line(refused, 'retry'), line(asked, 'retry')])[0] as string)
  world.refuseWrite = (path, text) => path !== source && path.startsWith(`${PARTITION_DIR}/retry-`) && text !== ''
  world.replies = [FIRST_REFUSED_SECOND_AGAIN]
  await startSession($)
  await world.clock.advance(20_000)
  const sent = (id: string) => world.sentRows().filter(row => row.event_id === id).length
  const copies = () => [...world.files].filter(([path, text]) => path.includes('/rejected-') && text !== '').length
  expect(sent(refused)).toBe(1)
  expect(copies()).toBe(1)
  // Three more session.start runs, each with a new writer, while what is
  // left still cannot all be written.
  for (let i = 0; i < 3; i += 1) {
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/my-repo' })
    await world.clock.advance(20_000)
  }
  expect(sent(refused)).toBe(1)
  expect(copies()).toBe(1)
  world.refuseWrite = null
  world.replies = [OK_INSERT]
  await idleFor(world, 3)
  expect(world.files.get(source)).toBe('')
  expect(sent(refused)).toBe(1)
  expect(copies()).toBe(1)
  expect(parkedIn(world, 'retry')).toEqual([])
  expect(world.sentRows().filter(row => row.event_id === asked).length >= 2).toBe(true)
  expect([...world.store.keys()].some(key => key.startsWith('replayed:'))).toBe(false)
})

// Two writers of their own, as two sessions have, on one dead-letter
// directory and one store, which takes no more than 4 MiB of JSON in all, as
// the host's. BigQuery gives `answer` for the ids of each request.
function twoWriters(answer: (ids: string[]) => { status: number; text: string }) {
  const config = resolveConfig({ project: 'my-gcp-project', dataset: 'agent_analytics', deadLetterDir: '/dl' }, {})
  const files = new Map<string, string>()
  const store = new Map<string, unknown>()
  const sent: string[] = []
  const bytes = (text: string): number => new TextEncoder().encode(text).length
  let refuseWrite: ((path: string, text: string) => boolean) | null = null
  // Writes cut off part-way: half the text lands, then the write fails.
  let tearWrite: ((path: string, text: string) => boolean) | null = null
  // Holds a session's requests until it is let go.
  let gate: ((session: string) => Promise<void> | undefined) | null = null
  const statuses: (string | undefined)[] = []
  // `from`: the store takes that many of a replay's records, then no more.
  // `get` may name the keys whose reads fail.
  let storeFails: { get?: boolean | ((key: string) => boolean); set?: boolean; from?: number } = {}
  let records = 0
  const io = (session: string): Io => ({
    now: () => 0,
    after: () => ({ cancel: () => undefined }),
    fetch: async (url, init) => {
      const ids = idsOf(init.body ?? '{"rows":[]}')
      sent.push(...ids)
      await gate?.(session)
      return answer(ids)
    },
    runCommand: async () => ({ exitCode: 0, stdout: `${'a'.repeat(24)}\n`, stderr: '' }),
    envToken: async () => undefined,
    writeFile: async (path, text) => {
      if (refuseWrite?.(path, text)) throw new Error(`EACCES: ${path} (${session})`)
      if (tearWrite?.(path, text)) {
        files.set(path, text.slice(0, Math.floor(text.length / 2)))
        throw new Error(`EIO: ${path} cut off (${session})`)
      }
      files.set(path, text)
    },
    readFile: async path => files.get(path) ?? '',
    listDir: async dir => [...files].filter(([path]) => path.startsWith(`${dir}/`)).map(([path, text]) => ({ name: path.slice(dir.length + 1), kind: 'file', size: bytes(text) })),
    storeGet: async key => {
      if (key.startsWith('replayed:') && (storeFails.get === true || (typeof storeFails.get === 'function' && storeFails.get(key)))) throw new Error('the store could not be read')
      return store.get(key)
    },
    storeSet: async (key, value) => {
      if (key.startsWith('replayed:') && (storeFails.set || (storeFails.from !== undefined && records >= storeFails.from))) throw new Error('the store could not be written')
      if (key.startsWith('replayed:')) records += 1
      const json = JSON.parse(JSON.stringify(value)) as unknown
      if (bytes(JSON.stringify(Object.fromEntries(new Map(store).set(key, json)))) > 4 * 1024 * 1024) throw new Error('the store would pass 4 MiB of JSON')
      store.set(key, json)
    },
    storeDelete: async key => void store.delete(key),
    status: text => void statuses.push(text),
    debug: () => undefined,
  })
  return {
    config,
    files,
    store,
    sent,
    statuses,
    writer: (session: string) => new Writer(io(session), () => config, () => session),
    // Refuses the writes of what is left to the paths `f` picks.
    refuse: (f: ((path: string) => boolean) | null) => (refuseWrite = f === null ? null : (path, text) => text !== '' && f(path)),
    // Refuses the writes `f` picks, emptying a file included.
    refuseWrites: (f: ((path: string, text: string) => boolean) | null) => (refuseWrite = f),
    failStore: (fails: { get?: boolean | ((key: string) => boolean); set?: boolean; from?: number }) => (storeFails = fails),
    tear: (f: ((path: string, text: string) => boolean) | null) => (tearWrite = f),
    hold: (f: ((session: string) => Promise<void> | undefined) | null) => (gate = f),
    sentOf: (id: string) => sent.filter(x => x === id).length,
    copiesOf: (id: string) => [...files].filter(([path, text]) => path.includes('/rejected-') && text !== '').flatMap(([, text]) => parseFile(text).lines).filter(l => l.row.event_id === id).length,
  }
}

test('another session\'s writer resumes what a replay left only partly written: it sends none of it, writes the rest, and empties the file', async () => {
  const w = twoWriters(() => FIRST_REFUSED_SECOND_AGAIN)
  const source = `/dl/${TABLE_REF}/retry-20261013T200102003Z-earlier-1.jsonl`
  w.files.set(source, packFiles([line('a'.repeat(32), 'retry'), line('b'.repeat(32), 'retry')])[0] as string)
  w.refuse(path => path !== source && path.includes('/retry-'))
  await w.writer('first-session').backfill(['spill', 'retry'], 'auto')
  expect(w.sent).toEqual(['a'.repeat(32), 'b'.repeat(32)])
  // The other session, with writes working again.
  w.refuse(null)
  const report = await w.writer('second-session').backfill(['spill', 'retry'], 'auto')
  expect(w.sent).toEqual(['a'.repeat(32), 'b'.repeat(32)])
  // Its last-backfill line counts the file it finished, what it left, and
  // how many of those were refused.
  expect(report).toMatchObject({ files: 1, rowsSent: 0, rowsLeft: 2, rowsRefused: 1 })
  expect(w.files.get(source)).toBe('')
  const lines = [...w.files].filter(([, text]) => text !== '').flatMap(([path, text]) => parseFile(text).lines.map(l => `${path.includes('/rejected-') ? 'rejected' : 'retry'}:${l.row.event_id.slice(0, 1)}`))
  expect(lines.sort()).toEqual(['rejected:a', 'retry:b'])
  expect([...w.store.keys()]).toEqual([])
})

test('an outcome recorded before any of what is left was written: the next writer writes all of it from the record, sending nothing', async () => {
  const w = twoWriters(() => FIRST_REFUSED_SECOND_AGAIN)
  const source = `/dl/${TABLE_REF}/retry-20261013T200102003Z-earlier-1.jsonl`
  w.files.set(source, packFiles([line('a'.repeat(32), 'retry'), line('b'.repeat(32), 'retry')])[0] as string)
  // No file can be written: the record is, then the first write fails.
  w.refuse(path => path.includes(`/dl/${TABLE_REF}/`) && path !== source)
  await w.writer('first-session').backfill(['spill', 'retry'], 'auto')
  const record = w.store.get(`replayed:${TABLE_REF}/retry-20261013T200102003Z-earlier-1.jsonl`) as { fates: string; written: boolean[] }
  expect(record).toMatchObject({ fates: 'RW', written: [false, false] })
  w.refuse(null)
  await w.writer('second-session').backfill(['spill', 'retry'], 'auto')
  expect(w.sent.length).toBe(2)
  expect(w.files.get(source)).toBe('')
  expect([...w.files].filter(([, text]) => text !== '').length).toBe(2)
})

test('past the 10,000 rows a count keeps, a row refused again may count again, and the status line says about', async () => {
  const config = resolveConfig({ project: 'my-gcp-project', dataset: 'agent_analytics', deadLetterDir: '/dl' }, {})
  const files = new Map<string, string>()
  const statuses: (string | undefined)[] = []
  // Every row of every request refused.
  const refuseAll = (body: string) => ({ status: 200, text: JSON.stringify({ insertErrors: idsOf(body).map((id, index) => ({ index, errors: [{ reason: 'invalid', message: 'no such field: extra' }] })) }) })
  const io: Io = {
    now: () => 0,
    after: () => ({ cancel: () => undefined }),
    fetch: async (url, init) => refuseAll(init.body ?? '{"rows":[]}'),
    runCommand: async () => ({ exitCode: 0, stdout: `${'a'.repeat(24)}\n`, stderr: '' }),
    envToken: async () => undefined,
    writeFile: async (path, text) => void files.set(path, text),
    readFile: async path => files.get(path) ?? '',
    listDir: async dir => [...files].filter(([path]) => path.startsWith(`${dir}/`)).map(([path, text]) => ({ name: path.slice(dir.length + 1), kind: 'file', size: new TextEncoder().encode(text).length })),
    storeGet: async () => undefined,
    storeSet: async () => undefined,
    storeDelete: async () => undefined,
    status: text => void statuses.push(text),
    debug: () => undefined,
  }
  const ids = Array.from({ length: 10_001 }, (_, n) => n.toString(16).padStart(32, '0'))
  packFiles(ids.map(id => line(id, 'rejected'))).forEach((text, n) => files.set(`/dl/${TABLE_REF}/rejected-20261013T200102003Z-earlier-${n + 1}.jsonl`, text))
  const writer = new Writer(io, () => config, () => 'hand-built-session')
  await writer.backfill(['spill', 'retry', 'rejected'], 'command')
  expect(statuses.at(-1) ?? '').toMatch(/^BQAA: about 10001 row\(s\) refused /)
  await writer.backfill(['spill', 'retry', 'rejected'], 'command')
  expect(statuses.at(-1) ?? '').toMatch(/^BQAA: about 10002 row\(s\) refused /)
})

test('a file of what is left that one writer wrote, and /bqaa-backfill sent and emptied, is never written again by the writer that finishes the outcome', async () => {
  let answer = FIRST_REFUSED_SECOND_AGAIN
  const w = twoWriters(() => answer)
  const source = `/dl/${TABLE_REF}/retry-20261013T200102003Z-earlier-1.jsonl`
  w.files.set(source, packFiles([line('a'.repeat(32), 'retry'), line('b'.repeat(32), 'retry')])[0] as string)
  w.refuse(path => path !== source && path.includes('/retry-'))
  await w.writer('first-session').backfill(['spill', 'retry'], 'auto')
  const rejectedFile = [...w.files.keys()].find(path => path.includes('/rejected-')) ?? ''
  // The refused row's cause is fixed: another session's /bqaa-backfill sends
  // the rejected file and empties it (what is left of the source still
  // cannot be written).
  answer = OK_INSERT
  await w.writer('second-session').backfill(['spill', 'retry', 'rejected'], 'command')
  expect(w.files.get(rejectedFile)).toBe('')
  w.refuse(null)
  await w.writer('third-session').backfill(['spill', 'retry'], 'auto')
  expect(w.files.get(source)).toBe('')
  expect(w.files.get(rejectedFile)).toBe('')
  expect(w.sent.filter(id => id === 'a'.repeat(32)).length).toBe(2)
})

test('a record that does not fit the file (another size) is not trusted: the file is replayed, never emptied unsent', async () => {
  const w = twoWriters(() => OK_INSERT)
  const name = 'retry-20261013T200102003Z-earlier-1.jsonl'
  const source = `/dl/${TABLE_REF}/${name}`
  w.files.set(source, packFiles([line('c'.repeat(32), 'retry')])[0] as string)
  w.store.set(`replayed:${TABLE_REF}/${name}`, { size: 1, fates: 'L', reasons: [], refusals: [], files: [], written: [], waits: false })
  await w.writer('a-session').backfill(['spill', 'retry'], 'auto')
  expect(w.sent).toEqual(['c'.repeat(32)])
  expect(w.files.get(source)).toBe('')
})

test('a writer back after another one finished its outcome, and replayed what it left, writes none of it again: the refused row goes twice in all, and is copied once', async () => {
  let answer = FIRST_REFUSED_SECOND_AGAIN
  const w = twoWriters(() => answer)
  const source = `/dl/${TABLE_REF}/retry-20261013T200102003Z-earlier-1.jsonl`
  const [a, b] = ['a'.repeat(32), 'b'.repeat(32)]
  w.files.set(source, packFiles([line(a, 'retry'), line(b, 'retry')])[0] as string)
  // The first writer records the outcome, and can write none of what is left.
  const first = w.writer('first-session')
  w.refuse(path => path !== source)
  await first.backfill(['spill', 'retry'], 'auto')
  // Another session writes all of it, but cannot empty the source; its next
  // replay sends the row asked for again, and BigQuery refuses it.
  w.refuseWrites((path, text) => path === source && text === '')
  const second = w.writer('second-session')
  await second.backfill(['spill', 'retry'], 'auto')
  answer = FIRST_REFUSED
  await second.backfill(['spill', 'retry'], 'auto')
  expect([w.sentOf(b), w.copiesOf(b)]).toEqual([2, 1])
  // The first writer comes back, writes working: the record says all of what
  // is left is written, so it writes none of it again, only empties the file.
  w.refuseWrites(null)
  await first.backfill(['spill', 'retry'], 'auto')
  await first.backfill(['spill', 'retry'], 'auto')
  expect([w.sentOf(a), w.sentOf(b), w.copiesOf(a), w.copiesOf(b)]).toEqual([1, 2, 1, 1])
  expect(w.files.get(source)).toBe('')
  expect([...w.store.keys()]).toEqual([])
})

test('two writers that replay one file at the same time write what it left once', async () => {
  const w = twoWriters(() => FIRST_REFUSED)
  const source = `/dl/${TABLE_REF}/retry-20261013T200102003Z-earlier-1.jsonl`
  w.files.set(source, packFiles([line('a'.repeat(32), 'retry')])[0] as string)
  // Both read the lease before either writes it, and both send the row.
  await Promise.all([w.writer('first-session').backfill(['spill', 'retry'], 'auto'), w.writer('second-session').backfill(['spill', 'retry'], 'auto')])
  expect(w.copiesOf('a'.repeat(32))).toBe(1)
  expect(w.files.get(source)).toBe('')
})

test('a record that cannot be read leaves its file waiting: no writer sends any of it, and once it can be read the file is only emptied', async () => {
  const w = twoWriters(() => FIRST_REFUSED)
  const source = `/dl/${TABLE_REF}/retry-20261013T200102003Z-earlier-1.jsonl`
  const a = 'a'.repeat(32)
  w.files.set(source, packFiles([line(a, 'retry')])[0] as string)
  w.refuseWrites((path, text) => path === source && text === '')
  await w.writer('first-session').backfill(['spill', 'retry'], 'auto')
  expect([w.sentOf(a), w.copiesOf(a)]).toEqual([1, 1])
  w.failStore({ get: true })
  const second = w.writer('second-session')
  const report = await second.backfill(['spill', 'retry'], 'auto')
  expect([w.sentOf(a), w.copiesOf(a)]).toEqual([1, 1])
  expect(report.error ?? '').toMatch(/^cannot read the replay record of retry-20261013T200102003Z-earlier-1\.jsonl: the store could not be read/)
  expect(report.skippedFiles).toBe(1)
  w.failStore({})
  w.refuseWrites(null)
  await second.backfill(['spill', 'retry'], 'auto')
  expect([w.sentOf(a), w.copiesOf(a)]).toEqual([1, 1])
  expect(w.files.get(source)).toBe('')
})

test('a record the store does not take is kept in a file beside the source: another writer resumes it from there, sending nothing again, and both files are emptied once they can be', async () => {
  const w = twoWriters(() => FIRST_REFUSED)
  const name = 'retry-20261013T200102003Z-earlier-1.jsonl'
  const source = `/dl/${TABLE_REF}/${name}`
  const a = 'a'.repeat(32)
  w.files.set(source, packFiles([line(a, 'retry')])[0] as string)
  w.failStore({ set: true })
  w.refuseWrites((path, text) => path === source && text === '')
  await w.writer('first-session').backfill(['spill', 'retry'], 'auto')
  expect([w.sentOf(a), w.copiesOf(a)]).toEqual([1, 1])
  await w.writer('second-session').backfill(['spill', 'retry'], 'auto')
  expect([w.sentOf(a), w.copiesOf(a)]).toEqual([1, 1])
  expect([...w.store.keys()]).toEqual([])
  expect(w.files.get(`/dl/${TABLE_REF}/outcome-${name}`) ?? '').toMatch(/^\{"fates":"R",/)
  w.failStore({})
  w.refuseWrites(null)
  await w.writer('third-session').backfill(['spill', 'retry'], 'auto')
  expect([w.sentOf(a), w.copiesOf(a)]).toEqual([1, 1])
  expect([w.files.get(source), w.files.get(`/dl/${TABLE_REF}/outcome-${name}`)]).toEqual(['', ''])
  expect([...w.store.keys()]).toEqual([])
})

test('a record neither the store nor a file takes: nothing of what the replay left is written, and the writer sends none of it again until it can record it', async () => {
  const w = twoWriters(() => FIRST_REFUSED)
  const source = `/dl/${TABLE_REF}/retry-20261013T200102003Z-earlier-1.jsonl`
  const a = 'a'.repeat(32)
  const text = packFiles([line(a, 'retry')])[0] as string
  w.files.set(source, text)
  w.failStore({ set: true })
  w.refuseWrites(path => path.includes('/outcome-'))
  const writer = w.writer('a-session')
  const report = await writer.backfill(['spill', 'retry'], 'auto')
  await writer.backfill(['spill', 'retry'], 'auto')
  expect([w.sentOf(a), w.copiesOf(a)]).toEqual([1, 0])
  expect(w.files.get(source)).toBe(text)
  expect(report.error ?? '').toMatch(/could not record the replay of .*retry-20261013T200102003Z-earlier-1\.jsonl, so nothing more of what it left is written/)
  w.failStore({})
  w.refuseWrites(null)
  await writer.backfill(['spill', 'retry'], 'auto')
  expect([w.sentOf(a), w.copiesOf(a)]).toEqual([1, 1])
  expect(w.files.get(source)).toBe('')
})

test('a record the store took at first and then did not: what the file beside the source has as written counts too, so nothing replayed meanwhile is written again', async () => {
  let answer = FIRST_REFUSED_SECOND_AGAIN
  const w = twoWriters(() => answer)
  const source = `/dl/${TABLE_REF}/retry-20261013T200102003Z-earlier-1.jsonl`
  const [a, b] = ['a'.repeat(32), 'b'.repeat(32)]
  w.files.set(source, packFiles([line(a, 'retry'), line(b, 'retry')])[0] as string)
  // The store takes the first record (nothing written yet), then no more: the
  // file beside the source holds the rest. The source cannot be emptied.
  w.failStore({ from: 1 })
  w.refuseWrites((path, text) => path === source && text === '')
  const first = w.writer('first-session')
  await first.backfill(['spill', 'retry'], 'auto')
  expect(w.store.get(`replayed:${TABLE_REF}/retry-20261013T200102003Z-earlier-1.jsonl`)).toMatchObject({ written: [false, false] })
  // Its next replay sends the row asked for again, which BigQuery refuses.
  answer = FIRST_REFUSED
  await first.backfill(['spill', 'retry'], 'auto')
  expect([w.sentOf(b), w.copiesOf(b)]).toEqual([2, 1])
  w.failStore({})
  await w.writer('second-session').backfill(['spill', 'retry'], 'auto')
  await w.writer('second-session').backfill(['spill', 'retry'], 'auto')
  expect([w.sentOf(a), w.sentOf(b), w.copiesOf(a), w.copiesOf(b)]).toEqual([1, 2, 1, 1])
})

test('a record of the file\'s size that names fewer lines than the file holds is not trusted: the file is replayed, and no row is lost', async () => {
  const w = twoWriters(() => OK_INSERT)
  const name = 'retry-20261013T200102003Z-earlier-1.jsonl'
  const source = `/dl/${TABLE_REF}/${name}`
  const text = packFiles([line('c'.repeat(32), 'retry'), line('d'.repeat(32), 'retry')])[0] as string
  w.files.set(source, text)
  w.store.set(`replayed:${TABLE_REF}/${name}`, { size: new TextEncoder().encode(text).length, fates: 'W', reasons: [], refusals: [], files: [`/dl/${TABLE_REF}/retry-20261013T200103003Z-earlier-2.jsonl`], written: [false], waits: true })
  await w.writer('a-session').backfill(['spill', 'retry'], 'auto')
  expect(w.sent).toEqual(['c'.repeat(32), 'd'.repeat(32)])
  expect(w.files.get(source)).toBe('')
})

test('a replay record stays small whatever BigQuery says: 4,500 rows refused for as many reasons fit the store with 16 reasons kept, and another writer sends none of them again', async () => {
  const ids = Array.from({ length: 4500 }, (_, n) => n.toString(16).padStart(32, '0'))
  const w = twoWriters(chunk => ({ status: 200, text: JSON.stringify({ insertErrors: chunk.map((id, index) => ({ index, errors: [{ reason: 'invalid', message: `row ${id}: ${'x'.repeat(940)}` }] })) }) }))
  const name = 'retry-20261013T200102003Z-earlier-1.jsonl'
  const source = `/dl/${TABLE_REF}/${name}`
  const texts = packFiles(ids.map(id => line(id, 'retry')))
  expect(texts.length).toBe(1)
  w.files.set(source, texts[0] as string)
  w.refuseWrites((path, text) => path === source && text === '')
  await w.writer('first-session').backfill(['spill', 'retry'], 'auto')
  await w.writer('second-session').backfill(['spill', 'retry'], 'auto')
  expect(w.sent.length).toBe(4500)
  const record = w.store.get(`replayed:${TABLE_REF}/${name}`) as { reasons: string[] }
  expect(record.reasons.length).toBe(16)
  expect(record.reasons[15]).toBe('refused for another reason (a replay keeps 16 reasons a file)')
  expect(new TextEncoder().encode(JSON.stringify(record)).length < 64 * 1024).toBe(true)
  expect(w.files.has(`/dl/${TABLE_REF}/outcome-${name}`)).toBe(false)
  const rejected = [...w.files].filter(([path, text]) => path.includes('/rejected-') && text !== '').flatMap(([, text]) => parseFile(text).lines)
  expect(rejected.length).toBe(4500)
  expect(rejected.find(l => l.row.event_id === ids[0])?.reason).toMatch(new RegExp(`row ${ids[0]}: x`))
  expect(rejected.find(l => l.row.event_id === ids[4499])?.reason).toBe('refused for another reason (a replay keeps 16 reasons a file)')
})

test('a record in the store that no longer fits the file does not hide the one beside it: the file is only emptied, and nothing is sent', async () => {
  const w = twoWriters(() => FIRST_REFUSED)
  const name = 'retry-20261013T200102003Z-earlier-1.jsonl'
  const source = `/dl/${TABLE_REF}/${name}`
  const rejected = `/dl/${TABLE_REF}/rejected-20261013T200103003Z-earlier-2.jsonl`
  const text = packFiles([line('c'.repeat(32), 'retry')])[0] as string
  const size = new TextEncoder().encode(text).length
  w.files.set(source, text)
  w.files.set(rejected, packFiles([line('c'.repeat(32), 'rejected')])[0] as string)
  w.store.set(`replayed:${TABLE_REF}/${name}`, { size, fates: 'WW', reasons: [], refusals: [], files: [`/dl/${TABLE_REF}/retry-20261013T200103003Z-earlier-3.jsonl`], written: [false], waits: true })
  w.files.set(`/dl/${TABLE_REF}/outcome-${name}`, sealFile(`${JSON.stringify({ size, fates: 'R', reasons: ['invalid: no such field: extra'], refusals: [0], files: [rejected], written: [true], waits: false })}\n`))
  await w.writer('a-session').backfill(['spill', 'retry'], 'auto')
  expect(w.sent).toEqual([])
  expect([w.files.get(source), w.files.get(`/dl/${TABLE_REF}/outcome-${name}`)]).toEqual(['', ''])
  expect(w.copiesOf('c'.repeat(32))).toBe(1)
})

test('a record beside the file that does not fit it is emptied with the replay afresh, so no later replay sends the file again', async () => {
  const w = twoWriters(() => FIRST_REFUSED)
  const name = 'retry-20261013T200102003Z-earlier-1.jsonl'
  const source = `/dl/${TABLE_REF}/${name}`
  const text = packFiles([line('c'.repeat(32), 'retry')])[0] as string
  w.files.set(source, text)
  w.files.set(`/dl/${TABLE_REF}/outcome-${name}`, sealFile(`${JSON.stringify({ size: new TextEncoder().encode(text).length, fates: 'WW', reasons: [], refusals: [], files: [`/dl/${TABLE_REF}/retry-20261013T200103003Z-earlier-3.jsonl`], written: [false], waits: true })}\n`))
  // The source cannot be emptied, so the new outcome's record stays.
  w.refuseWrites((path, text) => path === source && text === '')
  const writer = w.writer('a-session')
  for (let i = 0; i < 3; i += 1) await writer.backfill(['spill', 'retry'], 'auto')
  await w.writer('another-session').backfill(['spill', 'retry'], 'auto')
  expect([w.sentOf('c'.repeat(32)), w.copiesOf('c'.repeat(32))]).toEqual([1, 1])
  expect(w.files.get(`/dl/${TABLE_REF}/outcome-${name}`)).toBe('')
})

test('a record update beside the source cut off part-way leaves the one before it whole: no writer sends the file again, and the next one finishes it', async () => {
  const w = twoWriters(() => FIRST_REFUSED)
  const source = `/dl/${TABLE_REF}/retry-20261013T200102003Z-earlier-1.jsonl`
  const a = 'a'.repeat(32)
  w.files.set(source, packFiles([line(a, 'retry')])[0] as string)
  w.failStore({ set: true })
  // The record's first update, after the rejected file is written, is cut off.
  let records = 0
  w.tear((path, text) => path.includes('/outcome-') && text !== '' && ++records === 2)
  await w.writer('first-session').backfill(['spill', 'retry'], 'auto')
  expect([w.sentOf(a), w.copiesOf(a)]).toEqual([1, 1])
  for (const session of ['second-session', 'third-session']) await w.writer(session).backfill(['spill', 'retry'], 'auto')
  expect([w.sentOf(a), w.copiesOf(a)]).toEqual([1, 1])
  expect(w.files.get(source)).toBe('')
  // Both files that held the record are emptied with it.
  expect([...w.files].filter(([path, text]) => path.includes('/outcome-') && text !== '')).toEqual([])
})

test('a first record cut off part-way, with none whole: the writer that holds the outcome writes it again, and sends nothing again', async () => {
  const w = twoWriters(() => FIRST_REFUSED)
  const source = `/dl/${TABLE_REF}/retry-20261013T200102003Z-earlier-1.jsonl`
  const a = 'a'.repeat(32)
  w.files.set(source, packFiles([line(a, 'retry')])[0] as string)
  w.failStore({ set: true })
  let records = 0
  w.tear((path, text) => path.includes('/outcome-') && text !== '' && ++records === 1)
  const writer = w.writer('a-session')
  await writer.backfill(['spill', 'retry'], 'auto')
  expect([w.sentOf(a), w.copiesOf(a)]).toEqual([1, 0])
  await writer.backfill(['spill', 'retry'], 'auto')
  expect([w.sentOf(a), w.copiesOf(a)]).toEqual([1, 1])
  expect(w.files.get(source)).toBe('')
})

test('a first record cut off part-way, with none whole, its writer gone: replays that run by themselves leave the file waiting, and /bqaa-backfill replays it afresh', async () => {
  const w = twoWriters(() => FIRST_REFUSED)
  const source = `/dl/${TABLE_REF}/retry-20261013T200102003Z-earlier-1.jsonl`
  const a = 'a'.repeat(32)
  w.files.set(source, packFiles([line(a, 'retry')])[0] as string)
  w.failStore({ set: true })
  let records = 0
  w.tear((path, text) => path.includes('/outcome-') && text !== '' && ++records === 1)
  await w.writer('first-session').backfill(['spill', 'retry'], 'auto')
  const report = await w.writer('second-session').backfill(['spill', 'retry'], 'auto')
  expect([w.sentOf(a), w.copiesOf(a)]).toEqual([1, 0])
  expect(report.error ?? '').toMatch(/cut off part-way; \/bqaa-backfill replays the file afresh/)
  // The store takes records again: the one cut off goes with the file.
  w.failStore({})
  await w.writer('third-session').backfill(['spill', 'retry', 'rejected'], 'command')
  expect([w.sentOf(a), w.copiesOf(a)]).toEqual([2, 1])
  expect(w.files.get(source)).toBe('')
  expect([...w.files].filter(([path, text]) => path.includes('/outcome-') && text !== '')).toEqual([])
})

test('a file of what is left, written while its record could not be updated, is not replayed until the record has it: then its rows go once', async () => {
  let answer = FIRST_REFUSED_SECOND_AGAIN
  const w = twoWriters(() => answer)
  const source = `/dl/${TABLE_REF}/retry-20261013T200102003Z-earlier-1.jsonl`
  const [a, b] = ['a'.repeat(32), 'b'.repeat(32)]
  w.files.set(source, packFiles([line(a, 'retry'), line(b, 'retry')])[0] as string)
  // The store takes the first two records; once the retry file of what is
  // left is written, no record can be kept anywhere.
  w.failStore({ from: 2 })
  w.refuseWrites(path => path.includes('/outcome-'))
  await w.writer('first-session').backfill(['spill', 'retry'], 'auto')
  expect(w.store.get(`replayed:${TABLE_REF}/retry-20261013T200102003Z-earlier-1.jsonl`)).toMatchObject({ written: [true, false] })
  w.failStore({})
  w.refuseWrites(null)
  answer = FIRST_REFUSED
  // The next writer leaves that retry file waiting, finishes the source's
  // outcome (writing it again, unreplayed), then replays it.
  const next = w.writer('second-session')
  await next.backfill(['spill', 'retry'], 'auto')
  expect(w.sentOf(b)).toBe(1)
  await next.backfill(['spill', 'retry'], 'auto')
  expect([w.sentOf(a), w.sentOf(b), w.copiesOf(a), w.copiesOf(b)]).toEqual([1, 2, 1, 1])
})

test('a replay whose answer comes after another session recorded and wrote out its own outcome goes on with that one: what is left is written once', async () => {
  const w = twoWriters(() => FIRST_REFUSED)
  const source = `/dl/${TABLE_REF}/retry-20261013T200102003Z-earlier-1.jsonl`
  const a = 'a'.repeat(32)
  w.files.set(source, packFiles([line(a, 'retry')])[0] as string)
  w.refuseWrites((path, text) => path === source && text === '')
  let release = (): void => undefined
  w.hold(session => (session === 'first-session' ? new Promise<void>(resolve => (release = resolve)) : undefined))
  // Both read the lease before either writes it; the first's answer waits.
  const first = w.writer('first-session').backfill(['spill', 'retry'], 'auto')
  await w.writer('second-session').backfill(['spill', 'retry'], 'auto')
  expect(w.copiesOf(a)).toBe(1)
  release()
  await first
  expect([w.sentOf(a), w.copiesOf(a)]).toEqual([2, 1])
})

test('a file of what is left is replayed once its parent\'s record names other files, and waits while that record is cut off or cannot be read', async () => {
  const w = twoWriters(() => OK_INSERT)
  const parent = 'retry-20261013T200102003Z-earlier-1.jsonl'
  const child = `/dl/${TABLE_REF}/retry-20261013T200103003Z-earlier-2.jsonl`
  w.files.set(child, packFiles([line('d'.repeat(32), 'retry')], parent)[0] as string)
  // The record is cut off part-way, with none whole: the file waits.
  w.files.set(`/dl/${TABLE_REF}/outcome-${parent}`, '{"fates":"W","refusa')
  await w.writer('a-session').backfill(['spill', 'retry'], 'auto')
  expect(w.sent).toEqual([])
  // The parent's record cannot be read: it still waits.
  w.failStore({ get: key => key.endsWith(`/${parent}`) })
  await w.writer('a-session').backfill(['spill', 'retry'], 'auto')
  expect(w.sent).toEqual([])
  // A whole record of another outcome (another replay's): the file goes.
  w.failStore({})
  w.store.set(`replayed:${TABLE_REF}/${parent}`, { size: 1, fates: 'W', reasons: [], refusals: [], files: [`/dl/${TABLE_REF}/retry-20261013T200104003Z-other-3.jsonl`], written: [true], waits: true, seq: 1 })
  await w.writer('a-session').backfill(['spill', 'retry'], 'auto')
  expect(w.sent).toEqual(['d'.repeat(32)])
  expect(w.files.get(child)).toBe('')
})

test('a replay whose answer comes after another session finished the file and emptied it writes nothing of its own', async () => {
  const w = twoWriters(() => FIRST_REFUSED)
  const source = `/dl/${TABLE_REF}/retry-20261013T200102003Z-earlier-1.jsonl`
  const a = 'a'.repeat(32)
  w.files.set(source, packFiles([line(a, 'retry')])[0] as string)
  let release = (): void => undefined
  w.hold(session => (session === 'first-session' ? new Promise<void>(resolve => (release = resolve)) : undefined))
  const first = w.writer('first-session').backfill(['spill', 'retry'], 'auto')
  // The other session writes the rejected file, empties the source and lets
  // its record go, all before the first session's answer comes.
  await w.writer('second-session').backfill(['spill', 'retry'], 'auto')
  expect([w.files.get(source), [...w.store.keys()]]).toEqual(['', []])
  release()
  await first
  expect([w.sentOf(a), w.copiesOf(a)]).toEqual([2, 1])
})

test('a replay whose answer comes late, while the record it would adopt cannot be read, keeps its outcome until it can: what is left is still written once', async () => {
  const w = twoWriters(() => FIRST_REFUSED)
  const source = `/dl/${TABLE_REF}/retry-20261013T200102003Z-earlier-1.jsonl`
  const a = 'a'.repeat(32)
  w.files.set(source, packFiles([line(a, 'retry')])[0] as string)
  w.refuseWrites((path, text) => path === source && text === '')
  let release = (): void => undefined
  w.hold(session => (session === 'first-session' ? new Promise<void>(resolve => (release = resolve)) : undefined))
  const firstWriter = w.writer('first-session')
  const first = firstWriter.backfill(['spill', 'retry'], 'auto')
  await w.writer('second-session').backfill(['spill', 'retry'], 'auto')
  w.failStore({ get: true })
  release()
  await first
  expect(w.copiesOf(a)).toBe(1)
  w.failStore({})
  w.hold(null)
  await firstWriter.backfill(['spill', 'retry'], 'auto')
  expect([w.sentOf(a), w.copiesOf(a)]).toEqual([2, 1])
})

test('while the source cannot be emptied, a file of what is left that its later record has as written is replayed', async () => {
  let answer = { status: 200, text: JSON.stringify({ insertErrors: [{ index: 1, errors: [{ reason: 'backendError', message: 'try again' }] }] }) }
  const w = twoWriters(() => answer)
  const source = `/dl/${TABLE_REF}/retry-20261013T200102003Z-earlier-1.jsonl`
  const [a, b] = ['a'.repeat(32), 'b'.repeat(32)]
  w.files.set(source, packFiles([line(a, 'retry'), line(b, 'retry')])[0] as string)
  // Records go to the two files beside the source; it cannot be emptied.
  w.failStore({ set: true })
  w.refuseWrites((path, text) => path === source && text === '')
  await w.writer('first-session').backfill(['spill', 'retry'], 'auto')
  expect([w.sentOf(a), w.sentOf(b)]).toEqual([1, 1])
  answer = OK_INSERT
  await w.writer('second-session').backfill(['spill', 'retry'], 'auto')
  expect([w.sentOf(a), w.sentOf(b)]).toEqual([1, 2])
})

test('rows with no id alike in two files count as two refused', async () => {
  const w = twoWriters(() => FIRST_REFUSED)
  const noId = JSON.parse(line('c'.repeat(32), 'retry')) as { row: { event_id?: string } }
  delete noId.row.event_id
  const text = packFiles([JSON.stringify(noId)])[0] as string
  w.files.set(`/dl/${TABLE_REF}/retry-20261013T200102003Z-earlier-1.jsonl`, text)
  w.files.set(`/dl/${TABLE_REF}/retry-20261013T200102003Z-earlier-2.jsonl`, text)
  await w.writer('a-session').backfill(['spill', 'retry'], 'auto')
  expect(w.statuses.at(-1) ?? '').toMatch(/^BQAA: 2 row\(s\) refused /)
})

test('a replay record too large for the store goes to the file beside the source, which another writer resumes from', async () => {
  // Rows as small as a line can be, each refused for one of many reasons.
  const small = (id: string): string => JSON.stringify({ v: 1, kind: 'retry', reason: '', attempts: 0, failed_at: '2026-10-13T20:01:02.003Z', table: TABLE_REF, row: { timestamp: '2026-10-13T20:01:02.003Z', event_type: 'TEST', event_id: id } })
  const ids = Array.from({ length: 13_000 }, (_, n) => n.toString(16).padStart(8, '0'))
  const w = twoWriters(chunk => ({ status: 200, text: JSON.stringify({ insertErrors: chunk.map((id, index) => ({ index, errors: [{ reason: 'invalid', message: `reason ${Number.parseInt(id, 16) % 1000}: ${'x'.repeat(980)}` }] })) }) }))
  const name = 'retry-20261013T200102003Z-earlier-1.jsonl'
  const source = `/dl/${TABLE_REF}/${name}`
  const texts = packFiles(ids.map(small))
  expect(texts.length).toBe(1)
  w.files.set(source, texts[0] as string)
  w.refuseWrites((path, text) => path === source && text === '')
  await w.writer('first-session').backfill(['spill', 'retry'], 'auto')
  await w.writer('second-session').backfill(['spill', 'retry'], 'auto')
  expect(w.sent.length).toBe(13_000)
  expect(w.store.has(`replayed:${TABLE_REF}/${name}`)).toBe(false)
  const filed = parseFile(w.files.get(`/dl/${TABLE_REF}/outcome-${name}`) ?? '')
  expect(filed.complete).toBe(true)
  expect(new TextEncoder().encode(filed.unreadable[0] ?? '').length > 64 * 1024).toBe(true)
  w.refuseWrites(null)
  await w.writer('third-session').backfill(['spill', 'retry'], 'auto')
  expect(w.sent.length).toBe(13_000)
  expect([w.files.get(source), w.files.get(`/dl/${TABLE_REF}/outcome-${name}`)]).toEqual(['', ''])
})

test('rows with no id, in a file another writer made, each count once refused, however often /bqaa-backfill sends them', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  const noId = (n: number): string => {
    const parsed = JSON.parse(line(String(n).repeat(32), 'rejected')) as { row: { event_id?: string } }
    delete parsed.row.event_id
    return JSON.stringify(parsed)
  }
  world.files.set(`${PARTITION_DIR}/rejected-20261013T200102003Z-earlier-1.jsonl`, packFiles([noId(1), noId(2)])[0] as string)
  await startSession($)
  await world.clock.advance(5000)
  world.replies = [{ status: 200, text: JSON.stringify({ insertErrors: [0, 1].map(index => ({ index, errors: [{ reason: 'invalid', message: 'no such field: extra' }] })) }) }]
  // Run again, BigQuery still refusing them: each still counts once.
  for (let i = 0; i < 2; i += 1) {
    await $.command.run({ command: 'bqaa-backfill', args: '', ...COMMAND })
    await world.clock.advance(1000)
    expect(world.statusLines.at(-1) ?? '').toMatch(/^BQAA: 2 row\(s\) refused /)
  }
})
