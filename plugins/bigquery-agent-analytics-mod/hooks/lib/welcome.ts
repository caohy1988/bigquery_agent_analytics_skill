// The card the band above the prompt shows in the first session after the
// mod is installed, or updated to a new version: that the mod is on, what it
// records and where to, and once rows land, that they did. Nothing else on
// screen says so while rows are written without trouble. Pure, like
// status.ts: register.ts keeps the record in `$.store` and draws the card.

import { type Config, PLUGIN_VERSION, canDeliver, tableRef } from './config.ts'

// The `$.store` key the record below is kept under.
export const WELCOME_KEY = 'welcome'

// The version greeted, the version greeted before it (null on a fresh
// install), the session that showed the card, when rows first landed while
// it showed, and whether it was closed. A reload in that session
// (/reload-plugins, an option changed in /config) shows the card again as it
// was; no later session shows it.
export type Welcome = {
  version: string
  previous: string | null
  sessionId: string | null
  landedAt: number | null
  closed: boolean
}

export type Tone = 'success' | 'suggestion' | 'warning' | 'inactive'

// What the card says: the title line, after it the version dim, and the
// lines under it.
export type WelcomeCard = {
  tone: Tone
  glyph: string
  title: string
  tag: string
  lines: { text: string; tone?: Tone; dim?: boolean }[]
}

const WHAT = 'sessions, turns, model requests and tool calls'
const NOT_SET_UP = 'the project and dataset options are set in /config, or BQAA_PROJECT_ID and BQAA_DATASET'

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

// At session start, from what the store holds: a new card for a version not
// greeted yet, the same card after a reload in the session that showed it
// (unless it was closed), else none.
export function openWelcome(stored: unknown, sessionId: string | null): { welcome: Welcome; isNew: boolean } | null {
  const seen = isObject(stored) ? stored : {}
  const version = typeof seen.version === 'string' ? seen.version : null
  if (version !== PLUGIN_VERSION) {
    return { welcome: { version: PLUGIN_VERSION, previous: version, sessionId, landedAt: null, closed: false }, isNew: true }
  }
  if (sessionId === null || seen.sessionId !== sessionId || seen.closed !== false) return null
  const previous = typeof seen.previous === 'string' ? seen.previous : null
  const landedAt = typeof seen.landedAt === 'number' ? seen.landedAt : null
  return { welcome: { version, previous, sessionId, landedAt, closed: false }, isNew: false }
}

const arrival = (w: Welcome): string => (w.previous === null ? 'installed' : `updated to ${w.version}`)

// Why nothing is recorded, when the configuration leaves nowhere to write.
const unset = (c: Config): string => (c.dryRun ? (c.problems[0] ?? 'the dry run has nowhere to write') : `nothing is recorded until ${NOT_SET_UP}`)

// The card for this configuration, with `sent` rows landed so far (none
// after a reload, which starts the counts over).
export function welcomeCard(w: Welcome, c: Config, sent: number): WelcomeCard {
  const title = `BigQuery Agent Analytics mod ${arrival(w)}`
  const tag = w.previous === null ? w.version : `was ${w.previous}`
  if (!c.enabled) {
    return { tone: 'inactive', glyph: '○', title: `${title}, capture off`, tag, lines: [{ text: 'Nothing is recorded: the enabled option is off, or BQAA_TRACE_ENABLED=false. Turn it on in /config.' }] }
  }
  if (!canDeliver(c)) {
    const lines = c.dryRun ? [{ text: `Nothing is recorded: ${unset(c)}.` }] : [{ text: `Nothing is recorded until ${NOT_SET_UP}.` }, { text: "Then make the dataset with the mod's setup.sh; its README shows how.", dim: true }]
    return { tone: 'warning', glyph: '◇', title: `${title}, not set up yet`, tag, lines }
  }
  const landed = w.landedAt !== null
  const every = `every ${Math.round(c.flushIntervalMs / 1000)} s`
  const status = '/bqaa-status shows the counts'
  if (c.dryRun) {
    return {
      tone: landed ? 'success' : 'suggestion',
      glyph: '✓',
      title: `${title}, dry run`,
      tag,
      lines: [
        { text: `Writes ${WHAT} as JSONL files to ${c.dryRunDir}, not to BigQuery.` },
        landed ? { text: `✓ First rows written${sent > 0 ? ` · ${sent} so far` : ''} · ${status}`, tone: 'success' } : { text: `◌ Waiting for the first rows, written ${every} while you work · ${status}`, dim: true },
      ],
    }
  }
  return {
    tone: landed ? 'success' : 'suggestion',
    glyph: '✓',
    title,
    tag,
    lines: [
      { text: `Records ${WHAT} to ${tableRef(c)} (${c.location}).` },
      landed ? { text: `✓ First rows landed in BigQuery${sent > 0 ? ` · ${sent} sent` : ''} · ${status}`, tone: 'success' } : { text: `◌ Waiting for the first rows, sent ${every} while you work · ${status}`, dim: true },
    ],
  }
}

// The transcript line (dim, never sent to the model) when the card first
// shows: what it says, kept in the scrollback.
export function welcomeNotice(w: Welcome, c: Config): string {
  const mod = `bqaa: BigQuery Agent Analytics mod ${w.previous === null ? `installed (${w.version})` : `updated to ${w.version} (from ${w.previous})`}`
  if (!c.enabled) return `${mod}; capture is off (the enabled option, or BQAA_TRACE_ENABLED=false).`
  if (!canDeliver(c)) return `${mod}, not set up yet: ${unset(c)}.`
  if (c.dryRun) return `${mod}, dry run: writes ${WHAT} as JSONL files to ${c.dryRunDir}, not to BigQuery.`
  return `${mod}: records ${WHAT} to ${tableRef(c)} (${c.location}); /bqaa-status shows what was sent.`
}

// The toast when the first rows land while the card shows: the band may be
// collapsed.
export const landedToast = (c: Config): string => (c.dryRun ? `BQAA: first rows written to ${c.dryRunDir}` : `BQAA: first rows landed in ${tableRef(c)}`)
