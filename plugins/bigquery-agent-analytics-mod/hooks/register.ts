// BigQuery Agent Analytics mod: captures the host coding-agent CLI's session,
// turn, model request and tool events as BQAA `agent_events` rows and streams
// them to BigQuery from the background.
//
// The rule the capture hooks here follow (the lesson of the settings-hook
// plugin's PR #6, whose foreground hooks could hang the host CLI): a hook
// calls `next` right away, records what it saw into an in-memory queue, and
// returns. No hook waits on the network or a process; the writer does that
// from timers. Two lifecycle hooks do bounded work before passing their event
// on: session.start sets the writer up and registers the commands, and
// session.end writes what is still queued to a spill file, waiting at most
// the exit budget. If the mod's own code throws, the event goes on as if the
// mod were not there (fail open): the observers through their `.catch`, the
// other hooks because their bookkeeping runs inside `safely` or a `try`.
// While rows cannot be written for lack of credentials or permission, the
// band above the prompt says what is wrong; no prompt ever waits on that.
// With nothing wrong, in the first session after an install or an update,
// the band shows a welcome card: that the mod is on, where rows go, and when
// the first ones land.

import type { EngineInterface, Register, SessionStartInput } from 'claude-code'

import { type Config, type EnvSnapshot, type Options, PLUGIN_VERSION, canDeliver, deadLetterPartition, destinationDir, joinPath, resolveConfig, tableRef } from './lib/config.ts'
import { HOST_FILE_BYTES, kindOf } from './lib/deadletter.ts'
import { randomIds } from './lib/ids.ts'
import type { BqaaRow } from './lib/rows.ts'
import { redactDiagnostic } from './lib/sanitize.ts'
import { type DeadLetterSummary, formatStatus } from './lib/status.ts'
import { type StepCtx, type StepResult, type ToolCtx, type ToolOutcome, Tracer, errorText } from './lib/tracer.ts'
import { CardRecords, WELCOME_KEY, type Welcome, cardKey, closedKey, destinationKey, greetedBy, greetedKey, greetedVersions, landedToast, openWelcome, reopenWelcome, welcomeCard, welcomeNotice } from './lib/welcome.ts'
import { COMMAND_LINE_CHARS, type Io, Writer } from './lib/writer.ts'

let options: Options = {}
let config: Config = resolveConfig({}, {})
let writer: Writer | null = null
let flushTimer: { cancel: () => void } | null = null
let internalErrors = 0
// The host's timer, from session.start's `$`, for work that waits briefly
// outside any hook (a finished tool call waiting for its decision).
let clockAfter: ((ms: number, fn: () => void) => { cancel: () => void }) | null = null

// The welcome card (lib/welcome.ts) in the first session after the mod is
// installed or updated; null in any other session, and once it is closed.
let welcome: Welcome | null = null
// Counts session.start runs: a store read for the card that answers after a
// later one began is not used.
let welcomeStarts = 0
// The writes of the card this load of the code showed (`CardRecords`).
let records: CardRecords | null = null
// Where the session keeps the card for a reload of this code (types/).
const WELCOME_STATE = { plugin: 'bigquery-agent-analytics-mod', key: 'welcome' } as const

// Rows captured before session.start built the writer (an event the engine
// raised first); handed over once it exists.
const early: { row: BqaaRow; redactions: number }[] = []

// Whether session.start has loaded the configuration: the options, the
// environment and the host version. Until then `config` holds the defaults
// register() starts with, so the session-start row, whose classic event the
// host raises while session.start is still reading the environment, waits.
let configured = false
const awaitingConfig: (() => void)[] = []

// `work` now if the configuration is loaded, else once session.start has
// loaded it. Never waits: the hook calling this has called `next` already.
function whenConfigured(work: () => void): void {
  if (configured) safely(work)
  else if (awaitingConfig.length < 10) awaitingConfig.push(work)
}

function configurationLoaded(): void {
  configured = true
  for (const work of awaitingConfig.splice(0)) safely(work)
}

const tracer = new Tracer({
  now: () => Date.now(),
  ids: randomIds,
  config: () => config,
  emit: (row, redactions) => {
    if (writer) writer.enqueue(row, redactions)
    else if (early.length < 1000) early.push({ row, redactions })
  },
  after: (ms, fn) => (clockAfter ? clockAfter(ms, fn) : null),
})

// The mod's bookkeeping never breaks the event it watches.
function safely(work: () => void): void {
  try {
    work()
  } catch {
    internalErrors += 1
  }
}

// `next(e)` for `turn.step` streams the response; this passes every chunk
// (and `return`/`throw`) straight through and notes when the first chunk of
// content (text, thinking or a tool call) arrived.
function timedStream<C extends { kind: string }, R>(inner: AsyncGenerator<C, R, unknown>, onFirstContent: () => void): AsyncGenerator<C, R, unknown> {
  let seen = false
  const stream: AsyncGenerator<C, R, unknown> = {
    async next(...args: [] | [unknown]) {
      const step = await inner.next(...args)
      if (!seen && !step.done && step.value.kind !== 'engine') {
        seen = true
        onFirstContent()
      }
      return step
    },
    return: (value: R | PromiseLike<R>) => inner.return(value),
    throw: (error: unknown) => inner.throw(error),
    [Symbol.asyncIterator]: () => stream,
  }
  return stream
}

// A variable a policy refuses to hand over reads as unset, not as a reason
// to stop capturing.
const none = (): undefined => undefined

// Every line the mod logs or a command prints is redacted on its way out.
const clean = (text: string, maxChars = 2000): string => redactDiagnostic(text, maxChars)
const say = (text: string): { text: string } => ({ text: clean(text, 8000) })

async function readEnv($: EngineInterface): Promise<EnvSnapshot> {
  const [
    BQAA_PROJECT_ID,
    GCP_PROJECT_ID,
    GOOGLE_CLOUD_PROJECT,
    BQAA_DATASET,
    BQ_DATASET,
    BQAA_TABLE,
    BQ_TABLE,
    BQAA_LOCATION,
    BQAA_TRACE_ENABLED,
    BQAA_DRY_RUN,
    BQAA_AGENT_NAME,
    BQAA_USER_ID,
    USER,
    USERNAME,
    HOME,
    USERPROFILE,
    BQAA_DEAD_LETTER_DIR,
    BQAA_ACCESS_TOKEN_COMMAND,
    BQAA_REQUEST_TIMEOUT_MS,
    BQAA_MAX_QUEUE_ROWS,
    BQAA_EXIT_FLUSH_MS,
    BQAA_AUTO_CREATE_TABLE,
    BQAA_AUTO_BACKFILL,
  ] = await Promise.all([
    $.env.get('BQAA_PROJECT_ID').catch(none),
    $.env.get('GCP_PROJECT_ID').catch(none),
    $.env.get('GOOGLE_CLOUD_PROJECT').catch(none),
    $.env.get('BQAA_DATASET').catch(none),
    $.env.get('BQ_DATASET').catch(none),
    $.env.get('BQAA_TABLE').catch(none),
    $.env.get('BQ_TABLE').catch(none),
    $.env.get('BQAA_LOCATION').catch(none),
    $.env.get('BQAA_TRACE_ENABLED').catch(none),
    $.env.get('BQAA_DRY_RUN').catch(none),
    $.env.get('BQAA_AGENT_NAME').catch(none),
    $.env.get('BQAA_USER_ID').catch(none),
    $.env.get('USER').catch(none),
    $.env.get('USERNAME').catch(none),
    $.env.get('HOME').catch(none),
    $.env.get('USERPROFILE').catch(none),
    $.env.get('BQAA_DEAD_LETTER_DIR').catch(none),
    $.env.get('BQAA_ACCESS_TOKEN_COMMAND').catch(none),
    $.env.get('BQAA_REQUEST_TIMEOUT_MS').catch(none),
    $.env.get('BQAA_MAX_QUEUE_ROWS').catch(none),
    $.env.get('BQAA_EXIT_FLUSH_MS').catch(none),
    $.env.get('BQAA_AUTO_CREATE_TABLE').catch(none),
    $.env.get('BQAA_AUTO_BACKFILL').catch(none),
  ])
  return {
    BQAA_PROJECT_ID,
    GCP_PROJECT_ID,
    GOOGLE_CLOUD_PROJECT,
    BQAA_DATASET,
    BQ_DATASET,
    BQAA_TABLE,
    BQ_TABLE,
    BQAA_LOCATION,
    BQAA_TRACE_ENABLED,
    BQAA_DRY_RUN,
    BQAA_AGENT_NAME,
    BQAA_USER_ID,
    USER,
    USERNAME,
    HOME,
    USERPROFILE,
    BQAA_DEAD_LETTER_DIR,
    BQAA_ACCESS_TOKEN_COMMAND,
    BQAA_REQUEST_TIMEOUT_MS,
    BQAA_MAX_QUEUE_ROWS,
    BQAA_EXIT_FLUSH_MS,
    BQAA_AUTO_CREATE_TABLE,
    BQAA_AUTO_BACKFILL,
  }
}

// The session id, read again for each event: after /clear, /resume or
// /branch the process goes on under a new id, and neither session.start nor,
// where a managed policy keeps classic hooks from a user plugin,
// classic.SessionStart says so. A read the host refuses leaves the id the
// tracer has: the last one, or after a session change none. It cannot fail,
// so hooks read it before passing the event on: a tool's own events (its
// permission prompt, a subagent) then find the tool already started.
async function readSessionId($: EngineInterface): Promise<void> {
  try {
    tracer.setSession({ sessionId: await $.session.id() })
  } catch {
    // The tracer keeps what it has.
  }
}

// With recordHostname: the machine's name, from the `hostname` command, run
// from a timer (never in a hook). Rows built after it answers carry it.
async function lookUpHostname($: EngineInterface): Promise<void> {
  try {
    const answer = await $.process.run(['hostname'], { timeoutMs: 5000 })
    const printed = answer.stdout.trim()
    if (answer.exitCode === 0 && /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(printed)) tracer.setSession({ hostName: printed })
    else $.ui.log(clean(`bqaa: recordHostname: the hostname command gave no usable name (exit ${answer.exitCode})`), { to: 'debug' })
  } catch (err) {
    $.ui.log(clean(`bqaa: recordHostname: ${errorText(err)}`), { to: 'debug' })
  }
}

// In a session a person sees (a `-p` run draws no band): the welcome card
// for a version not greeted yet, recorded at once so that no later session
// shows it, or the card this session showed, as a reload left it. Runs in
// the background: nothing waits on the store for it. `start` is the
// session.start run it belongs to. Nothing of an earlier load of this code
// is used: a reload starts it afresh, keeping `$.state` alone.
async function startWelcome($: EngineInterface, e: SessionStartInput, sessionId: string | null, start: number): Promise<void> {
  if (!e.isInteractive || e.surface === null) return
  const key = destinationKey(config)
  // The card this session showed, as it left it (the greeting and a close
  // included, written to the store or not). Where the session keeps no
  // state, the store's records decide.
  let kept: Welcome | null = null
  try {
    kept = (await $.state.get(WELCOME_STATE)).value ?? null
  } catch {
    kept = null
  }
  let opened: { welcome: Welcome; isNew: boolean } | null
  try {
    if (kept !== null && kept.version === PLUGIN_VERSION && sessionId !== null && kept.sessionId === sessionId) opened = reopenWelcome(kept, key)
    else {
      const [latest, greeted] = await Promise.all([$.store.get(WELCOME_KEY), $.store.get(greetedKey(PLUGIN_VERSION))])
      if (start !== welcomeStarts) return
      let landing: unknown
      let closed: unknown
      let versions: string[] = []
      if (sessionId !== null && greetedBy(latest, greeted)?.sessionId === sessionId) {
        ;[landing, closed] = await Promise.all([$.store.get(cardKey(PLUGIN_VERSION, sessionId)), $.store.get(closedKey(PLUGIN_VERSION, sessionId))])
      } else if (greetedBy(latest, greeted) === null) {
        // A new card: the versions greeted before name the one it replaces.
        try {
          versions = greetedVersions(await $.store.keys())
        } catch {
          versions = []
        }
      }
      opened = openWelcome({ latest, greeted, landing, closed, versions }, sessionId, key)
    }
  } catch {
    // Unable to tell whether it showed before: never a card each session.
    return
  }
  // session.start ran again meanwhile: the card is that start's to show.
  if (start !== welcomeStarts || opened === null) return
  welcome = opened.welcome
  // The band may be drawn already, from before this session started.
  redrawBand($)
  keepWelcome($, opened.welcome)
  records = new CardRecords((key, value) => $.store.set(key, value), opened.welcome, opened.isNew)
  if (opened.isNew) $.ui.log(clean(welcomeNotice(opened.welcome, config)))
  // Rows that landed while the records were read (this writer's rows go
  // where this configuration sends them): the card says so now.
  if (writer !== null && writer.counters.sent > 0) rowsLanded($, writer.counters.sent, key)
}

// The card, for a reload of this code to show as it is now; one a reload
// cannot read is shown from the store's records.
function keepWelcome($: EngineInterface, card: Welcome): void {
  try {
    void $.state.set(WELCOME_STATE, card).catch(() => {
      internalErrors += 1
    })
  } catch {
    internalErrors += 1
  }
}

// A surface that draws no band may refuse the redraw: nothing to draw then.
function redrawBand($: EngineInterface): void {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // No band here.
  }
}

// `rows` landed in `to` (their destination's `destinationKey`): where this
// configuration sends rows, the card counts them, and the first time it
// says they landed, with a toast as well, as the band may be collapsed. Rows
// that a writer of an earlier configuration sent elsewhere say nothing here.
function rowsLanded($: EngineInterface, rows: number, to: string | null): void {
  const shown = welcome
  if (shown === null || to === null || to !== destinationKey(config)) return
  const first = shown.landedAt === null
  welcome = { ...shown, sent: shown.sent + rows, ...(first ? { landedAt: Date.now(), landedTo: to } : {}) }
  keepWelcome($, welcome)
  if (first) {
    records?.update(welcome)
    try {
      $.ui.toast(clean(landedToast(config), 500), { timeoutMs: 15_000 })
    } catch {
      // No toast here: the card says it.
    }
  }
  redrawBand($)
}

// Got it was pressed, or a prompt came after rows landed.
function closeWelcome($: EngineInterface): void {
  const shown = welcome
  if (shown === null) return
  welcome = null
  const closed = { ...shown, closed: true }
  keepWelcome($, closed)
  records?.update(closed)
  redrawBand($)
}

// This table's dead-letter files, those elsewhere in the dead-letter
// directory (other tables' subdirectories, at most 50 of them, and files from
// the older flat layout), and files too large to read back.
async function deadLetterSummary($: EngineInterface): Promise<DeadLetterSummary> {
  if (config.deadLetterDir === '') return { error: 'no dead-letter directory configured' }
  const dir = deadLetterPartition(config)
  const summary = { dir, files: 0, bytes: 0, byKind: {} as Record<string, number>, oversized: [] as string[], elsewhere: 0 }
  try {
    if (!(await $.fs.exists(config.deadLetterDir))) return summary
    if (await $.fs.exists(dir)) {
      for (const entry of await $.fs.list(dir)) {
        const kind = kindOf(entry.name)
        if (entry.kind !== 'file' || kind === null || entry.size === 0) continue
        summary.files += 1
        summary.bytes += entry.size
        summary.byKind[kind] = (summary.byKind[kind] ?? 0) + 1
        if (entry.size > HOST_FILE_BYTES) summary.oversized.push(entry.name)
      }
    }
    const mine = destinationDir(tableRef(config))
    let dirs = 0
    for (const entry of await $.fs.list(config.deadLetterDir)) {
      if (entry.kind === 'file' && kindOf(entry.name) !== null && entry.size > 0) summary.elsewhere += 1
      else if (entry.kind === 'dir' && entry.name !== mine && dirs < 50) {
        dirs += 1
        for (const inner of await $.fs.list(joinPath(config.deadLetterDir, entry.name))) {
          if (inner.kind === 'file' && kindOf(inner.name) !== null && inner.size > 0) summary.elsewhere += 1
        }
      }
    }
    return summary
  } catch (err) {
    return { error: clean(`could not list ${config.deadLetterDir}: ${errorText(err)}`, 300) }
  }
}

export const register: Register = (on, registered) => {
  options = registered
  config = resolveConfig(registered, {})
  configured = false
  awaitingConfig.length = 0

  on('session.start', async ($, e, next) => {
    // A store read for the card from an earlier run is not used from here
    // on, and that run's card is gone until this run's shows.
    const start = ++welcomeStarts
    welcome = null
    try {
      config = resolveConfig(options, await readEnv($))
      clockAfter = (ms, fn) => $.clock.after(ms, fn)
      const io: Io = {
        now: () => Date.now(),
        after: (ms, fn) => $.clock.after(ms, fn),
        fetch: async (url, init) => {
          const answer = await $.http.fetch(url, init)
          return { status: answer.status, text: answer.text }
        },
        runCommand: async (argv, timeoutMs) => {
          const run = await $.process.run(argv, { timeoutMs })
          return { exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr }
        },
        // Refused by a policy, it reads as unset: the token command is next.
        envToken: () => $.env.get('BQAA_ACCESS_TOKEN').catch(none),
        writeFile: (path, text) => $.fs.write(path, text),
        readFile: async path => {
          const read = await $.fs.read(path)
          return typeof read === 'string' ? read : ''
        },
        exists: path => $.fs.exists(path),
        listDir: async path => (await $.fs.list(path)).map(entry => ({ name: entry.name, kind: entry.kind, size: entry.size, mtimeMs: entry.mtimeMs })),
        storeGet: key => $.store.get(key),
        storeSet: (key, value) => $.store.set(key, value),
        storeDelete: key => $.store.delete(key),
        status: text => $.ui.status(text === undefined ? undefined : clean(text, 300)),
        debug: text => $.ui.log(clean(text), { to: 'debug' }),
        toast: text => $.ui.toast(clean(text, 500), { timeoutMs: 15_000 }),
        notice: text => $.ui.log(clean(text)),
        redraw: () => $.ui.invalidate('ui.render'),
        // Where setup.sh is, for the fix when BigQuery cannot find the dataset.
        pluginRoot: $.plugin.root,
        sent: (rows, to) => rowsLanded($, rows, destinationKey(to)),
      }
      const previous = writer
      writer = new Writer(io, () => config, () => tracer.sessionId)
      // session.start can fire again without a reload (the plugin was turned
      // off and on): keep what the previous writer still held.
      if (previous) writer.adopt(previous)
      // The host keeps one status line per plugin until it is replaced, a
      // reload included: this writer starts with none, as it holds no notice.
      writer.clearStatus()
      for (const held of early.splice(0)) writer.enqueue(held.row, held.redactions)
      const [sessionId, version] = await Promise.all([$.session.id().catch(() => null), $.session.version().catch(() => null)])
      tracer.setSession({ sessionId, cwd: e.cwd, engineVersion: version?.version ?? null })
      flushTimer?.cancel()
      flushTimer = $.clock.every(config.flushIntervalMs, () => {
        void writer?.flush()
      })
      if (config.enabled && config.recordHostname) $.clock.after(0, () => void lookUpHostname($))
      if (canDeliver(config) && !config.dryRun) {
        // Off this dispatch: the token command and the replay run later.
        $.clock.after(0, () => writer?.prefetchToken())
        if (config.autoBackfill) {
          $.clock.after(15_000, () => {
            void writer?.backfill(['spill', 'retry'], 'auto')
          })
        }
      }
      for (const problem of config.problems) $.ui.log(clean(`bqaa: ${problem}`), { to: 'debug' })
    } catch (err) {
      internalErrors += 1
      $.ui.log(clean(`bqaa: setup failed, rows are not sent: ${errorText(err)}`), { to: 'debug' })
    }
    // A session-start row that waited for the configuration is written now.
    configurationLoaded()
    // Each in its own try: a refused name must not keep the others out.
    try {
      await $.command.register({ name: 'bqaa-status', description: 'BigQuery Agent Analytics: queue, sent, failed and dead-letter counts', immediate: true })
    } catch {
      internalErrors += 1
    }
    try {
      await $.command.register({ name: 'bqaa-flush', description: 'BigQuery Agent Analytics: send the queued rows now', immediate: true })
    } catch {
      internalErrors += 1
    }
    try {
      await $.command.register({ name: 'bqaa-backfill', description: 'BigQuery Agent Analytics: resend rows parked in the dead-letter directory', argumentHint: '[force]', immediate: true })
    } catch {
      internalErrors += 1
    }
    // In the background: neither the first prompt nor anything above waits
    // on the store for the welcome card.
    void startWelcome($, e, tracer.sessionId, start).catch(() => {
      internalErrors += 1
    })
    return next(e)
  })

  // Observers: each calls `next` before it records anything, after reading
  // the session id where it needs it. Their `.catch` spells out what a
  // failure means here: the event goes on as if the mod were not there.
  on('classic.SessionStart', ($, e, next) => {
    const pending = next(e)
    // Its row carries what session.start loads (the user, the agent name,
    // the writer mode, the host version): written now if that is done, else
    // once it is, at the time the event came.
    const at = Date.now()
    whenConfigured(() => tracer.sessionStarted(e, at))
    return pending
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStart', async ($, e, next) => {
    await readSessionId($)
    const pending = next(e)
    safely(() => tracer.subagentStarted(e))
    return pending
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', ($, e, next) => {
    const pending = next(e)
    safely(() => tracer.permissionRequested(e))
    return pending
  }).catch(($, e, next) => next(e))

  // Every prompt is passed on first, as it came; the hook then waits on
  // nothing but the session id (no network, no process). A prompt while rows
  // cannot be written also starts a retry, from a timer: the person may have
  // just signed in.
  on('prompt.submit', async ($, e, next) => {
    const submittedAt = Date.now()
    const entered = await next(e)
    if (entered.drop === undefined) {
      await readSessionId($)
      safely(() =>
        tracer.promptSubmitted({
          text: entered.text,
          submittedAt,
          originKind: e.origin.kind,
          duringTurnId: e.turnId,
          wait: e.wait,
          attachments: e.attachments,
        }),
      )
      safely(() => writer?.retrySoon())
      // Rows landed before this prompt, typed at the terminal: the welcome
      // card has said what it is for.
      if (welcome !== null && welcome.landedAt !== null && e.origin.kind === 'composer') safely(() => closeWelcome($))
    }
    return entered
  }).catch(($, e, next) => next(e))

  // The band above the prompt while rows cannot be written for lack of
  // credentials or permission, or because BigQuery cannot find the dataset:
  // what is wrong, the fix (for a missing dataset, the setup.sh command on a
  // line of its own), and how many rows wait. Otherwise, in the session that
  // greets an install or an update, the welcome card. What the mods after
  // this one draw there stays, under these lines; a survey has the band to
  // itself.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const theirs = await next(e)
    const current = writer
    if (current === null || e.props.hasSurvey) return theirs
    if (current.problem === null) {
      const shown = welcome
      if (shown === null) return theirs
      const card = welcomeCard(shown, config, shown.sent)
      const { Box, Button, Text } = $.ui.resolve(e)
      const title = Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        children: [
          Box({
            flexDirection: 'row',
            flexWrap: 'wrap',
            flexShrink: 1,
            children: [
              Text({ color: card.tone, bold: true, children: `${card.glyph} ` }),
              Text({ bold: true, children: clean(card.title, 200) }),
              Text({ dimColor: true, children: ` ${clean(card.tag, 100)}` }),
            ],
          }),
          Button({ key: 'bqaa-welcome-close', label: 'Got it', role: 'dismiss', onPress: () => closeWelcome($) }),
        ],
      })
      const lines = card.lines.map(line => Text({ ...(line.tone ? { color: line.tone } : {}), ...(line.dim ? { dimColor: true } : {}), children: clean(line.text, 500) }))
      // In a box where the band has the rows for its border; lines alone where not.
      const frame = e.props.maxRows >= lines.length + 3 ? { borderStyle: 'round', borderColor: card.tone, paddingX: 1 } : {}
      return Box({ flexDirection: 'column', children: [Box({ flexDirection: 'column', ...frame, children: [title, ...lines] }), theirs] })
    }
    const { headline, fix } = current.problemText()
    const run = current.commandLine()
    const { Box, Text } = $.ui.resolve(e)
    const line = Box({
      flexDirection: 'row',
      flexWrap: 'wrap',
      children: [
        Text({ color: 'warning', bold: true, children: '⚠ BQAA: ' }),
        Text({ children: clean(`rows are not being written: ${headline}. To fix, ${fix}.`, 500) }),
        Text({ dimColor: true, children: ` ${current.waitingText()} row(s) waiting.` }),
      ],
    })
    const lines = run === null ? [line] : [line, Text({ dimColor: true, children: clean(run, COMMAND_LINE_CHARS) })]
    return Box({ flexDirection: 'column', children: [...lines, theirs] })
  })

  // Permission decisions, from the host's own collector records: each record
  // goes on first, unchanged, and one a later hook refused is not used.
  on('telemetry.log', { to: 'collector' }, async ($, e, next) => {
    const logged = await next(e)
    if (logged.deny === undefined) safely(() => tracer.recordSeen(e.event, e.attributes))
    return logged
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await readSessionId($)
    const pending = next(e)
    safely(() => tracer.turnStarted(e))
    return pending
  })

  on('turn.step', async function* ($, e, next) {
    await readSessionId($)
    const stream = next(e)
    let ctx: StepCtx | undefined
    safely(() => {
      ctx = tracer.stepStarted(e)
    })
    let firstContentAt: number | undefined
    let result
    try {
      result = yield* timedStream(stream, () => {
        firstContentAt = Date.now()
      })
    } catch (err) {
      const failed = ctx
      if (failed) safely(() => tracer.stepFailed(failed, err))
      throw err
    }
    const done = ctx
    const response = result
    if (done) safely(() => tracer.stepFinished(done, response as StepResult, firstContentAt))
    return result
  })

  on('tool.call', async ($, e, next) => {
    await readSessionId($)
    const pending = next(e)
    let ctx: ToolCtx | undefined
    safely(() => {
      ctx = tracer.toolStarted(e as unknown as Record<string, unknown>)
    })
    let result
    try {
      result = await pending
    } catch (err) {
      const failed = ctx
      if (failed) safely(() => tracer.toolFailed(failed, err))
      throw err
    }
    const done = ctx
    const outcome = result
    if (done) safely(() => tracer.toolFinished(done, outcome as ToolOutcome))
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await readSessionId($)
    const pending = next(e)
    safely(() => {
      tracer.turnCompleted({
        turnId: e.turnId,
        agentId: e.agentId,
        answer: e.answer,
        durationMs: e.durationMs,
        isAborted: e.isAborted,
        reason: e.reason,
        refusal: e.reason === 'refusal' ? e.refusal : undefined,
        usage: e.usage,
      })
      // A finished main-loop turn is a natural moment to send.
      if (!e.agentId) writer?.requestFlush(0)
    })
    return pending
  })

  on('session.end', async ($, e, next) => {
    safely(() => tracer.sessionEnded(e))
    if (writer) {
      if (e.reason === 'clear' || e.reason === 'resume') {
        // The process goes on under another session: send as usual.
        safely(() => writer?.requestFlush(0))
      } else {
        // The process is ending. No request starts here: what is still
        // queued goes to a spill file the next session sends, and the write
        // may take at most the exit budget, inside the engine's
        // end-of-session bound.
        const budget = Math.max(0, Math.min(config.exitFlushMs, next.budget.remainingMs - 300))
        try {
          await writer.spillForExit(budget)
        } catch {
          internalErrors += 1
        }
      }
    }
    return next(e)
  })

  on('command.run', { command: 'bqaa-status' }, async ($, e) => {
    if (!writer) return say('BigQuery Agent Analytics mod: not started (session.start has not run).')
    const summary = await deadLetterSummary($)
    const text = formatStatus({
      config,
      writer,
      now: Date.now(),
      sessionId: tracer.sessionId,
      deadLetter: summary,
      backfill: writer.backfillReport,
      isBackfilling: writer.isBackfilling,
    })
    return say(internalErrors > 0 ? `${text}\ninternal errors (skipped bookkeeping): ${internalErrors}` : text)
  })

  on('command.run', { command: 'bqaa-flush' }, async () => {
    if (!writer) return say('BigQuery Agent Analytics mod: not started.')
    if (!canDeliver(config)) return say(`BigQuery Agent Analytics mod: nothing to flush to (${config.problems.join('; ') || 'disabled'}).`)
    const queued = writer.queue.length
    writer.requestFlush(0)
    return say(`BigQuery Agent Analytics mod: flush requested for ${queued} queued row(s); /bqaa-status shows the result.`)
  })

  on('command.run', { command: 'bqaa-backfill' }, async ($, e) => {
    const current = writer
    if (!current) return say('BigQuery Agent Analytics mod: not started.')
    if (current.isBackfilling) return say('BigQuery Agent Analytics mod: a backfill is already running; /bqaa-status shows progress.')
    const summary = await deadLetterSummary($)
    if ('error' in summary) return say(`BigQuery Agent Analytics mod: ${summary.error}`)
    if (summary.files === 0) {
      const elsewhere = summary.elsewhere > 0 ? ` ${summary.elsewhere} file(s) elsewhere in ${config.deadLetterDir} are for other tables or an older layout; they are replayed only under a configuration for their table.` : ''
      return say(`BigQuery Agent Analytics mod: no dead-letter files for ${tableRef(config)} in ${summary.dir}.${elsewhere}`)
    }
    // `force` replays afresh, too, a file another session's replay holds (its
    // mark, or its record cut off part-way): for a session that stopped
    // mid-replay. Runs in the background: the command returns now. Its
    // result is a transcript line.
    const force = (e.args ?? '').trim() === 'force'
    void current
      .backfill(['spill', 'retry', 'rejected'], force ? 'force' : 'command')
      .then(report => {
        const refused = report.rowsRefused ? `, ${report.rowsRefused} of them refused` : ''
        const other = report.otherTableRows ? ` (${report.otherTableRows} for another table)` : ''
        const oversized = report.oversizedFiles.length ? `, ${report.oversizedFiles.length} file(s) too large to read` : ''
        const incomplete = report.incompleteFiles.length ? `, ${report.incompleteFiles.length} file(s) without a completion record kept` : ''
        $.ui.log(clean(`bqaa backfill: ${report.files} file(s), ${report.rowsSent} row(s) sent, ${report.rowsLeft} left${refused}${other}${oversized}${incomplete}${report.held ? `; left waiting: ${report.held}` : ''}${report.error ? `; stopped: ${report.error}` : ''}`, 500))
      })
      .catch(() => {
        internalErrors += 1
      })
    return say(`BigQuery Agent Analytics mod: backfill started for ${summary.files} file(s) in ${summary.dir}; /bqaa-status shows progress.`)
  })
}
