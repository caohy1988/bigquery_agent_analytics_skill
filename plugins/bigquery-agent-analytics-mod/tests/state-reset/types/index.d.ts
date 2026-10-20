export type Count = number

declare module 'claude-code' {
  interface PluginState {
    'state-reset': { n: Count }
  }
}
