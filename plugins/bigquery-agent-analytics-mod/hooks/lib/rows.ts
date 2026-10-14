// The BigQuery Agent Analytics row, as the `agent_events` table holds it
// (schema version 2, with `event_id`), and the table definition the mod
// creates when the table is missing.

import { type JsonValue, type Limits, type SanitizeStats, limitsFor, newStats, sanitize, toJsonColumn } from './sanitize.ts'

export type ContentPart = {
  mime_type: string | null
  uri: string | null
  object_ref: { uri: string | null; version: string | null; authorizer: string | null; details: string | null } | null
  text: string | null
  part_index: number | null
  part_attributes: string | null
  storage_mode: string | null
}

// One row as tabledata.insertAll takes it: JSON columns as JSON text.
export type BqaaRow = {
  timestamp: string
  event_id: string
  event_type: string
  agent: string
  session_id: string | null
  invocation_id: string | null
  user_id: string | null
  trace_id: string | null
  span_id: string | null
  parent_span_id: string | null
  content: string | null
  content_parts: ContentPart[]
  attributes: string | null
  latency_ms: string | null
  status: 'OK' | 'ERROR'
  error_message: string | null
  is_truncated: boolean
}

export type RowInput = {
  eventType: string
  timestampMs: number
  eventId: string
  agent: string
  sessionId: string | null
  invocationId: string | null
  userId: string | null
  traceId: string | null
  spanId: string | null
  parentSpanId: string | null
  content: unknown
  attributes: Record<string, unknown>
  latencyMs?: Record<string, number | undefined>
  status?: 'OK' | 'ERROR'
  errorMessage?: string | null
  maxPayloadChars: number
}

export type BuiltRow = { row: BqaaRow; redactions: number }

const ERROR_MESSAGE_CHARS = 4096

// Builds one row: payloads copied within `maxPayloadChars`, secrets redacted,
// `is_truncated` set when anything was cut.
export function buildRow(input: RowInput): BuiltRow {
  const stats: SanitizeStats = newStats()
  const limits: Limits = limitsFor(input.maxPayloadChars)
  const content = input.content === undefined || input.content === null ? null : sanitize(input.content, limits, stats)
  const attributes = sanitize(input.attributes, limits, stats)
  let latency: string | null = null
  if (input.latencyMs) {
    const clean: Record<string, number> = {}
    for (const [key, value] of Object.entries(input.latencyMs)) {
      if (typeof value === 'number' && Number.isFinite(value)) clean[key] = Math.max(0, Math.round(value))
    }
    if (Object.keys(clean).length > 0) latency = JSON.stringify(clean)
  }
  let errorMessage: string | null = null
  if (input.errorMessage) {
    const errLimits: Limits = { ...limits, budgetChars: ERROR_MESSAGE_CHARS, maxStringChars: ERROR_MESSAGE_CHARS }
    errorMessage = sanitize(input.errorMessage, errLimits, stats) as string
  }
  const row: BqaaRow = {
    timestamp: new Date(input.timestampMs).toISOString(),
    event_id: input.eventId,
    event_type: input.eventType,
    agent: input.agent,
    session_id: input.sessionId,
    invocation_id: input.invocationId,
    user_id: input.userId,
    trace_id: input.traceId,
    span_id: input.spanId,
    parent_span_id: input.parentSpanId,
    content: content === null ? null : toJsonColumn(content, input.maxPayloadChars, stats),
    content_parts: [],
    attributes: toJsonColumn(attributes as JsonValue, input.maxPayloadChars, stats),
    latency_ms: latency,
    status: input.status ?? 'OK',
    error_message: errorMessage,
    is_truncated: false,
  }
  row.is_truncated = stats.truncated
  return { row, redactions: stats.redactions }
}

// Approximate bytes a row adds to an insertAll body.
export const rowBytes = (row: BqaaRow): number => JSON.stringify(row).length + 64

// The BQAA `agent_events` schema (v2) in the REST API's TableSchema form.
export const AGENT_EVENTS_SCHEMA = {
  fields: [
    { name: 'timestamp', type: 'TIMESTAMP', mode: 'REQUIRED', description: 'The UTC time at which the event was logged.' },
    { name: 'event_id', type: 'STRING', description: 'Unique ID assigned before enqueue; also the insertAll insertId.' },
    { name: 'event_type', type: 'STRING', description: "The type of event (e.g. 'LLM_REQUEST', 'TOOL_COMPLETED')." },
    { name: 'agent', type: 'STRING', description: 'The agent (or subagent type) associated with the event.' },
    { name: 'session_id', type: 'STRING', description: 'The coding-agent session id.' },
    { name: 'invocation_id', type: 'STRING', description: 'The turn (invocation) id within the session.' },
    { name: 'user_id', type: 'STRING', description: 'The user associated with the session.' },
    { name: 'trace_id', type: 'STRING', description: '32-char hex trace id, one per main-loop turn.' },
    { name: 'span_id', type: 'STRING', description: '16-char hex span id for this operation.' },
    { name: 'parent_span_id', type: 'STRING', description: '16-char hex span id of the immediate caller.' },
    { name: 'content', type: 'JSON', description: 'The event-specific payload.' },
    {
      name: 'content_parts',
      type: 'RECORD',
      mode: 'REPEATED',
      description: 'Detailed content parts for multi-modal data.',
      fields: [
        { name: 'mime_type', type: 'STRING' },
        { name: 'uri', type: 'STRING' },
        {
          name: 'object_ref',
          type: 'RECORD',
          fields: [
            { name: 'uri', type: 'STRING' },
            { name: 'version', type: 'STRING' },
            { name: 'authorizer', type: 'STRING' },
            { name: 'details', type: 'JSON' },
          ],
        },
        { name: 'text', type: 'STRING' },
        { name: 'part_index', type: 'INTEGER' },
        { name: 'part_attributes', type: 'STRING' },
        { name: 'storage_mode', type: 'STRING' },
      ],
    },
    { name: 'attributes', type: 'JSON', description: 'Metadata: model, token usage, writer, session metadata.' },
    { name: 'latency_ms', type: 'JSON', description: 'Latency measurements (total_ms, time_to_first_token_ms).' },
    { name: 'status', type: 'STRING', description: "'OK' or 'ERROR'." },
    { name: 'error_message', type: 'STRING', description: 'Sanitized error or termination diagnostic.' },
    { name: 'is_truncated', type: 'BOOLEAN', description: 'True when content or metadata was truncated.' },
  ],
} as const
