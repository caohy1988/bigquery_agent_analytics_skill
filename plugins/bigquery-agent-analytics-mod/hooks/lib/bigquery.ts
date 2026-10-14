// BigQuery REST requests the writer makes through `$.http.fetch`:
// tabledata.insertAll (the legacy streaming API, which takes JSON over
// HTTP/1.1) and tables.insert for the optional create-on-first-use. The
// Storage Write API is gRPC only, which `$.http.fetch` does not speak.

import type { Config } from './config.ts'
import { AGENT_EVENTS_SCHEMA, type BqaaRow } from './rows.ts'

const API = 'https://bigquery.googleapis.com/bigquery/v2'
const seg = (s: string): string => encodeURIComponent(s)

export const insertAllUrl = (c: Config): string =>
  `${API}/projects/${seg(c.project)}/datasets/${seg(c.dataset)}/tables/${seg(c.table)}/insertAll`

export const tablesUrl = (c: Config): string => `${API}/projects/${seg(c.project)}/datasets/${seg(c.dataset)}/tables`

// `insertId` is the row's event_id, so BigQuery can drop a retried row on a
// best-effort basis; event_id stays in the row for exact dedup in SQL.
// skipInvalidRows: a bad row is reported alone instead of failing the batch.
// ignoreUnknownValues: a table created before schema v2 (no event_id column)
// still takes the rows.
export function insertAllBody(rows: readonly BqaaRow[]): string {
  return JSON.stringify({
    kind: 'bigquery#tableDataInsertAllRequest',
    skipInvalidRows: true,
    ignoreUnknownValues: true,
    rows: rows.map(row => ({ insertId: row.event_id, json: row })),
  })
}

export function createTableBody(c: Config): string {
  return JSON.stringify({
    tableReference: { projectId: c.project, datasetId: c.dataset, tableId: c.table },
    schema: AGENT_EVENTS_SCHEMA,
    timePartitioning: { type: 'DAY', field: 'timestamp' },
    clustering: { fields: ['event_type', 'agent', 'user_id'] },
    description: 'BigQuery Agent Analytics events written by the bigquery-agent-analytics-mod coding-agent mod.',
  })
}

export type HttpAnswer = { status: number; text: string }

export type InsertOutcome =
  | { kind: 'ok' }
  // Some rows were rejected; `rejected` maps a row index to its reason.
  | { kind: 'partial'; rejected: Map<number, string>; retry: Set<number> }
  // Try again later (network, 408, 429, 5xx, quota).
  | { kind: 'retry'; message: string }
  // The token was refused: refresh it and try again.
  | { kind: 'auth'; message: string }
  // The table (or dataset) does not exist.
  | { kind: 'not-found'; message: string }
  // Needs the person's action (permissions, bad request, billing).
  | { kind: 'rejected'; message: string }

const RETRYABLE_REASONS = new Set(['rateLimitExceeded', 'quotaExceeded', 'userRateLimitExceeded', 'backendError', 'internalError', 'timeout', 'stopped'])

type ApiError = { error?: { code?: number; message?: string; status?: string; errors?: { reason?: string; message?: string }[] } }

const parseJson = <T>(text: string): T | null => {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export function apiErrorMessage(answer: HttpAnswer): string {
  const body = parseJson<ApiError>(answer.text)
  const message = body?.error?.message ?? answer.text.slice(0, 300)
  return `HTTP ${answer.status}: ${message}`.slice(0, 1000)
}

export function classifyInsert(answer: HttpAnswer, rowCount: number): InsertOutcome {
  const { status } = answer
  if (status >= 200 && status < 300) {
    const body = parseJson<{ insertErrors?: { index: number; errors?: { reason?: string; message?: string }[] }[] }>(answer.text)
    const errors = body?.insertErrors ?? []
    if (errors.length === 0) return { kind: 'ok' }
    const rejected = new Map<number, string>()
    const retry = new Set<number>()
    for (const entry of errors) {
      if (typeof entry.index !== 'number' || entry.index < 0 || entry.index >= rowCount) continue
      const reasons = entry.errors ?? []
      const isRetryable = reasons.length > 0 && reasons.every(r => RETRYABLE_REASONS.has(r.reason ?? ''))
      if (isRetryable) retry.add(entry.index)
      else rejected.set(entry.index, reasons.map(r => `${r.reason ?? 'error'}: ${r.message ?? ''}`.trim()).join('; ').slice(0, 1000) || 'rejected')
    }
    return { kind: 'partial', rejected, retry }
  }
  const body = parseJson<ApiError>(answer.text)
  const reason = body?.error?.errors?.[0]?.reason ?? ''
  const message = apiErrorMessage(answer)
  if (status === 401) return { kind: 'auth', message }
  if (status === 404) return { kind: 'not-found', message }
  if (status === 403 && RETRYABLE_REASONS.has(reason)) return { kind: 'retry', message }
  if (status === 408 || status === 429 || status >= 500) return { kind: 'retry', message }
  if (status === 403 || status === 400) return { kind: 'rejected', message }
  return { kind: 'retry', message }
}

// Whether a 404 names the dataset rather than the table.
export const isDatasetMissing = (message: string): boolean => /not found: dataset/i.test(message)
