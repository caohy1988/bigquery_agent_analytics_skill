// The local dead-letter files: JSONL, one row per line, each line keeping
// the full insertAll row so a backfill can send it again unchanged.
//
// `$.fs` has no append and no delete, and reads and writes at most 4 MiB per
// file. So every failure writes a new, immutable file (no read-modify-write
// races between sessions), files are kept under that size, and a backfill
// that delivered a file truncates it to zero bytes.

import type { BqaaRow } from './rows.ts'

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
  table: string
  row: BqaaRow
}

export const MAX_FILE_CHARS = 3 * 1024 * 1024
export const FILE_PATTERN = /^(spill|retry|rejected)-[A-Za-z0-9._-]+\.jsonl$/

export function encodeLines(lines: DeadLetterLine[]): string[] {
  // Several files when the lines would pass MAX_FILE_CHARS.
  const files: string[] = []
  let current = ''
  for (const line of lines) {
    const text = `${JSON.stringify(line)}\n`
    if (current !== '' && current.length + text.length > MAX_FILE_CHARS) {
      files.push(current)
      current = ''
    }
    current += text
  }
  if (current !== '') files.push(current)
  return files
}

export const fileName = (kind: DeadLetterKind, atMs: number, session: string | null, seq: number): string => {
  const stamp = new Date(atMs).toISOString().replace(/[-:]/g, '').replace('.', '')
  const who = (session ?? 'nosession').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'nosession'
  return `${kind}-${stamp}-${who}-${seq}.jsonl`
}

export const kindOf = (name: string): DeadLetterKind | null => {
  const m = FILE_PATTERN.exec(name)
  return m ? (m[1] as DeadLetterKind) : null
}

export type ParsedFile = { lines: DeadLetterLine[]; unreadable: string[] }

export function parseFile(text: string): ParsedFile {
  const lines: DeadLetterLine[] = []
  const unreadable: string[] = []
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    try {
      const line = JSON.parse(raw) as DeadLetterLine
      if (line && typeof line === 'object' && line.row && typeof line.row.event_type === 'string' && typeof line.row.timestamp === 'string') {
        lines.push(line)
      } else {
        unreadable.push(raw)
      }
    } catch {
      unreadable.push(raw)
    }
  }
  return { lines, unreadable }
}
