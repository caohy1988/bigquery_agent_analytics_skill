// The background writer. Hooks only call `enqueue` (synchronous, in memory);
// everything that touches the network, a process or the disk runs here, from
// timers, never inside a hook's dispatch (session.end's bounded spill aside).
//
// Delivery: batched tabledata.insertAll with a client-side timeout, retries
// with exponential backoff, then a local dead-letter file. Every failure path
// keeps the rows (on disk) or counts them as dropped; none throws into a hook.

import { type Config, canDeliver, joinPath, tableRef } from './config.ts'
import { type HttpAnswer, classifyInsert, createTableBody, insertAllBody, insertAllUrl, isDatasetMissing, tablesUrl } from './bigquery.ts'
import { type DeadLetterKind, type DeadLetterLine, MAX_FILE_CHARS, encodeLines, fileName, kindOf, parseFile } from './deadletter.ts'
import { BoundedQueue, type Queued } from './queue.ts'
import { type BqaaRow, rowBytes } from './rows.ts'
import { newStats, redactText } from './sanitize.ts'
import { errorText } from './tracer.ts'

export type Timer = { cancel: () => void }

// Everything the writer reaches outside itself, wired to `$` in register.ts.
export type Io = {
  now: () => number
  after: (ms: number, fn: () => void) => Timer
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<HttpAnswer>
  runCommand: (argv: string[], timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  envToken: () => Promise<string | undefined>
  writeFile: (path: string, text: string) => Promise<void>
  readFile: (path: string) => Promise<string>
  listDir: (path: string) => Promise<readonly { name: string; kind: string; size: number }[]>
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  storeDelete: (key: string) => Promise<void>
  status: (text: string | undefined) => void
  debug: (text: string) => void
}

export type Counters = {
  // Rows built and queued.
  captured: number
  // Rows BigQuery accepted (or, in a dry run, written to the dry-run files).
  sent: number
  // Rows moved to dead-letter files after a failure (retry + rejected).
  failed: number
  // Of those, rows BigQuery or the configuration refused.
  rejected: number
  // Rows written to spill files: at session end, or under queue pressure.
  spilled: number
  // Rows lost: dropped by the full queue, or a dead-letter write failed.
  dropped: number
  // Rows not queued because there was nowhere to send them.
  skipped: number
  retries: number
  batches: number
  truncatedRows: number
  redactions: number
  deadLetterFiles: number
}

export type BackfillReport = {
  trigger: 'auto' | 'command' | 'recovery'
  files: number
  rowsSent: number
  rowsLeft: number
  skippedFiles: number
  error: string | null
  finishedAt: number | null
}

const TIMED_OUT = Symbol('timed out')
const MAX_BATCHES_PER_TICK = 10
const LEASE_MS = 10 * 60 * 1000

const firstLine = (text: string): string => (text.split('\n').find(l => l.trim() !== '') ?? '').trim().slice(0, 300)

export class Writer {
  readonly queue: BoundedQueue
  readonly counters: Counters = {
    captured: 0,
    sent: 0,
    failed: 0,
    rejected: 0,
    spilled: 0,
    dropped: 0,
    skipped: 0,
    retries: 0,
    batches: 0,
    truncatedRows: 0,
    redactions: 0,
    deadLetterFiles: 0,
  }
  lastError: { message: string; at: number } | null = null
  lastSuccessAt: number | null = null
  backfillReport: BackfillReport | null = null

  private io: Io
  private config: () => Config
  private sessionId: () => string | null
  private inFlight: Promise<void> | null = null
  private inFlightRows: Queued[] = []
  private consecutiveFailures = 0
  // Backoff is a timer, not a clock comparison, so it follows the host's
  // clock (and a test's mock clock) exactly.
  private pauseTimer: Timer | null = null
  private pausedUntil = 0
  private token: { value: string; expiresAt: number } | null = null
  private tokenPending: Promise<string> | null = null
  private createAttempted = false
  private tableCreatedAt: number | null = null
  private seq = 0
  private soon: Timer | null = null
  private backfilling: Promise<BackfillReport> | null = null
  private wroteRecoverable = false
  private statusText: string | undefined = undefined
  // Set once the session is ending: no new batch starts after that.
  private closing = false

  constructor(io: Io, config: () => Config, sessionId: () => string | null) {
    this.io = io
    this.config = config
    this.sessionId = sessionId
    const c = config()
    this.queue = new BoundedQueue(c.maxQueueRows, c.maxQueueBytes)
  }

  // ---- hot path ----------------------------------------------------------

  // Called from hooks: synchronous, bounded, never throws past its caller's
  // try, never waits on anything.
  enqueue(row: BqaaRow, redactions: number): void {
    if (!canDeliver(this.config())) {
      this.counters.skipped += 1
      return
    }
    this.queue.push(row)
    this.counters.captured += 1
    this.counters.redactions += redactions
    if (row.is_truncated) this.counters.truncatedRows += 1
  }

  // ---- background --------------------------------------------------------

  // Takes over the rows another writer still queues (oldest first).
  adopt(previous: Writer): void {
    this.queue.unshift(previous.queue.takeAll())
  }

  // Asks for a flush shortly, outside the caller's dispatch.
  requestFlush(delayMs = 0): void {
    if (this.soon) return
    this.soon = this.io.after(delayMs, () => {
      this.soon = null
      void this.flush()
    })
  }

  // One flush at a time; a call while one runs joins it.
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight
    const run = this.flushLoop().catch(err => this.recordError(`flush failed: ${errorText(err)}`))
    this.inFlight = run.finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  prefetchToken(): void {
    const c = this.config()
    if (!canDeliver(c) || c.dryRun) return
    void this.getToken().catch(err => this.recordError(`auth: ${errorText(err)}`))
  }

  private async flushLoop(): Promise<void> {
    for (let i = 0; i < MAX_BATCHES_PER_TICK; i += 1) {
      const c = this.config()
      if (this.closing || this.queue.length === 0 || !canDeliver(c)) return
      if (this.pauseTimer !== null) {
        await this.relievePressure()
        return
      }
      const batch = this.queue.take(c.maxBatchRows, c.maxBatchBytes)
      this.inFlightRows = batch
      let delivered = false
      try {
        delivered = await this.deliver(batch, c)
      } finally {
        this.inFlightRows = []
      }
      if (!delivered) {
        // Backing off now: keep the queue from filling while we wait.
        await this.relievePressure()
        return
      }
    }
  }

  private async deliver(batch: Queued[], c: Config): Promise<boolean> {
    if (c.dryRun) return this.writeDryRun(batch, c)
    let token: string
    try {
      token = await this.getToken()
    } catch (err) {
      await this.retryLater(batch, `auth: ${errorText(err)}`)
      return false
    }
    const answer = await this.post(insertAllUrl(c), insertAllBody(batch.map(q => q.row)), token, c.requestTimeoutMs)
    if ('error' in answer) {
      await this.retryLater(batch, answer.error)
      return false
    }
    const outcome = classifyInsert(answer, batch.length)
    switch (outcome.kind) {
      case 'ok':
        this.succeeded(batch.length)
        return true
      case 'partial': {
        const rejected: Queued[] = []
        const retry: Queued[] = []
        const reasons: string[] = []
        batch.forEach((q, i) => {
          const reason = outcome.rejected.get(i)
          if (reason !== undefined) {
            rejected.push(q)
            reasons.push(reason)
          } else if (outcome.retry.has(i)) retry.push(q)
        })
        this.succeeded(batch.length - rejected.length - retry.length)
        if (rejected.length > 0) await this.reject(rejected, `BigQuery rejected ${rejected.length} row(s): ${reasons[0]}`)
        if (retry.length > 0) {
          await this.retryLater(retry, 'BigQuery asked to retry some rows')
          return false
        }
        return true
      }
      case 'auth':
        this.token = null
        await this.retryLater(batch, `auth: ${outcome.message}`)
        return false
      case 'not-found': {
        if (c.autoCreateTable && !this.createAttempted && !isDatasetMissing(outcome.message)) {
          this.createAttempted = true
          if (await this.createTable(c, token)) {
            this.queue.unshift(batch)
            return true
          }
        }
        if (this.tableCreatedAt !== null && this.io.now() - this.tableCreatedAt < 120_000) {
          // A table created moments ago can take a little while to take rows.
          await this.retryLater(batch, outcome.message)
          return false
        }
        await this.reject(batch, outcome.message)
        return false
      }
      case 'rejected':
        await this.reject(batch, outcome.message)
        return false
      case 'retry':
        await this.retryLater(batch, outcome.message)
        return false
    }
  }

  private succeeded(rows: number): void {
    const hadFailures = this.consecutiveFailures > 0
    this.counters.sent += rows
    this.counters.batches += 1
    this.consecutiveFailures = 0
    this.resume()
    this.lastSuccessAt = this.io.now()
    this.setStatus(undefined)
    // BigQuery is reachable again: replay what this session parked on disk.
    if (hadFailures && this.wroteRecoverable && this.config().autoBackfill) {
      this.wroteRecoverable = false
      this.io.after(1000, () => {
        void this.backfill(['spill', 'retry'], 'recovery')
      })
    }
  }

  private backoffMs(): number {
    const base = Math.min(60_000, 1000 * 2 ** Math.max(0, this.consecutiveFailures - 1))
    return Math.round(base * (1 + Math.random() * 0.25))
  }

  private pause(): void {
    const ms = this.backoffMs()
    this.pauseTimer?.cancel()
    this.pausedUntil = this.io.now() + ms
    this.pauseTimer = this.io.after(ms, () => {
      this.pauseTimer = null
      this.pausedUntil = 0
    })
  }

  private resume(): void {
    this.pauseTimer?.cancel()
    this.pauseTimer = null
    this.pausedUntil = 0
  }

  private async retryLater(batch: Queued[], message: string): Promise<void> {
    const c = this.config()
    this.consecutiveFailures += 1
    this.counters.retries += 1
    this.pause()
    this.recordError(message)
    const exhausted: Queued[] = []
    const keep: Queued[] = []
    for (const q of batch) {
      q.attempts += 1
      if (q.attempts > c.maxRetries) exhausted.push(q)
      else keep.push(q)
    }
    this.queue.unshift(keep)
    if (exhausted.length > 0) {
      this.counters.failed += exhausted.length
      await this.deadLetter('retry', exhausted, message)
      this.setStatus(`BQAA: ${exhausted.length} row(s) parked after retries (${message.slice(0, 80)}); /bqaa-backfill sends them`)
    }
  }

  private async reject(batch: Queued[], message: string): Promise<void> {
    this.consecutiveFailures += 1
    this.pause()
    this.counters.failed += batch.length
    this.counters.rejected += batch.length
    this.recordError(message)
    await this.deadLetter('rejected', batch, message)
    this.setStatus(`BQAA: ${batch.length} row(s) refused (${message.slice(0, 80)}); fix, then /bqaa-backfill`)
  }

  // While BigQuery is unreachable, rows past 80% of the queue go to disk
  // rather than wait to be dropped.
  private async relievePressure(): Promise<void> {
    if (!this.queue.isUnderPressure()) return
    const spill = this.queue.take(Math.ceil(this.queue.length / 2), Number.MAX_SAFE_INTEGER)
    this.counters.spilled += spill.length
    await this.deadLetter('spill', spill, 'queue pressure while BigQuery was unreachable')
  }

  // Error text reaches /bqaa-status (which the model reads) and the debug
  // log: redacted like any payload, in case a command echoed a credential.
  private recordError(message: string): void {
    const clean = redactText(message, newStats()).slice(0, 1000)
    this.lastError = { message: clean, at: this.io.now() }
    this.io.debug(`bqaa: ${clean}`)
  }

  private setStatus(text: string | undefined): void {
    if (text === this.statusText) return
    this.statusText = text
    this.io.status(text)
  }

  private async post(url: string, body: string, token: string, timeoutMs: number): Promise<HttpAnswer | { error: string }> {
    let timer: Timer | null = null
    const timeout = new Promise<typeof TIMED_OUT>(resolve => {
      timer = this.io.after(timeoutMs, () => resolve(TIMED_OUT))
    })
    const request = this.io
      .fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
      })
      .then(
        answer => answer,
        err => ({ error: `request failed: ${errorText(err)}` }),
      )
    try {
      const result = await Promise.race([request, timeout])
      if (result === TIMED_OUT) return { error: `request timed out after ${timeoutMs} ms` }
      return result
    } finally {
      ;(timer as Timer | null)?.cancel()
    }
  }

  private getToken(): Promise<string> {
    const c = this.config()
    if (this.token && this.io.now() < this.token.expiresAt) return Promise.resolve(this.token.value)
    if (this.tokenPending) return this.tokenPending
    const pending = (async (): Promise<string> => {
      const fromEnv = (await this.io.envToken())?.trim()
      if (fromEnv) {
        // Re-read every five minutes, so a token the person rotates is picked up.
        this.token = { value: fromEnv, expiresAt: this.io.now() + 5 * 60 * 1000 }
        return fromEnv
      }
      if (c.accessTokenCommand.length === 0) throw new Error('no access token source: set BQAA_ACCESS_TOKEN or accessTokenCommand')
      const result = await this.io.runCommand(c.accessTokenCommand, c.tokenCommandTimeoutMs)
      if (result.exitCode !== 0) {
        throw new Error(`\`${c.accessTokenCommand.join(' ')}\` exited ${result.exitCode}: ${firstLine(result.stderr)}`)
      }
      const value = result.stdout.trim().split(/\s+/)[0] ?? ''
      if (!/^[A-Za-z0-9._~+/=-]{16,}$/.test(value)) throw new Error(`\`${c.accessTokenCommand.join(' ')}\` printed no access token`)
      this.token = { value, expiresAt: this.io.now() + c.tokenTtlMs }
      return value
    })()
    this.tokenPending = pending
    const clear = (): void => {
      if (this.tokenPending === pending) this.tokenPending = null
    }
    pending.then(clear, clear)
    return pending
  }

  private async createTable(c: Config, token: string): Promise<boolean> {
    const answer = await this.post(tablesUrl(c), createTableBody(c), token, c.requestTimeoutMs)
    if ('error' in answer) {
      this.recordError(`create table: ${answer.error}`)
      return false
    }
    if ((answer.status >= 200 && answer.status < 300) || answer.status === 409) {
      this.tableCreatedAt = this.io.now()
      this.io.debug(`bqaa: created ${tableRef(c)} (day-partitioned on timestamp, clustered on event_type, agent, user_id)`)
      return true
    }
    this.recordError(`create table: HTTP ${answer.status}: ${answer.text.slice(0, 300)}`)
    return false
  }

  private async writeDryRun(batch: Queued[], c: Config): Promise<boolean> {
    const name = fileName('spill', this.io.now(), this.sessionId(), ++this.seq).replace(/^spill-/, 'dry-run-')
    try {
      await this.io.writeFile(joinPath(c.dryRunDir, name), batch.map(q => JSON.stringify(q.row)).join('\n') + '\n')
      this.succeeded(batch.length)
      return true
    } catch (err) {
      await this.retryLater(batch, `dry run write failed: ${errorText(err)}`)
      return false
    }
  }

  private async deadLetter(kind: DeadLetterKind, rows: Queued[], reason: string): Promise<void> {
    if (rows.length === 0) return
    const c = this.config()
    const at = this.io.now()
    const failedAt = new Date(at).toISOString()
    const lines: DeadLetterLine[] = rows.map(q => ({ v: 1, kind, reason, attempts: q.attempts, failed_at: failedAt, table: tableRef(c), row: q.row }))
    for (const text of encodeLines(lines)) {
      const count = text.split('\n').length - 1
      const path = joinPath(c.deadLetterDir, fileName(kind, at, this.sessionId(), ++this.seq))
      try {
        if (c.deadLetterDir === '') throw new Error('no dead-letter directory')
        await this.io.writeFile(path, text)
        this.counters.deadLetterFiles += 1
        if (kind !== 'rejected') this.wroteRecoverable = true
      } catch (err) {
        this.counters.dropped += count
        this.recordError(`dead-letter write failed (${count} rows lost): ${errorText(err)}`)
      }
    }
  }

  // ---- session end -------------------------------------------------------

  // Called from session.end, inside the engine's short end-of-session bound:
  // one request if a token is in hand and time allows, then whatever is not
  // confirmed sent goes to a spill file. Never throws.
  async drainForExit(budgetMs: number): Promise<{ sent: number; spilled: number }> {
    const c = this.config()
    let sent = 0
    const start = this.io.now()
    const sendBy = start + Math.max(0, budgetMs - 250)
    this.closing = true
    try {
      if (this.soon) {
        this.soon.cancel()
        this.soon = null
      }
      if (this.inFlight && budgetMs > 0) await this.raceUntil(this.inFlight, sendBy)
      // A request still running may yet land: its rows are spilled too, and
      // event_id lets a query drop the duplicate.
      const unconfirmed = this.inFlight ? [...this.inFlightRows] : []
      let rest = this.queue.takeAll()
      if (rest.length > 0 && canDeliver(c)) {
        if (c.dryRun) {
          if (await this.writeDryRun(rest, c)) {
            sent += rest.length
            rest = []
          } else {
            rest = this.queue.takeAll()
          }
        } else {
          const tokenOk = this.token !== null && this.io.now() < this.token.expiresAt
          const left = sendBy - this.io.now()
          // Not when BigQuery is backing us off, nor while an earlier request
          // is still hanging: a second would most likely hang too.
          if (tokenOk && left > 100 && this.pauseTimer === null && this.inFlight === null) {
            const first = rest.slice(0, c.maxBatchRows)
            let bytes = 0
            let fit = 0
            for (const q of first) {
              if (fit > 0 && bytes + q.bytes > c.maxBatchBytes) break
              bytes += q.bytes
              fit += 1
            }
            const batch = rest.slice(0, fit)
            const answer = await this.post(insertAllUrl(c), insertAllBody(batch.map(q => q.row)), (this.token as { value: string }).value, Math.min(c.requestTimeoutMs, left))
            if (!('error' in answer)) {
              const outcome = classifyInsert(answer, batch.length)
              if (outcome.kind === 'ok') {
                this.succeeded(batch.length)
                sent += batch.length
                rest = rest.slice(fit)
              } else if (outcome.kind === 'partial') {
                const unsent = batch.filter((_, i) => outcome.rejected.has(i) || outcome.retry.has(i))
                this.succeeded(batch.length - unsent.length)
                sent += batch.length - unsent.length
                rest = [...unsent, ...rest.slice(fit)]
              }
            }
          }
        }
      }
      const spill = [...unconfirmed, ...rest]
      if (spill.length > 0) {
        this.counters.spilled += spill.length
        await this.deadLetter('spill', spill, 'session ended before these rows were confirmed sent')
      }
      return { sent, spilled: spill.length }
    } catch (err) {
      this.recordError(`exit drain failed: ${errorText(err)}`)
      return { sent, spilled: 0 }
    }
  }

  private raceUntil(work: Promise<unknown>, until: number): Promise<unknown> {
    const wait = until - this.io.now()
    if (wait <= 0) return Promise.resolve()
    let timer: Timer | null = null
    const timeout = new Promise<void>(resolve => {
      timer = this.io.after(wait, () => resolve())
    })
    return Promise.race([work.catch(() => undefined), timeout]).finally(() => (timer as Timer | null)?.cancel())
  }

  // ---- backfill ----------------------------------------------------------

  // Sends the rows parked in dead-letter files. A file whose rows all land is
  // truncated to zero bytes (`$.fs` has no delete); rows that fail again stay.
  backfill(kinds: DeadLetterKind[], trigger: BackfillReport['trigger']): Promise<BackfillReport> {
    if (this.backfilling) return this.backfilling
    const run = this.backfillRun(kinds, trigger).catch(err => {
      const report: BackfillReport = { trigger, files: 0, rowsSent: 0, rowsLeft: 0, skippedFiles: 0, error: errorText(err), finishedAt: this.io.now() }
      return report
    })
    this.backfilling = run.finally(() => {
      this.backfilling = null
    })
    return this.backfilling
  }

  get isBackfilling(): boolean {
    return this.backfilling !== null
  }

  private async backfillRun(kinds: DeadLetterKind[], trigger: BackfillReport['trigger']): Promise<BackfillReport> {
    const c = this.config()
    const report: BackfillReport = { trigger, files: 0, rowsSent: 0, rowsLeft: 0, skippedFiles: 0, error: null, finishedAt: null }
    const finish = (): BackfillReport => {
      report.finishedAt = this.io.now()
      this.backfillReport = report
      return report
    }
    if (!canDeliver(c) || c.dryRun) {
      report.error = c.dryRun ? 'dry run: nothing is sent to BigQuery' : 'not configured: set project and dataset'
      return finish()
    }
    let entries: readonly { name: string; kind: string; size: number }[] = []
    try {
      entries = await this.io.listDir(c.deadLetterDir)
    } catch {
      return finish()
    }
    const files = entries
      .filter(e => e.kind === 'file' && e.size > 0 && e.size <= MAX_FILE_CHARS + 1024 * 1024)
      .filter(e => {
        const kind = kindOf(e.name)
        return kind !== null && kinds.includes(kind)
      })
      .map(e => e.name)
      .sort()
    const me = this.sessionId() ?? 'unknown'
    for (const name of files) {
      if (report.error) {
        report.skippedFiles += 1
        continue
      }
      const leaseKey = `lease:${name}`
      try {
        const lease = (await this.io.storeGet(leaseKey)) as { by?: string; until?: number } | undefined
        if (lease && typeof lease.until === 'number' && lease.until > this.io.now() && lease.by !== me) {
          report.skippedFiles += 1
          continue
        }
        await this.io.storeSet(leaseKey, { by: me, until: this.io.now() + LEASE_MS })
      } catch {
        // No store: go on without the lease; event_id still dedups in SQL.
      }
      try {
        await this.backfillFile(joinPath(c.deadLetterDir, name), c, report)
        report.files += 1
      } finally {
        try {
          await this.io.storeDelete(leaseKey)
        } catch {
          // The lease expires on its own.
        }
      }
    }
    return finish()
  }

  private async backfillFile(path: string, c: Config, report: BackfillReport): Promise<void> {
    const text = await this.io.readFile(path)
    const { lines, unreadable } = parseFile(text)
    const left: DeadLetterLine[] = []
    let index = 0
    while (index < lines.length) {
      if (report.error) {
        left.push(...lines.slice(index))
        break
      }
      let bytes = 0
      let end = index
      while (end < lines.length && end - index < c.maxBatchRows) {
        const size = rowBytes((lines[end] as DeadLetterLine).row)
        if (end > index && bytes + size > c.maxBatchBytes) break
        bytes += size
        end += 1
      }
      const chunk = lines.slice(index, end)
      index = end
      let token: string
      try {
        token = await this.getToken()
      } catch (err) {
        report.error = `auth: ${errorText(err)}`
        left.push(...chunk)
        continue
      }
      const answer = await this.post(insertAllUrl(c), insertAllBody(chunk.map(l => l.row)), token, c.requestTimeoutMs)
      if ('error' in answer) {
        report.error = answer.error
        left.push(...chunk)
        continue
      }
      const outcome = classifyInsert(answer, chunk.length)
      if (outcome.kind === 'ok') {
        report.rowsSent += chunk.length
        this.counters.sent += chunk.length
        continue
      }
      if (outcome.kind === 'partial') {
        chunk.forEach((line, i) => {
          const reason = outcome.rejected.get(i)
          if (reason !== undefined) left.push({ ...line, kind: 'rejected', reason, attempts: line.attempts + 1 })
          else if (outcome.retry.has(i)) left.push(line)
          else {
            report.rowsSent += 1
            this.counters.sent += 1
          }
        })
        continue
      }
      if (outcome.kind === 'auth') this.token = null
      report.error = outcome.message
      left.push(...chunk)
    }
    report.rowsLeft += left.length
    const rest = left.map(l => JSON.stringify(l)).concat(unreadable)
    await this.io.writeFile(path, rest.length === 0 ? '' : `${rest.join('\n')}\n`)
  }

  // ---- status ------------------------------------------------------------

  snapshot(): {
    queued: number
    queuedBytes: number
    inFlight: number
    dropped: number
    counters: Counters
    lastError: { message: string; at: number } | null
    lastSuccessAt: number | null
    pausedUntil: number
    consecutiveFailures: number
    hasToken: boolean
  } {
    return {
      queued: this.queue.length,
      queuedBytes: this.queue.bytes,
      inFlight: this.inFlightRows.length,
      dropped: this.counters.dropped + this.queue.dropped,
      counters: { ...this.counters },
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
      pausedUntil: this.pausedUntil,
      consecutiveFailures: this.consecutiveFailures,
      hasToken: this.token !== null && this.io.now() < this.token.expiresAt,
    }
  }
}
