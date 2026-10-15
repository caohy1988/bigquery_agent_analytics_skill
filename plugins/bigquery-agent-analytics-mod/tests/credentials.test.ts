// When rows cannot be written for lack of credentials or permission: the
// band above the prompt, the toast, the transcript line and the status line,
// each with the fix and the rows waiting; recovery soon after the fix; and
// the opt-in `block` mode, which refuses prompts while no credentials work.

import { type Engine, expect, test } from 'claude-code/testing'

import { COMMAND, OK_INSERT, OPTIONS, type World, setUp, startSession } from './helpers.ts'

const PLUGIN = 'bigquery-agent-analytics-mod'

// What the host passes a hook drawing in the band above the prompt.
const BAND = {
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 115, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

// gcloud with no application-default sign-in: a WARNING line first, then
// the ERROR line, then advice.
const NO_SIGN_IN = 'ERROR: (gcloud.auth.application-default.print-access-token) Your default credentials were not found. To set up Application Default Credentials, see https://cloud.google.com/docs/authentication/external/set-up-adc for more information.'
const GCLOUD_FAILS = {
  exitCode: 1,
  stdout: '',
  stderr: `WARNING: The project property is not set; the account's default applies.\n${NO_SIGN_IN}\nTo sign in, use the login command of gcloud auth application-default.\n`,
}
const UNAUTHENTICATED = { status: 401, text: '{"error":{"code":401,"message":"Request had invalid authentication credentials.","status":"UNAUTHENTICATED"}}' }
const DENIED = {
  status: 403,
  text: '{"error":{"code":403,"message":"Access Denied: Table my-gcp-project:agent_analytics.agent_events: Permission bigquery.tables.updateData denied","errors":[{"reason":"accessDenied"}],"status":"PERMISSION_DENIED"}}',
}

const FIX = 'run: gcloud auth application-default login'
const LINE = `rows are not being written: no working Google credentials. To fix, ${FIX}.`
const PROMPT = { text: 'hi', wait: false, origin: { kind: 'composer' } } as const

const statusText = async ($: Engine): Promise<string> => (await $.command.run({ command: 'bqaa-status', args: '', ...COMMAND })).text ?? ''

// The band as the terminal would draw it: the mod's line, if any, and the
// text the mods after it drew.
async function band($: Engine, props: { hasSurvey?: boolean } = {}): Promise<{ line?: string; waiting?: string; blocked?: string; beneath: boolean }> {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND, props: { ...BAND.props, ...props } })
  const line = (await ui.find({ type: 'Text', text: /^rows are not being written/ }))?.text
  const waiting = (await ui.find({ type: 'Text', text: /row\(s\) waiting/ }))?.text
  const blocked = (await ui.find({ type: 'Text', text: /refused until then/ }))?.text
  const beneath = (await ui.find({ type: 'Text', text: 'drawn beneath' })) !== undefined
  await ui.unmount()
  return { line, waiting, blocked, beneath }
}

const noticeLines = (world: World): string[] => world.transcript.filter(l => l.startsWith('bqaa: rows are not being written'))

test('without working credentials, the band, one toast and one transcript line give the fix and the rows waiting', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.processReply = GCLOUD_FAILS
  await startSession($)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await world.clock.advance(5000)
  expect(world.fetches.length).toBe(0)
  // The session-start row and the call's two rows wait.
  expect(await band($)).toEqual({ line: LINE, waiting: ' 3 row(s) waiting.', blocked: undefined, beneath: true })
  expect(world.toasts).toEqual([`BQAA: ${LINE}`])
  expect(world.statusLines.at(-1)).toBe(`BQAA: no working Google credentials. To fix, ${FIX} (3 row(s) waiting)`)
  // The transcript line has the reason: gcloud's ERROR line, not its
  // WARNING line or its instructions.
  const [notice] = noticeLines(world)
  expect(notice).toContain(`exited 1: ${NO_SIGN_IN}`)
  expect(notice).not.toContain('WARNING')
  expect(notice).not.toContain('To sign in, use')
  // More failures, more rows: one toast and one transcript line still; the
  // count follows the rows, parked on disk ones included.
  for (let t = 0; t < 6; t += 1) {
    await $.tool.call({ tool: 'Read', file_path: `b${t}.ts` })
    await world.clock.advance(5000)
  }
  expect(world.toasts.length).toBe(1)
  expect(noticeLines(world).length).toBe(1)
  expect((await band($)).waiting).toBe(' 15 row(s) waiting.')
  expect(await statusText($)).toMatch(/notice \(since .*\): rows are not being written: no working Google credentials \(authentication: token command .gcloud. exited 1: ERROR: .*\); to fix, run: gcloud auth application-default login; 15 row\(s\) waiting/)
})

test('the notice clears on the next successful send, and the rows go out', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  const working = world.processReply
  world.processReply = GCLOUD_FAILS
  await startSession($)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await world.clock.advance(5000)
  expect((await band($)).line).toBe(LINE)
  // Signed in again: the next try sends, and the band, the status line and
  // /bqaa-status no longer show a notice.
  world.processReply = working
  await world.clock.advance(5000)
  expect(world.acceptedRows().length).toBe(3)
  expect(await band($)).toEqual({ line: undefined, waiting: undefined, blocked: undefined, beneath: true })
  expect(world.statusLines.at(-1)).toBeUndefined()
  expect(await statusText($)).not.toMatch(/notice/)
})

test('the band yields to a survey, and keeps what the mods after it draw', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.processReply = GCLOUD_FAILS
  await startSession($)
  await world.clock.advance(5000)
  expect(await band($, { hasSurvey: true })).toEqual({ line: undefined, waiting: undefined, blocked: undefined, beneath: true })
  expect((await band($)).line).toBe(LINE)
})

test('a 401 gets one immediate retry with a fresh token, with no notice', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [UNAUTHENTICATED, OK_INSERT]
  await startSession($)
  await world.clock.advance(5000)
  // Both requests in the same flush: no backoff between them.
  expect(world.insertCalls().map(f => f.answered)).toEqual([401, 200])
  expect(world.commands.length).toBe(2)
  expect(world.acceptedRows().length).toBe(1)
  expect(world.toasts.length).toBe(0)
  expect(world.statusLines.at(-1)).toBeUndefined()
})

test('BigQuery refusing a fresh token too is a credentials notice, cleared once a token works', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [UNAUTHENTICATED, UNAUTHENTICATED, OK_INSERT]
  await startSession($)
  await world.clock.advance(5000)
  expect(world.insertCalls().length).toBe(2)
  expect((await band($)).line).toBe(LINE)
  expect(noticeLines(world)[0]).toContain('BigQuery refused a fresh token too: HTTP 401: Request had invalid authentication credentials.')
  await world.clock.advance(5000)
  expect(world.acceptedRows().length).toBe(1)
  expect((await band($)).line).toBeUndefined()
})

test('a missing permission is a notice with the role to ask for; /bqaa-backfill is named once rows flow again', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.replies = [DENIED, OK_INSERT]
  await startSession($)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await world.clock.advance(5000)
  const shown = await band($)
  expect(shown.line).toBe('rows are not being written: BigQuery denied the identity access to the dataset. To fix, ask for roles/bigquery.dataEditor on my-gcp-project:agent_analytics, then run /bqaa-backfill.')
  expect(shown.waiting).toBe(' 3 row(s) waiting.')
  expect(world.toasts.length).toBe(1)
  // Access granted: new rows land, the band clears, and the transcript says
  // the refused ones wait for /bqaa-backfill (they are not replayed alone).
  await $.tool.call({ tool: 'Read', file_path: 'b.ts' })
  await world.clock.advance(5000)
  expect(world.acceptedRows().length).toBe(2)
  expect((await band($)).line).toBeUndefined()
  expect(world.transcript).toContain('bqaa: rows are being written again; /bqaa-backfill sends the 3 row(s) parked while they could not be.')
})

test('while credentials fail, a retry comes at least every 30 s', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.processReply = GCLOUD_FAILS
  await startSession($)
  // Fail, with rows to send at every tick, until the backoff would pass a
  // minute; read the wait right after the failure that set it.
  let failures = 0
  let waitSeconds = -1
  for (let t = 0; t < 120 && waitSeconds < 0; t += 1) {
    await $.tool.call({ tool: 'Read', file_path: `f${t}.ts` })
    await world.clock.advance(5000)
    const status = await statusText($)
    const now = Number(/backing off: (\d+) failure/.exec(status)?.[1] ?? 0)
    if (now > failures && now >= 8) waitSeconds = Number(/next try in about (\d+)s/.exec(status)?.[1] ?? -1)
    failures = now
  }
  expect(waitSeconds > 0).toBe(true)
  expect(waitSeconds <= 30).toBe(true)
})

test('a prompt while credentials fail retries at once, from a timer: the hook itself waits on nothing', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  const working = world.processReply
  world.processReply = GCLOUD_FAILS
  await startSession($)
  for (let t = 0; t < 6; t += 1) {
    await $.tool.call({ tool: 'Read', file_path: `f${t}.ts` })
    await world.clock.advance(5000)
  }
  // Signed in from the session (`! gcloud auth application-default login`).
  world.processReply = working
  const commands = world.commands.length
  const result = await $.prompt.submit(PROMPT)
  expect(result.text).toBe('hi')
  expect(world.commands.length).toBe(commands)
  expect(world.fetches.length).toBe(0)
  // No time passes: the retry runs as soon as the hook has returned.
  await world.clock.settle()
  expect(world.acceptedRows().some(r => r.event_type === 'USER_MESSAGE_RECEIVED')).toBe(true)
  expect((await band($)).line).toBeUndefined()
})

test('warn (the default) lets prompts in without working credentials', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on)
  world.processReply = GCLOUD_FAILS
  await startSession($)
  await world.clock.advance(5000)
  const result = await $.prompt.submit(PROMPT)
  expect(result.drop).toBeUndefined()
  expect(result.text).toBe('hi')
  expect(await statusText($)).toMatch(/on credential failure: warn/)
})

test('block refuses a prompt while no credentials work, with the fix, and records nothing of it', { options: { ...OPTIONS, onAuthFailure: 'block' } }, async ($, on) => {
  const world = setUp(on)
  world.processReply = GCLOUD_FAILS
  await startSession($)
  const result = await $.prompt.submit(PROMPT)
  expect(result.drop).toBe(
    `BQAA blocks prompts until rows can be written: no working Google credentials. To fix, ${FIX}, then send the prompt again. (token command \`gcloud\` exited 1: ${NO_SIGN_IN})`,
  )
  expect(world.fetches.length).toBe(0)
  // The band says prompts are blocked; the refused prompt left no row.
  const shown = await band($)
  expect(shown.line).toBe(LINE)
  expect(shown.blocked).toBe(' New prompts are refused until then.')
  expect(await statusText($)).toMatch(/on credential failure: block/)
  world.processReply = { exitCode: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' }
  await world.clock.advance(5000)
  expect(world.acceptedRows().map(r => r.event_type)).toEqual(['STATE_DELTA'])
})

test('block lets a prompt in when a token is at hand, with no request and no process', { options: { ...OPTIONS, onAuthFailure: 'block' } }, async ($, on) => {
  const world = setUp(on)
  await startSession($)
  await world.clock.settle()
  const commands = world.commands.length
  const result = await $.prompt.submit(PROMPT)
  expect(result.drop).toBeUndefined()
  expect(result.text).toBe('hi')
  expect(world.commands.length).toBe(commands)
  expect(world.fetches.length).toBe(0)
})

test('block gets a token for the first prompt if none is at hand yet', { options: { ...OPTIONS, onAuthFailure: 'block' } }, async ($, on) => {
  const world = setUp(on)
  await startSession($)
  const result = await $.prompt.submit(PROMPT)
  expect(result.text).toBe('hi')
  expect(world.commands.length).toBe(1)
})

test('block never refuses for a missing permission', { options: { ...OPTIONS, onAuthFailure: 'block' } }, async ($, on) => {
  const world = setUp(on)
  world.replies = [DENIED]
  await startSession($)
  await world.clock.advance(5000)
  expect((await band($)).line).toMatch(/BigQuery denied the identity access/)
  const result = await $.prompt.submit(PROMPT)
  expect(result.drop).toBeUndefined()
  // A permission notice says nothing of refusing prompts.
  expect((await band($)).blocked).toBeUndefined()
})

test('block re-checks credentials BigQuery refused before letting a prompt in: a 401 or a failed check refuses, an answer lets it in', { options: { ...OPTIONS, onAuthFailure: 'block' } }, async ($, on) => {
  const world = setUp(on)
  world.replies = [UNAUTHENTICATED, UNAUTHENTICATED, UNAUTHENTICATED, { reject: 'network unreachable' }, { status: 200, text: '{"id":"my-gcp-project:agent_analytics.agent_events"}' }, OK_INSERT]
  await startSession($)
  await world.clock.advance(5000)
  expect(world.insertCalls().length).toBe(2)
  const still = await $.prompt.submit(PROMPT)
  expect(still.drop ?? '').toMatch(/BigQuery still refuses the credentials \(HTTP 401\)\)$/)
  const failed = await $.prompt.submit(PROMPT)
  expect(failed.drop ?? '').toMatch(/BigQuery refused the credentials before, and checking them again failed: request failed: .*network unreachable/)
  const entered = await $.prompt.submit(PROMPT)
  expect(entered.drop).toBeUndefined()
  // Each check was a tables.get of the table's id with a fresh token: no
  // body, no rows.
  const checks = world.fetches.filter(f => f.method === 'GET')
  expect(checks.length).toBe(3)
  for (const check of checks) {
    expect(check.url).toBe('https://bigquery.googleapis.com/bigquery/v2/projects/my-gcp-project/datasets/agent_analytics/tables/agent_events?fields=id')
    expect(check.body).toBe('')
    expect(check.headers.authorization?.startsWith('Bearer ')).toBe(true)
  }
  expect((await band($)).line).toBeUndefined()
  await world.clock.advance(5000)
  expect(world.acceptedRows().map(r => r.event_type)).toEqual(['STATE_DELTA', 'USER_MESSAGE_RECEIVED'])
})

test('block refuses a prompt whose credential check cannot finish in time, and the token that comes later lets the next one in', { options: { ...OPTIONS, onAuthFailure: 'block' } }, async ($, on) => {
  const world = setUp(on)
  world.processDelayMs = 9000
  await startSession($)
  const pending = $.prompt.submit(PROMPT)
  await world.clock.advance(8000)
  const refused = await pending
  expect(refused.drop ?? '').toMatch(/no access token came within 8 s\)$/)
  await world.clock.advance(1000)
  const entered = await $.prompt.submit(PROMPT)
  expect(entered.drop).toBeUndefined()
})

test('block with capture turned off lets prompts in', { options: { ...OPTIONS, onAuthFailure: 'block', enabled: false } }, async ($, on) => {
  const world = setUp(on)
  world.processReply = GCLOUD_FAILS
  await startSession($)
  expect((await $.prompt.submit(PROMPT)).drop).toBeUndefined()
})

test('block in a dry run lets prompts in', { options: { onAuthFailure: 'block', dryRun: true } }, async ($, on) => {
  const world = setUp(on)
  world.processReply = GCLOUD_FAILS
  await startSession($)
  expect((await $.prompt.submit(PROMPT)).drop).toBeUndefined()
})

test('block with no project or dataset refuses prompts and says what to set', { options: { onAuthFailure: 'block' } }, async ($, on) => {
  setUp(on)
  await startSession($)
  const result = await $.prompt.submit(PROMPT)
  expect(result.drop).toBe('BQAA blocks prompts until rows can be written: project and dataset are not set (userConfig project/dataset or BQAA_PROJECT_ID/BQAA_DATASET).')
})

test('an onAuthFailure that is neither warn nor block reads as warn', { options: { ...OPTIONS, onAuthFailure: 'enforce' } }, async ($, on) => {
  const world = setUp(on)
  world.processReply = GCLOUD_FAILS
  await startSession($)
  expect((await $.prompt.submit(PROMPT)).drop).toBeUndefined()
  expect(await statusText($)).toMatch(/on credential failure: warn/)
})

test('with BQAA_ACCESS_TOKEN refused, the fix is a fresh token or the command', { options: OPTIONS }, async ($, on) => {
  // Joined at run time, like every credential-shaped test value (helpers.ts).
  const world = setUp(on, { BQAA_ACCESS_TOKEN: ['ya29', 'stale-environment-token-0123456789'].join('.') })
  world.replies = [UNAUTHENTICATED]
  await startSession($)
  await world.clock.advance(5000)
  expect((await band($)).line).toBe('rows are not being written: no working Google credentials. To fix, set a fresh BQAA_ACCESS_TOKEN, or unset it to use the token command.')
  expect(world.commands.length).toBe(0)
})

test("with gcloud's own account as the token command, the fix is gcloud auth login", { options: { ...OPTIONS, accessTokenCommand: 'gcloud auth print-access-token' } }, async ($, on) => {
  const world = setUp(on)
  world.processReply = { exitCode: 1, stdout: '', stderr: 'ERROR: (gcloud.auth.print-access-token) You do not currently have an active account selected.\n' }
  await startSession($)
  await world.clock.advance(5000)
  expect((await band($)).line).toBe('rows are not being written: no working Google credentials. To fix, run: gcloud auth login.')
})
