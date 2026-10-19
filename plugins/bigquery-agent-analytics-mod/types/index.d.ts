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
  // Rows landed where the card says rows go, while it showed: the sum of
  // `counted`.
  sent: number
  // Each writer's rows counted (by its load's session.start run, as
  // `owner`): that writer's total sent when last counted, so a writer that
  // says so again, or late, is never counted twice.
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
}

declare module 'claude-code' {
  interface PluginState {
    'bigquery-agent-analytics-mod': {
      welcome: WelcomeState | null
      // How many session.start runs, of every load of the code, the session
      // has seen: each run's rank (register.ts `nextLoad`).
      loads: number
    }
  }
}
