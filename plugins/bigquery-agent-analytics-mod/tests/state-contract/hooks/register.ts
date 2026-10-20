// A mod of its own, for tests/state-contract.test.sh: two commands, each its
// own dispatch, on two values of the session's state. `probe-read` reads `a`,
// waits on a store read the test holds, then reads `b`, writes `a` at the
// version it read, and reads both again; `probe-write` writes `b` (and `a`
// too, for `both`) meanwhile.

import type { Register } from 'claude-code'

const A = { plugin: 'state-contract', key: 'a' } as const
const B = { plugin: 'state-contract', key: 'b' } as const

export const register: Register = on => {
  on('command.run', { command: 'probe-read' }, async $ => {
    const first = await $.state.get(A)
    await $.store.get('pause')
    const staleB = await $.state.get(B)
    const set = await $.state.set(A, 99, { ifVersion: first.version })
    const afterA = await $.state.get(A)
    const afterB = await $.state.get(B)
    return { text: JSON.stringify({ first, staleB, set, afterA, afterB }) }
  })
  on('command.run', { command: 'probe-write' }, async ($, e) => {
    if (e.args === 'both') await $.state.set(A, 1)
    await $.state.set(B, 2)
    return { text: 'written' }
  })
}
