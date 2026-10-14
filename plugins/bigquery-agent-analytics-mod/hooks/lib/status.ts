// The text `/bqaa-status` prints. Plain lines: the model reads a command's
// output too, so it carries counts and states, never a payload or a token.

import { type Config, tableRef } from './config.ts'
import type { BackfillReport, Writer } from './writer.ts'

export type DeadLetterSummary = { files: number; bytes: number; byKind: Record<string, number> } | { error: string }

const ago = (now: number, at: number | null): string => {
  if (at === null) return 'never'
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

const kb = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`)

export function formatStatus(args: {
  config: Config
  writer: Writer
  now: number
  sessionId: string | null
  deadLetter: DeadLetterSummary
  backfill: BackfillReport | null
  isBackfilling: boolean
}): string {
  const { config: c, writer, now } = args
  const s = writer.snapshot()
  const k = s.counters
  const target = c.dryRun ? `dry run -> ${c.dryRunDir}` : c.project && c.dataset ? `${tableRef(c)} (${c.location})` : 'not configured'
  const lines = [
    `BigQuery Agent Analytics mod: ${c.enabled ? 'enabled' : 'disabled'}, target ${target}`,
    `queue: ${s.queued} rows (${kb(s.queuedBytes)}), ${s.inFlight} in flight; flush every ${c.flushIntervalMs} ms`,
    `this session: captured ${k.captured}, sent ${k.sent}, dead-lettered ${k.failed} (${k.rejected} refused), spilled ${k.spilled}, dropped ${s.dropped}, not captured ${k.skipped}`,
    `requests: ${k.batches} ok, ${k.retries} retried; last success ${ago(now, s.lastSuccessAt)}`,
  ]
  if (s.consecutiveFailures > 0) lines.push(`backing off: ${s.consecutiveFailures} failure(s) in a row, next try in about ${Math.max(0, Math.round((s.pausedUntil - now) / 1000))}s`)
  if (s.lastError) lines.push(`last error (${ago(now, s.lastError.at)}): ${s.lastError.message.slice(0, 300)}`)
  if ('error' in args.deadLetter) lines.push(`dead-letter: ${args.deadLetter.error}`)
  else {
    const d = args.deadLetter
    const kinds = Object.entries(d.byKind)
      .map(([kind, n]) => `${n} ${kind}`)
      .join(', ')
    lines.push(`dead-letter: ${d.files} file(s), ${kb(d.bytes)}${kinds ? ` (${kinds})` : ''} in ${c.deadLetterDir}`)
  }
  if (args.isBackfilling) lines.push('backfill: running')
  else if (args.backfill) {
    const b = args.backfill
    lines.push(
      `last backfill (${b.trigger}, ${ago(now, b.finishedAt)}): ${b.files} file(s), ${b.rowsSent} rows sent, ${b.rowsLeft} left${b.skippedFiles ? `, ${b.skippedFiles} skipped` : ''}${b.error ? `; stopped: ${b.error.slice(0, 200)}` : ''}`,
    )
  }
  lines.push(`redactions ${k.redactions}, truncated rows ${k.truncatedRows}; session ${args.sessionId ?? 'unknown'}`)
  for (const problem of c.problems) lines.push(`problem: ${problem}`)
  return lines.join('\n')
}
