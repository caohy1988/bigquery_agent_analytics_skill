// The background writer: retries, timeouts, auth refresh, table creation,
// dead-letter files, backfill and the end-of-session spill. No network: the
// insertAll answers are scripted.

import { type Engine, expect, test } from 'claude-code/testing'

import { COMMAND, DEAD_LETTER_DIR, DRY_RUN_DIR, OK_INSERT, OPTIONS, SESSION_ID, deadLetterFiles, json, setUp, startSession } from './helpers.ts'

const UNAVAILABLE = { status: 503, text: '{"error":{"code":503,"message":"The service is currently unavailable.","status":"UNAVAILABLE"}}' }
const TABLE_MISSING = {
  status: 404,
  text: '{"error":{"code":404,"message":"Not found: Table my-gcp-project:agent_analytics.agent_events","errors":[{"reason":"notFound"}],"status":"NOT_FOUND"}}',
}
const DATASET_MISSING = {
  status: 404,
  text: '{"error":{"code":404,"message":"Not found: Dataset my-gcp-project:agent_analytics","errors":[{"reason":"notFound"}],"status":"NOT_FOUND"}}',
}
const DENIED = {
  status: 403,
  text: '{"error":{"code":403,"message":"Access Denied: Table my-gcp-project:agent_analytics.agent_events: Permission bigquery.tables.updateData denied","errors":[{"reason":"accessDenied"}],"status":"PERMISSION_DENIED"}}',
}
const UNAUTHENTICATED = { status: 401, text: '{"error":{"code":401,"message":"Request had invalid authentication credentials.","status":"UNAUTHENTICATED"}}' }

const statusText = async ($: Engine): Promise<string> => (await $.command.run({ command: 'bqaa-status', args: '', ...COMMAND })).text ?? ''

test('a failed request is retried with the same insertIds, then succeeds', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [UNAVAILABLE, OK_INSERT]
  await startSession($)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await world.clock.advance(5000)
  expect(world.insertCalls().length).toBe(1)
  expect(world.acceptedRows().length).toBe(0)
  await world.clock.advance(5000)
  const [first, second] = world.insertCalls()
  const ids = (call: typeof first) => (JSON.parse(call?.body ?? '{}') as { rows: { insertId: string }[] }).rows.map(r => r.insertId)
  expect(ids(second)).toEqual(ids(first))
  expect(world.acceptedRows().length).toBe(3)
  expect(deadLetterFiles(world).length).toBe(0)
  expect(await statusText($)).toMatch(/sent 3, dead-lettered 0/)
})

test('rows that exhaust their retries go to a dead-letter file, and are replayed once BigQuery is back', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, OK_INSERT]
  await startSession($)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  for (let t = 0; t < 4; t += 1) await world.clock.advance(5000)
  // Four attempts (one plus three retries), then parked on disk.
  expect(world.insertCalls().length).toBe(4)
  const files = deadLetterFiles(world)
  expect(files.length).toBe(1)
  const [path, text] = files[0] as [string, string]
  expect(path.startsWith(`${DEAD_LETTER_DIR}/retry-`)).toBe(true)
  const lines = text.trim().split('\n').map(l => JSON.parse(l) as { kind: string; attempts: number; table: string; reason: string; row: { event_type: string } })
  expect(lines.map(l => l.row.event_type)).toEqual(['STATE_DELTA', 'TOOL_STARTING', 'TOOL_COMPLETED'])
  expect(lines[0]).toMatchObject({ kind: 'retry', attempts: 4, table: 'my-gcp-project.agent_analytics.agent_events' })
  expect(lines[0]?.reason ?? '').toMatch(/HTTP 503/)
  expect(world.statusLines.some(l => (l ?? '').includes('parked after retries'))).toBe(true)

  // BigQuery answers again: new rows go out, then the parked ones follow.
  await $.tool.call({ tool: 'Read', file_path: 'b.ts' })
  for (let t = 0; t < 4; t += 1) await world.clock.advance(5000)
  const sent = world.acceptedRows().map(r => r.event_type)
  expect(sent.filter(t => t === 'STATE_DELTA').length).toBe(1)
  expect(sent.filter(t => t === 'TOOL_COMPLETED').length).toBe(2)
  expect(deadLetterFiles(world).length).toBe(0)
  expect(world.files.get(path)).toBe('')
  expect(world.statusLines.at(-1)).toBeUndefined()
})

test('a missing table is created with the BQAA schema, then written', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [TABLE_MISSING, { status: 200, text: '{"kind":"bigquery#table"}' }, OK_INSERT]
  await startSession($)
  await world.clock.advance(5000)
  expect(world.fetches.map(f => f.url.split('/').slice(-2).join('/'))).toEqual(['agent_events/insertAll', 'agent_analytics/tables', 'agent_events/insertAll'])
  const create = JSON.parse(world.fetches[1]?.body ?? '{}') as {
    tableReference: unknown
    schema: { fields: { name: string; type: string; mode?: string }[] }
    timePartitioning: unknown
    clustering: unknown
  }
  expect(create.tableReference).toEqual({ projectId: 'my-gcp-project', datasetId: 'agent_analytics', tableId: 'agent_events' })
  expect(create.schema.fields.map(f => f.name)).toEqual([
    'timestamp',
    'event_id',
    'event_type',
    'agent',
    'session_id',
    'invocation_id',
    'user_id',
    'trace_id',
    'span_id',
    'parent_span_id',
    'content',
    'content_parts',
    'attributes',
    'latency_ms',
    'status',
    'error_message',
    'is_truncated',
  ])
  expect(create.timePartitioning).toEqual({ type: 'DAY', field: 'timestamp' })
  expect(create.clustering).toEqual({ fields: ['event_type', 'agent', 'user_id'] })
  expect(world.acceptedRows().length).toBe(1)
})

test('a missing dataset is not created: the rows are refused and parked', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [DATASET_MISSING]
  await startSession($)
  await world.clock.advance(5000)
  expect(world.fetches.length).toBe(1)
  const [file] = deadLetterFiles(world)
  expect(file?.[0].startsWith(`${DEAD_LETTER_DIR}/rejected-`)).toBe(true)
  expect(await statusText($)).toMatch(/1 refused/)
})

test('a permission error parks rows as refused; /bqaa-backfill sends them once fixed', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [DENIED, OK_INSERT]
  await startSession($)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await world.clock.advance(5000)
  expect(world.insertCalls().length).toBe(1)
  const [file] = deadLetterFiles(world)
  expect(file?.[0].startsWith(`${DEAD_LETTER_DIR}/rejected-`)).toBe(true)
  expect(world.statusLines.at(-1) ?? '').toMatch(/refused/)
  // Refused rows are not replayed automatically.
  await world.clock.advance(60_000)
  expect(world.acceptedRows().length).toBe(0)

  const started = await $.command.run({ command: 'bqaa-backfill', args: '', ...COMMAND })
  expect(started.text ?? '').toMatch(/backfill started for 1 file/)
  await world.clock.settle()
  expect(world.acceptedRows().map(r => r.event_type)).toEqual(['STATE_DELTA', 'TOOL_STARTING', 'TOOL_COMPLETED'])
  expect(deadLetterFiles(world).length).toBe(0)
  expect(world.logs.some(l => l.includes('bqaa backfill: 1 file(s), 3 row(s) sent, 0 left'))).toBe(true)
  expect(await statusText($)).toMatch(/last backfill \(command, .*\): 1 file\(s\), 3 rows sent, 0 left/)
})

test('a refused token is fetched again', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [UNAUTHENTICATED, OK_INSERT]
  await startSession($)
  await world.clock.advance(5000)
  await world.clock.advance(5000)
  expect(world.commands.length).toBe(2)
  expect(world.acceptedRows().length).toBe(1)
})

test('a failing token command is reported, and rows wait for it', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.processReply = { exitCode: 1, stdout: '', stderr: 'ERROR: (gcloud.auth.application-default.print-access-token) Reauthentication failed.\n' }
  await startSession($)
  await world.clock.advance(5000)
  expect(world.fetches.length).toBe(0)
  const status = await statusText($)
  expect(status).toMatch(/auth: .*gcloud auth application-default print-access-token. exited 1: ERROR: \(gcloud/)
  expect(status).toMatch(/queue: 1 rows/)
})

test('BQAA_ACCESS_TOKEN is used as is, with no token command', { options: OPTIONS }, async ($, on) => {
  // Joined at run time, like every credential-shaped test value (helpers.ts).
  const token = ['ya29', 'from-the-environment-0123456789'].join('.')
  const world = setUp(on, { BQAA_ACCESS_TOKEN: token })
  await startSession($)
  await world.clock.advance(5000)
  expect(world.commands.length).toBe(0)
  expect(world.insertCalls()[0]?.headers.authorization).toBe(`Bearer ${token}`)
})

test('rows BigQuery reports as invalid are parked; the rest land', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [
    {
      status: 200,
      text: JSON.stringify({ kind: 'bigquery#tableDataInsertAllResponse', insertErrors: [{ index: 1, errors: [{ reason: 'invalid', message: 'no such field: foo.' }] }] }),
    },
  ]
  await startSession($)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await world.clock.advance(5000)
  const [file] = deadLetterFiles(world)
  const line = JSON.parse((file?.[1] ?? '').trim()) as { kind: string; reason: string; row: { event_type: string } }
  expect(line.kind).toBe('rejected')
  expect(line.reason).toMatch(/invalid: no such field: foo/)
  expect(line.row.event_type).toBe('TOOL_STARTING')
  expect(await statusText($)).toMatch(/sent 2, dead-lettered 1 \(1 refused\)/)
})

test('session end sends what is queued when it can', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  await startSession($)
  await world.clock.settle()
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await $.session.end({ reason: 'prompt_input_exit', sessionId: SESSION_ID, resume: { id: SESSION_ID } })
  expect(world.acceptedRows().map(r => r.event_type)).toEqual(['STATE_DELTA', 'TOOL_STARTING', 'TOOL_COMPLETED', 'STATE_DELTA'])
  expect(deadLetterFiles(world).length).toBe(0)
})

test('session end spills to disk when a request is stuck, bounded by its budget', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [{ hang: true }]
  await startSession($)
  await world.clock.advance(5000)
  expect(world.insertCalls().length).toBe(1)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  let ended = false
  const ending = $.session.end({ reason: 'other', sessionId: SESSION_ID, resume: { id: SESSION_ID } }).then(() => {
    ended = true
  })
  for (let i = 0; i < 20 && !ended; i += 1) await world.clock.advance(100)
  await ending
  // No second request was started behind the stuck one.
  expect(world.insertCalls().length).toBe(1)
  const [file] = deadLetterFiles(world)
  expect(file?.[0].startsWith(`${DEAD_LETTER_DIR}/spill-`)).toBe(true)
  const types = (file?.[1] ?? '')
    .trim()
    .split('\n')
    .map(l => (JSON.parse(l) as { row: { event_type: string } }).row.event_type)
  // The stuck batch (it may yet land; event_id dedups) and everything after it.
  expect(types).toEqual(['STATE_DELTA', 'TOOL_STARTING', 'TOOL_COMPLETED', 'STATE_DELTA'])
  world.releaseHung(200, '{}')
})

test('with BQAA_EXIT_FLUSH_MS=0 session end never touches the network', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on, { BQAA_EXIT_FLUSH_MS: '0' })
  await startSession($)
  await world.clock.settle()
  await $.session.end({ reason: 'prompt_input_exit', sessionId: SESSION_ID, resume: { id: SESSION_ID } })
  expect(world.fetches.length).toBe(0)
  expect(deadLetterFiles(world).length).toBe(1)
})

test('the next session replays spill files on its own', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  const row = {
    timestamp: '2026-10-13T20:01:02.003Z',
    event_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    event_type: 'STATE_DELTA',
    agent: 'coding-agent',
    session_id: 'previous-session',
    invocation_id: null,
    user_id: 'dev',
    trace_id: null,
    span_id: 'bbbbbbbbbbbbbbbb',
    parent_span_id: null,
    content: '{"session_end":true}',
    content_parts: [],
    attributes: '{}',
    latency_ms: null,
    status: 'OK',
    error_message: null,
    is_truncated: false,
  }
  const path = `${DEAD_LETTER_DIR}/spill-20261013T200102003Z-previoussess-1.jsonl`
  world.files.set(path, `${JSON.stringify({ v: 1, kind: 'spill', reason: 'session ended', attempts: 0, failed_at: '2026-10-13T20:01:02.003Z', table: 'x', row })}\nnot json\n`)
  await startSession($)
  await world.clock.advance(15_000)
  expect(world.acceptedRows().some(r => r.event_id === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true)
  // The unreadable line is kept for a person to look at; the sent one is gone.
  expect(world.files.get(path)).toBe('not json\n')
})

test('a file another session is replaying is left to it', { options: OPTIONS }, async ($, on) => {
  const name = 'spill-20261013T200102003Z-othersession-1.jsonl'
  const world = setUp(on, {}, { [`lease:${name}`]: { by: 'other-session', until: Date.now() + 60_000 } })
  world.files.set(`${DEAD_LETTER_DIR}/${name}`, '{"v":1}\n')
  await startSession($)
  await world.clock.advance(15_000)
  expect(world.files.get(`${DEAD_LETTER_DIR}/${name}`)).toBe('{"v":1}\n')
  expect(await statusText($)).toMatch(/1 skipped/)
})

test('under queue pressure while BigQuery is down, rows go to disk instead of being dropped', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on, { BQAA_MAX_QUEUE_ROWS: '20' })
  world.replies = [UNAVAILABLE]
  await startSession($)
  await world.clock.advance(5000)
  for (let i = 0; i < 9; i += 1) await $.tool.call({ tool: 'Read', file_path: `f${i}` })
  await world.clock.advance(5000)
  const status = await statusText($)
  expect(status).toMatch(/dropped 0/)
  expect(status).toMatch(/spilled [1-9]/)
  expect(deadLetterFiles(world).some(([p]) => p.startsWith(`${DEAD_LETTER_DIR}/spill-`))).toBe(true)
})

test('a dead-letter write that fails is counted as dropped, not thrown', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [DENIED]
  world.failWrites = true
  await startSession($)
  await world.clock.advance(5000)
  const status = await statusText($)
  expect(status).toMatch(/dropped 1/)
  expect(status).toMatch(/dead-letter write failed \(1 rows lost\)/)
})

test('dry run writes the rows locally and sends nothing', { options: { dryRun: true } }, async ($, on) => {
  const world = setUp(on)
  await startSession($)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await world.clock.advance(5000)
  expect(world.fetches.length).toBe(0)
  expect(world.commands.length).toBe(0)
  const written = [...world.files.entries()].filter(([p]) => p.startsWith(`${DRY_RUN_DIR}/dry-run-`))
  expect(written.length).toBe(1)
  const rows = (written[0]?.[1] ?? '')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l) as { event_type: string; attributes: string })
  expect(rows.map(r => r.event_type)).toEqual(['STATE_DELTA', 'TOOL_STARTING', 'TOOL_COMPLETED'])
  expect(json(rows[0]?.attributes ?? null)).toMatchObject({ writer: { mode: 'dry_run' } })
})

test('error text is redacted before /bqaa-status shows it', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  const token = ['ya29', 'a0AfH6SMBexampleexampleexample0123'].join('.')
  world.processReply = { exitCode: 1, stdout: '', stderr: `ERROR: refresh failed for ${token}\n` }
  await startSession($)
  await world.clock.advance(5000)
  const status = await statusText($)
  expect(status).toMatch(/\[REDACTED:google-oauth-token\]/)
  expect(status).not.toMatch(/a0AfH6SMBexample/)
})

test('/bqaa-flush sends right away instead of at the next interval', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  await startSession($)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  const reply = await $.command.run({ command: 'bqaa-flush', args: '', ...COMMAND })
  expect(reply.text ?? '').toMatch(/flush requested for 3 queued row/)
  await world.clock.settle()
  expect(world.acceptedRows().length).toBe(3)
})

test('/clear keeps the process sending, under the new session id', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  await startSession($)
  await $.session.end({ reason: 'clear', sessionId: SESSION_ID, resume: { id: SESSION_ID } })
  await $.classic.SessionStart({ source: 'clear', session_id: 'after-clear-session' })
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await world.clock.advance(5000)
  // Nothing was spilled: the process did not end.
  expect(deadLetterFiles(world).length).toBe(0)
  const rows = world.acceptedRows()
  expect(rows.map(r => [r.event_type, r.session_id])).toEqual([
    ['STATE_DELTA', SESSION_ID],
    ['STATE_DELTA', SESSION_ID],
    ['STATE_DELTA', 'after-clear-session'],
    ['TOOL_STARTING', 'after-clear-session'],
    ['TOOL_COMPLETED', 'after-clear-session'],
  ])
})
