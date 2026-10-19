// The welcome card: in the first session after the mod is installed or
// updated, the band above the prompt says that the mod is on, what it
// records and where to, and then that the first rows landed there; a
// transcript line says the same, and a toast says when the rows land. The
// next prompt after they land, or Got it, closes it, and no later session
// shows it. A problem notice has the band first; a run with no one at the
// prompt shows nothing and leaves the store alone; nothing waits on the
// store for the card, session.start included.

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
// Where rows land under OPTIONS, as the record names it.
const HERE = `${TABLE} (US)`

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
  expect(stored(world)).toEqual({ version: PLUGIN_VERSION, previous: null, sessionId: SESSION_ID, landedAt: null, landedTo: null, closed: false })
  // The session-start row lands.
  await world.clock.advance(5000)
  expect((await band($)).texts).toEqual([...INSTALLED, RECORDS, landed(1), 'drawn beneath'])
  expect(world.toasts).toEqual([`BQAA: first rows landed in ${TABLE}`])
  expect(typeof (stored(world) as { landedAt: unknown }).landedAt).toBe('number')
  expect(stored(world)).toMatchObject({ landedTo: HERE })
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
  const world = setUp(on, {}, { welcome: { version: PLUGIN_VERSION, previous: null, sessionId: SESSION_ID, landedAt: 1, landedTo: HERE, closed: false } })
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
  expect(stored(world)).toEqual({ version: PLUGIN_VERSION, previous: '0.0.9', sessionId: SESSION_ID, landedAt: null, landedTo: null, closed: false })
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

for (const operation of ['get', 'set'] as const) {
  test(`a welcome store ${operation} that never answers holds up nothing: session.start returns, rows land, the commands are there`, { options: OPTIONS }, async ($, on) => {
    if (operation === 'get') on('store.get', { key: 'welcome' }, () => new Promise<never>(() => undefined))
    else on('store.set', { key: 'welcome' }, () => new Promise<never>(() => undefined))
    const world = setUp(on, {}, {})
    let started = false
    void startSession($).then(() => {
      started = true
    })
    await world.clock.advance(5000)
    expect(started).toBe(true)
    expect(world.acceptedRows().length).toBe(1)
    expect(world.registered).toEqual(['bqaa-status', 'bqaa-flush', 'bqaa-backfill'])
    // Never read: no card. Read, but never recorded: the card, with its rows.
    const texts = (await band($)).texts
    if (operation === 'get') expect(texts).toEqual(['drawn beneath'])
    else expect(texts).toEqual([...INSTALLED, RECORDS, landed(1), 'drawn beneath'])
  })
}

test('a session left open never writes over a newer version another session greeted meanwhile', { options: OPTIONS }, async ($, on) => {
  const world = setUp(on, {}, {})
  await startSession($)
  const newer = { version: '0.2.0', previous: PLUGIN_VERSION, sessionId: 'a-newer-session', landedAt: 10, landedTo: HERE, closed: true }
  world.store.set('welcome', newer)
  // This session's rows land, then its card is closed: neither touches the record.
  await world.clock.advance(5000)
  expect((await band($)).texts).toEqual([...INSTALLED, RECORDS, landed(1), 'drawn beneath'])
  await $.prompt.submit(PROMPT)
  await world.clock.settle()
  expect(stored(world)).toEqual(newer)
})

test('rows that land while the store is still being read: the card says so as soon as it shows', { options: OPTIONS }, async ($, on) => {
  // The first read of the record waits until the test answers it; later
  // ones read the store.
  let answer: ((stored: { value: undefined }) => void) | undefined
  on('store.get', { key: 'welcome' }, () => (answer === undefined ? new Promise<{ value: unknown }>(resolve => (answer = resolve)) : { value: world.store.get('welcome') }))
  const world = setUp(on, {}, {})
  await startSession($)
  await world.clock.advance(5000)
  expect(world.acceptedRows().length).toBe(1)
  answer?.({ value: undefined })
  await world.clock.settle()
  expect((await band($)).texts).toEqual([...INSTALLED, RECORDS, landed(1), 'drawn beneath'])
  expect(world.toasts).toEqual([`BQAA: first rows landed in ${TABLE}`])
  expect(stored(world)).toMatchObject({ landedTo: HERE })
})

test('a store read that answers after session.start ran again is not used: one card, one line', { options: OPTIONS }, async ($, on) => {
  const answers: ((stored: { value: undefined }) => void)[] = []
  on('store.get', { key: 'welcome' }, () => new Promise<{ value: undefined }>(resolve => answers.push(resolve)))
  const world = setUp(on, {}, {})
  await startSession($)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/my-repo' })
  expect(answers.length).toBe(2)
  // The later start's read answers first; the earlier one's after it.
  answers[1]?.({ value: undefined })
  await world.clock.settle()
  answers[0]?.({ value: undefined })
  await world.clock.settle()
  expect(welcomeLines(world.transcript).length).toBe(1)
  expect((await band($)).texts).toEqual([...INSTALLED, RECORDS, WAITING, 'drawn beneath'])
})

test('a reload from a dry run to BigQuery waits for rows to land in BigQuery: files written in the dry run are not that', { options: OPTIONS }, async ($, on) => {
  let dryRun = true
  on('env.get', { name: 'BQAA_DRY_RUN' }, () => ({ value: dryRun ? 'true' : undefined }))
  const world = setUp(on, {}, {})
  await startSession($)
  await world.clock.advance(5000)
  expect(world.fetches.length).toBe(0)
  expect(stored(world)).toMatchObject({ landedTo: `dry run: ${DRY_RUN_DIR}` })
  // The dry run is turned off, and the mod loads again in the same session.
  dryRun = false
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/my-repo' })
  await world.clock.settle()
  expect((await band($)).texts).toEqual([...INSTALLED, RECORDS, WAITING, 'drawn beneath'])
  // A prompt leaves it up: nothing has landed in BigQuery yet.
  await $.prompt.submit(PROMPT)
  expect((await band($)).texts.slice(0, 5)).toEqual([...INSTALLED, RECORDS, WAITING])
  // The prompt's rows land, and the card says so.
  await world.clock.advance(5000)
  const texts = (await band($)).texts
  expect(texts[4]?.startsWith('✓ First rows landed in BigQuery · ')).toBe(true)
  expect(world.toasts).toEqual([`BQAA: first rows written to ${DRY_RUN_DIR}`, `BQAA: first rows landed in ${TABLE}`])
  expect(welcomeLines(world.transcript).length).toBe(1)
})

test('a reload to another table waits for rows to land in that table', { options: {} }, async ($, on) => {
  let dataset = 'events_a'
  on('env.get', { name: 'BQAA_DATASET' }, () => ({ value: dataset }))
  const world = setUp(on, { BQAA_PROJECT_ID: 'my-gcp-project' }, {})
  await startSession($)
  await world.clock.advance(5000)
  expect(world.acceptedRows().length).toBe(1)
  dataset = 'events_b'
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/my-repo' })
  await world.clock.settle()
  expect(world.insertCalls().length).toBe(1)
  expect((await band($)).texts).toEqual([...INSTALLED, `Records ${WHAT} to my-gcp-project.events_b.agent_events (US).`, WAITING, 'drawn beneath'])
  await $.prompt.submit(PROMPT)
  expect((await band($)).texts[4]).toBe(WAITING)
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
