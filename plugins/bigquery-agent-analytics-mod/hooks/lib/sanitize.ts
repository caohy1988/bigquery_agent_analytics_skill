// Bounded copies of event payloads: secrets redacted, long text cut, deep or
// wide structures trimmed. Runs on the hot path, so its work is bounded by
// the character budget rather than by the size of what the host CLI passed in
// (a Write of a 2 MB file costs the same as one of 20 KB).

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type SanitizeStats = {
  // Something was cut (BQAA `is_truncated`).
  truncated: boolean
  // How many secrets were replaced; redaction alone does not set `truncated`,
  // as in the BQAA plugin.
  redactions: number
}

export type Limits = {
  // Characters of serialized JSON (quotes, escapes, keys and punctuation
  // counted) the whole copy may take.
  budgetChars: number
  maxStringChars: number
  maxDepth: number
  maxKeys: number
  maxItems: number
}

export const newStats = (): SanitizeStats => ({ truncated: false, redactions: 0 })

// Room left under a column's cap for the truncation markers the walk adds
// (at most one per nesting level once the budget is spent), so a cut copy
// still serializes within `maxPayloadChars` and keeps its shape.
const MARKER_HEADROOM = 512

export const limitsFor = (maxPayloadChars: number): Limits => {
  const budget = Math.max(256, maxPayloadChars - MARKER_HEADROOM)
  return { budgetChars: budget, maxStringChars: budget, maxDepth: 12, maxKeys: 200, maxItems: 200 }
}

// A key names a credential when, with case and punctuation removed, it
// contains one of these stems (`api_key`, `X-Api-Key`, `openaiApiKey` and
// `my_api_key` all contain `apikey`), ends in `token` (`access_token`,
// `X-Amz-Security-Token`; `max_tokens` does not, and its values are counts
// anyway), is one of the short names below (too common inside other words to
// match as stems), or has ADK's `temp:` prefix.
const SENSITIVE_STEMS = ['password', 'passwd', 'passphrase', 'secret', 'apikey', 'accesskey', 'privatekey', 'signingkey', 'authorization', 'credential', 'signature', 'cookie']
const SENSITIVE_NAMES = new Set(['auth', 'sig', 'jwt', 'bearer'])

export const isSensitiveKey = (key: string): boolean => {
  if (key.toLowerCase().startsWith('temp:')) return true
  const name = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return SENSITIVE_NAMES.has(name) || name.endsWith('token') || SENSITIVE_STEMS.some(stem => name.includes(stem))
}

// Well-known credential shapes in free text. Every pattern is linear: no
// unbounded quantifier sits next to another that can match the same text.
const PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g, '[REDACTED:private-key]'],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, '[REDACTED:api-key]'],
  [/\bsk-(?=[A-Za-z0-9_-]{0,200}\d)[A-Za-z0-9_-]{32,}/g, '[REDACTED:api-key]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED:aws-access-key-id]'],
  [/\bAIza[0-9A-Za-z_-]{35}/g, '[REDACTED:google-api-key]'],
  [/\bya29\.[0-9A-Za-z._-]{20,}/g, '[REDACTED:google-oauth-token]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g, '[REDACTED:github-token]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, '[REDACTED:gitlab-token]'],
  [/\bnpm_[A-Za-z0-9]{36,}/g, '[REDACTED:npm-token]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack-token]'],
  [/\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g, '[REDACTED:stripe-key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED:jwt]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [REDACTED]'],
  // user:password@ inside a URL
  [/(\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s:@/]{1,100}:)[^\s@/]{1,200}@/gi, '$1[REDACTED]@'],
  // Signed-link and token query parameters (`?X-Goog-Signature=…`,
  // `&X-Amz-Security-Token=…`, `&sig=…`, `?access_token=…`): the value goes,
  // the name stays.
  [
    /([?&](?:[A-Za-z0-9_.-]{0,40}?(?:signature|credential|token|secret|password|passwd|api[_-]?key)|sig|key)=)(?!\[REDACTED)(?![0-9]+(?:[&#\s"']|$))[^&#\s"'<>]{3,}/gi,
    '$1[REDACTED]',
  ],
]

// `key: value`, `key=value`, `"key": "value"` in text: key and separator
// only. Whether the key names a credential is isSensitiveKey's call, the same
// as for structured keys, and the value's extent is found by `valueEnd`.
const ASSIGNMENT = /(["']?)([A-Za-z][A-Za-z0-9_.-]{0,63})\1[ \t]{0,5}([:=])[ \t]{0,5}/g
// Unquoted values that stay: counts, booleans and null (`max_tokens: 1024`).
const KEPT_VALUE = /^(?:-?[0-9][0-9.]*|true|false|null)$/
const VALUE_CHARS = 4096

// Where the value starting at `start` ends. A quoted value runs to its closing
// quote, an object or list to its closing bracket; an unquoted value after
// `=` is one word, after `:` the rest of the line up to a separator that ends
// an inline value (all of it for a cookie header).
function valueEnd(text: string, start: number, separator: string, key: string): number {
  const limit = Math.min(text.length, start + VALUE_CHARS)
  const first = text[start]
  if (first === '"' || first === "'") {
    for (let i = start + 1; i < limit; i += 1) {
      const ch = text[i]
      if (ch === '\\') i += 1
      else if (ch === first) return i + 1
      else if (ch === '\n' || ch === '\r') return i
    }
    return limit
  }
  if (first === '{' || first === '[') {
    let depth = 0
    let quote: string | null = null
    for (let i = start; i < limit; i += 1) {
      const ch = text[i]
      if (quote !== null) {
        if (ch === '\\') i += 1
        else if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '{' || ch === '[') depth += 1
      else if (ch === '}' || ch === ']') {
        depth -= 1
        if (depth === 0) return i + 1
      }
    }
    return limit
  }
  const stop = separator === '=' ? /[\s"',;&]/ : /cookie/i.test(key) ? /[\r\n]/ : /[\r\n"',;})\]]/
  for (let i = start; i < limit; i += 1) if (stop.test(text[i] as string)) return i
  return limit
}

function redactAssignments(text: string, stats: SanitizeStats): string {
  ASSIGNMENT.lastIndex = 0
  let out = ''
  let copied = 0
  for (let m = ASSIGNMENT.exec(text); m !== null; m = ASSIGNMENT.exec(text)) {
    if (!isSensitiveKey(m[2] as string)) continue
    const start = m.index + m[0].length
    const end = valueEnd(text, start, m[3] as string, m[2] as string)
    const value = text.slice(start, end)
    const first = value[0] ?? ''
    const quoted = first === '"' || first === "'"
    const nested = first === '{' || first === '['
    if (value.trim() === '' || value.includes('[REDACTED') || (!quoted && !nested && KEPT_VALUE.test(value.trim()))) continue
    const closed = quoted && value.length > 1 && value.endsWith(first)
    const replacement = quoted ? `${first}[REDACTED]${closed ? first : ''}` : nested ? '"[REDACTED]"' : '[REDACTED]'
    out += text.slice(copied, start) + replacement
    copied = end
    ASSIGNMENT.lastIndex = end
    stats.redactions += 1
  }
  return copied === 0 ? text : out + text.slice(copied)
}

export function redactText(input: string, stats: SanitizeStats): string {
  let out = input
  for (const [pattern, replacement] of PATTERNS) {
    pattern.lastIndex = 0
    if (!pattern.test(out)) continue
    pattern.lastIndex = 0
    out = out.replace(pattern, (...args: unknown[]) => {
      stats.redactions += 1
      const groups = args.slice(1, -2) as (string | undefined)[]
      return replacement.replace(/\$(\d)/g, (_, n: string) => groups[Number(n) - 1] ?? '')
    })
  }
  return redactAssignments(out, stats)
}

// Error text, dead-letter reasons and status lines: redacted first, then held
// to `maxChars`, so a cut can never leave the start of a credential that, cut
// short, no longer matches its pattern.
export function redactDiagnostic(text: string, maxChars: number): string {
  const window = text.length > maxChars + 4096 ? text.slice(0, maxChars + 4096) : text
  return cutAt(redactText(window, newStats()), maxChars)
}

type WalkState = { remaining: number; seen: WeakSet<object> }

// Length of the marker a cut string ends with.
const MARKER_RESERVE = 40

const jsonLength = (text: string): number => JSON.stringify(text).length

// Never end a cut between the two halves of a surrogate pair.
export const cutAt = (text: string, end: number): string => {
  let cut = text.slice(0, Math.max(0, end))
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return cut
}

// `input` redacted and, past `maxJson` characters of serialized JSON, cut
// and marked. Returns the text and what it costs serialized. Redacts a
// little past the cut, so a secret straddling it is not left half visible.
function clipString(input: string, maxJson: number, stats: SanitizeStats): { text: string; cost: number } {
  const window = input.length > maxJson + 256 ? input.slice(0, maxJson + 256) : input
  const redacted = redactText(window, stats)
  if (window.length === input.length) {
    const cost = jsonLength(redacted)
    if (cost <= maxJson) return { text: redacted, cost }
  }
  stats.truncated = true
  const room = Math.max(0, maxJson - MARKER_RESERVE)
  let keep = Math.min(redacted.length, room)
  let cut = cutAt(redacted, keep)
  let cost = jsonLength(cut)
  // Escapes (quotes, newlines, control characters) make JSON longer than
  // the text: shrink until the serialized form fits.
  for (let i = 0; i < 8 && cost > room && keep > 0; i += 1) {
    keep = Math.max(0, Math.floor((keep * room) / cost) - 1)
    cut = cutAt(redacted, keep)
    cost = jsonLength(cut)
  }
  const text = `${cut}...[TRUNCATED ${input.length - cut.length} chars]`
  return { text, cost: jsonLength(text) }
}

function walk(value: unknown, depth: number, limits: Limits, stats: SanitizeStats, state: WalkState): JsonValue | undefined {
  if (value === null) {
    state.remaining -= 4
    return null
  }
  switch (typeof value) {
    case 'string': {
      const allowed = Math.max(0, Math.min(limits.maxStringChars, state.remaining))
      const { text, cost } = clipString(value, allowed, stats)
      state.remaining -= cost
      return text
    }
    case 'number': {
      const out = Number.isFinite(value) ? value : null
      state.remaining -= String(out).length
      return out
    }
    case 'boolean':
      state.remaining -= 5
      return value
    case 'bigint': {
      const out = value.toString()
      state.remaining -= out.length + 2
      return out
    }
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined
  }
  const obj = value as object
  if (state.seen.has(obj)) return '[CIRCULAR]'
  if (depth >= limits.maxDepth) {
    stats.truncated = true
    return '[TRUNCATED: nested too deep]'
  }
  if (ArrayBuffer.isView(obj)) return `[binary ${obj.byteLength} bytes]`
  if (obj instanceof ArrayBuffer) return `[binary ${obj.byteLength} bytes]`
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString()
  state.seen.add(obj)
  state.remaining -= 2
  try {
    if (Array.isArray(obj)) {
      const out: JsonValue[] = []
      for (let i = 0; i < obj.length; i += 1) {
        if (i >= limits.maxItems || state.remaining <= 0) {
          stats.truncated = true
          out.push(`[TRUNCATED ${obj.length - i} items]`)
          break
        }
        state.remaining -= 1
        const item = walk(obj[i], depth + 1, limits, stats, state)
        out.push(item === undefined ? null : item)
      }
      return out
    }
    const out: { [key: string]: JsonValue } = {}
    const keys = Object.keys(obj)
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i] as string
      if (i >= limits.maxKeys || state.remaining <= 0) {
        stats.truncated = true
        out['_truncated_keys'] = keys.length - i
        break
      }
      const raw = (obj as Record<string, unknown>)[key]
      if (raw === undefined || typeof raw === 'function' || typeof raw === 'symbol') continue
      state.remaining -= jsonLength(key) + 2
      if (isSensitiveKey(key) && raw !== null && typeof raw !== 'number' && typeof raw !== 'boolean') {
        stats.redactions += 1
        state.remaining -= 12
        out[key] = '[REDACTED]'
        continue
      }
      const item = walk(raw, depth + 1, limits, stats, state)
      if (item !== undefined) out[key] = item
    }
    return out
  } finally {
    state.seen.delete(obj)
  }
}

// A JSON-safe, bounded, redacted copy of `value`.
export function sanitize(value: unknown, limits: Limits, stats: SanitizeStats): JsonValue {
  const out = walk(value, 0, limits, stats, { remaining: limits.budgetChars, seen: new WeakSet() })
  return out === undefined ? null : out
}

// Serializes a sanitized value as the text of a BigQuery JSON column, held to
// `maxChars`. Past it the column becomes a valid JSON object holding a prefix
// of the serialized text, and `truncated` is set.
export function toJsonColumn(value: JsonValue, maxChars: number, stats: SanitizeStats): string {
  const json = JSON.stringify(value)
  if (json.length <= maxChars) return json
  stats.truncated = true
  let keep = Math.max(0, Math.floor((maxChars - 120) / 2))
  for (;;) {
    const wrapped = JSON.stringify({ truncated: true, original_chars: json.length, preview: json.slice(0, keep) })
    if (wrapped.length <= maxChars || keep === 0) return wrapped
    keep = Math.floor(keep / 2)
  }
}
