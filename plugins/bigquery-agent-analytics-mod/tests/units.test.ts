// Unit tests of the mod's plain functions: redaction, truncation, row
// building, configuration, the BigQuery answer classifier and the
// dead-letter file format.

import { expect, test } from 'claude-code/testing'

import { classifyInsert, insertAllBody } from '../hooks/lib/bigquery.ts'
import { resolveConfig, splitArgv } from '../hooks/lib/config.ts'
import { FILE_PATTERN, MAX_FILE_CHARS, encodeLines, fileName, kindOf, parseFile } from '../hooks/lib/deadletter.ts'
import { BoundedQueue } from '../hooks/lib/queue.ts'
import { buildRow } from '../hooks/lib/rows.ts'
import { limitsFor, newStats, redactText, sanitize, toJsonColumn } from '../hooks/lib/sanitize.ts'

const redact = (text: string) => {
  const stats = newStats()
  return { out: redactText(text, stats), count: stats.redactions }
}

// Credential-shaped inputs are joined from pieces at run time, so no file
// holds a literal that a secret scanner would match. Each joined value still
// has its provider's prefix and length, so every pattern has to fire.
const fake = (prefix: readonly string[], filler: string, length: number): string => prefix.join('') + filler.repeat(length).slice(0, length)

test('well-known credential shapes are redacted', () => {
  const pemLabel = ['RSA', 'PRIVATE', 'KEY'].join(' ')
  const cases: [string, RegExp][] = [
    [`key ${fake(['sk-', 'ant-api03-'], 'x', 40)}`, /\[REDACTED:api-key\]/],
    [`PROVIDER_API_KEY=${fake(['sk-', 'proj-'], 'x1', 40)}`, /\[REDACTED/],
    [`aws ${fake(['AK', 'IA'], 'X', 16)} id`, /\[REDACTED:aws-access-key-id\]/],
    [`maps ${fake(['AI', 'za'], 'x', 35)} key`, /\[REDACTED:google-api-key\]/],
    [`tok ${fake(['ya', '29.'], 'x', 30)}`, /\[REDACTED:google-oauth-token\]/],
    [`gh ${fake(['gh', 'p_'], 'x', 36)}`, /\[REDACTED:github-token\]/],
    [`pat ${fake(['github', '_pat_'], 'x', 40)}`, /\[REDACTED:github-token\]/],
    [`gl ${fake(['gl', 'pat-'], 'x', 20)}`, /\[REDACTED:gitlab-token\]/],
    [`npm ${fake(['np', 'm_'], 'x', 36)}`, /\[REDACTED:npm-token\]/],
    [`slack ${fake(['xo', 'xb-'], 'x', 20)}`, /\[REDACTED:slack-token\]/],
    [`stripe ${fake(['sk', '_live_'], 'x', 24)}`, /\[REDACTED:stripe-key\]/],
    [`jwt ${[fake(['ey', 'J'], 'x', 16), fake(['ey', 'J'], 'x', 16), 'x'.repeat(16)].join('.')}`, /\[REDACTED:jwt\]/],
    [`curl -H "Authorization: Bearer ${'x'.repeat(20)}"`, /Bearer \[REDACTED\]/],
    [`postgres://admin:${'x'.repeat(14)}@db.internal:5432/app`, /postgres:\/\/admin:\[REDACTED\]@db/],
    [`export DB_PASSWORD=${'x'.repeat(14)}`, /DB_PASSWORD=\[REDACTED\]/],
    [`{"client_secret": "${'x'.repeat(12)}"}`, /"client_secret": "\[REDACTED\]"/],
    [`GITHUB_TOKEN=${'x'.repeat(16)}`, /GITHUB_TOKEN=\[REDACTED\]/],
    [[`-----BEGIN ${pemLabel}-----`, 'MIIEow', 'abc', `-----END ${pemLabel}-----`].join('\n'), /^\[REDACTED:private-key\]$/],
  ]
  for (const [input, pattern] of cases) {
    const { out, count } = redact(input)
    expect(out).toMatch(pattern)
    expect(count > 0).toBe(true)
  }
})

test('ordinary text, token counts and hashes are left alone', () => {
  const keep = [
    'max_tokens: 1024',
    '"input_tokens": 512, "output_tokens": 77',
    'scikit-learn and sk-learn are fine',
    'commit 3f2a9c1e5b7d4e8a9c216d0f4b8a7e13a1b2c3d4',
    'session 5c4b1d2e-8f7a-4c3b-9d1e-2a6f0b7c8d9e',
    'The tokenizer splits words.',
    'Read the README and run npm test',
  ]
  for (const input of keep) expect(redact(input)).toEqual({ out: input, count: 0 })
})

test('credential keys are redacted in structured payloads; numbers are not', () => {
  const stats = newStats()
  const out = sanitize(
    { api_key: 'abc', headers: { Authorization: 'Bearer x', 'X-Api-Key': 'k' }, token: 'zzz', max_tokens: 5, password: null, 'temp:scratch': 'x' },
    limitsFor(16384),
    stats,
  )
  expect(out).toEqual({
    api_key: '[REDACTED]',
    headers: { Authorization: '[REDACTED]', 'X-Api-Key': '[REDACTED]' },
    token: '[REDACTED]',
    max_tokens: 5,
    password: null,
    'temp:scratch': '[REDACTED]',
  })
  expect(stats.redactions).toBe(5)
  // Redaction alone is not truncation (as in the BQAA plugin).
  expect(stats.truncated).toBe(false)
})

test('long text is cut, marked, and flagged as truncated, within the column cap', () => {
  const stats = newStats()
  const out = sanitize({ content: 'x'.repeat(50_000) }, limitsFor(4096), stats) as { content: string }
  expect(out.content.startsWith('x'.repeat(3000))).toBe(true)
  expect(out.content).toMatch(/\.\.\.\[TRUNCATED \d+ chars\]$/)
  expect(JSON.stringify(out).length <= 4096).toBe(true)
  expect(stats.truncated).toBe(true)
})

test('escape-heavy text is cut by its serialized length and keeps the row shape', () => {
  const stats = newStats()
  const value = { tool: 'Bash', tool_origin: 'LOCAL', result: '"quoted"\n\t\u0001'.repeat(5000) }
  const out = sanitize(value, limitsFor(2048), stats) as { tool: string; tool_origin: string; result: string }
  const json = toJsonColumn(out, 2048, stats)
  expect(json.length <= 2048).toBe(true)
  const parsed = JSON.parse(json) as { tool: string; tool_origin: string; truncated?: boolean }
  expect(parsed.tool).toBe('Bash')
  expect(parsed.tool_origin).toBe('LOCAL')
  expect(parsed.truncated).toBeUndefined()
})

test('a cut never splits a surrogate pair', () => {
  const stats = newStats()
  const out = sanitize({ text: '\u{1F600}'.repeat(5000) }, limitsFor(1024), stats) as { text: string }
  const body = out.text.replace(/\.\.\.\[TRUNCATED \d+ chars\]$/, '')
  const last = body.charCodeAt(body.length - 1)
  expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
})

test('the character budget bounds the whole copy, not only each string', () => {
  const stats = newStats()
  const wide = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`field${i}`, 'y'.repeat(900)]))
  const out = sanitize(wide, limitsFor(4096), stats) as Record<string, unknown>
  expect(JSON.stringify(out).length < 6000).toBe(true)
  expect(typeof out._truncated_keys).toBe('number')
  expect(stats.truncated).toBe(true)
})

test('deep, wide and circular values stay bounded', () => {
  const stats = newStats()
  let deep: Record<string, unknown> = { leaf: true }
  for (let i = 0; i < 40; i += 1) deep = { next: deep }
  const out = JSON.stringify(sanitize(deep, limitsFor(16384), stats))
  expect(out).toMatch(/TRUNCATED: nested too deep/)
  const list = sanitize(Array.from({ length: 1000 }, (_, i) => i), limitsFor(16384), newStats()) as unknown[]
  expect(list.length).toBe(201)
  expect(list.at(-1)).toBe('[TRUNCATED 800 items]')
  const loop: Record<string, unknown> = { name: 'a' }
  loop.self = loop
  expect(sanitize(loop, limitsFor(16384), newStats())).toEqual({ name: 'a', self: '[CIRCULAR]' })
})

test('a multi-megabyte payload costs the hot path a few milliseconds', () => {
  const big = { file_path: 'dump.sql', content: 'INSERT INTO t VALUES (1, \'password=hunter2\');\n'.repeat(60_000) }
  const started = performance.now()
  const built = buildRow({
    eventType: 'TOOL_STARTING',
    timestampMs: Date.now(),
    eventId: 'e'.repeat(32),
    agent: 'coding-agent',
    sessionId: 's',
    invocationId: 'i',
    userId: 'u',
    traceId: 't'.repeat(32),
    spanId: 's'.repeat(16),
    parentSpanId: null,
    content: { tool: 'Write', args: big, tool_origin: 'LOCAL' },
    attributes: {},
    maxPayloadChars: 16384,
  })
  const elapsed = performance.now() - started
  expect(elapsed < 100).toBe(true)
  expect(built.row.is_truncated).toBe(true)
  expect((built.row.content ?? '').length <= 16384).toBe(true)
  expect(built.row.content ?? '').not.toMatch(/hunter2/)
  expect(() => JSON.parse(built.row.content ?? '')).not.toThrow()
})

test('an oversized JSON column becomes a valid object holding a prefix', () => {
  const stats = newStats()
  const text = toJsonColumn({ a: 'q"'.repeat(5000) }, 2048, stats)
  expect(text.length <= 2048).toBe(true)
  const parsed = JSON.parse(text) as { truncated: boolean; original_chars: number; preview: string }
  expect(parsed.truncated).toBe(true)
  expect(parsed.original_chars > 2048).toBe(true)
  expect(stats.truncated).toBe(true)
})

test('rows carry JSON columns as JSON text and cap the error message', () => {
  const { row } = buildRow({
    eventType: 'TOOL_COMPLETED',
    timestampMs: Date.parse('2026-10-13T23:52:17.123Z'),
    eventId: 'a'.repeat(32),
    agent: 'coding-agent',
    sessionId: 's',
    invocationId: 'i',
    userId: 'u',
    traceId: null,
    spanId: 'b'.repeat(16),
    parentSpanId: null,
    content: { tool: 'Bash', result: null, tool_origin: 'LOCAL' },
    attributes: { tool_use_id: 'toolu_1' },
    latencyMs: { total_ms: 12.6, time_to_first_token_ms: undefined },
    status: 'ERROR',
    errorMessage: 'E'.repeat(10_000),
    maxPayloadChars: 16384,
  })
  expect(row.timestamp).toBe('2026-10-13T23:52:17.123Z')
  expect(row.content).toBe('{"tool":"Bash","result":null,"tool_origin":"LOCAL"}')
  expect(row.latency_ms).toBe('{"total_ms":13}')
  expect(row.content_parts).toEqual([])
  expect((row.error_message ?? '').length < 4200).toBe(true)
  expect(row.is_truncated).toBe(true)
})

test('configuration: userConfig wins, then BQAA_* variables, then defaults', () => {
  const fromEnv = resolveConfig({}, { BQAA_PROJECT_ID: 'p1', BQ_DATASET: 'd1', HOME: '/h', USER: 'me', BQAA_TABLE: 't1' })
  expect([fromEnv.project, fromEnv.dataset, fromEnv.table, fromEnv.location, fromEnv.agentName, fromEnv.userId]).toEqual(['p1', 'd1', 't1', 'US', 'coding-agent', 'me'])
  expect(fromEnv.deadLetterDir).toBe('/h/.bqaa-mod/dead-letter')
  expect(fromEnv.dryRunDir).toBe('/h/.bqaa-mod/dry-run')
  expect(fromEnv.problems).toEqual([])
  const fromOptions = resolveConfig({ project: 'p2', dataset: 'd2', table: 'events', location: 'EU', flushIntervalMs: 50, maxPayloadChars: 9e9 }, { BQAA_PROJECT_ID: 'p1', HOME: '/h' })
  expect([fromOptions.project, fromOptions.dataset, fromOptions.table, fromOptions.location]).toEqual(['p2', 'd2', 'events', 'EU'])
  // Numbers are held to their documented bounds.
  expect(fromOptions.flushIntervalMs).toBe(1000)
  expect(fromOptions.maxPayloadChars).toBe(500_000)
  const missing = resolveConfig({}, { HOME: '/h' })
  expect(missing.problems.length).toBe(1)
  expect(resolveConfig({ dryRun: true }, { HOME: '/h' }).problems).toEqual([])
  expect(resolveConfig({}, { BQAA_TRACE_ENABLED: 'false' }).enabled).toBe(false)
  expect(resolveConfig({ enabled: false }, {}).enabled).toBe(false)
  expect(resolveConfig({}, { BQAA_DRY_RUN: 'true' }).dryRun).toBe(true)
  expect(resolveConfig({}, {}).accessTokenCommand).toEqual(['gcloud', 'auth', 'application-default', 'print-access-token'])
})

test('the token command is split into argv without a shell', () => {
  expect(splitArgv('gcloud auth print-access-token --impersonate-service-account=bqaa@p.iam.gserviceaccount.com')).toEqual([
    'gcloud',
    'auth',
    'print-access-token',
    '--impersonate-service-account=bqaa@p.iam.gserviceaccount.com',
  ])
  expect(splitArgv(`"/Applications/Google Cloud SDK/bin/gcloud" auth  print-access-token ''`)).toEqual(['/Applications/Google Cloud SDK/bin/gcloud', 'auth', 'print-access-token', ''])
})

test('insertAll answers are classified for retry, refresh, refusal or success', () => {
  expect(classifyInsert({ status: 200, text: '{}' }, 3).kind).toBe('ok')
  expect(classifyInsert({ status: 503, text: '' }, 3).kind).toBe('retry')
  expect(classifyInsert({ status: 429, text: '' }, 3).kind).toBe('retry')
  expect(classifyInsert({ status: 500, text: 'x' }, 3).kind).toBe('retry')
  expect(classifyInsert({ status: 401, text: '' }, 3).kind).toBe('auth')
  expect(classifyInsert({ status: 404, text: '' }, 3).kind).toBe('not-found')
  expect(classifyInsert({ status: 400, text: '' }, 3).kind).toBe('rejected')
  expect(classifyInsert({ status: 403, text: '{"error":{"errors":[{"reason":"accessDenied"}]}}' }, 3).kind).toBe('rejected')
  expect(classifyInsert({ status: 403, text: '{"error":{"errors":[{"reason":"quotaExceeded"}]}}' }, 3).kind).toBe('retry')
  const partial = classifyInsert(
    { status: 200, text: JSON.stringify({ insertErrors: [{ index: 0, errors: [{ reason: 'invalid', message: 'bad' }] }, { index: 2, errors: [{ reason: 'backendError' }] }] }) },
    3,
  )
  expect(partial.kind).toBe('partial')
  if (partial.kind === 'partial') {
    expect([...partial.rejected.keys()]).toEqual([0])
    expect([...partial.retry]).toEqual([2])
  }
  const body = JSON.parse(insertAllBody([{ event_id: 'e1' } as never])) as { rows: { insertId: string }[] }
  expect(body.rows[0]?.insertId).toBe('e1')
})

test('dead-letter files are JSONL, split under the 4 MiB file limit, and parsed tolerantly', () => {
  const row = { event_type: 'TOOL_STARTING', timestamp: '2026-10-13T00:00:00.000Z', content: 'z'.repeat(400_000) } as never
  const lines = Array.from({ length: 20 }, () => ({ v: 1 as const, kind: 'retry' as const, reason: 'r', attempts: 4, failed_at: 'f', table: 't', row }))
  const files = encodeLines(lines)
  expect(files.length > 1).toBe(true)
  for (const text of files) expect(text.length <= MAX_FILE_CHARS).toBe(true)
  expect(files.flatMap(f => parseFile(f).lines).length).toBe(20)
  const parsed = parseFile(`${files[0]?.split('\n')[0]}\n{broken\n\n`)
  expect(parsed.lines.length).toBe(1)
  expect(parsed.unreadable).toEqual(['{broken'])
  const name = fileName('spill', Date.parse('2026-10-13T23:52:17.123Z'), '5c4b1d2e-8f7a', 3)
  expect(name).toBe('spill-20261013T235217123Z-5c4b1d2e8f7a-3.jsonl')
  expect(FILE_PATTERN.test(name)).toBe(true)
  expect(kindOf(name)).toBe('spill')
  expect(kindOf('notes.txt')).toBe(null)
})

test('the queue drops its oldest rows past its row or byte bound', () => {
  const queue = new BoundedQueue(3, 1_000_000)
  const row = (n: number) => ({ event_id: String(n), content: null }) as never
  for (let i = 0; i < 5; i += 1) queue.push(row(i))
  expect(queue.length).toBe(3)
  expect(queue.dropped).toBe(2)
  expect(queue.take(10, 1_000_000).map(q => (q.row as { event_id: string }).event_id)).toEqual(['2', '3', '4'])
  const small = new BoundedQueue(100, 500)
  for (let i = 0; i < 10; i += 1) small.push({ event_id: String(i), content: 'x'.repeat(100) } as never)
  expect(small.bytes <= 500).toBe(true)
  expect(small.dropped > 0).toBe(true)
})

test('a huge tool input is cut inside args; tool and tool_origin survive', () => {
  const built = buildRow({
    eventType: 'TOOL_STARTING',
    timestampMs: Date.now(),
    eventId: 'e'.repeat(32),
    agent: 'coding-agent',
    sessionId: 's',
    invocationId: 'i',
    userId: 'u',
    traceId: null,
    spanId: 's'.repeat(16),
    parentSpanId: null,
    content: { tool: 'Write', tool_origin: 'LOCAL', args: { file_path: 'big.txt', content: 'z'.repeat(100_000) } },
    attributes: {},
    maxPayloadChars: 4096,
  })
  const content = JSON.parse(built.row.content ?? '{}') as { tool: string; tool_origin: string; args: { file_path: string } }
  expect(content.tool).toBe('Write')
  expect(content.tool_origin).toBe('LOCAL')
  expect(content.args.file_path).toBe('big.txt')
  expect(built.row.is_truncated).toBe(true)
})
