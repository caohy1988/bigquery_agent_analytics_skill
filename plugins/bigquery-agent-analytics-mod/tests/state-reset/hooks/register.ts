// A mod of its own, for tests/state-reset.live.sh: it writes one value of
// the session's state three times at session.start; after /clear it reads
// the value, then writes it three times, each followed by a write on the
// version from before the reset. What each step answered goes to out/
// beside it.

import type { Register } from 'claude-code'

const N = { plugin: 'state-reset', key: 'n' } as const
let before = -1

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const steps: unknown[] = []
    for (let i = 0; i < 3; i += 1) {
      const read = await $.state.get(N)
      const wrote = await $.state.set(N, (read.value ?? 0) + 1, { ifVersion: read.version })
      steps.push({ read, wrote })
      if (wrote.isSet) before = wrote.version
    }
    await $.fs.write(`${$.plugin.root}/out/start.json`, JSON.stringify({ steps, before }))
    return result
  })
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (String(e.source) !== 'clear') return result
    const first = await $.state.get(N)
    const steps: unknown[] = []
    for (let i = 0; i < 3; i += 1) {
      const read = await $.state.get(N)
      const wrote = await $.state.set(N, (read.value ?? 0) + 100, { ifVersion: read.version })
      const stale = await $.state.set(N, 999, { ifVersion: before })
      steps.push({ read, wrote, stale })
    }
    await $.fs.write(`${$.plugin.root}/out/clear.json`, JSON.stringify({ before, first, steps }))
    return result
  }).catch(($, e, next) => next(e))
}
