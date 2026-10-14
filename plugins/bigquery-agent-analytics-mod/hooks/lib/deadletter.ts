// The local dead-letter files: JSONL, one row per line, each line keeping
// the full insertAll row so a backfill can send it again unchanged.
//
// `$.fs` has no append and no delete, and reads and writes at most 4 MiB per
// file, counted in UTF-8 bytes (the file on disk). So every failure writes a
// new, immutable file (no read-modify-write races between sessions), files
// are kept to 3 MiB of UTF-8, and a backfill that delivered a file truncates
// it to zero bytes. Each table's files live in a subdirectory of their own
// (config.ts `deadLetterPartition`).

import { type BqaaRow, fitRow, utf8Length } from './rows.ts'
import { redactDiagnostic } from './sanitize.ts'

export type DeadLetterKind =
  // Queued rows written out at session end, or under queue pressure while
  // BigQuery was unreachable: never refused, sent by the next auto-backfill.
  | 'spill'
  // Retries ran out on transient errors: sent by the next auto-backfill.
  | 'retry'
  // BigQuery or the configuration refused them (permissions, missing table,
  // invalid row): sent again only by an explicit /bqaa-backfill.
  | 'rejected'

export type DeadLetterLine = {
  v: 1
  kind: DeadLetterKind
  reason: string
  attempts: number
  failed_at: string
  // The table the row was meant for, `project.dataset.table`: a replay sends
  // a line only to that table.
  table: string
  row: BqaaRow
}

// What `$.fs.read` and `$.fs.write` take, and what this mod writes: a file
// a backfill rewrites (with longer reasons, say) still reads back.
export const HOST_FILE_BYTES = 4 * 1024 * 1024
export const MAX_FILE_BYTES = 3 * 1024 * 1024
const REASON_CHARS = 1000

export const FILE_PATTERN = /^(spill|retry|rejected)-[A-Za-z0-9._-]+\.jsonl$/

// One line of a dead-letter file: the reason redacted and held to
// REASON_CHARS, and a row too large for a file on its own cut to fit.
export function lineText(line: DeadLetterLine): string {
  const clean: DeadLetterLine = { ...line, reason: redactDiagnostic(line.reason, REASON_CHARS) }
  const text = JSON.stringify(clean)
  if (utf8Length(text) < MAX_FILE_BYTES) return text
  const overhead = utf8Length(JSON.stringify({ ...clean, row: null }))
  return JSON.stringify({ ...clean, row: fitRow(clean.row, MAX_FILE_BYTES - overhead - 16) })
}

// Groups JSONL lines, each of which fits on its own, into file texts of at
// most `maxBytes` of UTF-8.
export function packLines(lines: readonly string[], maxBytes = MAX_FILE_BYTES): string[] {
  const files: string[] = []
  let current: string[] = []
  let bytes = 0
  for (const line of lines) {
    const size = utf8Length(line) + 1
    if (current.length > 0 && bytes + size > maxBytes) {
      files.push(`${current.join('\n')}\n`)
      current = []
      bytes = 0
    }
    current.push(line)
    bytes += size
  }
  if (current.length > 0) files.push(`${current.join('\n')}\n`)
  return files
}

// Several files when the lines pass MAX_FILE_BYTES.
export const encodeLines = (lines: readonly DeadLetterLine[]): string[] => packLines(lines.map(lineText))

export const fileName = (kind: DeadLetterKind, atMs: number, session: string | null, seq: number): string => {
  const stamp = new Date(atMs).toISOString().replace(/[-:]/g, '').replace('.', '')
  const who = (session ?? 'nosession').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'nosession'
  return `${kind}-${stamp}-${who}-${seq}.jsonl`
}

export const kindOf = (name: string): DeadLetterKind | null => {
  const m = FILE_PATTERN.exec(name)
  return m ? (m[1] as DeadLetterKind) : null
}

// `raw[i]` is the text `lines[i]` was read from, so a line can be kept
// exactly as written.
export type ParsedFile = { lines: DeadLetterLine[]; raw: string[]; unreadable: string[] }

export function parseFile(text: string): ParsedFile {
  const lines: DeadLetterLine[] = []
  const raw: string[] = []
  const unreadable: string[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line) as DeadLetterLine
      if (parsed && typeof parsed === 'object' && parsed.row && typeof parsed.row.event_type === 'string' && typeof parsed.row.timestamp === 'string') {
        lines.push(parsed)
        raw.push(line)
      } else {
        unreadable.push(line)
      }
    } catch {
      unreadable.push(line)
    }
  }
  return { lines, raw, unreadable }
}
