// The values this mod keeps in the session's `$.state`, which the host keeps
// across a reload of the mod's code (the code's own variables start over):
// the welcome card (lib/welcome.ts), its one copy, which every load of the
// code reads and the band draws from.
export type WelcomeState = {
  version: string
  previous: string | null
  sessionId: string | null
  landedAt: number | null
  landedTo: string | null
  closed: boolean
  // Rows landed where the card says rows go, while it showed.
  sent: number
  // What the card has taken of each writer's rows, by writer (its load's
  // session.start run, as `owner`) and destination (register.ts
  // `countKey`): that writer's total landed there when last counted, or
  // when the card opened (the session's `delivered`). Baselines, not a sum:
  // a writer that says so again, or late, is never counted twice, and rows
  // landed before the card opened never count on it.
  counted: Record<string, number>
  // Where it counts rows: the `destinationKey` of the load that showed it.
  destination: string | null
  // The load of the code (and its session.start run) that showed it: the
  // one that speaks for it (a toast); rows an earlier load still sends only
  // count.
  owner: string
  // The rank of that load's run (`loads` when it ran), so a load whose reads
  // answered late never takes the card from a later one.
  rank: number
  // The session's delivery generation the card opened at (`delivered`): a
  // delivery that began at an earlier one never counts on it.
  generation?: number
}

// The session's deliveries: each writer's rows landed so far, keyed as
// `counted`, whatever the card shows (none, closed, or counting elsewhere),
// and the generation, which a card that opens moves on, at the version
// read, taking its start from the totals it moved on from.
export type DeliveredState = {
  generation: number
  totals: Record<string, number>
}

declare module 'claude-code' {
  interface PluginState {
    'bigquery-agent-analytics-mod': {
      welcome: WelcomeState | null
      // How many session.start runs, of every load of the code, the session
      // has seen: each run's rank (register.ts `nextLoad`).
      loads: number
      // Each writer's rows landed so far in the session, and the generation
      // a card that opens moves on (DeliveredState).
      delivered: DeliveredState
      // Written by each delivery before it reads the generation: a dispatch
      // reads one moment of the session's state until a write of its own
      // brings it up to date, and a flush runs on through an update.
      refresh: number
    }
  }
}
