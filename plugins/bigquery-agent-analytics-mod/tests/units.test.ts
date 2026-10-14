// Unit tests of the mod's plain functions: redaction, truncation, row
// building, configuration, the BigQuery answer classifier and the
// dead-letter file format.

import { expect, test } from 'claude-code/testing'

import { classifyInsert, insertAllBody } from '../hooks/lib/bigquery.ts'
import { destinationDir, resolveConfig, splitArgv } from '../hooks/lib/config.ts'
import { FILE_PATTERN, MAX_FILE_BYTES, encodeLines, fileName, kindOf, parseFile } from '../hooks/lib/deadletter.ts'
import { BoundedQueue } from '../hooks/lib/queue.ts'
import { buildRow, utf8Length } from '../hooks/lib/rows.ts'
import { isSensitiveKey, limitsFor, newStats, redactDiagnostic, redactText, sanitize, sanitizeAttributes, sanitizeContent, toJsonColumn } from '../hooks/lib/sanitize.ts'

import { utf8Bytes } from './helpers.ts'

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
    [`curl -H "Authorization: Bearer ${'x'.repeat(20)}"`, /Authorization: \[REDACTED\]$/],
    [`postgres://admin:${'x'.repeat(14)}@db.internal:5432/app`, /^postgres:\/\/\[REDACTED\]@db\.internal:5432\/app$/],
    [`export DB_PASSWORD=${'x'.repeat(14)}`, /DB_PASSWORD=\[REDACTED\]/],
    [`{"client_secret": "${'x'.repeat(12)}"}`, /^\{"client_secret": \[REDACTED\]$/],
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
    'https://example.test/search?q=tokens&page=2',
  ]
  for (const input of keep) expect(redact(input)).toEqual({ out: input, count: 0 })
})

test('credential keys are redacted in structured payloads, whole, whatever the value', () => {
  const stats = newStats()
  const out = sanitize(
    {
      api_key: 'abc',
      headers: { Authorization: 'Bearer x', 'X-Api-Key': 'k' },
      token: 'zzz',
      password: null,
      'temp:scratch': 'x',
      pwd: 1234,
      secret: true,
      credentials: ['[REDACTED]', 'opaque'],
      session: { id: 'abc', user: 'u' },
      max_tokens: 5,
    },
    limitsFor(16384),
    stats,
  )
  expect(out).toEqual({
    api_key: '[REDACTED]',
    headers: { Authorization: '[REDACTED]', 'X-Api-Key': '[REDACTED]' },
    token: '[REDACTED]',
    // Nothing to hide in null.
    password: null,
    'temp:scratch': '[REDACTED]',
    pwd: '[REDACTED]',
    secret: '[REDACTED]',
    credentials: '[REDACTED]',
    session: '[REDACTED]',
    max_tokens: 5,
  })
  expect(stats.redactions).toBe(9)
  // Redaction alone is not truncation (as in the BQAA plugin).
  expect(stats.truncated).toBe(false)
})

test('credential names: components, endings and stems', () => {
  for (const name of ['pass', 'PASS', 'MY_PWD', 'db_pwd', 'rootpwd', 'password', 'dbPassword', 'passwordHash', 'passwd', 'passphrase', 'secret', 'clientSecret', 'token', 'accessToken', 'X-Amz-Security-Token', 'accesstoken', 'auth', 'Authorization', 'Proxy-Authorization', 'cookie', 'Set-Cookie', 'cookies', 'sessionCookie', 'session', 'session_id', 'key', 'api_key', 'X-Api-Key', 'APIKey', 'apikey', 'privatekey', 'credential', 'credentials', 'private', 'private_key', 'bearer', 'jwt', 'sig', 'signature', 'temp:scratch']) {
    expect([name, isSensitiveKey(name)]).toEqual([name, true])
  }
  for (const name of ['max_tokens', 'inputTokens', 'prompt_tokens', 'tokenizer', 'author', 'oauth_client_id', 'monkey', 'keyboard', 'signal', 'file_path', 'command', 'description', 'content', 'role', 'url', 'page']) {
    expect([name, isSensitiveKey(name)]).toEqual([name, false])
  }
})

test('credential keys match by stem: prefixed names, signatures and signed-link parameters', () => {
  const stats = newStats()
  const signed = `https://storage.example.test/b/o?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=${'c'.repeat(24)}&X-Goog-Expires=900&X-Goog-Signature=${'d'.repeat(64)}`
  const shared = `https://acct.blob.example.test/c/b?sv=2024-01-01&sp=r&sig=${'s'.repeat(24)}`
  const presigned = `https://bucket.s3.example.test/k?X-Amz-Credential=${'c'.repeat(20)}&X-Amz-Security-Token=${'t'.repeat(40)}&X-Amz-Signature=${'f'.repeat(64)}`
  const out = sanitize(
    {
      signature: 's'.repeat(20),
      my_api_key: 'x'.repeat(16),
      openaiApiKey: 'x'.repeat(12),
      x_amz_security_token: 'x'.repeat(12),
      sessionCookie: 'x'.repeat(12),
      db_passphrase: 'x'.repeat(12),
      links: [signed, shared, presigned],
      max_tokens: 5,
      usage: { prompt_tokens: 9, total_tokens: 12 },
      tokenizer: 'whitespace',
      author: 'dev',
      session_id: 'abc',
    },
    limitsFor(16384),
    stats,
  ) as Record<string, unknown>
  for (const key of ['signature', 'my_api_key', 'openaiApiKey', 'x_amz_security_token', 'sessionCookie', 'db_passphrase']) expect(out[key]).toBe('[REDACTED]')
  expect(out.links).toEqual([
    'https://storage.example.test/b/o?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=[REDACTED]&X-Goog-Expires=900&X-Goog-Signature=[REDACTED]',
    'https://acct.blob.example.test/c/b?sv=2024-01-01&sp=r&sig=[REDACTED]',
    'https://bucket.s3.example.test/k?X-Amz-Credential=[REDACTED]&X-Amz-Security-Token=[REDACTED]&X-Amz-Signature=[REDACTED]',
  ])
  // Token counts and ordinary names are left alone; a session id is not.
  expect(out.max_tokens).toBe(5)
  expect(out.usage).toEqual({ prompt_tokens: 9, total_tokens: 12 })
  expect([out.tokenizer, out.author, out.session_id]).toEqual(['whitespace', 'dev', '[REDACTED]'])
  expect(stats.redactions).toBe(13)
})

test('diagnostics are redacted before they are cut, so a cut never leaves part of a credential', () => {
  // The token starts four characters before the cut: cut first and redacted
  // second, its first characters would be too short to match, and would show.
  const token = ['ya29', 'x'.repeat(40)].join('.')
  const out = redactDiagnostic(`${'e'.repeat(295)} ${token} and more`, 300)
  expect(out.length <= 300).toBe(true)
  expect(out.includes('ya29')).toBe(false)
  expect(redactDiagnostic(`password=${'p'.repeat(30)}`, 1000)).toBe('password=[REDACTED]')
  // Redacting twice changes nothing.
  expect(redactDiagnostic(redactDiagnostic(`key ${token} password=${'p'.repeat(30)}`, 1000), 1000)).toBe('key [REDACTED:google-oauth-token] password=[REDACTED]')
})

test('UTF-8 length matches the standard encoder', () => {
  for (const text of ['', 'abc', '\u00e9', '\u754c', '\u{1F600}', 'a\u754cb\u{1F600}c', '\uD800', 'x\uDC00y', '\u754c'.repeat(1000)]) {
    expect(utf8Length(text)).toBe(utf8Bytes(text))
  }
})

test('each table gets its own dead-letter subdirectory, with a safe and distinct name', () => {
  expect(destinationDir('my-gcp-project.agent_analytics.agent_events')).toBe('my-gcp-project.agent_analytics.agent_events')
  expect(destinationDir('example.com:proj.ds.t')).toBe('example.com%3Aproj.ds.t')
  const tables = ['p.d.a/b', 'p.d.a%2Fb', 'p.d.t*', 'p.d.t!', 'p.d.t \u754c']
  const dirs = tables.map(destinationDir)
  for (const dir of dirs) expect(/^[A-Za-z0-9._%-]+$/.test(dir)).toBe(true)
  expect(new Set(dirs).size).toBe(tables.length)
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

test('a 2xx answer acknowledges rows only when it is a valid insertAll response', () => {
  const unknown = (text: string) => classifyInsert({ status: 200, text }, 3).kind
  // A body cut off mid-way, the wrong JSON shape, or entries that do not
  // name a row of this batch: the outcome is not known, so the rows are kept.
  for (const text of [
    '{"insertErrors":[{"index":0,"errors":[{"reason":"invalid"',
    '',
    '[]',
    'null',
    '<html>OK</html>',
    '{"insertErrors":{"index":0}}',
    '{"insertErrors":[{"errors":[{"reason":"invalid"}]}]}',
    '{"insertErrors":[{"index":7,"errors":[{"reason":"invalid"}]}]}',
    '{"insertErrors":[{"index":0.5,"errors":[]}]}',
    '{"insertErrors":[{"index":0,"errors":"invalid"}]}',
    '{"insertErrors":[{"index":0,"errors":[null]}]}',
    '{"error":{"code":500,"message":"backend"}}',
  ]) {
    expect(unknown(text)).toBe('retry')
  }
  expect(unknown('{"kind":"bigquery#tableDataInsertAllResponse"}')).toBe('ok')
  expect(unknown('{"insertErrors":[]}')).toBe('ok')
  expect(unknown('{"insertErrors":[{"index":1,"errors":[{"reason":"invalid","message":"bad"}]}]}')).toBe('partial')
})

test('error text is redacted before the answer classifier cuts it', () => {
  const token = ['gh', 'p_', 'x'.repeat(36)].join('')
  const fragment = token.slice(0, 8)
  // The message cap is 1,000 characters, the non-JSON fallback 300: each
  // token below runs past its cap.
  const capped = classifyInsert({ status: 403, text: JSON.stringify({ error: { message: `${'e'.repeat(950)} ${token}` } }) }, 1)
  const page = classifyInsert({ status: 400, text: `<html>${'p'.repeat(280)} ${token}</html>` }, 1)
  const partial = classifyInsert({ status: 200, text: JSON.stringify({ insertErrors: [{ index: 0, errors: [{ reason: 'invalid', message: `${'e'.repeat(970)} ${token}` }] }] }) }, 1)
  expect(capped.kind === 'rejected' && !capped.message.includes(fragment) && capped.message.length <= 1000).toBe(true)
  expect(page.kind === 'rejected' && !page.message.includes(fragment)).toBe(true)
  expect(partial.kind === 'partial' && !(partial.rejected.get(0) ?? fragment).includes(fragment)).toBe(true)
})

test('a credential-named line loses everything after its separator, markers and quotes included', () => {
  const long = `${'x'.repeat(5000)}tail-secret`
  const cases: [string, string][] = [
    ['Cookie: session=abc123; csrf=[REDACTED]', 'Cookie: [REDACTED]'],
    ['Authorization: Token abc123def\nAccept: json', 'Authorization: [REDACTED]\nAccept: json'],
    ['db:\n  password: alpha beta gamma\n  host: db.internal', 'db:\n  password: [REDACTED]\n  host: db.internal'],
    ['export MY_PWD=abc def\nPASS=xyz\nmode=fast', 'export MY_PWD=[REDACTED]\nPASS=[REDACTED]\nmode=fast'],
    ['password: 987654321', 'password: [REDACTED]'],
    [`password: ${long}`, 'password: [REDACTED]'],
    // JSON that is only part of the text, escaped or not: the rest of its line goes.
    ['config {"user": "u", "password": "p", "next": 1}', 'config {"user": "u", "password": [REDACTED]'],
    ['log {\\"password\\": \\"p\\", \\"user\\": \\"u\\"}', 'log {\\"password\\": [REDACTED]'],
    // Code keeps the lines that do not name a credential.
    ['function f(token: string) {\n  return token\n}', 'function f(token: [REDACTED]\n  return token\n}'],
  ]
  for (const [input, output] of cases) expect(redact(input).out).toBe(output)
  for (const input of ['max_tokens: 1024', 'https://example.test/search?q=tokens&page=2', 'session 5c4b1d2e']) expect(redact(input)).toEqual({ out: input, count: 0 })
})

test('URLs: user-info, credential-named parameters and webhook URLs', () => {
  const secret = 's'.repeat(24)
  const slack = `https://${['hooks', 'slack', 'com'].join('.')}/${['services', 'T0', 'B0', secret].join('/')}`
  const discord = `https://${['discord', 'com'].join('.')}/api/${['webhooks', '42', secret].join('/')}`
  const office = `https://contoso.${['webhook', 'office', 'com'].join('.')}/webhookb2/${secret}`
  const cases: [string, string][] = [
    [`go to https://${['bob', secret].join(':')}@db.example.test/x`, 'go to https://[REDACTED]@db.example.test/x'],
    [`https://h.example.test/cb?code=1&access_token=${secret}&page=2#id_token=${secret}`, 'https://h.example.test/cb?code=1&access_token=[REDACTED]&page=2#id_token=[REDACTED]'],
    [`https://h.example.test/x?sig=${secret}&session=${secret}&key=${secret}`, 'https://h.example.test/x?sig=[REDACTED]&session=[REDACTED]&key=[REDACTED]'],
    [`post to ${slack}, ${discord} and ${office}.`, 'post to [REDACTED:webhook-url], [REDACTED:webhook-url] and [REDACTED:webhook-url].'],
  ]
  for (const [input, output] of cases) {
    expect(redact(input).out).toBe(output)
    expect(redact(input).out.includes(secret)).toBe(false)
  }
})

test('JSON inside strings is parsed and redacted by structure, however deeply it is encoded', () => {
  const secret = 'z'.repeat(20)
  const once = JSON.stringify({ user: 'u', password: secret })
  const twice = JSON.stringify({ text: once })
  const thrice = JSON.stringify(JSON.stringify({ wrapper: twice }))
  const stats = newStats()
  const out = sanitize({ a: once, b: twice, c: thrice, d: JSON.stringify([{ pwd: 1 }, 'x']) }, limitsFor(16384), stats) as Record<string, string>
  expect(out.a).toBe('{"user":"u","password":"[REDACTED]"}')
  expect(out.b).toBe(JSON.stringify({ text: '{"user":"u","password":"[REDACTED]"}' }))
  expect(JSON.stringify(out).includes(secret)).toBe(false)
  expect(out.d).toBe('[{"pwd":"[REDACTED]"},"x"]')
  expect(stats.truncated).toBe(false)
  // Shaped like JSON but not parsed whole (not valid, or past the budget):
  // dropped and marked, never scrubbed line by line. Text that only starts
  // with a bracket or a quote is not JSON-shaped and gets the text rules.
  const shapedStats = newStats()
  const shaped = sanitize({ invalid: '{not json: password}', long: JSON.stringify({ password: secret, pad: 'p'.repeat(30_000) }, null, 2), lines: '[\n  1,\n  {"note": "cut short"', list: '[1] first, [2] second', quoted: '"Hi," she said.' }, limitsFor(16384), shapedStats) as Record<string, string>
  expect(shaped.invalid).toBe('[TRUNCATED: 20 chars of JSON text that could not be parsed and checked]')
  expect(shaped.long).toMatch(/^\[TRUNCATED: \d+ chars of JSON text that could not be parsed and checked\]$/)
  expect(shaped.lines).toBe('[TRUNCATED: 29 chars of JSON text that could not be parsed and checked]')
  expect([shaped.list, shaped.quoted]).toEqual(['[1] first, [2] second', '"Hi," she said.'])
  expect(shapedStats.truncated).toBe(true)
  // Deeper than the walk goes: dropped and marked, never passed on unscanned.
  let deep = JSON.stringify({ password: secret })
  for (let i = 0; i < 8; i += 1) deep = JSON.stringify({ layer: deep })
  const deepStats = newStats()
  const deepOut = sanitize({ deep }, limitsFor(16384), deepStats)
  expect(JSON.stringify(deepOut).includes(secret)).toBe(false)
  expect(deepStats.truncated).toBe(true)
})

test('text past the scanned window is dropped and marked, never passed on unscanned', () => {
  const secret = 'w'.repeat(24)
  const stats = newStats()
  // A credential far past the payload budget, with nothing before it to name it.
  const out = sanitize({ result: `${'a'.repeat(40_000)} ${secret}`, note: `password: ${'b'.repeat(20_000)}${secret}` }, limitsFor(16384), stats)
  expect(JSON.stringify(out).includes(secret)).toBe(false)
  expect(stats.truncated).toBe(true)
})

test('a row\'s own fields are not name-checked; everything observed under them is', () => {
  const stats = newStats()
  const content = sanitizeContent({ session_end: true, args: { session_end: true, cmd: 'ls' } }, limitsFor(16384), stats)
  expect(content).toEqual({ session_end: true, args: { session_end: '[REDACTED]', cmd: 'ls' } })
  const attributes = sanitizeAttributes({ session_metadata: { cwd: `/home/dev/src/x?token=${'t'.repeat(12)}`, host_version: '2.1.296' }, usage_metadata: { prompt_tokens: 3 } }, limitsFor(16384), stats)
  // Attribute keys are the mod's own; their text still goes through the text rules.
  expect(attributes).toEqual({ session_metadata: { cwd: '/home/dev/src/x?token=[REDACTED]', host_version: '2.1.296' }, usage_metadata: { prompt_tokens: 3 } })
})

test('dead-letter files are JSONL, split by UTF-8 bytes under the file limit, and parsed tolerantly', () => {
  const line = (content: string) => ({
    v: 1 as const,
    kind: 'retry' as const,
    reason: 'r',
    attempts: 4,
    failed_at: 'f',
    table: 't',
    row: { event_type: 'TOOL_STARTING', timestamp: '2026-10-13T00:00:00.000Z', content, is_truncated: false } as never,
  })
  // 400,000 three-byte characters a line: 1.2 MB of UTF-8 in 400,000 characters.
  const files = encodeLines(Array.from({ length: 20 }, () => line('\u754c'.repeat(400_000))))
  expect(files.length >= 8).toBe(true)
  for (const text of files) expect(utf8Bytes(text) <= MAX_FILE_BYTES).toBe(true)
  expect(files.flatMap(f => parseFile(f).lines).length).toBe(20)
  // A row too large for a file on its own has its payload cut to fit and is
  // marked truncated, rather than failing the write.
  const [alone] = encodeLines([line('\u754c'.repeat(1_200_000))])
  expect(utf8Bytes(alone ?? '') <= MAX_FILE_BYTES).toBe(true)
  expect((parseFile(alone ?? '').lines[0]?.row as { is_truncated: boolean } | undefined)?.is_truncated).toBe(true)
  // Lines come back with their text as written, so a line can be kept as is.
  const first = files[0]?.split('\n')[0] ?? ''
  const parsed = parseFile(`${first}\n{broken\n\n`)
  expect(parsed.lines.length).toBe(1)
  expect(parsed.raw).toEqual([first])
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
