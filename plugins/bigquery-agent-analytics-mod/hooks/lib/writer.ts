// The background writer. Hooks only call `enqueue` (synchronous, in memory);
// everything that touches the network, a process or the disk runs here, from
// timers, never inside a hook's dispatch (session end's bounded spill write
// aside, which starts no request).
//
// Delivery: batched tabledata.insertAll with a client-side timeout, retries
// with exponential backoff, then a local dead-letter file. Every failure path
// keeps the rows (on disk) or counts them as dropped; none throws into a hook.
// Every diagnostic is redacted before it is cut, kept, written or shown.
//
// While rows cannot be written for lack of working credentials or of
// permission, the writer holds that problem and shows it: the band above the
// prompt (drawn in register.ts), a toast and a transcript line once, and the
// status line, each with the fix and how many rows wait. The next successful
// send clears it.

import { type Config, canDeliver, deadLetterPartition, destinationDir, joinPath, tableRef } from './config.ts'
import { type HttpAnswer, TOKEN_INFO_URL, classifyInsert, createTableBody, insertAllBody, insertAllUrl, isDatasetMissing, tableCheckUrl, tablesUrl } from './bigquery.ts'
import { type DeadLetterKind, type DeadLetterLine, HOST_FILE_BYTES, MAX_FILE_BYTES, type ParsedFile, fileName, kindOf, lineText, packBodies, packFiles, packLines, parseFile, sealFile } from './deadletter.ts'
import { BoundedQueue, type Queued } from './queue.ts'
import { type BqaaRow, fitRow, rowBytes } from './rows.ts'
import { redactDiagnostic } from './sanitize.ts'
import { errorText } from './tracer.ts'

export type Timer = { cancel: () => void }

export type HttpInit = { method: string; headers: Record<string, string>; body?: string }

// Everything the writer reaches outside itself, wired to `$` in register.ts.
export type Io = {
  now: () => number
  after: (ms: number, fn: () => void) => Timer
  fetch: (url: string, init: HttpInit) => Promise<HttpAnswer>
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
  // The rest of the credential notice: a toast, a transcript line (dim,
  // never sent to the model), and a redraw of the band above the prompt.
  // A writer without them shows the status line alone.
  toast?: (text: string) => void
  notice?: (text: string) => void
  redraw?: () => void
}

// Why rows cannot be written: no working credentials (the token source
// fails, or BigQuery refuses even a fresh token), or the identity lacks
// permission on the dataset.
export type ProblemKind = 'credentials' | 'permission'
export type Problem = { kind: ProblemKind; reason: string; since: number }

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
  // Of rowsLeft, lines recorded for another table: kept as they were.
  otherTableRows: number
  skippedFiles: number
  // Files over the 4 MiB `$.fs.read` limit, which cannot be read back.
  oversizedFiles: string[]
  // Files with no completion record that matches them: still being written,
  // or left by a writer that stopped part-way. Kept as they are, not read.
  incompleteFiles: string[]
  error: string | null
  finishedAt: number | null
}

const TIMED_OUT = Symbol('timed out')
const MAX_BATCHES_PER_TICK = 10
const LEASE_MS = 10 * 60 * 1000
// While credentials are the problem, a retry comes at least this often, so
// rows flow again soon after the person signs in.
const CREDENTIAL_RETRY_CAP_MS = 30_000
// How long a failed lookup of the credential's account is kept before it is
// tried again.
const IDENTITY_RETRY_MS = 10 * 60 * 1000
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/
// Longest diagnostic kept: the last error, a report's error, a line's reason.
const DIAGNOSTIC_CHARS = 1000

const diagnostic = (text: string, maxChars = DIAGNOSTIC_CHARS): string => redactDiagnostic(text, maxChars)
// An error's own message, without the `Error: ` errorText puts first.
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : errorText(err))
// One line of a command's error output: its `ERROR:` line when it has one
// (gcloud prints `WARNING:` lines first), else its first line.
const errorLine = (text: string): string => {
  let first = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('ERROR:')) return line
    if (first === '') first = line
  }
  return first
}
// The token command, named by its program only: its arguments can hold a
// credential (a key file, a header, a password).
const programName = (argv: readonly string[]): string => (argv[0] ?? '').split(/[\\/]/).pop() || 'command'

const HEADLINE: Record<ProblemKind, string> = {
  credentials: 'no working Google credentials',
  permission: 'BigQuery denied the identity access to the dataset',
}

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
  // True from when a batch is taken until its answer hands its rows on (to
  // BigQuery, back to the queue, or to disk): only then are they counted as
  // in flight among the rows waiting.
  private batchOpen = false
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
  // Why rows cannot be written now, if credentials or permission stop them.
  problem: Problem | null = null
  // Rows parked on disk while the problem stood (sent once it clears).
  private parkedDuringProblem = 0
  // Problem kinds already announced with a toast and a transcript line.
  private announced = new Set<ProblemKind>()
  // Where the last token came from: the fix differs.
  private tokenSource: 'environment' | 'command' = 'command'
  // With userIdFromCredentials: the account of one access token, the token it
  // describes, and the order its lookup started in (a lookup that answers
  // late never replaces a newer one). `email` is null while a failed lookup
  // waits to be tried again. The token stays in memory, like `token`.
  private identity: { token: string; email: string | null; seq: number } | null = null
  private identityPending: { token: string; answer: Promise<string | null> } | null = null
  private identitySeq = 0

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

  // Off a hook's dispatch: gets a token, so one is at hand for the first
  // send and at a `block` mode prompt, and with it the account's identity.
  prefetchToken(): void {
    const c = this.config()
    if (!canDeliver(c) || c.dryRun) return
    void this.getToken()
      .then(token => this.identityFor(token, c))
      .catch(err => this.recordError(`authentication: ${messageOf(err)}`))
  }

  // A prompt while a problem stands: the person may have just fixed it, so
  // the paused writer tries again now rather than at the end of its backoff.
  retrySoon(): void {
    if (this.problem === null || this.closing) return
    this.resume()
    this.requestFlush(0)
  }

  private async flushLoop(): Promise<void> {
    // The band's count of waiting rows moves with every tick.
    if (this.problem !== null) this.showProblem()
    for (let i = 0; i < MAX_BATCHES_PER_TICK; i += 1) {
      const c = this.config()
      if (this.closing || this.queue.length === 0 || !canDeliver(c)) return
      if (this.pauseTimer !== null) {
        await this.relievePressure()
        return
      }
      const batch = this.queue.take(c.maxBatchRows, c.maxBatchBytes)
      this.inFlightRows = batch
      this.batchOpen = true
      let delivered = false
      try {
        delivered = await this.deliver(batch, c)
      } finally {
        this.inFlightRows = []
        this.batchOpen = false
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
      await this.retryLater(batch, `authentication: ${messageOf(err)}`)
      return false
    }
    // This process's rows carry the account of the token they go out with.
    await this.stampFor(batch, token, c)
    let body = insertAllBody(batch.map(q => q.row))
    let answer = await this.post(insertAllUrl(c), body, token, c.requestTimeoutMs)
    if ('error' in answer) {
      await this.retryLater(batch, answer.error)
      return false
    }
    let outcome = classifyInsert(answer, batch.length)
    if (outcome.kind === 'auth') {
      // The token may have run out early: one more try at once, with a fresh
      // one. A second 401 means BigQuery refuses the credentials themselves.
      this.dropToken()
      try {
        token = await this.getToken()
      } catch (err) {
        await this.retryLater(batch, `authentication: ${messageOf(err)}`)
        return false
      }
      // The fresh token can be another account's: the rows go out under it.
      await this.stampFor(batch, token, c)
      body = insertAllBody(batch.map(q => q.row))
      answer = await this.post(insertAllUrl(c), body, token, c.requestTimeoutMs)
      if ('error' in answer) {
        await this.retryLater(batch, answer.error)
        return false
      }
      outcome = classifyInsert(answer, batch.length)
      if (outcome.kind === 'auth') this.noteProblem('credentials', `BigQuery refused a fresh token too: ${outcome.message}`)
    }
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
        this.dropToken()
        await this.retryLater(batch, `authentication: ${outcome.message}`)
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
        if (outcome.permission) this.noteProblem('permission', outcome.message)
        await this.reject(batch, outcome.message)
        return false
      case 'retry':
        await this.retryLater(batch, outcome.message)
        return false
    }
  }

  private succeeded(rows: number): void {
    this.batchOpen = false
    const hadFailures = this.consecutiveFailures > 0
    this.counters.sent += rows
    this.counters.batches += 1
    this.consecutiveFailures = 0
    this.resume()
    this.lastSuccessAt = this.io.now()
    this.clearProblem()
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
    const ms = this.problem?.kind === 'credentials' ? Math.min(CREDENTIAL_RETRY_CAP_MS, this.backoffMs()) : this.backoffMs()
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
    this.batchOpen = false
    const c = this.config()
    const reason = diagnostic(message)
    this.consecutiveFailures += 1
    this.counters.retries += 1
    this.pause()
    this.recordError(reason)
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
      await this.deadLetter('retry', exhausted, reason)
      if (this.problem === null) this.setStatus(`BQAA: ${exhausted.length} row(s) parked after retries (${reason.slice(0, 80)}); /bqaa-backfill sends them`)
    }
    if (this.problem !== null) this.showProblem()
  }

  private async reject(batch: Queued[], message: string): Promise<void> {
    this.batchOpen = false
    const reason = diagnostic(message)
    this.consecutiveFailures += 1
    this.pause()
    this.counters.failed += batch.length
    this.counters.rejected += batch.length
    this.recordError(reason)
    await this.deadLetter('rejected', batch, reason)
    if (this.problem !== null) this.showProblem()
    else this.setStatus(`BQAA: ${batch.length} row(s) refused (${reason.slice(0, 80)}); fix, then /bqaa-backfill`)
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
    const clean = diagnostic(message)
    this.lastError = { message: clean, at: this.io.now() }
    this.io.debug(`bqaa: ${clean}`)
  }

  private setStatus(text: string | undefined): void {
    const clean = text === undefined ? undefined : diagnostic(text, 300)
    if (clean === this.statusText) return
    this.statusText = clean
    this.io.status(clean)
  }

  // ---- credentials and permission ----------------------------------------

  // Records why rows cannot be written and shows it: the status line and the
  // band now, and the first time each kind comes up, a toast and a
  // transcript line with the reason. Never throws.
  private noteProblem(kind: ProblemKind, reason: string): void {
    const clean = diagnostic(reason, 300)
    if (this.problem === null || this.problem.kind !== kind) {
      this.problem = { kind, reason: clean, since: this.io.now() }
      this.parkedDuringProblem = 0
    } else this.problem.reason = clean
    this.showProblem()
    if (this.announced.has(kind)) return
    this.announced.add(kind)
    const { headline, fix } = this.problemText()
    this.call(() => this.io.toast?.(diagnostic(`BQAA: rows are not being written: ${headline}. To fix, ${fix}.`, 500)))
    this.call(() => this.io.notice?.(diagnostic(`bqaa: rows are not being written: ${headline} (${clean}). To fix, ${fix}; this clears after the next successful send.`, 1000)))
  }

  // The next successful send: the problem is gone. Rows refused while
  // access was denied stay parked until /bqaa-backfill, and the transcript
  // says so; rows parked for want of credentials follow on their own.
  private clearProblem(): void {
    const was = this.problem
    if (was === null) return
    const parked = this.parkedDuringProblem
    this.problem = null
    this.parkedDuringProblem = 0
    this.call(() => this.io.redraw?.())
    if (parked > 0 && (was.kind === 'permission' || !this.config().autoBackfill)) {
      this.call(() => this.io.notice?.(`bqaa: rows are being written again; /bqaa-backfill sends the ${parked} row(s) parked while they could not be.`))
    }
  }

  // The status line and the band, with the count of rows waiting now.
  private showProblem(): void {
    if (this.problem === null) return
    const { headline, fix } = this.problemText()
    this.setStatus(`BQAA: ${headline}. To fix, ${fix} (${this.waitingRows()} row(s) waiting)`)
    this.call(() => this.io.redraw?.())
  }

  // What is wrong, and what the person runs or asks for to fix it, for the
  // token source this writer uses (the command named by its program only).
  problemText(): { headline: string; fix: string } {
    const c = this.config()
    const kind = this.problem?.kind ?? 'credentials'
    if (kind === 'permission') return { headline: HEADLINE.permission, fix: `ask for roles/bigquery.dataEditor on ${c.project}:${c.dataset}, then run /bqaa-backfill` }
    if (this.tokenSource === 'environment') return { headline: HEADLINE.credentials, fix: 'set a fresh BQAA_ACCESS_TOKEN, or unset it to use the token command' }
    const argv = c.accessTokenCommand
    const program = programName(argv)
    if (argv.length === 0) return { headline: HEADLINE.credentials, fix: 'set BQAA_ACCESS_TOKEN or accessTokenCommand' }
    if (/^gcloud(\.cmd|\.exe)?$/i.test(program) && argv.includes('print-access-token')) {
      return { headline: HEADLINE.credentials, fix: argv.includes('application-default') ? 'run: gcloud auth application-default login' : 'run: gcloud auth login' }
    }
    return { headline: HEADLINE.credentials, fix: `check the token command \`${program}\`` }
  }

  // Rows that wait for the problem to clear: queued, in flight, and parked
  // on disk since it began.
  waitingRows(): number {
    return this.queue.length + (this.batchOpen ? this.inFlightRows.length : 0) + this.parkedDuringProblem
  }

  // A notice the surface may not take (no terminal, a `-p` run) is skipped.
  private call(show: () => void): void {
    try {
      show()
    } catch {
      // The status line and /bqaa-status still say it.
    }
  }

  // For `block` mode, before a prompt goes in: null when the credentials
  // work as far as can be told within `withinMs`, else why the prompt must
  // wait. A token at hand with no problem standing needs no request. A
  // permission problem never blocks: one wrong grant must not stop every
  // prompt. Fails closed: a check that cannot finish refuses.
  async credentialsCheck(withinMs: number): Promise<string | null> {
    const c = this.config()
    if (this.problem?.kind !== 'credentials' && this.token !== null && this.io.now() < this.token.expiresAt) return null
    const deadline = this.io.now() + withinMs
    const refuse = (why: string): string => {
      const { headline, fix } = this.problemText()
      return diagnostic(`BQAA blocks prompts until rows can be written: ${headline}. To fix, ${fix}, then send the prompt again. (${why})`, 1000)
    }
    if (withinMs <= 0) return refuse('no time was left to check the credentials')
    const got = await this.within(
      this.getToken().then(
        value => ({ value }),
        err => ({ error: messageOf(err) }),
      ),
      deadline,
    )
    if (got === TIMED_OUT) return refuse(`no access token came within ${Math.ceil(withinMs / 1000)} s`)
    if ('error' in got) return refuse(diagnostic(got.error, 300))
    if (this.problem?.kind !== 'credentials') return null
    // BigQuery refused a token before: ask it about this one first.
    const answer = await this.request(tableCheckUrl(c), { method: 'GET', headers: { authorization: `Bearer ${got.value}` } }, Math.max(1, deadline - this.io.now()))
    if ('error' in answer) return refuse(`BigQuery refused the credentials before, and checking them again failed: ${answer.error}`)
    if (answer.status === 401) {
      this.dropToken()
      return refuse('BigQuery still refuses the credentials (HTTP 401)')
    }
    this.clearProblem()
    this.setStatus(undefined)
    return null
  }

  // `work`'s result, or TIMED_OUT at `until`.
  private within<T>(work: Promise<T>, until: number): Promise<T | typeof TIMED_OUT> {
    let timer: Timer | null = null
    const timeout = new Promise<typeof TIMED_OUT>(resolve => {
      timer = this.io.after(Math.max(0, until - this.io.now()), () => resolve(TIMED_OUT))
    })
    return Promise.race([work, timeout]).finally(() => (timer as Timer | null)?.cancel())
  }

  // ---- identity ----------------------------------------------------------

  // With userIdFromCredentials: the verified email of the account `token`
  // was issued to. Each token is looked up once: a new token (a refresh, the
  // fresh one after a 401, another BQAA_ACCESS_TOKEN) is a new credential and
  // is looked up again; a failed lookup is tried again after ten minutes, by
  // a timer, so it follows the host's clock. Null when off, unknown or
  // failed. Never throws.
  private identityFor(token: string, c: Config): Promise<string | null> {
    if (!c.userIdFromCredentials) return Promise.resolve(null)
    if (this.identity !== null && this.identity.token === token) return Promise.resolve(this.identity.email)
    if (this.identityPending === null || this.identityPending.token !== token) {
      const answer = this.lookUpIdentity(token, c, ++this.identitySeq).catch(() => null)
      const pending = { token, answer }
      this.identityPending = pending
      void answer.then(() => {
        if (this.identityPending === pending) this.identityPending = null
      })
    }
    return this.identityPending.answer
  }

  // The account of the token in use now, if its lookup has answered. An
  // expired token is no longer in use, whether or not a fresh one came.
  private currentIdentity(): string | null {
    const token = this.token
    if (token === null || this.io.now() >= token.expiresAt) return null
    return this.identity !== null && this.identity.token === token.value ? this.identity.email : null
  }

  // A token that expired or that BigQuery refused is let go, and so is the
  // account looked up for it: while no fresh token comes, rows parked meanwhile
  // carry the user_id they were built with, never that account.
  private dropToken(): void {
    const dropped = this.token
    this.token = null
    if (dropped !== null && this.identity !== null && this.identity.token === dropped.value) this.identity = null
  }

  // Gives each of this process's rows the account of `token`, or, while that
  // account is unknown, the user_id it was built with: never an account
  // looked up for another token.
  private async stampFor(rows: Queued[], token: string, c: Config): Promise<void> {
    if (!c.userIdFromCredentials) return
    const email = await this.identityFor(token, c)
    for (const q of rows) this.stamp(q, email)
  }

  // Google's token information endpoint names the account; the token goes
  // in the POST body, never in the URL or a header. The address is never
  // logged.
  private async lookUpIdentity(token: string, c: Config, seq: number): Promise<string | null> {
    const answer = await this.request(TOKEN_INFO_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `access_token=${encodeURIComponent(token)}` }, c.requestTimeoutMs)
    let email: string | null = null
    let why = ''
    if ('error' in answer) why = answer.error
    else if (answer.status !== 200) why = `HTTP ${answer.status}`
    else {
      let info: { email?: unknown; email_verified?: unknown } | null = null
      try {
        info = JSON.parse(answer.text) as { email?: unknown; email_verified?: unknown }
      } catch {
        info = null
      }
      if (typeof info?.email !== 'string' || !EMAIL.test(info.email)) why = 'it names no account email (the token lacks the email scope)'
      else if (info.email_verified !== true && info.email_verified !== 'true') why = "the account's email is not verified"
      else email = info.email
    }
    // A lookup that started earlier, for an older token, never replaces the
    // answer of a later one.
    if (this.identity === null || this.identity.seq < seq) {
      const known = { token, email, seq }
      this.identity = known
      if (email === null) {
        this.io.after(IDENTITY_RETRY_MS, () => {
          if (this.identity === known) this.identity = null
        })
      }
    }
    if (email === null) this.io.debug(diagnostic(`bqaa: looking up the token's account for user_id failed (${why}); rows keep the configured user_id`))
    return email
  }

  // This process's row with `email` as its user_id, or with the user_id it
  // was built with when `email` is null.
  private stamp(q: Queued, email: string | null): void {
    if (email !== null && q.configuredUserId === undefined) q.configuredUserId = q.row.user_id
    const userId = email ?? (q.configuredUserId === undefined ? q.row.user_id : q.configuredUserId)
    if (q.row.user_id === userId) return
    q.row = { ...q.row, user_id: userId }
    q.bytes = rowBytes(q.row)
  }

  private post(url: string, body: string, token: string, timeoutMs: number): Promise<HttpAnswer | { error: string }> {
    return this.request(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body }, timeoutMs)
  }

  private async request(url: string, init: HttpInit, timeoutMs: number): Promise<HttpAnswer | { error: string }> {
    let timer: Timer | null = null
    const timeout = new Promise<typeof TIMED_OUT>(resolve => {
      timer = this.io.after(timeoutMs, () => resolve(TIMED_OUT))
    })
    const request = this.io.fetch(url, init).then(
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
    // Expired: let it go now, so a refresh that fails leaves no token behind.
    if (this.token) this.dropToken()
    if (this.tokenPending) return this.tokenPending
    const pending = (async (): Promise<string> => {
      const fromEnv = (await this.io.envToken())?.trim()
      if (fromEnv) {
        // Re-read every five minutes, so a token the person rotates is picked up.
        this.tokenSource = 'environment'
        this.token = { value: fromEnv, expiresAt: this.io.now() + 5 * 60 * 1000 }
        return fromEnv
      }
      this.tokenSource = 'command'
      if (c.accessTokenCommand.length === 0) throw new Error('no access token source: set BQAA_ACCESS_TOKEN or accessTokenCommand')
      const command = `token command \`${programName(c.accessTokenCommand)}\``
      const result = await this.io.runCommand(c.accessTokenCommand, c.tokenCommandTimeoutMs)
      if (result.exitCode !== 0) throw new Error(`${command} exited ${result.exitCode}: ${diagnostic(errorLine(result.stderr), 300)}`)
      const value = result.stdout.trim().split(/\s+/)[0] ?? ''
      if (!/^[A-Za-z0-9._~+/=-]{16,}$/.test(value)) throw new Error(`${command} printed no access token`)
      this.token = { value, expiresAt: this.io.now() + c.tokenTtlMs }
      return value
    })()
    // No token is no working credentials, whoever asked for it.
    pending.catch(err => this.noteProblem('credentials', `authentication: ${messageOf(err)}`))
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
    this.recordError(`create table: HTTP ${answer.status}: ${answer.text}`)
    return false
  }

  // Dry run: the rows as JSONL files beside the dead-letter directory, each
  // file within the file limit in bytes.
  private async writeDryRunFiles(rows: readonly Queued[], c: Config): Promise<void> {
    for (const text of packLines(rows.map(q => JSON.stringify(fitRow(q.row, MAX_FILE_BYTES - 1))))) {
      const name = fileName('spill', this.io.now(), this.sessionId(), ++this.seq).replace(/^spill-/, 'dry-run-')
      await this.io.writeFile(joinPath(c.dryRunDir, name), text)
    }
  }

  private async writeDryRun(batch: Queued[], c: Config): Promise<boolean> {
    try {
      await this.writeDryRunFiles(batch, c)
      this.succeeded(batch.length)
      return true
    } catch (err) {
      await this.retryLater(batch, `dry run write failed: ${errorText(err)}`)
      return false
    }
  }

  // Into this table's own subdirectory, each line naming the table.
  private async deadLetter(kind: DeadLetterKind, rows: Queued[], reason: string): Promise<void> {
    if (rows.length === 0) return
    const c = this.config()
    // The rows are this process's: they are parked with the account of the
    // token in use now, and keep it when they are replayed.
    if (c.userIdFromCredentials) for (const q of rows) this.stamp(q, this.currentIdentity())
    const at = this.io.now()
    const failedAt = new Date(at).toISOString()
    const dir = deadLetterPartition(c)
    const lines: DeadLetterLine[] = rows.map(q => ({ v: 1, kind, reason, attempts: q.attempts, failed_at: failedAt, table: tableRef(c), row: q.row }))
    for (const body of packBodies(lines.map(lineText))) {
      const count = body.split('\n').length - 1
      const path = joinPath(dir, fileName(kind, at, this.sessionId(), ++this.seq))
      try {
        if (c.deadLetterDir === '') throw new Error('no dead-letter directory')
        // The completion record goes last: a replay reads the file only once
        // the record is there and matches every row above it.
        await this.io.writeFile(path, sealFile(body))
        this.counters.deadLetterFiles += 1
        if (kind !== 'rejected') this.wroteRecoverable = true
        if (this.problem !== null) this.parkedDuringProblem += count
      } catch (err) {
        this.counters.dropped += count
        this.recordError(`dead-letter write failed (${count} rows lost): ${errorText(err)}`)
      }
    }
  }

  // ---- session end -------------------------------------------------------

  // Called from session.end when the process is ending, inside the engine's
  // short end-of-session bound. Starts no request: the rows still queued, and
  // rows whose request has not answered (it may yet land; event_id dedups),
  // go to a spill file the next session sends, or in a dry run to the dry-run
  // files. Waits at most `budgetMs` for those writes. Never throws.
  async spillForExit(budgetMs: number): Promise<{ spilled: number }> {
    const c = this.config()
    this.closing = true
    this.soon?.cancel()
    this.soon = null
    const rows = [...(this.inFlight ? this.inFlightRows : []), ...this.queue.takeAll()]
    if (rows.length === 0) return { spilled: 0 }
    const toDryRun = c.dryRun && c.dryRunDir !== ''
    const write = (async (): Promise<void> => {
      if (!toDryRun) {
        this.counters.spilled += rows.length
        await this.deadLetter('spill', rows, 'session ended before these rows were confirmed sent')
        return
      }
      try {
        await this.writeDryRunFiles(rows, c)
        this.counters.sent += rows.length
      } catch (err) {
        this.counters.dropped += rows.length
        this.recordError(`dry run write at exit failed (${rows.length} rows lost): ${errorText(err)}`)
      }
    })()
    await this.raceUntil(write, this.io.now() + budgetMs)
    return { spilled: toDryRun ? 0 : rows.length }
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

  // Sends the rows parked for this table. Only a file whose completion record
  // matches it is read; any other file, still being written or left by a
  // writer that stopped, is kept as it is and reported. A file whose rows all
  // land is truncated to zero bytes (`$.fs` has no delete); rows that fail
  // again stay, and so does every line recorded for another table, as
  // written.
  backfill(kinds: DeadLetterKind[], trigger: BackfillReport['trigger']): Promise<BackfillReport> {
    if (this.backfilling) return this.backfilling
    const run = this.backfillRun(kinds, trigger).catch(err => {
      const report: BackfillReport = {
        trigger,
        files: 0,
        rowsSent: 0,
        rowsLeft: 0,
        otherTableRows: 0,
        skippedFiles: 0,
        oversizedFiles: [],
        incompleteFiles: [],
        error: diagnostic(errorText(err)),
        finishedAt: this.io.now(),
      }
      this.backfillReport = report
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
    const report: BackfillReport = { trigger, files: 0, rowsSent: 0, rowsLeft: 0, otherTableRows: 0, skippedFiles: 0, oversizedFiles: [], incompleteFiles: [], error: null, finishedAt: null }
    const finish = (): BackfillReport => {
      report.finishedAt = this.io.now()
      this.backfillReport = report
      return report
    }
    if (!canDeliver(c) || c.dryRun) {
      report.error = c.dryRun ? 'dry run: nothing is sent to BigQuery' : 'not configured: set project and dataset'
      return finish()
    }
    // Only this table's subdirectory: rows parked for another table wait for
    // a session configured with that table.
    const dir = deadLetterPartition(c)
    let entries: readonly { name: string; kind: string; size: number }[] = []
    try {
      entries = await this.io.listDir(dir)
    } catch {
      return finish()
    }
    const files: string[] = []
    for (const e of entries) {
      const kind = kindOf(e.name)
      if (e.kind !== 'file' || e.size === 0 || kind === null || !kinds.includes(kind)) continue
      // `$.fs.read` refuses a file over 4 MiB: say so rather than pass it by.
      if (e.size > HOST_FILE_BYTES) report.oversizedFiles.push(e.name)
      else files.push(e.name)
    }
    files.sort()
    const me = this.sessionId() ?? 'unknown'
    for (const name of files) {
      if (report.error) {
        report.skippedFiles += 1
        continue
      }
      const leaseKey = `lease:${destinationDir(tableRef(c))}/${name}`
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
        const parsed = parseFile(await this.io.readFile(joinPath(dir, name)))
        if (!parsed.complete) report.incompleteFiles.push(name)
        else {
          await this.backfillFile(dir, name, parsed, c, report)
          report.files += 1
        }
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

  private async backfillFile(dir: string, name: string, file: ParsedFile, c: Config, report: BackfillReport): Promise<void> {
    const path = joinPath(dir, name)
    const { lines, raw, unreadable } = file
    // A line is sent only to the table it records. Others stay as written.
    const table = tableRef(c)
    const mine: DeadLetterLine[] = []
    const others: string[] = []
    lines.forEach((line, i) => {
      if (line.table === table) mine.push(line)
      else others.push(raw[i] as string)
    })
    report.otherTableRows += others.length
    const left: DeadLetterLine[] = []
    let changed = false
    let index = 0
    while (index < mine.length) {
      if (report.error) {
        left.push(...mine.slice(index))
        break
      }
      let bytes = 0
      let end = index
      while (end < mine.length && end - index < c.maxBatchRows) {
        const size = rowBytes((mine[end] as DeadLetterLine).row)
        if (end > index && bytes + size > c.maxBatchBytes) break
        bytes += size
        end += 1
      }
      const chunk = mine.slice(index, end)
      index = end
      let token: string
      try {
        token = await this.getToken()
      } catch (err) {
        report.error = diagnostic(`authentication: ${messageOf(err)}`)
        left.push(...chunk)
        continue
      }
      const answer = await this.post(insertAllUrl(c), insertAllBody(chunk.map(l => l.row)), token, c.requestTimeoutMs)
      if ('error' in answer) {
        report.error = diagnostic(answer.error)
        left.push(...chunk)
        continue
      }
      const outcome = classifyInsert(answer, chunk.length)
      if (outcome.kind === 'ok') {
        report.rowsSent += chunk.length
        this.counters.sent += chunk.length
        changed = true
        continue
      }
      if (outcome.kind === 'partial') {
        chunk.forEach((line, i) => {
          const reason = outcome.rejected.get(i)
          if (reason !== undefined) left.push({ ...line, kind: 'rejected', reason: diagnostic(reason), attempts: line.attempts + 1 })
          else if (outcome.retry.has(i)) left.push(line)
          else {
            report.rowsSent += 1
            this.counters.sent += 1
          }
        })
        changed = true
        continue
      }
      if (outcome.kind === 'auth') this.dropToken()
      report.error = diagnostic(outcome.message)
      left.push(...chunk)
    }
    report.rowsLeft += left.length + others.length
    // Nothing sent and nothing new to record: the file stays as it was.
    if (!changed) return
    // What is left goes to new files first (rewritten reasons can make it
    // outgrow one), each ending with its completion record, and only once
    // every one is written is the source emptied: `$.fs` has no rename or
    // delete. A write that fails leaves the source as it was, so an unsent
    // row is never held only in memory; rows sent meanwhile may go again,
    // and event_id dedups them.
    const rest = [...left.map(lineText), ...others, ...unreadable]
    for (const text of packFiles(rest)) {
      await this.io.writeFile(joinPath(dir, fileName(kindOf(name) ?? 'retry', this.io.now(), this.sessionId(), ++this.seq)), text)
    }
    await this.io.writeFile(path, '')
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
    problem: Problem | null
    waiting: number
    identity: 'off' | 'pending' | 'found' | 'failed'
  } {
    const c = this.config()
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
      problem: this.problem,
      waiting: this.waitingRows(),
      identity: !c.userIdFromCredentials ? 'off' : this.token === null || this.identity?.token !== this.token.value ? 'pending' : this.identity.email === null ? 'failed' : 'found',
    }
  }
}
