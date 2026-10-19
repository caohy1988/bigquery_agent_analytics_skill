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
// permission, or because BigQuery cannot find the dataset or table, the
// writer holds that problem and shows it: the band above the prompt (drawn in
// register.ts), a toast and a transcript line once, and the status line, each
// with the fix and how many rows wait. The next send or replay BigQuery
// takes clears it.

import { type Config, canDeliver, deadLetterPartition, destinationDir, joinPath, tableRef } from './config.ts'
import { type HttpAnswer, TOKEN_INFO_URL, classifyInsert, createTableBody, insertAllBody, insertAllUrl, isDatasetMissing, tablesUrl } from './bigquery.ts'
import { type DeadLetterKind, type DeadLetterLine, HOST_FILE_BYTES, MAX_FILE_BYTES, type ParsedFile, fileName, isDeadLetterKind, kindOf, lineText, packBodies, packFiles, packLines, parseFile, sealFile } from './deadletter.ts'
import { BoundedQueue, type Queued } from './queue.ts'
import { type BqaaRow, fitRow, rowBytes, utf8Length } from './rows.ts'
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
  // Whether a path exists. A writer without it reads the file, an empty text
  // being no file.
  exists?: (path: string) => Promise<boolean>
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
  // The mod's own directory, where setup.sh is: the fix for a dataset
  // BigQuery cannot find names the script there. Absent, the fix is told
  // without a command.
  pluginRoot?: string
}

// Why rows cannot be written: no working credentials (the token source
// fails, or BigQuery refuses even a fresh token), the identity lacks
// permission on the dataset, or BigQuery cannot find the dataset or table
// (not made yet, or made so recently that streaming inserts do not see it).
export type ProblemKind = 'credentials' | 'permission' | 'destination'
// `missing` says which one BigQuery could not find, for a destination problem.
export type Problem = { kind: ProblemKind; reason: string; since: number; missing?: 'dataset' | 'table' }

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
  // Of rowsLeft, rows BigQuery refused on this replay: moved to `rejected`
  // files, which only /bqaa-backfill sends.
  rowsRefused: number
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

// What a replay learns as it goes: how many of its rows still wait for a
// replay that runs by itself (lines, and files it did not read), and how
// many requests it sent.
type ReplayTally = { waiting: number; requests: number }

// What a replay made of a file's lines, one letter a line in the file's
// order (L landed, W waits as it was, R refused, K kept as written: another
// table's, or a kind this replay does not send), with each refused line's
// reason (`refusals`, in the same order, indexes `reasons`, which holds
// MAX_REASONS at most).
type Outcome = { fates: string; reasons: string[]; refusals: number[] }

// A replayed file (`name`), and where its record is: in `$.store` under
// `recordKey`, or, when the store does not take it, in one of the two files
// `recordFiles` beside it (`outcome-` and the file's name, then `outcome-b-`
// and it: no replay takes either for rows), which take the record's
// updates in turn, so one cut off part-way leaves the one before it whole.
// A file is written once, under a name of its own, so its name and size tell
// it.
type Source = { name: string; size: number; recordKey: string; recordFiles: readonly string[] }

// A file a replay has an outcome for: the outcome, the files that hold what
// is left of it under the names given them (`text` null once written),
// whether any of those holds rows that wait for a replay, whether its record
// may be in `recordFiles`, and the number of its last record (`seq`).
type Rewrite = Outcome & Source & { files: { path: string; text: string | null }[]; waits: boolean; filed: boolean; seq: number }

// The record of a Rewrite, which every writer reads: written before what is
// left is, updated as each file of it is written, removed once the source is
// emptied. A writer that finds it (a later session.start's, another
// session's, or this one after another writer moved it on) writes what is
// still missing, from the source and the outcome, and sends none of the
// file's rows again.
type Journal = Outcome & { size: number; files: string[]; written: boolean[]; waits: boolean; seq: number }

const TIMED_OUT = Symbol('timed out')
const MAX_BATCHES_PER_TICK = 10
const LEASE_MS = 10 * 60 * 1000
// A table this writer made gets this long before a 404 for it is the notice:
// streaming inserts may not see a new table for a while.
const NEW_TABLE_MS = 120_000
// While credentials or a missing dataset are the problem, a retry comes at
// least this often, so rows flow again soon after the person signs in or
// makes the dataset.
const QUICK_RETRY_CAP_MS = 30_000
// How long a failed lookup of the credential's account is kept before it is
// tried again.
const IDENTITY_RETRY_MS = 10 * 60 * 1000
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/
// Longest diagnostic kept: the last error, a report's error, a line's reason.
const DIAGNOSTIC_CHARS = 1000
// Most row ids kept to count a refused or parked row once; past that, rows
// are counted without the check.
const COUNTED_IDS = 10_000
// Most refusal reasons a replay keeps for one file: the first ones as
// BigQuery gave them, then OTHER_REASON for every row refused for yet another.
// So a file's replay record stays small: a letter and a small number a line,
// these reasons, and the names of what is left.
const MAX_REASONS = 16
const OTHER_REASON = `refused for another reason (a replay keeps ${MAX_REASONS} reasons a file)`
// Largest replay record kept in `$.store`, which holds 4 MiB of JSON in all
// for every key of the mod's: a larger one goes to the file beside its source.
const STORE_RECORD_BYTES = 64 * 1024
// Longest `Run: <command>` line the band (register.ts) and the transcript
// show whole; a longer command is shown whole by /bqaa-status alone.
export const COMMAND_LINE_CHARS = 1000
// Longest setup command offered at all.
const SETUP_COMMAND_CHARS = 4000

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

const HEADLINE: Record<Exclude<ProblemKind, 'destination'>, string> = {
  credentials: 'no working Google credentials',
  permission: 'BigQuery denied the identity access to the dataset',
}

// The names setup.sh takes (it checks them the same way before any call): a
// command is offered only for these, so nothing in it is read by the shell
// as anything but the name.
const PLAIN_PROJECT = /^([a-z0-9.-]+:)?[a-z][-a-z0-9]{4,28}[a-z0-9]$/
const PLAIN_NAME = /^[A-Za-z0-9_]{1,1024}$/
const PLAIN_LOCATION = /^[A-Za-z0-9-]+$/
// A path as one shell word: in single quotes, any single quote in it closed,
// escaped and reopened.
const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

// How the refused and parked counts know a line's row: its event_id; for one
// with none (in a file another writer made), the key a replay gave the line
// as it rewrote it, else the file (`name`) and the line's place there, which
// that key keeps. So such a row counts once however often it is refused,
// and rows alike in two files count as two.
const keyOf = (line: DeadLetterLine, name: string, index: number): string => {
  const id = line.row.event_id
  if (typeof id === 'string' && id !== '') return id
  return typeof line.key === 'string' && line.key !== '' ? line.key : `${name}#${index}`
}

// Whether an outcome is one for these lines: a letter for each, and a reason
// it holds for each refused one.
const fitsLines = (file: ParsedFile, outcome: Outcome): boolean =>
  outcome.fates.length === file.lines.length &&
  /^[LWRK]*$/.test(outcome.fates) &&
  outcome.refusals.length === outcome.fates.split('R').length - 1 &&
  outcome.refusals.every(k => outcome.reasons[k] !== undefined)

const sameNames = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((name, i) => name === b[i])

// A record as a writer finds it, and whether one may be in a file beside the
// source (to empty along with it).
type Found = { journal: Partial<Journal>; filed: boolean }

// Where the record of the file `name`, `size` long, in `dir` is kept.
const sourceFor = (dir: string, name: string, size: number, c: Config): Source => ({
  name,
  size,
  recordKey: `replayed:${destinationDir(tableRef(c))}/${name}`,
  recordFiles: [joinPath(dir, `outcome-${name}`), joinPath(dir, `outcome-b-${name}`)],
})

// Which files of what is left a record has as written: all of them for a
// record that does not say.
const writtenOf = (journal: Partial<Journal>): boolean[] => {
  const files = Array.isArray(journal.files) ? journal.files : []
  return Array.isArray(journal.written) ? files.map((_, i) => journal.written?.[i] === true) : files.map(() => true)
}

// The number of a record (0 for one that does not say).
const seqOf = (journal: Partial<Journal>): number => (typeof journal.seq === 'number' ? journal.seq : 0)

// A record kept in a file: its JSON on one line, then a completion record as
// a dead-letter file ends with, so one cut off part-way is told apart
// (`torn`) from none. A file that is empty, or read as anything but text
// (none there, to a writer without `exists`), holds none.
const journalText = (journal: Journal): string => sealFile(`${JSON.stringify(journal)}\n`)
const journalOf = (text: unknown): Partial<Journal> | 'torn' | undefined => {
  if (typeof text !== 'string' || text === '') return undefined
  const parsed = parseFile(text)
  const only = parsed.lines.length === 0 && parsed.unreadable.length === 1 ? parsed.unreadable[0] : undefined
  if (!parsed.complete || only === undefined) return 'torn'
  try {
    return JSON.parse(only) as Partial<Journal>
  } catch {
    return 'torn'
  }
}

// What a replay leaves of the file `name`, from its outcome, as the files to
// write: the lines that wait or were refused (a refused line as a `rejected`
// line, with its reason and one attempt more; either, for a row with no
// event_id, with its key), then the lines kept as written, then the lines
// that do not parse; each kind to files of its own, in the order it first
// comes, each naming `name` as the file it came from, so no replay takes it
// before that file's record has it as written. The same file and outcome
// always give the same files, so a writer that resumes another's outcome
// writes the same ones.
function leftoverFiles(file: ParsedFile, fileKind: DeadLetterKind, outcome: Outcome, name: string): { kind: DeadLetterKind; text: string }[] {
  const rest = new Map<DeadLetterKind, string[]>()
  const keep = (kind: DeadLetterKind, text: string): void => {
    const texts = rest.get(kind)
    if (texts) texts.push(text)
    else rest.set(kind, [text])
  }
  const kindOfLine = (line: DeadLetterLine): DeadLetterKind => (isDeadLetterKind(line.kind) ? line.kind : fileKind)
  const keyed = (line: DeadLetterLine, i: number): DeadLetterLine => (keyOf(line, name, i) === line.row.event_id ? line : { ...line, key: keyOf(line, name, i) })
  let refused = 0
  file.lines.forEach((line, i) => {
    const fate = outcome.fates[i]
    if (fate === 'W') keep(kindOfLine(line), lineText({ ...keyed(line, i), kind: kindOfLine(line) }))
    else if (fate === 'R') {
      const reason = outcome.reasons[outcome.refusals[refused] ?? -1] ?? ''
      refused += 1
      keep('rejected', lineText({ ...keyed(line, i), kind: 'rejected', reason, attempts: line.attempts + 1 }))
    }
  })
  file.lines.forEach((line, i) => {
    if (outcome.fates[i] === 'K') keep(kindOfLine(line), file.raw[i] as string)
  })
  for (const text of file.unreadable) keep(fileKind, text)
  const files: { kind: DeadLetterKind; text: string }[] = []
  for (const [kind, texts] of rest) for (const text of packFiles(texts, name)) files.push({ kind, text })
  return files
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
  // The dead-letter directories (one per table) whose rows wait for a replay
  // that runs by itself: this writer parked them as retries or spills, or a
  // replay left them unsent. While nothing is queued, the paced retries
  // replay the configured table's until one sends every such row.
  private replayDue = new Set<string>()
  // Counts those parkings: a replay that began before the latest one may not
  // have read its rows.
  private parkedSeq = 0
  private statusText: string | undefined = undefined
  // Set once the session is ending: no new batch starts after that.
  private closing = false
  // Why rows cannot be written now, if credentials or permission stop them.
  problem: Problem | null = null
  // Rows parked on disk while the problem stood (sent once it clears), and
  // their ids, so a row counts once however often it is parked or refused.
  private parkedDuringProblem = 0
  private parkedIds = new Set<string>()
  // Rows refused since rows last landed: the count the status line gives,
  // and their ids, likewise.
  private refusedSinceSuccess = 0
  private refusedIds = new Set<string>()
  // Whether a count went past the COUNTED_IDS it keeps, so a row may count
  // again: the count then reads "about N".
  private parkedRough = false
  private refusedRough = false
  // Replays whose outcome is not all written out yet, by the file's path: a
  // later replay finishes writing it and sends none of the file again.
  private rewrites = new Map<string, Rewrite>()
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
  // send, and with it the account's identity.
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
    // Nothing queued, and rows wait for a replay (`replayDue`): no send would
    // tell when what stopped them is fixed, so a replay does, at the paced
    // retries, in a session left idle too, until one sends them all. A
    // replay BigQuery takes clears the notice (`tookRequest`).
    const current = this.config()
    if (this.queue.length === 0 && this.replayDue.has(deadLetterPartition(current))) {
      if (this.pauseTimer !== null || this.closing || !current.autoBackfill || !canDeliver(current) || current.dryRun) return
      await this.backfill(['spill', 'retry'], 'recovery')
      // Rows still wait: the next replay comes after the backoff. Rows
      // queued meanwhile (the replay stops for them) go first, at the next
      // flush, and their send sets its own backoff.
      if (this.replayDue.has(deadLetterPartition(this.config())) && this.queue.length === 0) {
        this.consecutiveFailures += 1
        this.pause()
      }
      return
    }
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
        // Not made yet, or made so recently that streaming inserts do not
        // see it (minutes, after setup.sh): the person is told how to make
        // it, and the rows wait as retries, sent on their own once it is
        // found. A table this writer created moments ago gets the retries
        // alone.
        this.missingDestination(outcome.message)
        await this.retryLater(batch, outcome.message)
        return false
      }
      case 'rejected':
        if (outcome.permission) this.noteProblem('permission', outcome.message)
        else this.tableAnswered()
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
    this.tookRequest(rows)
    // BigQuery is reachable again: replay what this session parked on disk.
    if (hadFailures && this.wroteRecoverable && this.config().autoBackfill) {
      this.wroteRecoverable = false
      this.io.after(1000, () => {
        void this.backfill(['spill', 'retry'], 'recovery')
      })
    }
  }

  // BigQuery took a request, sent or replayed: the table is there and the
  // credentials work, so the backoff ends and so does a notice. Rows that
  // landed also end the status line and its count of refused rows; a request
  // whose rows were all refused or asked for again leaves both.
  private tookRequest(landed: number): void {
    this.consecutiveFailures = 0
    this.resume()
    this.lastSuccessAt = this.io.now()
    const stood = this.problem !== null
    this.clearProblem()
    if (landed > 0) {
      this.refusedSinceSuccess = 0
      this.refusedIds.clear()
      this.refusedRough = false
    }
    if (landed > 0 || stood) this.setStatus(undefined)
  }

  private backoffMs(): number {
    const base = Math.min(60_000, 1000 * 2 ** Math.max(0, this.consecutiveFailures - 1))
    return Math.round(base * (1 + Math.random() * 0.25))
  }

  private pause(): void {
    const quick = this.problem?.kind === 'credentials' || this.problem?.kind === 'destination'
    const ms = quick ? Math.min(QUICK_RETRY_CAP_MS, this.backoffMs()) : this.backoffMs()
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
      if (this.problem === null) this.setStatus(`BQAA: ${exhausted.length} row(s) parked after retries (${reason.slice(0, 80)}); ${c.autoBackfill ? 'they are replayed on their own' : '/bqaa-backfill sends them'}`)
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
    this.countRefused(batch.map(q => q.row.event_id))
    this.recordError(reason)
    await this.deadLetter('rejected', batch, reason)
    if (this.problem !== null) this.showProblem()
    else this.setStatus(`BQAA: ${this.refusedText()} row(s) refused (${reason.slice(0, 80)}); fix, then /bqaa-backfill`)
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
  private noteProblem(kind: ProblemKind, reason: string, missing?: Problem['missing']): void {
    const clean = diagnostic(reason, 300)
    if (this.problem === null || this.problem.kind !== kind) {
      this.problem = { kind, reason: clean, since: this.io.now(), missing }
      this.parkedDuringProblem = 0
      this.parkedIds.clear()
      this.parkedRough = false
    } else {
      this.problem.reason = clean
      this.problem.missing = missing
    }
    this.showProblem()
    if (this.announced.has(kind)) return
    this.announced.add(kind)
    const { headline, fix } = this.problemText()
    const run = this.commandLine()
    this.call(() => this.io.toast?.(diagnostic(`BQAA: rows are not being written: ${headline}. To fix, ${fix}.`, 500)))
    // The command line goes whole, after the rest is cut; on a line of its
    // own where redaction would take it with the rest (a project named like
    // a credential, `auth-…:` in the reason BigQuery gave).
    const told = diagnostic(`bqaa: rows are not being written: ${headline} (${clean}). To fix, ${fix}`, 900)
    const notice = `${told}${run ? `. ${run}` : ''}; this clears once rows are written again.`
    if (run === null || diagnostic(notice, 2000).includes(run)) this.call(() => this.io.notice?.(notice))
    else {
      this.call(() => this.io.notice?.(`${told}; this clears once rows are written again.`))
      this.call(() => this.io.notice?.(`bqaa: ${run}`))
    }
  }

  // BigQuery refused rows for a reason of their own (a 400, say): it found
  // the table and took the credentials, so a notice about either is stale.
  private tableAnswered(): void {
    if (this.problem?.kind === 'credentials' || this.problem?.kind === 'destination') this.clearProblem()
  }

  // A 404 from insertAll, sent or replayed: the notice for the dataset or
  // table, unless this writer made the table in the last two minutes.
  private missingDestination(message: string): void {
    if (this.tableCreatedAt !== null && this.io.now() - this.tableCreatedAt < NEW_TABLE_MS) return
    this.noteProblem('destination', message, isDatasetMissing(message) ? 'dataset' : 'table')
  }

  // The next successful send: the problem is gone. Rows refused while
  // access was denied stay parked until /bqaa-backfill, and the transcript
  // says so; rows parked for want of credentials follow on their own.
  private clearProblem(): void {
    const was = this.problem
    if (was === null) return
    const parked = this.parkedDuringProblem
    const about = this.parkedRough ? 'about ' : ''
    this.problem = null
    this.parkedDuringProblem = 0
    this.parkedIds.clear()
    this.parkedRough = false
    this.call(() => this.io.redraw?.())
    if (parked > 0 && (was.kind === 'permission' || !this.config().autoBackfill)) {
      this.call(() => this.io.notice?.(`bqaa: rows are being written again; /bqaa-backfill sends the ${about}${parked} row(s) parked while they could not be.`))
    }
  }

  // The status line and the band, with the count of rows waiting now.
  private showProblem(): void {
    if (this.problem === null) return
    const { headline, fix } = this.problemText()
    this.setStatus(`BQAA: ${headline}. To fix, ${fix} (${this.waitingText()} row(s) waiting)`)
    this.call(() => this.io.redraw?.())
  }

  // What is wrong, and what the person runs or asks for to fix it, for the
  // token source this writer uses (the command named by its program only).
  problemText(): { headline: string; fix: string } {
    const c = this.config()
    const kind = this.problem?.kind ?? 'credentials'
    if (kind === 'permission') return { headline: HEADLINE.permission, fix: `ask for roles/bigquery.dataEditor on ${c.project}.${c.dataset}, then run /bqaa-backfill` }
    if (kind === 'destination') {
      const what = this.problem?.missing === 'table' ? `the table ${c.project}.${c.dataset}.${c.table}` : `the dataset ${c.project}.${c.dataset}`
      const make = this.setupCommand() === null ? 'create it, or correct the project and dataset options' : "create it with the mod's setup.sh"
      return { headline: `BigQuery cannot find ${what}`, fix: `${make}; rows wait, and are sent once BigQuery finds it (a few minutes after it is made)` }
    }
    if (this.tokenSource === 'environment') return { headline: HEADLINE.credentials, fix: 'set a fresh BQAA_ACCESS_TOKEN, or unset it to use the token command' }
    const argv = c.accessTokenCommand
    const program = programName(argv)
    if (argv.length === 0) return { headline: HEADLINE.credentials, fix: 'set BQAA_ACCESS_TOKEN or accessTokenCommand' }
    if (/^gcloud(\.cmd|\.exe)?$/i.test(program) && argv.includes('print-access-token')) {
      return { headline: HEADLINE.credentials, fix: argv.includes('application-default') ? 'run: gcloud auth application-default login' : 'run: gcloud auth login' }
    }
    return { headline: HEADLINE.credentials, fix: `check the token command \`${program}\`` }
  }

  // For a dataset or table BigQuery cannot find: the command that makes it,
  // the mod's setup.sh run by bash with every name it reads set on the line,
  // the views dataset included (so none comes from a variable set in the
  // person's shell), or null when the mod's directory is unknown or not a
  // POSIX path, a name is one setup.sh would refuse, or the command is too
  // long, or holds text redaction would change, to be shown as it is.
  setupCommand(): string | null {
    if (this.problem?.kind !== 'destination') return null
    const c = this.config()
    const root = this.io.pluginRoot
    if (root === undefined || !root.startsWith('/')) return null
    // The views go to `<dataset>_reporting`, held to the same rule.
    const views = `${c.dataset}_reporting`
    if (!PLAIN_PROJECT.test(c.project) || ![c.dataset, views, c.table].every(name => PLAIN_NAME.test(name)) || !PLAIN_LOCATION.test(c.location)) return null
    // A POSIX path: a backslash in it is part of a name, not a separator.
    const script = root.endsWith('/') ? `${root}setup.sh` : `${root}/setup.sh`
    const command = `BQAA_PROJECT_ID=${c.project} BQAA_DATASET=${c.dataset} BQAA_TABLE=${c.table} BQAA_VIEWS_DATASET=${views} BQAA_LOCATION=${c.location} bash ${shellQuote(script)}`
    // Redaction also cuts a text past its limit, so a longer command fails
    // the same check.
    return diagnostic(`Run: ${command}`, SETUP_COMMAND_CHARS + 5) === `Run: ${command}` ? command : null
  }

  // The band's and the transcript's line for the setup command: the command
  // itself when the line holds it whole, else where to find it (a command
  // cut short would not run). Null when no command is offered.
  commandLine(): string | null {
    const command = this.setupCommand()
    if (command === null) return null
    const line = `Run: ${command}`
    return line.length <= COMMAND_LINE_CHARS ? line : 'Run the setup command /bqaa-status shows (too long for this line)'
  }

  // Rows that wait for the problem to clear: queued, in flight, and parked
  // on disk since it began.
  waitingRows(): number {
    return this.queue.length + (this.batchOpen ? this.inFlightRows.length : 0) + this.parkedDuringProblem
  }

  // The count as shown: "about N" once it went past the rows it keeps.
  waitingText(): string {
    return `${this.parkedRough ? 'about ' : ''}${this.waitingRows()}`
  }

  private refusedText(): string {
    return `${this.refusedRough ? 'about ' : ''}${this.refusedSinceSuccess}`
  }

  // A notice the surface may not take (no terminal, a `-p` run) is skipped.
  private call(show: () => void): void {
    try {
      show()
    } catch {
      // The status line and /bqaa-status still say it.
    }
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
    let first = 0
    for (const body of packBodies(lines.map(lineText))) {
      const count = body.split('\n').length - 1
      const ids = rows.slice(first, first + count).map(q => q.row.event_id)
      first += count
      const path = joinPath(dir, fileName(kind, at, this.sessionId(), ++this.seq))
      try {
        if (c.deadLetterDir === '') throw new Error('no dead-letter directory')
        // The completion record goes last: a replay reads the file only once
        // the record is there and matches every row above it.
        await this.io.writeFile(path, sealFile(body))
        this.counters.deadLetterFiles += 1
        if (kind !== 'rejected') {
          this.wroteRecoverable = true
          this.replayDue.add(dir)
          this.parkedSeq += 1
        }
        if (this.problem !== null) this.countParked(ids)
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
    const parked = this.parkedSeq
    const dir = deadLetterPartition(this.config())
    const run = this.backfillRun(kinds, trigger, dir, parked).catch(err => {
      // A file that could not be read or written: its rows are still in it,
      // so they stay due and the paced retries replay it. Once a replay has
      // its outcome, none of its rows goes again (`writeOut`).
      this.replayDue.add(dir)
      const report: BackfillReport = {
        trigger,
        files: 0,
        rowsSent: 0,
        rowsLeft: 0,
        rowsRefused: 0,
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

  private async backfillRun(kinds: DeadLetterKind[], trigger: BackfillReport['trigger'], dir: string, parked: number): Promise<BackfillReport> {
    const c = this.config()
    const report: BackfillReport = { trigger, files: 0, rowsSent: 0, rowsLeft: 0, rowsRefused: 0, otherTableRows: 0, skippedFiles: 0, oversizedFiles: [], incompleteFiles: [], error: null, finishedAt: null }
    const tally: ReplayTally = { waiting: 0, requests: 0 }
    const finish = (): BackfillReport => {
      report.finishedAt = this.io.now()
      this.backfillReport = report
      return report
    }
    if (!canDeliver(c) || c.dryRun) {
      report.error = c.dryRun ? 'dry run: nothing is sent to BigQuery' : 'not configured: set project and dataset'
      return finish()
    }
    // Only this table's subdirectory (`dir`): rows parked for another table
    // wait for a session configured with that table.
    let entries: readonly { name: string; kind: string; size: number }[] = []
    try {
      entries = await this.io.listDir(dir)
    } catch (err) {
      // No such directory: no row waits in it. Any other failure leaves the
      // rows due, and the next replay lists it again.
      const message = errorText(err)
      if (!/ENOENT|no such file|not found/i.test(message)) {
        this.replayDue.add(dir)
        report.error = diagnostic(`cannot list ${dir}: ${message}`)
      } else if (this.parkedSeq === parked) this.replayDue.delete(dir)
      return finish()
    }
    const files: string[] = []
    const sizes = new Map<string, number>()
    for (const e of entries) {
      const kind = kindOf(e.name)
      if (e.kind !== 'file' || e.size === 0 || kind === null || !kinds.includes(kind)) continue
      // `$.fs.read` refuses a file over 4 MiB: say so rather than pass it by.
      if (e.size > HOST_FILE_BYTES) report.oversizedFiles.push(e.name)
      else {
        files.push(e.name)
        sizes.set(e.name, e.size)
      }
    }
    files.sort()
    const me = this.sessionId() ?? 'unknown'
    for (const name of files) {
      if (report.error || this.replayStops(trigger, tally)) {
        report.skippedFiles += 1
        // Not read: its rows wait for the next replay.
        if (kindOf(name) !== 'rejected') tally.waiting += 1
        continue
      }
      const leaseKey = `lease:${destinationDir(tableRef(c))}/${name}`
      try {
        const lease = (await this.io.storeGet(leaseKey)) as { by?: string; until?: number } | undefined
        if (lease && typeof lease.until === 'number' && lease.until > this.io.now() && lease.by !== me) {
          // Another session replays it. Should that one stop part-way, the
          // rows still wait, so a replay here tries the file again.
          report.skippedFiles += 1
          if (kindOf(name) !== 'rejected') tally.waiting += 1
          continue
        }
        await this.io.storeSet(leaseKey, { by: me, until: this.io.now() + LEASE_MS })
      } catch {
        // No store: go on without the lease; event_id still dedups in SQL.
      }
      try {
        const path = joinPath(dir, name)
        const source = sourceFor(dir, name, sizes.get(name) ?? -1, c)
        // A replay already has this file's outcome: what is left of it is
        // written out (the rest of it, now), the file is emptied, and none
        // of it goes again. Until it is emptied, its table stays due. The
        // record is read even when this writer holds the outcome: another
        // writer may have written more of it since.
        let held = this.rewrites.get(path)
        if (held !== undefined && held.size !== source.size) {
          this.rewrites.delete(path)
          held = undefined
        }
        let found: Found | 'torn' | undefined
        try {
          found = await this.readJournal(source)
        } catch (err) {
          // It may have an outcome that cannot be read now: none of it goes
          // until its record can be, and its rows wait.
          report.error = diagnostic(`cannot read the replay record of ${name}: ${messageOf(err)}`)
          report.skippedFiles += 1
          if (kindOf(name) !== 'rejected') tally.waiting += 1
          continue
        }
        if (found === 'torn') {
          // Its record was cut off part-way, with none whole: nothing of what
          // it left was written (that waits for a whole record), but its rows
          // may have gone. The writer that holds the outcome writes it again;
          // any other replay that runs by itself leaves the file waiting, and
          // /bqaa-backfill, asked to send it, replays it afresh.
          if (held === undefined && trigger !== 'command') {
            report.error = diagnostic(`the replay record of ${name} is cut off part-way; /bqaa-backfill replays the file afresh`)
            report.skippedFiles += 1
            if (kindOf(name) !== 'rejected') tally.waiting += 1
            continue
          }
          found = undefined
        }
        const known = await this.resumeRewrite(path, source, kindOf(name) ?? 'retry', held, found)
        let emptied = true
        if (known !== undefined) {
          emptied = await this.writeOut(path, known)
          // What it wrote out waits for the next replay.
          if (known.waits) tally.waiting += 1
          report.files += 1
          report.rowsLeft += [...known.fates].filter(fate => fate !== 'L').length
          report.rowsRefused += [...known.fates].filter(fate => fate === 'R').length
        } else {
          const parsed = parseFile(await this.io.readFile(path))
          if (!parsed.complete) report.incompleteFiles.push(name)
          else if (parsed.parent !== null && !(await this.parentHas(dir, parsed.parent, path, c))) {
            // Written by a replay of another file whose record does not have
            // it as written yet: it waits until that replay is finished.
            report.skippedFiles += 1
            if (kindOf(name) !== 'rejected') tally.waiting += 1
          } else {
            emptied = await this.backfillFile(dir, name, parsed, source, c, kinds, trigger, report, tally)
            report.files += 1
          }
        }
        if (!emptied) tally.waiting += 1
      } finally {
        try {
          await this.io.storeDelete(leaseKey)
        } catch {
          // The lease expires on its own.
        }
      }
    }
    // Another replay of this table follows by itself while rows wait: rows
    // this one left, files it did not read (another session's lease on them
    // included), or rows parked once it had begun. Rows refused here, and
    // files too large to read or not whole, never keep it going.
    if (tally.waiting > 0 || this.parkedSeq !== parked) this.replayDue.add(dir)
    else this.replayDue.delete(dir)
    return finish()
  }

  // A replay that runs by itself stops between requests, once it has sent
  // one, for rows queued meanwhile (the flush it holds sends them first) or
  // for the session ending. What it did not send stays due.
  private replayStops(trigger: BackfillReport['trigger'], tally: ReplayTally): boolean {
    return trigger === 'recovery' && (this.closing || (tally.requests > 0 && this.queue.length > 0))
  }

  // Rows one replay request had refused: on the status line, and among the
  // rows the access-denied notice counts, as a send's refused rows are, each
  // row once (one /bqaa-backfill sends again, and BigQuery refuses again,
  // is not counted twice; one an earlier session refused counts once here).
  private refusedOnReplay(ids: readonly string[], reason: string): void {
    if (ids.length === 0) return
    this.countRefused(ids)
    if (this.problem?.kind === 'permission') this.countParked(ids)
    if (this.problem !== null) this.showProblem()
    else if (this.refusedSinceSuccess > 0) this.setStatus(`BQAA: ${this.refusedText()} row(s) refused (${diagnostic(reason).slice(0, 80)}); fix, then /bqaa-backfill`)
  }

  private countRefused(ids: readonly string[]): void {
    const { added, rough } = Writer.countNew(this.refusedIds, ids)
    this.refusedSinceSuccess += added
    if (rough) this.refusedRough = true
  }

  private countParked(ids: readonly string[]): void {
    const { added, rough } = Writer.countNew(this.parkedIds, ids)
    this.parkedDuringProblem += added
    if (rough) this.parkedRough = true
  }

  // How many of `ids` are not in `seen`, which then holds them, up to
  // COUNTED_IDS; past that a row counts without the check (`rough`: it may
  // count again).
  private static countNew(seen: Set<string>, ids: readonly string[]): { added: number; rough: boolean } {
    let added = 0
    let rough = false
    for (const id of ids) {
      // A row with no id counts on its own.
      if (typeof id !== 'string' || id === '') {
        added += 1
        continue
      }
      if (seen.has(id)) continue
      added += 1
      if (seen.size < COUNTED_IDS) seen.add(id)
      else rough = true
    }
    return { added, rough }
  }

  // A file's replay record, wherever a writer left it: in `$.store`, and in
  // the files beside it when the store did not take it (or it was too large
  // for the store), the later of the two whole ones. When the store and the
  // file hold the same outcome, a file of what is left counts as written if
  // either says so. None when no record is there; `torn` when only one cut
  // off part-way is. A record that cannot be read throws, and is never taken
  // for none.
  private async readJournal(source: Source): Promise<Found | 'torn' | undefined> {
    const stored = ((await this.io.storeGet(source.recordKey)) ?? undefined) as Partial<Journal> | undefined
    let filed: Partial<Journal> | undefined
    let torn = false
    for (const file of source.recordFiles) {
      if (this.io.exists !== undefined && !(await this.io.exists(file))) continue
      const read = journalOf(await this.io.readFile(file))
      if (read === 'torn') torn = true
      else if (read !== undefined && (filed === undefined || seqOf(read) > seqOf(filed))) filed = read
    }
    if (stored === undefined) return filed !== undefined ? { journal: filed, filed: true } : torn ? 'torn' : undefined
    if (filed === undefined) return { journal: stored, filed: torn }
    // Two outcomes: the file's was written when the store did not take it.
    if (!Array.isArray(stored.files) || !Array.isArray(filed.files) || !sameNames(stored.files, filed.files)) return { journal: filed, filed: true }
    const a = writtenOf(stored)
    const b = writtenOf(filed)
    return { journal: { ...stored, written: a.map((w, i) => w || b[i] === true), seq: Math.max(seqOf(stored), seqOf(filed)) }, filed: true }
  }

  // Whether the file `path`, which a replay of `parent` wrote, may be
  // replayed: the parent's record has it as written, or names other files
  // (another replay's outcome), or is gone (the parent was emptied). Until
  // then the record may yet write it again, so it waits; and so it does
  // while the record cannot be read, or is cut off.
  private async parentHas(dir: string, parent: string, path: string, c: Config): Promise<boolean> {
    let found: Found | 'torn' | undefined
    try {
      found = await this.readJournal(sourceFor(dir, parent, -1, c))
    } catch {
      return false
    }
    if (found === 'torn') return false
    if (found === undefined) return true
    const at = (Array.isArray(found.journal.files) ? found.journal.files : []).indexOf(path)
    return at === -1 || writtenOf(found.journal)[at] === true
  }

  // Empties the files beside `source` that held its record: none is read
  // once the source is empty, or once the record is let go.
  private async emptyRecordFiles(source: Source): Promise<void> {
    for (const file of source.recordFiles) {
      try {
        if (this.io.exists !== undefined && !(await this.io.exists(file))) continue
        await this.io.writeFile(file, '')
      } catch {
        // Left as it is.
      }
    }
  }

  // What `rewrite` holds, brought up to its record: a file of what is left
  // that the record has as written counts as written, and never goes back to
  // unwritten (another writer may since have replayed and emptied it). False
  // when the record is of another outcome for the file.
  private static catchUp(rewrite: Rewrite, found: Found): boolean {
    if (!sameNames(rewrite.files.map(f => f.path), Array.isArray(found.journal.files) ? found.journal.files : [])) return false
    const written = writtenOf(found.journal)
    rewrite.files.forEach((file, i) => {
      if (written[i] === true) file.text = null
    })
    rewrite.filed ||= found.filed
    rewrite.seq = Math.max(rewrite.seq, seqOf(found.journal))
    return true
  }

  // The Rewrite for the file `source.size` long: what this writer holds of
  // it, brought up to its record, or else the record's, with what it has
  // still to write rebuilt from the source. With no record that fits the
  // file, what this writer holds, if anything; a record that no longer fits
  // the file is let go.
  private async resumeRewrite(path: string, source: Source, fileKind: DeadLetterKind, held: Rewrite | undefined, found: Found | undefined): Promise<Rewrite | undefined> {
    if (found === undefined || found.journal.size !== source.size) return held
    if (held !== undefined && Writer.catchUp(held, found)) return held
    const { journal } = found
    const paths = Array.isArray(journal.files) ? journal.files : []
    const written = writtenOf(journal)
    const outcome: Outcome = { fates: typeof journal.fates === 'string' ? journal.fates : '', reasons: Array.isArray(journal.reasons) ? journal.reasons : [], refusals: Array.isArray(journal.refusals) ? journal.refusals : [] }
    const rewrite: Rewrite = { ...outcome, ...source, waits: journal.waits === true, filed: found.filed, seq: seqOf(journal), files: paths.map(p => ({ path: p, text: null })) }
    if (written.every(Boolean)) return rewrite
    const lines = parseFile(await this.io.readFile(path))
    const texts = fitsLines(lines, outcome) ? leftoverFiles(lines, fileKind, outcome, source.name) : null
    if (texts === null || texts.length !== paths.length) {
      // Not this file's outcome after all: replay it afresh.
      try {
        await this.io.storeDelete(source.recordKey)
      } catch {
        // It no longer fits the file; it is passed by again.
      }
      if (found.filed) await this.emptyRecordFiles(source)
      return held
    }
    rewrite.files = paths.map((p, i) => ({ path: p, text: written[i] === true ? null : (texts[i]?.text ?? '') }))
    return rewrite
  }

  // What a replay left of a file, written out: first the record of its
  // outcome, where every writer reads it, then each file of what is left,
  // once, each followed by the record again (a write that fails stops the
  // replay, and the next one, of this or any writer, writes the rest under
  // the same names), then the source emptied. Nothing is written until the
  // record is: one that neither the store nor a file beside the source takes
  // stops the replay, and this writer tries again at the next. A file of what
  // is left that the record does not yet have as written is never replayed
  // (`parentHas`), so one written again over it was never taken. False when
  // the source could not be emptied: it stays on disk, its rows landed or in
  // the newer files, and the record keeps every session from sending it
  // again; the next replay tries to empty it again.
  private async writeOut(path: string, rewrite: Rewrite): Promise<boolean> {
    this.rewrites.set(path, rewrite)
    const record = async (): Promise<void> => {
      rewrite.seq += 1
      const { fates, reasons, refusals, size, waits, seq } = rewrite
      const journal: Journal = { fates, reasons, refusals, size, waits, seq, files: rewrite.files.map(f => f.path), written: rewrite.files.map(f => f.text === null) }
      if (utf8Length(JSON.stringify(journal)) <= STORE_RECORD_BYTES) {
        try {
          await this.io.storeSet(rewrite.recordKey, journal)
          return
        } catch {
          // Not taken (the store is full, say): a file beside the source.
        }
      }
      try {
        // The two files take the updates in turn: one cut off part-way
        // leaves the record before it whole in the other (or in the store).
        await this.io.writeFile(rewrite.recordFiles[(seq + 1) % 2] as string, journalText(journal))
        rewrite.filed = true
      } catch (err) {
        const message = `could not record the replay of ${path}, so nothing more of what it left is written: ${errorText(err)}`
        this.recordError(message)
        throw new Error(message)
      }
    }
    await record()
    for (const file of rewrite.files) {
      if (file.text === null) continue
      // Another writer may have written it since, or replayed the file at the
      // same time with an outcome of its own: the record says.
      const found = await this.readJournal(rewrite)
      if (found === 'torn' || (found !== undefined && found.journal.size === rewrite.size && !Writer.catchUp(rewrite, found))) {
        // That outcome goes on, at the next replay, and no more of this one.
        this.rewrites.delete(path)
        return false
      }
      if (file.text === null) continue
      await this.io.writeFile(file.path, file.text)
      file.text = null
      await record()
    }
    try {
      await this.io.writeFile(path, '')
    } catch (err) {
      this.recordError(`could not empty ${path} after its replay (its rows landed or are in newer files): ${errorText(err)}`)
      return false
    }
    this.rewrites.delete(path)
    // A record for an empty file is never read: no replay lists one.
    try {
      await this.io.storeDelete(rewrite.recordKey)
    } catch {
      // Left for an empty file.
    }
    if (rewrite.filed) await this.emptyRecordFiles(rewrite)
    return true
  }

  // Replays one file; false when what it left is written out but the file
  // itself could not be emptied.
  private async backfillFile(dir: string, name: string, file: ParsedFile, source: Source, c: Config, kinds: readonly DeadLetterKind[], trigger: BackfillReport['trigger'], report: BackfillReport, tally: ReplayTally): Promise<boolean> {
    const path = joinPath(dir, name)
    const { lines } = file
    const fileKind = kindOf(name) ?? 'retry'
    // A line is sent only to the table it records, and only by a replay that
    // sends its kind: one that runs by itself never sends a refused row,
    // whatever file holds it. The others stay as written.
    const table = tableRef(c)
    const mine: DeadLetterLine[] = []
    // Where each of `mine` is in the file, and what became of each line.
    const at: number[] = []
    const fates: string[] = []
    const reasons: string[] = []
    const refusals: number[] = []
    let kept = 0
    lines.forEach((line, i) => {
      const kind = isDeadLetterKind(line.kind) ? line.kind : fileKind
      if (line.table === table && kinds.includes(kind)) {
        mine.push({ ...line, kind })
        at.push(i)
        fates.push('W')
      } else {
        kept += 1
        fates.push('K')
        if (line.table !== table) report.otherTableRows += 1
      }
    })
    const keys = mine.map((line, n) => keyOf(line, name, at[n] as number))
    // A row BigQuery refused: kept, with the reason, for /bqaa-backfill.
    const refuse = (n: number, reason: string): void => {
      report.rowsRefused += 1
      let why = diagnostic(reason)
      // Past the reasons a replay keeps, one stands for every other.
      if (!reasons.includes(why) && reasons.length >= MAX_REASONS - 1) why = OTHER_REASON
      let k = reasons.indexOf(why)
      if (k === -1) k = reasons.push(why) - 1
      fates[at[n] as number] = 'R'
      refusals.push(k)
    }
    let changed = false
    let index = 0
    while (index < mine.length) {
      if (report.error || this.replayStops(trigger, tally)) break
      let bytes = 0
      let end = index
      while (end < mine.length && end - index < c.maxBatchRows) {
        const size = rowBytes((mine[end] as DeadLetterLine).row)
        if (end > index && bytes + size > c.maxBatchBytes) break
        bytes += size
        end += 1
      }
      const first = index
      const chunk = mine.slice(index, end)
      index = end
      let token: string
      try {
        token = await this.getToken()
      } catch (err) {
        report.error = diagnostic(`authentication: ${messageOf(err)}`)
        continue
      }
      const body = insertAllBody(chunk.map(l => l.row))
      tally.requests += 1
      let answer = await this.post(insertAllUrl(c), body, token, c.requestTimeoutMs)
      if ('error' in answer) {
        report.error = diagnostic(answer.error)
        continue
      }
      let outcome = classifyInsert(answer, chunk.length)
      if (outcome.kind === 'auth') {
        // As for a send: one more try at once with a fresh token, and a
        // second 401 is the credentials notice. The rows keep the user_id
        // they were parked with.
        this.dropToken()
        try {
          token = await this.getToken()
        } catch (err) {
          report.error = diagnostic(`authentication: ${messageOf(err)}`)
          continue
        }
        answer = await this.post(insertAllUrl(c), body, token, c.requestTimeoutMs)
        if ('error' in answer) {
          report.error = diagnostic(answer.error)
          continue
        }
        outcome = classifyInsert(answer, chunk.length)
        if (outcome.kind === 'auth') this.noteProblem('credentials', `BigQuery refused a fresh token too: ${outcome.message}`)
      }
      if (outcome.kind === 'ok' || outcome.kind === 'partial') {
        // BigQuery took the request: the table is there and the credentials
        // work, whatever it made of each row. The command's replay sends
        // the refused rows too, so its count of rows parked meanwhile starts
        // over.
        if (trigger === 'command') this.parkedDuringProblem = 0
        let landed = 0
        const refused: string[] = []
        let refusal = ''
        const { rejected, retry } = outcome.kind === 'partial' ? outcome : { rejected: new Map<number, string>(), retry: new Set<number>() }
        chunk.forEach((_, i) => {
          const reason = rejected.get(i)
          if (reason !== undefined) {
            refused.push(keys[first + i] as string)
            refusal = reason
            refuse(first + i, reason)
          } else if (!retry.has(i)) {
            landed += 1
            fates[at[first + i] as number] = 'L'
          }
        })
        report.rowsSent += landed
        this.counters.sent += landed
        // In the order they came, as for a send: rows landing end the count,
        // then this request's refusals start it again.
        this.tookRequest(landed)
        this.refusedOnReplay(refused, refusal)
        // Rows asked for again, and nothing else, leave the file as it was.
        if (outcome.kind === 'ok' || outcome.retry.size < chunk.length) changed = true
        continue
      }
      if (outcome.kind === 'rejected') {
        // Refused whole, as a send would be: parked for /bqaa-backfill, and
        // access denied is the notice. The rest waits for the next replay.
        if (outcome.permission) this.noteProblem('permission', outcome.message)
        else this.tableAnswered()
        chunk.forEach((line, i) => refuse(first + i, outcome.message))
        this.refusedOnReplay(keys.slice(first, first + chunk.length), outcome.message)
        changed = true
        report.error = diagnostic(outcome.message)
        continue
      }
      if (outcome.kind === 'auth') this.dropToken()
      if (outcome.kind === 'not-found') this.missingDestination(outcome.message)
      report.error = diagnostic(outcome.message)
    }
    tally.waiting += mine.filter((line, n) => fates[at[n] as number] === 'W' && line.kind !== 'rejected').length
    report.rowsLeft += at.filter(i => fates[i] !== 'L').length + kept
    // Nothing sent and nothing new to record: the file stays as it was.
    if (!changed) return true
    // What is left goes to new files first, each kind to files of its own (a
    // row refused here to a `rejected` file, which no replay that runs by
    // itself reads), each file ending with its completion record; only once
    // every one is written is the source emptied: `$.fs` has no rename or
    // delete. A write that fails leaves the source as it was, so an unsent
    // row is never held only in memory, and this outcome is kept: the next
    // replay finishes writing it out (`writeOut`) and sends none of the
    // file again.
    const outcome: Outcome = { fates: fates.join(''), reasons, refusals }
    const rest = leftoverFiles(file, fileKind, outcome, name)
    const files = rest.map(({ kind, text }) => ({ path: joinPath(dir, fileName(kind, this.io.now(), this.sessionId(), ++this.seq)), text }))
    const ours: Rewrite = { ...source, ...outcome, files, waits: rest.some(f => f.kind !== 'rejected'), filed: false, seq: 0 }
    // Another writer that replayed the file at the same time may have
    // recorded its outcome meanwhile: that one goes on, not this one, so no
    // row is written out twice. A record that cannot be read keeps this
    // outcome here until it can be.
    let found: Found | 'torn' | undefined
    try {
      found = await this.readJournal(source)
    } catch (err) {
      this.rewrites.set(path, ours)
      throw err
    }
    if (found !== undefined && found !== 'torn' && found.journal.size === source.size) {
      const theirs = await this.resumeRewrite(path, source, fileKind, undefined, found)
      if (theirs !== undefined) return this.writeOut(path, theirs)
    }
    return this.writeOut(path, ours)
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
    waitingText: string
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
      waitingText: this.waitingText(),
      identity: !c.userIdFromCredentials ? 'off' : this.token === null || this.identity?.token !== this.token.value ? 'pending' : this.identity.email === null ? 'failed' : 'found',
    }
  }
}
