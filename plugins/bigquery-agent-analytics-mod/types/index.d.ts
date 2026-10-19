// The values this mod keeps in the session's `$.state`, which the host keeps
// across a reload of the mod's code (the code's own variables start over):
// the welcome card as the session last left it (lib/welcome.ts).
export type WelcomeState = {
  version: string
  previous: string | null
  sessionId: string | null
  landedAt: number | null
  landedTo: string | null
  closed: boolean
  // Rows landed where the card says rows go, while it showed.
  sent: number
}

declare module 'claude-code' {
  interface PluginState {
    'bigquery-agent-analytics-mod': { welcome: WelcomeState | null }
  }
}
