// Opt-in identity: `user_id` from the credential's verified account, and
// the machine's name in `session_metadata.host_name`. Both are off unless
// set; neither puts the address in a log or a command's output.

import { type Engine, expect, test } from 'claude-code/testing'

import { resolveConfig } from '../hooks/lib/config.ts'
import { packFiles } from '../hooks/lib/deadletter.ts'
import { buildRow } from '../hooks/lib/rows.ts'
import { type Io, Writer } from '../hooks/lib/writer.ts'

import {
  ACCESS_TOKEN,
  COMMAND,
  OK_INSERT,
  OPTIONS,
  PARTITION_DIR,
  SESSION_ID,
  TABLE_REF,
  TOKEN_INFO_URL,
  byType,
  deadLetterRows,
  json,
  setUp,
  startSession,
} from './helpers.ts'

// A made-up address on a reserved domain.
const ADDRESS = 'dev.person@example.com'
const VERIFIED = { status: 200, text: JSON.stringify({ email: ADDRESS, email_verified: 'true', scope: 'openid https://www.googleapis.com/auth/userinfo.email', expires_in: 3599 }) }
const UNAVAILABLE = { status: 503, text: '{"error":{"code":503,"message":"The service is currently unavailable.","status":"UNAVAILABLE"}}' }
const UNAUTHENTICATED = { status: 401, text: '{"error":{"code":401,"message":"Request had invalid authentication credentials.","status":"UNAUTHENTICATED"}}' }

// Two accounts, and the token of the second; joined at run time, like every
// credential-shaped test value (helpers.ts).
const FIRST = 'first.person@example.com'
const SECOND = 'second.person@example.com'
const verified = (email: string) => ({ status: 200, text: JSON.stringify({ email, email_verified: 'true' }) })
const SECOND_TOKEN = ['ya29', 'token-of-the-second-account-0123'].join('.')

// The user_id of each row an insertAll request carried.
const usersOf = (call: { body: string } | undefined): (string | null)[] =>
  (JSON.parse(call?.body ?? '{"rows":[]}') as { rows: { json: { user_id: string | null } }[] }).rows.map(r => r.json.user_id)

const statusText = async ($: Engine): Promise<string> => (await $.command.run({ command: 'bqaa-status', args: '', ...COMMAND })).text ?? ''

test('off by default: no token information lookup, and user_id stays the configured user', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.tokenInfo = VERIFIED
  await startSession($)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await world.clock.advance(5000)
  expect(world.fetches.some(f => f.url === TOKEN_INFO_URL)).toBe(false)
  expect(world.acceptedRows().map(r => r.user_id)).toEqual(['dev', 'dev', 'dev'])
  expect(await statusText($)).not.toMatch(/token's account/)
})

test("userIdFromCredentials: the token's verified account is every row's user_id, the token sent in a POST body only", { options: { ...OPTIONS, userIdFromCredentials: true } }, async ($, on) => {
  const world = setUp(on)
  world.tokenInfo = VERIFIED
  await startSession($)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await world.clock.advance(5000)
  // The session-start row, built before the lookup, carries it too.
  expect(world.acceptedRows().map(r => r.user_id)).toEqual([ADDRESS, ADDRESS, ADDRESS])
  const lookups = world.fetches.filter(f => f.url.startsWith('https://oauth2.googleapis.com/'))
  expect(lookups.length).toBe(1)
  expect(lookups[0]?.url).toBe(TOKEN_INFO_URL)
  expect(lookups[0]?.method).toBe('POST')
  expect(lookups[0]?.body).toBe(`access_token=${encodeURIComponent(ACCESS_TOKEN)}`)
  expect(lookups[0]?.headers.authorization).toBeUndefined()
  // Looked up once: later sends reuse it.
  await $.tool.call({ tool: 'Read', file_path: 'b.ts' })
  await world.clock.advance(5000)
  expect(world.fetches.filter(f => f.url === TOKEN_INFO_URL).length).toBe(1)
  expect(world.acceptedRows().every(r => r.user_id === ADDRESS)).toBe(true)
  // The address goes to the table only: no log line or command output.
  const status = await statusText($)
  expect(status).toMatch(/user_id from the token's account \(found\)/)
  for (const text of [status, ...world.logs, ...world.toasts, ...world.statusLines.map(l => l ?? '')]) expect(text.includes(ADDRESS)).toBe(false)
})

test('an unverified or missing account email leaves the configured user_id, says why in the debug log, and is tried again after ten minutes', { options: { ...OPTIONS, userIdFromCredentials: true } }, async ($, on) => {
  const world = setUp(on)
  world.tokenInfo = { status: 200, text: JSON.stringify({ email: ADDRESS, email_verified: 'false' }) }
  await startSession($)
  await world.clock.advance(5000)
  expect(world.acceptedRows().map(r => r.user_id)).toEqual(['dev'])
  expect(world.logs.some(l => l.includes("looking up the token's account for user_id failed (the account's email is not verified)"))).toBe(true)
  expect(await statusText($)).toMatch(/user_id from the token's account \(failed\)/)
  // Within ten minutes the failed lookup is not repeated.
  world.tokenInfo = VERIFIED
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await world.clock.advance(5000)
  expect(world.fetches.filter(f => f.url === TOKEN_INFO_URL).length).toBe(1)
  expect(world.acceptedRows().slice(-2).map(r => r.user_id)).toEqual(['dev', 'dev'])
  // Ten minutes on, the lookup runs again, and the address it finds is used.
  await world.clock.advance(10 * 60 * 1000)
  await $.tool.call({ tool: 'Read', file_path: 'b.ts' })
  await world.clock.advance(5000)
  expect(world.fetches.filter(f => f.url === TOKEN_INFO_URL).length).toBe(2)
  expect(world.acceptedRows().slice(-2).map(r => r.user_id)).toEqual([ADDRESS, ADDRESS])
})

test('a token naming no account email leaves the configured user_id, and says why', { options: { ...OPTIONS, userIdFromCredentials: true } }, async ($, on) => {
  const world = setUp(on)
  world.tokenInfo = { status: 200, text: JSON.stringify({ email_verified: 'true', scope: 'https://www.googleapis.com/auth/cloud-platform' }) }
  await startSession($)
  await world.clock.advance(5000)
  expect(world.acceptedRows().map(r => r.user_id)).toEqual(['dev'])
  expect(world.logs.some(l => l.includes("looking up the token's account for user_id failed (it names no account email (the token lacks the email scope))"))).toBe(true)
})

test("rows parked on disk keep this process's account; rows an earlier session parked are sent as they were", { options: { ...OPTIONS, userIdFromCredentials: true } }, async ($, on) => {
  // No automatic replay: /bqaa-backfill below sends the files.
  const world = setUp(on, { BQAA_AUTO_BACKFILL: 'false' })
  world.tokenInfo = VERIFIED
  // A file an earlier session parked, for someone else.
  const earlier = {
    v: 1,
    kind: 'spill',
    reason: 'session ended',
    attempts: 0,
    failed_at: '2026-10-13T20:01:02.003Z',
    table: TABLE_REF,
    row: {
      timestamp: '2026-10-13T20:01:02.003Z',
      event_id: 'e'.repeat(32),
      event_type: 'STATE_DELTA',
      agent: 'coding-agent',
      session_id: 'earlier',
      invocation_id: null,
      user_id: 'someone-else',
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
    },
  }
  world.files.set(`${PARTITION_DIR}/spill-20261013T200102003Z-earlier-1.jsonl`, packFiles([JSON.stringify(earlier)])[0] as string)
  world.replies = [UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, OK_INSERT]
  await startSession($)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  // Four failed tries, then this session's rows are parked.
  for (let t = 0; t < 4; t += 1) await world.clock.advance(5000)
  const parked = deadLetterRows(world).filter(r => r.session_id !== 'earlier')
  expect(parked.length).toBe(3)
  expect(parked.every(r => r.user_id === ADDRESS)).toBe(true)
  // BigQuery is back: the earlier session's row goes out with its own user.
  await $.command.run({ command: 'bqaa-backfill', args: '', ...COMMAND })
  await world.clock.settle()
  const sent = world.acceptedRows()
  expect(sent.find(r => r.session_id === 'earlier')?.user_id).toBe('someone-else')
  expect(sent.filter(r => r.session_id !== 'earlier').every(r => r.user_id === ADDRESS)).toBe(true)
})

test("rows still queued at exit go to the spill file with this process's account", { options: { ...OPTIONS, userIdFromCredentials: true } }, async ($, on) => {
  const world = setUp(on)
  world.tokenInfo = VERIFIED
  await startSession($)
  // The token and the account are looked up from a timer; no row is sent yet.
  await world.clock.settle()
  expect(world.insertCalls().length).toBe(0)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await $.session.end({ reason: 'prompt_input_exit', sessionId: SESSION_ID, resume: { id: SESSION_ID } })
  const spilled = deadLetterRows(world)
  expect(spilled.map(r => r.event_type)).toEqual(['STATE_DELTA', 'TOOL_STARTING', 'TOOL_COMPLETED', 'STATE_DELTA'])
  expect(spilled.every(r => r.user_id === ADDRESS)).toBe(true)
})

test('a new credential after a session change: the rows sent with it carry its account, the 401 retry included', { options: { ...OPTIONS, userIdFromCredentials: true } }, async ($, on) => {
  const world = setUp(on)
  world.tokenInfo = verified(FIRST)
  await startSession($)
  await world.clock.advance(5000)
  expect(world.acceptedRows().map(r => r.user_id)).toEqual([FIRST])
  // The session changes; the process and its writer go on.
  await $.session.end({ reason: 'clear', sessionId: SESSION_ID, resume: { id: SESSION_ID } })
  world.sessionId = 'second-session'
  // The person signed in as someone else: the token at hand has expired, and
  // the token command now prints the other account's.
  world.processReply = { exitCode: 0, stdout: `${SECOND_TOKEN}\n`, stderr: '' }
  world.tokenInfo = verified(SECOND)
  world.replies = [UNAUTHENTICATED, OK_INSERT]
  await $.tool.call({ tool: 'Read', file_path: 'b.ts' })
  await world.clock.advance(5000)
  const [, refused, retried] = world.insertCalls()
  // Tried with the old token as the old account; the 401's fresh token is
  // the other account's, and the retry carries that account.
  expect(refused?.answered).toBe(401)
  expect(usersOf(refused)).toEqual([FIRST, FIRST, FIRST])
  expect(retried?.headers.authorization).toBe(`Bearer ${SECOND_TOKEN}`)
  expect(usersOf(retried)).toEqual([SECOND, SECOND, SECOND])
  // Later rows carry it too, and each token was looked up once.
  await $.tool.call({ tool: 'Read', file_path: 'c.ts' })
  await world.clock.advance(5000)
  const later = world.acceptedRows().slice(-2)
  expect(later.map(r => r.session_id)).toEqual(['second-session', 'second-session'])
  expect(later.map(r => r.user_id)).toEqual([SECOND, SECOND])
  expect(world.fetches.filter(f => f.url === TOKEN_INFO_URL).map(f => f.body)).toEqual([`access_token=${encodeURIComponent(ACCESS_TOKEN)}`, `access_token=${encodeURIComponent(SECOND_TOKEN)}`])
})

test('rows parked under one account keep it when a later credential replays them', { options: { ...OPTIONS, userIdFromCredentials: true } }, async ($, on) => {
  // No automatic replay: /bqaa-backfill below sends the file.
  const world = setUp(on, { BQAA_AUTO_BACKFILL: 'false' })
  world.tokenInfo = verified(FIRST)
  world.replies = [UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE]
  await startSession($)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  // Four failed tries: the rows are parked, with the first account.
  for (let t = 0; t < 4; t += 1) await world.clock.advance(5000)
  expect(deadLetterRows(world).map(r => r.user_id)).toEqual([FIRST, FIRST, FIRST])
  // Another account's credential takes over.
  world.processReply = { exitCode: 0, stdout: `${SECOND_TOKEN}\n`, stderr: '' }
  world.tokenInfo = verified(SECOND)
  world.replies = [UNAUTHENTICATED, OK_INSERT]
  await $.tool.call({ tool: 'Read', file_path: 'c.ts' })
  await world.clock.advance(20_000)
  await $.command.run({ command: 'bqaa-backfill', args: '', ...COMMAND })
  await world.clock.settle()
  const sent = world.acceptedRows()
  const fileOf = (r: { content: string | null }) => (JSON.parse(r.content ?? '{}') as { args?: { file_path?: string } }).args?.file_path
  expect(sent.filter(r => r.event_type === 'TOOL_STARTING').map(r => [fileOf(r), r.user_id])).toEqual([
    ['c.ts', SECOND],
    ['a.ts', FIRST],
  ])
})

test("while a new token's account is unknown, rows carry the configured user_id, never the old account", { options: { ...OPTIONS, userIdFromCredentials: true } }, async ($, on) => {
  const world = setUp(on)
  world.tokenInfo = verified(FIRST)
  await startSession($)
  await world.clock.advance(5000)
  world.processReply = { exitCode: 0, stdout: `${SECOND_TOKEN}\n`, stderr: '' }
  world.tokenInfo = { status: 400, text: '{"error":"invalid_token"}' }
  // Busy once, then the old token is refused: the rows are given the first
  // account twice before the new token's account turns out unknown.
  world.replies = [UNAVAILABLE, UNAUTHENTICATED, OK_INSERT]
  await $.tool.call({ tool: 'Read', file_path: 'b.ts' })
  await world.clock.advance(10_000)
  const [, busy, refused, retried] = world.insertCalls()
  expect([busy?.answered, refused?.answered, retried?.answered]).toEqual([503, 401, 200])
  expect(usersOf(busy)).toEqual([FIRST, FIRST])
  expect(usersOf(refused)).toEqual([FIRST, FIRST])
  expect(usersOf(retried)).toEqual(['dev', 'dev'])
})

test('rows parked while no token works carry the configured user_id, not the last account', { options: { ...OPTIONS, userIdFromCredentials: true } }, async ($, on) => {
  const world = setUp(on)
  world.tokenInfo = verified(FIRST)
  await startSession($)
  await world.clock.advance(5000)
  // BigQuery refuses the token, and no fresh one comes.
  world.replies = [UNAUTHENTICATED]
  world.processReply = { exitCode: 1, stdout: '', stderr: 'ERROR: (gcloud.auth.application-default.print-access-token) Your default credentials were not found.\n' }
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  // Tried with the first account's token once, then four failed tries.
  for (let t = 0; t < 4; t += 1) await world.clock.advance(5000)
  expect(usersOf(world.insertCalls()[1])).toEqual([FIRST, FIRST])
  expect(deadLetterRows(world).map(r => r.user_id)).toEqual(['dev', 'dev'])
})

test('a lookup that answers late, for an older token, never replaces the account of the newer one', async () => {
  const config = resolveConfig({ project: 'race-project', dataset: 'events', deadLetterDir: '/race/dead-letter', userIdFromCredentials: true }, {})
  const firstToken = ['ya29', 'token-of-the-first-account-0123'].join('.')
  const commands = [firstToken, SECOND_TOKEN]
  let now = 0
  let answerFirst = (): void => undefined
  const lookups: string[] = []
  const sent: (string | null)[][] = []
  const io: Io = {
    now: () => now,
    after: () => ({ cancel: () => undefined }),
    fetch: async (url, init) => {
      if (url !== TOKEN_INFO_URL) {
        sent.push(usersOf({ body: init.body ?? '' }))
        return OK_INSERT
      }
      const isFirst = (init.body ?? '').endsWith(encodeURIComponent(firstToken))
      lookups.push(isFirst ? 'first' : 'second')
      // The first token's lookup answers only when the test says so.
      if (isFirst) await new Promise<void>(resolve => (answerFirst = resolve))
      return verified(isFirst ? FIRST : SECOND)
    },
    runCommand: async () => ({ exitCode: 0, stdout: `${commands.shift() ?? SECOND_TOKEN}\n`, stderr: '' }),
    envToken: async () => undefined,
    readFile: async () => '',
    writeFile: async () => undefined,
    listDir: async () => [],
    storeGet: async () => undefined,
    storeSet: async () => undefined,
    storeDelete: async () => undefined,
    status: () => undefined,
    debug: () => undefined,
  }
  const row = (eventId: string) =>
    buildRow({ eventType: 'STATE_DELTA', timestampMs: 0, eventId, agent: 'coding-agent', sessionId: 's', invocationId: null, userId: 'dev', traceId: null, spanId: null, parentSpanId: null, content: {}, attributes: {}, maxPayloadChars: 16384 }).row
  const turns = async (until: () => boolean) => {
    for (let i = 0; i < 200 && !until(); i += 1) await Promise.resolve()
  }
  const writer = new Writer(io, () => config, () => 's')
  // The first token's account is being looked up...
  writer.prefetchToken()
  await turns(() => lookups.length === 1)
  // ...when that token runs out (45 minutes) and a row goes out with the
  // next one, whose account answers at once.
  now += 46 * 60 * 1000
  writer.enqueue(row('a'.repeat(32)), 0)
  await writer.flush()
  // The older lookup answers now; it must not replace the newer account.
  answerFirst()
  await turns(() => false)
  writer.enqueue(row('b'.repeat(32)), 0)
  await writer.flush()
  expect(sent).toEqual([[SECOND], [SECOND]])
  expect(lookups).toEqual(['first', 'second'])
})

test("recordHostname: the machine's name is in the session metadata of the turns after the lookup; off by default, hostname never runs", { options: { ...OPTIONS, recordHostname: true } }, async ($, on) => {
  const world = setUp(on)
  await startSession($)
  await world.clock.settle()
  expect(world.commands.flat().includes('hostname')).toBe(true)
  await $.turn.start({ turnId: 'turn-1', text: 'hi' })
  await world.clock.advance(5000)
  const [started] = byType(world.acceptedRows(), 'INVOCATION_STARTING')
  expect(json(started?.attributes ?? null)).toMatchObject({ session_metadata: { host_name: 'devbox-7', project_name: 'my-repo' } })
  expect(await statusText($)).toMatch(/host name recorded/)
})

test('without recordHostname no row carries a host name and hostname never runs', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  await startSession($)
  await $.turn.start({ turnId: 'turn-1', text: 'hi' })
  await world.clock.advance(5000)
  expect(world.commands.flat().includes('hostname')).toBe(false)
  for (const row of world.acceptedRows()) expect(row.attributes ?? '').not.toMatch(/host_name/)
})

test('a hostname that is not a plain name is not recorded', { options: { ...OPTIONS, recordHostname: true } }, async ($, on) => {
  const world = setUp(on)
  world.hostname = 'bad name; with spaces'
  await startSession($)
  await world.clock.settle()
  await $.turn.start({ turnId: 'turn-1', text: 'hi' })
  await world.clock.advance(5000)
  for (const row of world.acceptedRows()) expect(row.attributes ?? '').not.toMatch(/host_name/)
  expect(world.logs.some(l => l.includes('recordHostname: the hostname command gave no usable name'))).toBe(true)
})
