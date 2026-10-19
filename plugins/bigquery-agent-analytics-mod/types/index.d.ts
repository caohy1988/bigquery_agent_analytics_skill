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
  // Where it counts rows: the `destinationKey` of the load that showed it.
  destination: string | null
  // The load of the code (and its session.start run) that showed it: the
  // one that speaks for it (a toast); rows an earlier load still sends only
  // count.
  owner: string
}

declare module 'claude-code' {
  interface PluginState {
    'bigquery-agent-analytics-mod': { welcome: WelcomeState | null }
  }
}
