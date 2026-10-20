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
  // Rows landed where the card says rows go, by the run it counts from
  // (`since`) and every later run: the sum of their totals in `delivered`.
  sent: number
  // Where it counts rows: the `destinationKey` of the load that showed it.
  destination: string | null
  // The load of the code (and its session.start run) that showed it: the
  // one that speaks for it (a toast); rows an earlier load still sends only
  // count.
  owner: string
  // The rank of that load's run (`loads` when it ran), so a load whose reads
  // answered late never takes the card from a later one.
  rank: number
  // The rank of the run that opened the card, or last moved it where rows go
  // now: the card counts that run's rows and every later run's there, and no
  // earlier run's, whenever they land.
  since: number
}

// What one session.start run has landed in one destination so far: the
// run's rank, the destination (`destinationKey`), and its rows in all.
export type DeliveredRows = {
  rank: number
  to: string
  rows: number
}

// Each run's rows landed so far in the session, by run and destination
// (register.ts `countKey`), whatever the card shows (none, closed, or
// counting elsewhere).
export type DeliveredState = Record<string, DeliveredRows>

declare module 'claude-code' {
  interface PluginState {
    'bigquery-agent-analytics-mod': {
      welcome: WelcomeState | null
      // How many session.start runs, of every load of the code, the session
      // has seen: each run's rank (register.ts `nextLoad`).
      loads: number
      // Each run's rows landed so far in the session (DeliveredState).
      delivered: DeliveredState
    }
  }
}
