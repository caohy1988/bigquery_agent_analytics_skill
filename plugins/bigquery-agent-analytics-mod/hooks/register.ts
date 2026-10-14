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

import type { EngineInterface, Register } from 'claude-code'

import { type Config, type EnvSnapshot, type Options, canDeliver, deadLetterPartition, destinationDir, joinPath, resolveConfig, tableRef } from './lib/config.ts'
import { HOST_FILE_BYTES, kindOf } from './lib/deadletter.ts'
import { randomIds } from './lib/ids.ts'
import type { BqaaRow } from './lib/rows.ts'
import { redactDiagnostic } from './lib/sanitize.ts'
import { type DeadLetterSummary, formatStatus } from './lib/status.ts'
import { type StepCtx, type StepResult, type ToolCtx, type ToolOutcome, Tracer, errorText } from './lib/tracer.ts'
import { type Io, Writer } from './lib/writer.ts'

let options: Options = {}
let config: Config = resolveConfig({}, {})
let writer: Writer | null = null
let flushTimer: { cancel: () => void } | null = null
let internalErrors = 0

// Rows captured before session.start built the writer (an event the engine
// raised first); handed over once it exists.
const early: { row: BqaaRow; redactions: number }[] = []

const tracer = new Tracer({
  now: () => Date.now(),
  ids: randomIds,
  config: () => config,
  emit: (row, redactions) => {
    if (writer) writer.enqueue(row, redactions)
    else if (early.length < 1000) early.push({ row, redactions })
  },
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

  on('session.start', async ($, e, next) => {
    try {
      config = resolveConfig(options, await readEnv($))
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
        listDir: async path => (await $.fs.list(path)).map(entry => ({ name: entry.name, kind: entry.kind, size: entry.size })),
        storeGet: key => $.store.get(key),
        storeSet: (key, value) => $.store.set(key, value),
        storeDelete: key => $.store.delete(key),
        status: text => $.ui.status(text === undefined ? undefined : clean(text, 300)),
        debug: text => $.ui.log(clean(text), { to: 'debug' }),
      }
      const previous = writer
      writer = new Writer(io, () => config, () => tracer.sessionId)
      // session.start can fire again without a reload (the plugin was turned
      // off and on): keep what the previous writer still held.
      if (previous) writer.adopt(previous)
      for (const held of early.splice(0)) writer.enqueue(held.row, held.redactions)
      const [sessionId, version] = await Promise.all([$.session.id().catch(() => null), $.session.version().catch(() => null)])
      tracer.setSession({ sessionId, cwd: e.cwd, engineVersion: version?.version ?? null })
      flushTimer?.cancel()
      flushTimer = $.clock.every(config.flushIntervalMs, () => {
        void writer?.flush()
      })
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
      await $.command.register({ name: 'bqaa-backfill', description: 'BigQuery Agent Analytics: resend rows parked in the dead-letter directory', immediate: true })
    } catch {
      internalErrors += 1
    }
    return next(e)
  })

  // Observers: each calls `next` first. Their `.catch` spells out what a
  // failure means here: the event goes on as if the mod were not there.
  on('classic.SessionStart', ($, e, next) => {
    const pending = next(e)
    safely(() => tracer.sessionStarted(e))
    return pending
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStart', ($, e, next) => {
    const pending = next(e)
    safely(() => tracer.subagentStarted(e))
    return pending
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', ($, e, next) => {
    const pending = next(e)
    safely(() => tracer.permissionRequested(e))
    return pending
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const submittedAt = Date.now()
    const entered = await next(e)
    if (entered.drop === undefined) {
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
    }
    return entered
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    const pending = next(e)
    safely(() => tracer.turnStarted(e))
    return pending
  })

  on('turn.step', async function* ($, e, next) {
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

  on('turn.complete', ($, e, next) => {
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
    // Runs in the background: the command returns now. Its result is a
    // transcript line.
    void current
      .backfill(['spill', 'retry', 'rejected'], 'command')
      .then(report => {
        const other = report.otherTableRows ? ` (${report.otherTableRows} for another table)` : ''
        const oversized = report.oversizedFiles.length ? `, ${report.oversizedFiles.length} file(s) too large to read` : ''
        $.ui.log(clean(`bqaa backfill: ${report.files} file(s), ${report.rowsSent} row(s) sent, ${report.rowsLeft} left${other}${oversized}${report.error ? `; stopped: ${report.error}` : ''}`, 500))
      })
      .catch(() => {
        internalErrors += 1
      })
    return say(`BigQuery Agent Analytics mod: backfill started for ${summary.files} file(s) in ${summary.dir}; /bqaa-status shows progress.`)
  })
}
