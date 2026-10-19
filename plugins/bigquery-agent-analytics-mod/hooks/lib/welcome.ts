// The card the band above the prompt shows in the first session after the
// mod is installed, or updated to a new version: that the mod is on, what it
// records and where to, and once rows land, that they did. Nothing else on
// screen says so while rows are written without trouble. No `$` here, like
// status.ts: register.ts reads the records from `$.store`, hands
// CardRecords its writes, and draws the card.

import { type Config, PLUGIN_VERSION, canDeliver, tableRef } from './config.ts'

// The `$.store` key of the greeting record (`Greeting`).
export const WELCOME_KEY = 'welcome'

// The `$.store` key of one card's own record (`CardState`), which that card
// alone writes: what one session writes never lands on another's record.
export const cardKey = (version: string, sessionId: string): string => `${WELCOME_KEY}:${version}:${sessionId}`

// The version greeted, the version greeted before it (null on a fresh
// install), and the session that showed the card. That session writes it
// once, when the card first shows, and no later session shows the card.
export type Greeting = { version: string; previous: string | null; sessionId: string | null }

// What became of a card: when rows first landed while it showed and where
// they went (`destinationKey`), and whether it was closed. A reload in its
// session (/reload-plugins, an option changed in /config) shows the card
// again as it was, waiting again if rows now go elsewhere, unless it was
// closed.
export type CardState = { landedAt: number | null; landedTo: string | null; closed: boolean }

export type Welcome = Greeting & CardState

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

// Where rows go under this configuration: the dry-run directory, or the
// table and its location; null while nothing is recorded (capture off, or
// not set up). Rows that landed somewhere else (in a dry run before a
// reload, in another table) say nothing about it.
export const destinationKey = (c: Config): string | null => (!c.enabled || !canDeliver(c) ? null : c.dryRun ? `dry run: ${c.dryRunDir}` : `${tableRef(c)} (${c.location})`)

// The version a greeting record names, if it names one.
export const greetedVersion = (greeted: unknown): string | null => (isObject(greeted) && typeof greeted.version === 'string' ? greeted.version : null)

// Whether the greeting record says this session greeted this version: its
// card's own record then says what became of the card.
export const greetedHere = (greeted: unknown, sessionId: string | null): boolean => sessionId !== null && isObject(greeted) && greeted.version === PLUGIN_VERSION && greeted.sessionId === sessionId

// At session start, from the greeting record and, when this session greeted
// this version, the card's own record (`own`): a new card for a version not
// greeted yet, the same card after a reload in the session that showed it
// (unless it was closed; waiting again if rows now go elsewhere, so `key` is
// this configuration's `destinationKey`), else none.
export function openWelcome(greeted: unknown, own: unknown, sessionId: string | null, key: string | null): { welcome: Welcome; isNew: boolean } | null {
  const seen = isObject(greeted) ? greeted : {}
  const version = greetedVersion(greeted)
  if (version !== PLUGIN_VERSION) {
    return { welcome: { version: PLUGIN_VERSION, previous: version, sessionId, landedAt: null, landedTo: null, closed: false }, isNew: true }
  }
  if (!greetedHere(greeted, sessionId)) return null
  const state = isObject(own) ? own : {}
  if (state.closed === true) return null
  const previous = typeof seen.previous === 'string' ? seen.previous : null
  const here = key !== null && typeof state.landedAt === 'number' && state.landedTo === key
  return { welcome: { version, previous, sessionId, landedAt: here ? (state.landedAt as number) : null, landedTo: here ? key : null, closed: false }, isNew: false }
}

// One card's writes to `$.store` (register.ts passes `save`), in the
// background, one at a time and in order: the greeting record first (for a
// new card), then the card's own record, which no other session writes.
// Each write takes the card as it is by then, so a write that answers late
// never undoes a later change, and a close is in every write after it.
// Nothing waits on them; one that never answers holds up only the writes
// after it.
export class CardRecords {
  card: Welcome
  private greetingDue: boolean
  private stateDue = false
  private writing = false

  // `save` writes one value to `$.store`.
  constructor(
    private readonly save: (key: string, value: unknown) => Promise<void>,
    card: Welcome,
    greet: boolean,
  ) {
    this.card = card
    this.greetingDue = greet
    this.write()
  }

  // Whether these are the records of the card `sessionId` showed.
  isFor(sessionId: string | null): boolean {
    return sessionId !== null && this.card.sessionId === sessionId
  }

  // The card changed (rows landed, it was closed): its own record follows.
  update(card: Welcome): void {
    this.card = { ...card, closed: this.card.closed || card.closed }
    this.stateDue = true
    this.write()
  }

  private write(): void {
    if (this.writing) return
    this.writing = true
    void this.drain()
  }

  private async drain(): Promise<void> {
    try {
      while (this.greetingDue || this.stateDue) {
        const { version, previous, sessionId, landedAt, landedTo, closed } = this.card
        try {
          if (this.greetingDue) {
            this.greetingDue = false
            await this.save(WELCOME_KEY, { version, previous, sessionId })
          } else {
            this.stateDue = false
            if (sessionId !== null) await this.save(cardKey(version, sessionId), { landedAt, landedTo, closed })
          }
        } catch {
          // Not recorded: the next session shows the card again, or a reload
          // shows it as the store last had it.
        }
      }
    } finally {
      this.writing = false
    }
  }
}

// Whether `version` comes before `than`, both dot-separated numbers; false
// when either is not.
const isOlder = (version: string, than: string): boolean => {
  const a = version.split('.').map(Number)
  const b = than.split('.').map(Number)
  if (![...a, ...b].every(Number.isInteger)) return false
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const step = (a[i] ?? 0) - (b[i] ?? 0)
    if (step !== 0) return step < 0
  }
  return false
}

// Installed, updated, or, back to an older version, changed.
const arrival = (w: Welcome): string => (w.previous === null ? 'installed' : `${isOlder(w.version, w.previous) ? 'changed' : 'updated'} to ${w.version}`)

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
  const mod = `bqaa: BigQuery Agent Analytics mod ${w.previous === null ? `installed (${w.version})` : `${arrival(w)} (from ${w.previous})`}`
  if (!c.enabled) return `${mod}; capture is off (the enabled option, or BQAA_TRACE_ENABLED=false).`
  if (!canDeliver(c)) return `${mod}, not set up yet: ${unset(c)}.`
  if (c.dryRun) return `${mod}, dry run: writes ${WHAT} as JSONL files to ${c.dryRunDir}, not to BigQuery.`
  return `${mod}: records ${WHAT} to ${tableRef(c)} (${c.location}); /bqaa-status shows what was sent.`
}

// The toast when the first rows land while the card shows: the band may be
// collapsed.
export const landedToast = (c: Config): string => (c.dryRun ? `BQAA: first rows written to ${c.dryRunDir}` : `BQAA: first rows landed in ${tableRef(c)}`)
