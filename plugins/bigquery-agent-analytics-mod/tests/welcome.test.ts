// The welcome card: in the first session after the mod is installed or
// updated, the band above the prompt says that the mod is on, what it
// records and where to, and then that the first rows landed; a transcript
// line says the same, and a toast says when the rows land. The next prompt
// after they land, or Got it, closes it, and no later session shows it. A
// problem notice has the band first; a run with no one at the prompt shows
// nothing and leaves the store alone.

import { type Engine, expect, test } from 'claude-code/testing'

import { PLUGIN_VERSION } from '../hooks/lib/config.ts'

import { COMMAND, DRY_RUN_DIR, OK_INSERT, OPTIONS, SESSION_ID, type World, deadLetterFiles, setUp, startSession } from './helpers.ts'

const PLUGIN = 'bigquery-agent-analytics-mod'

// What the host passes a hook drawing in the band above the prompt.
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

const TABLE = 'my-gcp-project.agent_analytics.agent_events'
const WHAT = 'sessions, turns, model requests and tool calls'
const RECORDS = `Records ${WHAT} to ${TABLE} (US).`
const WAITING = '◌ Waiting for the first rows, sent every 5 s while you work · /bqaa-status shows the counts'
const landed = (sent: number): string => `✓ First rows landed in BigQuery · ${sent} sent · /bqaa-status shows the counts`
const INSTALLED = ['✓ ', 'BigQuery Agent Analytics mod installed', ` ${PLUGIN_VERSION}`]
const NOT_SET_UP = 'the project and dataset options are set in /config, or BQAA_PROJECT_ID and BQAA_DATASET'
const PROMPT = { text: 'hi', wait: false, origin: { kind: 'composer' } } as const
const CLOSE = 'bqaa-welcome-close'

// The band as the terminal would draw it: every Text in order (the card's
// glyph, title, version and lines, then what the mods after this one drew),
// whether the card is boxed, and its Got it button.
async function band($: Engine, props: { hasSurvey?: boolean; maxRows?: number } = {}): Promise<{ texts: string[]; boxed: boolean; button?: string }> {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND, props: { ...BAND.props, ...props } })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const boxed = (await ui.findAll({ type: 'Box' })).some(b => b.props.borderStyle === 'round')
  const button = (await ui.find({ type: 'Button', key: CLOSE }))?.props.label as string | undefined
  await ui.unmount()
  return { texts, boxed, button }
}

const welcomeLines = (lines: string[]): string[] => lines.filter(l => l.startsWith('bqaa: BigQuery Agent Analytics mod'))
const stored = (world: World): unknown => world.store.get('welcome')
const statusText = async ($: Engine): Promise<string> => (await $.command.run({ command: 'bqaa-status', args: '', ...COMMAND })).text ?? ''

test('a fresh install shows the welcome card, then that the first rows landed, and the next prompt closes it', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on, {}, {})
  await startSession($)
  expect(await band($)).toEqual({ texts: [...INSTALLED, RECORDS, WAITING, 'drawn beneath'], boxed: true, button: 'Got it' })
  expect(welcomeLines(world.transcript)).toEqual([`bqaa: BigQuery Agent Analytics mod installed (${PLUGIN_VERSION}): records ${WHAT} to ${TABLE} (US); /bqaa-status shows what was sent.`])
  // Recorded at once: no later session shows it.
  expect(stored(world)).toEqual({ version: PLUGIN_VERSION, previous: null, sessionId: SESSION_ID, landedAt: null, closed: false })
  // The session-start row lands.
  await world.clock.advance(5000)
  expect((await band($)).texts).toEqual([...INSTALLED, RECORDS, landed(1), 'drawn beneath'])
  expect(world.toasts).toEqual([`BQAA: first rows landed in ${TABLE}`])
  expect(typeof (stored(world) as { landedAt: unknown }).landedAt).toBe('number')
  // The count moves with each send; one toast.
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await world.clock.advance(5000)
  expect((await band($)).texts).toEqual([...INSTALLED, RECORDS, landed(3), 'drawn beneath'])
  expect(world.toasts.length).toBe(1)
  // The person's next prompt: the card has done its job.
  await $.prompt.submit(PROMPT)
  expect(await band($)).toEqual({ texts: ['drawn beneath'], boxed: false, button: undefined })
  expect(stored(world)).toMatchObject({ closed: true })
  await world.clock.advance(5000)
  expect(world.toasts.length).toBe(1)
  expect(welcomeLines(world.transcript).length).toBe(1)
})

test('a band drawn before the session started shows the card at once, before any row lands', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on, {}, {})
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['drawn beneath'])
  await startSession($)
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual([...INSTALLED, RECORDS, WAITING, 'drawn beneath'])
  await ui.unmount()
  expect(world.acceptedRows().length).toBe(0)
})

const SHOWN_BEFORE = [
  ['an earlier session showed the card', { version: PLUGIN_VERSION, previous: null, sessionId: 'an-earlier-session', landedAt: null, closed: false }],
  ['this session showed it and it was closed', { version: PLUGIN_VERSION, previous: null, sessionId: SESSION_ID, landedAt: 1, closed: true }],
] as const

for (const [name, record] of SHOWN_BEFORE) {
  test(`no card, line or toast when ${name}`, { options: OPTIONS }, async ($, on) => {
    const world = setUp(on, {}, { welcome: record })
    await startSession($)
    await world.clock.advance(5000)
    expect(world.acceptedRows().length).toBe(1)
    expect((await band($)).texts).toEqual(['drawn beneath'])
    expect(welcomeLines(world.transcript)).toEqual([])
    expect(world.toasts).toEqual([])
    expect(stored(world)).toEqual(record)
  })
}

test('a reload in the session that showed the card shows it again as it was, with no second line or toast', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on, {}, { welcome: { version: PLUGIN_VERSION, previous: null, sessionId: SESSION_ID, landedAt: 1, closed: false } })
  await startSession($)
  // A reload starts the counts over: no count until rows land again.
  expect((await band($)).texts).toEqual([...INSTALLED, RECORDS, '✓ First rows landed in BigQuery · /bqaa-status shows the counts', 'drawn beneath'])
  await world.clock.advance(5000)
  expect((await band($)).texts).toEqual([...INSTALLED, RECORDS, landed(1), 'drawn beneath'])
  expect(welcomeLines(world.transcript)).toEqual([])
  expect(world.toasts).toEqual([])
})

test('an update greets the new version and names the one it replaced', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on, {}, { welcome: { version: '0.0.9', previous: null, sessionId: 'an-earlier-session', landedAt: 1, closed: true } })
  await startSession($)
  expect((await band($)).texts).toEqual(['✓ ', `BigQuery Agent Analytics mod updated to ${PLUGIN_VERSION}`, ' was 0.0.9', RECORDS, WAITING, 'drawn beneath'])
  expect(welcomeLines(world.transcript)).toEqual([`bqaa: BigQuery Agent Analytics mod updated to ${PLUGIN_VERSION} (from 0.0.9): records ${WHAT} to ${TABLE} (US); /bqaa-status shows what was sent.`])
  expect(stored(world)).toEqual({ version: PLUGIN_VERSION, previous: '0.0.9', sessionId: SESSION_ID, landedAt: null, closed: false })
})

test('not set up: the card says what to set, stays after a prompt, and Got it closes it for good', { options: {} }, async ($, on) => {
  const world = setUp(on, {}, {})
  await startSession($)
  const card = ['◇ ', 'BigQuery Agent Analytics mod installed, not set up yet', ` ${PLUGIN_VERSION}`, `Nothing is recorded until ${NOT_SET_UP}.`, "Then make the dataset with the mod's setup.sh; its README shows how."]
  expect(await band($)).toEqual({ texts: [...card, 'drawn beneath'], boxed: true, button: 'Got it' })
  expect(welcomeLines(world.transcript)).toEqual([`bqaa: BigQuery Agent Analytics mod installed (${PLUGIN_VERSION}), not set up yet: nothing is recorded until ${NOT_SET_UP}.`])
  // No rows can land, so a prompt leaves it up.
  await $.prompt.submit(PROMPT)
  await world.clock.advance(5000)
  expect((await band($)).texts).toEqual([...card, 'drawn beneath'])
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  await ui.press({ key: CLOSE })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['drawn beneath'])
  await ui.unmount()
  expect(stored(world)).toMatchObject({ closed: true })
})

test('a missing dataset has the band first; once rows land, the card says so', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on, {}, {})
  world.replies = [DATASET_MISSING]
  await startSession($)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await world.clock.advance(5000)
  const during = (await band($)).texts
  expect(during.some(t => t.startsWith('rows are not being written: BigQuery cannot find the dataset'))).toBe(true)
  expect(during.some(t => t.startsWith('BigQuery Agent Analytics mod'))).toBe(false)
  // setup.sh has made it, and BigQuery finds it.
  world.replies = [OK_INSERT]
  for (let t = 0; t < 8; t += 1) await world.clock.advance(5000)
  const sent = world.acceptedRows().length
  expect(sent).toBe(3)
  expect((await band($)).texts).toEqual([...INSTALLED, RECORDS, landed(3), 'drawn beneath'])
  expect(world.toasts.length).toBe(2)
  expect(world.toasts.at(-1)).toBe(`BQAA: first rows landed in ${TABLE}`)
})

test('rows parked while the dataset was missing land by replay in an idle session, and the card says so', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on, {}, {})
  world.replies = [DATASET_MISSING]
  await startSession($)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  // Until every row is parked and none is queued.
  for (let t = 0; t < 30 && !/queue: 0 rows/.test(await statusText($)); t += 1) await world.clock.advance(5000)
  expect(deadLetterFiles(world).length > 0).toBe(true)
  // The dataset is made, and nothing new is queued: only the replay sends.
  world.replies = [OK_INSERT]
  for (let t = 0; t < 8; t += 1) await world.clock.advance(5000)
  expect(world.acceptedRows().length).toBe(3)
  expect(deadLetterFiles(world).length).toBe(0)
  expect((await band($)).texts).toEqual([...INSTALLED, RECORDS, landed(3), 'drawn beneath'])
  expect(world.toasts.at(-1)).toBe(`BQAA: first rows landed in ${TABLE}`)
})

test('a run with no one at the prompt shows no card and leaves the store alone', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on, {}, {})
  await $.classic.SessionStart({ source: 'startup', session_id: SESSION_ID, model: 'example-model', cwd: '/work/my-repo' })
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work/my-repo' })
  await world.clock.advance(5000)
  expect(world.acceptedRows().length).toBe(1)
  expect(welcomeLines(world.transcript)).toEqual([])
  expect(world.toasts).toEqual([])
  expect(stored(world)).toBeUndefined()
  // The first interactive session after it still has the card.
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/my-repo' })
  expect((await band($)).texts.slice(0, 3)).toEqual(INSTALLED)
})

test('a store that never answers keeps the card away, never the rows or the commands', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on, {}, {})
  world.hangStore = true
  await $.classic.SessionStart({ source: 'startup', session_id: SESSION_ID, model: 'example-model', cwd: '/work/my-repo' })
  // session.start waits on the store last; nothing else waits behind it.
  void $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/my-repo' })
  await world.clock.advance(5000)
  expect(world.acceptedRows().length).toBe(1)
  expect(world.registered).toEqual(['bqaa-status', 'bqaa-flush', 'bqaa-backfill'])
  expect((await band($)).texts).toEqual(['drawn beneath'])
})

test('dry run: the card says where rows are written, then that the first were', { options: { dryRun: true } }, async ($, on) => {
  const world = setUp(on, {}, {})
  await startSession($)
  const head = ['✓ ', 'BigQuery Agent Analytics mod installed, dry run', ` ${PLUGIN_VERSION}`, `Writes ${WHAT} as JSONL files to ${DRY_RUN_DIR}, not to BigQuery.`]
  expect((await band($)).texts).toEqual([...head, '◌ Waiting for the first rows, written every 5 s while you work · /bqaa-status shows the counts', 'drawn beneath'])
  expect(welcomeLines(world.transcript)).toEqual([`bqaa: BigQuery Agent Analytics mod installed (${PLUGIN_VERSION}), dry run: writes ${WHAT} as JSONL files to ${DRY_RUN_DIR}, not to BigQuery.`])
  await world.clock.advance(5000)
  expect((await band($)).texts).toEqual([...head, '✓ First rows written · 1 so far · /bqaa-status shows the counts', 'drawn beneath'])
  expect(world.toasts).toEqual([`BQAA: first rows written to ${DRY_RUN_DIR}`])
})

test('capture off: the card says nothing is recorded, and how to turn it on', { options: { ...OPTIONS, enabled: false } }, async ($, on) => {
  const world = setUp(on, {}, {})
  await startSession($)
  expect((await band($)).texts).toEqual([
    '○ ',
    'BigQuery Agent Analytics mod installed, capture off',
    ` ${PLUGIN_VERSION}`,
    'Nothing is recorded: the enabled option is off, or BQAA_TRACE_ENABLED=false. Turn it on in /config.',
    'drawn beneath',
  ])
  expect(welcomeLines(world.transcript)).toEqual([`bqaa: BigQuery Agent Analytics mod installed (${PLUGIN_VERSION}); capture is off (the enabled option, or BQAA_TRACE_ENABLED=false).`])
})

test('the card is boxed where the band has the rows for a border, lines alone where not, and yields to a survey', { options: OPTIONS }, async ($, on) => {
  setUp(on, {}, {})
  await startSession($)
  expect(await band($, { maxRows: 5 })).toEqual({ texts: [...INSTALLED, RECORDS, WAITING, 'drawn beneath'], boxed: true, button: 'Got it' })
  expect(await band($, { maxRows: 4 })).toEqual({ texts: [...INSTALLED, RECORDS, WAITING, 'drawn beneath'], boxed: false, button: 'Got it' })
  expect(await band($, { hasSurvey: true })).toEqual({ texts: ['drawn beneath'], boxed: false, button: undefined })
})
