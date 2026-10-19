// The welcome card across a fresh load of the mod's code (a hot reload):
// what the host keeps for the session (`$.state`) and across sessions
// (`$.store`) is all a new load has; the old load's store writes still
// answer, late, in either order. The host's test kit cannot load the code
// twice, so this loads hooks/register.ts again under node 24 (which runs
// TypeScript as is), with a small stand-in for `$`. No network, no files.
//   node tests/reload.test.mjs
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { PLUGIN_VERSION } from '../hooks/lib/config.ts'

const REGISTER = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'register.ts')).href
const SESSION = 'reload-session'
const OWN = `welcome:${PLUGIN_VERSION}:${SESSION}`
const CLOSED = `${OWN}:closed`
const START = { surface: 'terminal', isInteractive: true, cwd: '/work' }
const settle = async () => {
  for (let i = 0; i < 200; i += 1) await Promise.resolve()
}

// What outlives a load of the code: the store, the session's state (each
// value with a version, a write with `ifVersion` landing only while the
// value stands at it, as the host's), and the writes still to answer.
// `hold` picks the store keys whose writes wait; `holdState` the state
// writes that wait, `refuseState` those refused; `read` may hold store reads.
function host({ hold = () => false, holdState = () => false, refuseState = () => false, read } = {}) {
  const store = new Map()
  const state = new Map()
  const held = []
  const write = (key, value) => {
    const land = () => store.set(key, structuredClone(value))
    if (!hold(key)) return Promise.resolve(land())
    return new Promise(resolve => held.push({ key, release: () => resolve(land()) }))
  }
  const stateSet = (ref, value, options) => {
    if (refuseState(value)) return Promise.reject(new Error('refused by policy'))
    const land = () => {
      const now = state.get(ref.key) ?? { value: undefined, version: 0 }
      if (options?.ifVersion !== undefined && options.ifVersion !== now.version) return { isSet: false, version: now.version }
      state.set(ref.key, { value: structuredClone(value), version: now.version + 1 })
      return { isSet: true, version: now.version + 1 }
    }
    if (!holdState(value)) return Promise.resolve(land())
    return new Promise(resolve => held.push({ key: 'state', value, release: () => resolve(land()) }))
  }
  const card = () => state.get('welcome')?.value
  return { store, state, held, write, stateSet, read, card, release: key => held.splice(held.findIndex(h => h.key === key), 1)[0].release() }
}

// Store reads that wait while `holding` says so, until `answer`.
function heldReads(h, holding) {
  const waiting = []
  h.read = key => (holding(key) ? new Promise(resolve => waiting.push(() => resolve(structuredClone(h.store.get(key))))) : Promise.resolve(structuredClone(h.store.get(key))))
  return { answer: () => waiting.splice(0).forEach(go => go()), count: () => waiting.length }
}

let loads = 0
// One load of the code against `h`, with `options` over the usual ones. The
// newest load is the one the host runs: a hot reload cancels the waits of the
// load it replaces, so `$.clock.sleep` never answers there once a later load
// is in, or (`h.refuseWaits`) is refused; its other calls may still answer,
// late.
async function load(h, options = {}) {
  const index = ++loads
  const { register } = await import(`${REGISTER}?load=${index}`)
  h.current = index
  const hooks = new Map()
  const timers = []
  const lines = []
  const toasts = []
  let redraws = 0
  const on = (name, ...args) => {
    hooks.set(name, args.at(-1))
    return { catch: () => undefined }
  }
  register(on, { project: 'my-gcp-project', dataset: 'agent_analytics', dryRun: true, ...options })
  const $ = {
    env: { get: async name => ({ HOME: '/home/dev' })[name] },
    store: { get: key => (h.read ? h.read(key) : Promise.resolve(structuredClone(h.store.get(key)))), set: h.write, delete: async key => void h.store.delete(key), keys: async () => [...h.store.keys()] },
    state: {
      get: async ref => {
        if (h.stateRead) await h.stateRead(ref.key)
        const now = h.state.get(ref.key) ?? { value: undefined, version: 0 }
        return { value: structuredClone(now.value), version: now.version }
      },
      set: h.stateSet,
    },
    session: { id: async () => SESSION, version: async () => ({ version: 'test' }) },
    clock: {
      every: (ms, fn) => (timers.push(fn), { cancel() {} }),
      after: () => ({ cancel() {} }),
      sleep: () => new Promise((resolve, reject) => queueMicrotask(() => (h.current === index ? resolve() : h.refuseWaits && reject(new Error('cancelled by a reload'))))),
    },
    command: { register: async () => undefined },
    plugin: { root: '/opt/mods/bigquery-agent-analytics-mod' },
    ui: {
      log: text => void lines.push(text),
      toast: text => void toasts.push(text),
      status: () => undefined,
      invalidate: () => void (redraws += 1),
      resolve: () => Object.fromEntries(['Box', 'Text', 'Button'].map(type => [type, props => ({ type, props })])),
    },
    fs: { write: (...args) => (h.writeFile ? h.writeFile(...args) : Promise.resolve()), read: async () => '', list: async () => [], exists: async () => false },
    http: { fetch: async () => Promise.reject(new Error('no network here')) },
    process: { run: async () => Promise.reject(new Error('no processes here')) },
  }
  const fire = (name, e) => hooks.get(name)($, e, async x => (name === 'ui.render' ? null : x))
  const walk = n => (n ? [n, ...(Array.isArray(n.props?.children) ? n.props.children.flatMap(walk) : typeof n.props?.children === 'object' ? walk(n.props.children) : [])] : [])
  const band = async () => walk(await fire('ui.render', { component: 'AbovePrompt', props: { hasSurvey: false, maxRows: 10 } }))
  const button = async () => (await band()).find(n => n.type === 'Button')
  return {
    texts: async () => (await band()).filter(n => n.type === 'Text').map(n => n.props.children),
    greetings: () => lines.filter(line => line.startsWith('bqaa: BigQuery Agent Analytics mod')).length,
    toasts: () => toasts.length,
    // The redraws this load asked for.
    redraws: () => redraws,
    start: async () => {
      await fire('session.start', START)
      await settle()
    },
    shown: async () => (await button()) !== undefined,
    // A prompt typed at the terminal.
    prompt: async () => {
      await fire('prompt.submit', { text: 'hi', wait: false, origin: { kind: 'composer' } })
      await settle()
    },
    close: async () => {
      const b = await button()
      assert.ok(b, 'the card is up')
      b.props.onPress()
      await settle()
    },
    // The session's first row, written by the next flush (a dry run).
    land: async () => {
      await fire('classic.SessionStart', { source: 'startup', session_id: SESSION, model: 'example-model', cwd: '/work' })
      timers.at(-1)()
      await settle()
    },
  }
}

const tests = {
  async 'a card closed before a reload stays closed while the close is still being written'() {
    const h = host({ hold: () => true })
    const a = await load(h)
    await a.start()
    await a.close()
    const b = await load(h)
    await b.start()
    assert.equal(await b.shown(), false)
    assert.equal(a.greetings() + b.greetings(), 1)
  },
  async 'a greeting still being written gives one transcript line across loads, and the same card'() {
    const h = host({ hold: () => true })
    const a = await load(h)
    await a.start()
    const b = await load(h)
    await b.start()
    assert.equal(await b.shown(), true)
    assert.equal(a.greetings() + b.greetings(), 1)
  },
  ...Object.fromEntries(
    ['before', 'after'].map(order => [
      `a landing an earlier load is still writing lands ${order} the close a later load writes: the card stays closed`,
      async () => {
        const h = host({ hold: key => key === OWN })
        const a = await load(h)
        await a.start()
        await a.land()
        assert.equal(h.held.length, 1)
        const b = await load(h)
        await b.start()
        assert.equal(await b.shown(), true)
        if (order === 'before') h.release(OWN)
        await b.close()
        if (order === 'after') h.release(OWN)
        await settle()
        assert.equal(h.store.get(CLOSED), true)
        assert.equal(typeof h.store.get(OWN)?.landedAt, 'number')
        // A later load, and one in a new process with no `$.state`.
        const c = await load(h)
        await c.start()
        assert.equal(await c.shown(), false)
        h.state.clear()
        const d = await load(h)
        await d.start()
        assert.equal(await d.shown(), false)
      },
    ]),
  ),
  async 'a store read an earlier load is still waiting on, answering after a later load showed the card and it was closed, shows nothing, greets no more, and leaves it closed'() {
    let answer
    let first = true
    const h = host({
      read: key => {
        if (first && key === 'welcome') {
          first = false
          return new Promise(resolve => (answer = () => resolve(undefined)))
        }
        return Promise.resolve(structuredClone(h.store.get(key)))
      },
    })
    const a = await load(h)
    await a.start()
    const b = await load(h)
    await b.start()
    await b.close()
    answer()
    await settle()
    const c = await load(h)
    await c.start()
    assert.equal(a.greetings() + b.greetings() + c.greetings(), 1)
    assert.equal(h.store.get(CLOSED), true)
    assert.equal(h.card()?.closed, true)
    assert.equal(await c.shown(), false)
  },
  async 'a dry-run write an earlier load is still finishing, landing after a later load closed the card, leaves it closed'() {
    const writes = []
    const h = host()
    h.writeFile = (path, text) => new Promise(resolve => writes.push(resolve))
    const a = await load(h)
    await a.start()
    await a.land()
    const b = await load(h)
    await b.start()
    await b.close()
    for (const done of writes.splice(0)) done()
    await settle()
    const c = await load(h)
    await c.start()
    assert.equal(h.store.get(CLOSED), true)
    assert.equal(h.card()?.closed, true)
    assert.equal(await c.shown(), false)
  },
  async 'rows an earlier load lands where the card counts them, after a later load took the card over, count on it'() {
    const writes = []
    const h = host()
    h.writeFile = (path, text) => new Promise(resolve => writes.push(resolve))
    const a = await load(h)
    await a.start()
    await a.land()
    const b = await load(h)
    await b.start()
    assert.ok((await b.texts()).some(t => String(t).startsWith('◌ Waiting for the first rows')))
    for (const done of writes.splice(0)) done()
    await settle()
    assert.equal(h.card()?.sent, 1)
    assert.ok((await b.texts()).some(t => String(t).startsWith('✓ First rows written · 1 so far')))
    // The earlier load only counts: the card is the later load's to speak for.
    assert.equal(a.toasts(), 0)
  },
  async 'a greeting an earlier load never got written is written by the load that reopens the card'() {
    let greetings = 0
    const h = host({ hold: key => key === `welcome:${PLUGIN_VERSION}` && ++greetings === 1 })
    const a = await load(h)
    await a.start()
    assert.equal(h.store.get(`welcome:${PLUGIN_VERSION}`), undefined)
    const b = await load(h)
    await b.start()
    await settle()
    assert.deepEqual(h.store.get(`welcome:${PLUGIN_VERSION}`), { sessionId: SESSION, previous: null })
    assert.equal(a.greetings() + b.greetings(), 1)
  },
  async 'a close the store has, whose session-state write was refused, wins over the open card the state still has'() {
    const h = host({ refuseState: value => value?.closed === true })
    const a = await load(h)
    await a.start()
    await a.close()
    await settle()
    assert.equal(h.store.get(CLOSED), true)
    assert.equal(h.card()?.closed, false)
    // The state still says open (its writes of a close are refused), but a
    // new load reads the close from the store and never draws the card.
    const b = await load(h)
    await b.start()
    assert.equal(await b.shown(), false)
  },
  async 'a close the store has, whose session-state write was refused once, is written back to the state by the next load'() {
    let refusals = 0
    const h = host({ refuseState: value => value?.closed === true && ++refusals === 1 })
    const a = await load(h)
    await a.start()
    await a.close()
    await settle()
    assert.equal(h.store.get(CLOSED), true)
    assert.equal(h.card()?.closed, false)
    const b = await load(h)
    await b.start()
    assert.equal(h.card()?.closed, true)
    assert.equal(await b.shown(), false)
  },
  async 'a close whose session-state write never answers is in the store at once, and a new load shows no card'() {
    let holding = false
    const h = host({ holdState: () => holding })
    const a = await load(h)
    await a.start()
    holding = true
    await a.close()
    await settle()
    assert.equal(h.store.get(CLOSED), true)
    assert.equal(await a.shown(), false)
    const b = await load(h)
    await b.start()
    assert.equal(await b.shown(), false)
  },
  async 'session-state writes that answer late, a close and then an earlier landing, leave the card closed'() {
    let holding = false
    const h = host({ holdState: () => holding })
    const a = await load(h)
    await a.start()
    holding = true
    await a.land()
    await a.close()
    holding = false
    // The close's write answers first, then the landing's.
    const close = h.held.findIndex(w => w.key === 'state' && w.value.closed === true)
    h.held.splice(close, 1)[0].release()
    await settle()
    for (const w of h.held.splice(0)) w.release()
    await settle()
    // The landing's late write did not land over the close.
    assert.equal(h.card()?.closed, true)
    const b = await load(h)
    await b.start()
    assert.equal(h.card()?.closed, true)
    assert.equal(await b.shown(), false)
  },
  async 'a greeting whose store write and session-state write are both still in flight gives one transcript line across loads'() {
    let holding = true
    const h = host({ hold: () => true, holdState: () => holding })
    const a = await load(h)
    const starting = a.start()
    const b = await load(h)
    holding = false
    await b.start()
    for (const w of h.held.filter(w => w.key === 'state').splice(0)) h.held.splice(h.held.indexOf(w), 1)[0].release()
    await starting
    await settle()
    assert.equal(a.greetings() + b.greetings(), 1)
  },
  async 'Got it while the greeting is still being written, its session-state close refused, puts the close in the store at once, and a new load shows no card'() {
    const h = host({ hold: key => key === `welcome:${PLUGIN_VERSION}`, refuseState: value => value?.closed === true })
    const a = await load(h)
    await a.start()
    await a.close()
    // The close is written while the greeting still waits.
    assert.equal(h.store.get(CLOSED), true)
    assert.deepEqual(h.held.map(w => w.key), [`welcome:${PLUGIN_VERSION}`])
    assert.equal(h.card()?.closed, false)
    const b = await load(h)
    await b.start()
    assert.equal(await b.shown(), false)
    h.release(`welcome:${PLUGIN_VERSION}`)
    await settle()
    assert.equal(await b.shown(), false)
  },
  async 'Got it while a landing is still being written, its session-state close refused, puts the close in the store at once, and a new load shows no card'() {
    const h = host({ hold: key => key === OWN, refuseState: value => value?.closed === true })
    const a = await load(h)
    await a.start()
    await a.land()
    assert.deepEqual(h.held.map(w => w.key), [OWN])
    await a.close()
    assert.equal(h.store.get(CLOSED), true)
    const b = await load(h)
    await b.start()
    assert.equal(await b.shown(), false)
  },
  async 'a new load draws the card only once its reads of the store have answered, and one whose reads never answer never draws it'() {
    const h = host()
    const a = await load(h)
    await a.start()
    assert.equal(await a.shown(), true)
    let holding = true
    const reads = heldReads(h, () => holding)
    const b = await load(h)
    await b.start()
    assert.ok(reads.count() > 0)
    assert.equal(await b.shown(), false)
    holding = false
    reads.answer()
    await settle()
    assert.equal(await b.shown(), true)
    holding = true
    const c = await load(h)
    await c.start()
    await settle()
    assert.equal(await c.shown(), false)
  },
  async 'a close the store has, its session-state write refused: a new load draws no card while its read of that close waits, nor after'() {
    const h = host({ refuseState: value => value?.closed === true })
    const a = await load(h)
    await a.start()
    await a.close()
    assert.equal(h.store.get(CLOSED), true)
    assert.equal(h.card()?.closed, false)
    const reads = heldReads(h, key => key === CLOSED)
    const b = await load(h)
    await b.start()
    assert.equal(await b.shown(), false)
    reads.answer()
    await settle()
    assert.equal(await b.shown(), false)
  },
  async 'a load whose reads answer after a later load took the card over for another destination leaves the card to it, and rows it lands count nowhere'() {
    const A = { deadLetterDir: '/home/dev/a/dead-letter' }
    const B = { deadLetterDir: '/home/dev/b/dead-letter' }
    const h = host()
    const a = await load(h, A)
    await a.start()
    let holding = true
    const reads = heldReads(h, () => holding)
    const b = await load(h, A)
    await b.start()
    holding = false
    const c = await load(h, B)
    await c.start()
    assert.equal(h.card()?.destination, 'dry run: /home/dev/b/dry-run')
    reads.answer()
    await settle()
    assert.equal(h.card()?.destination, 'dry run: /home/dev/b/dry-run')
    assert.equal(await b.shown(), false)
    await b.land()
    assert.equal(h.card()?.sent, 0)
    assert.ok((await c.texts()).some(t => String(t).startsWith('◌ Waiting for the first rows')))
    // The first load, still drawing, claims no landing either.
    await c.land()
    assert.equal(h.card()?.sent, 1)
    assert.ok((await c.texts()).some(t => String(t).startsWith('✓ First rows written · 1 so far')))
    assert.ok((await a.texts()).some(t => String(t).startsWith('◌ Waiting for the first rows')))
  },
  async 'rows a new load lands while its reads of the store wait count once, across repeated reloads'() {
    const h = host()
    const a = await load(h)
    await a.start()
    await a.land()
    assert.equal(h.card()?.sent, 1)
    let holding = true
    const reads = heldReads(h, () => holding)
    const b = await load(h)
    await b.start()
    await b.land()
    holding = false
    reads.answer()
    await settle()
    assert.equal(h.card()?.sent, 2)
    const c = await load(h)
    await c.start()
    await c.land()
    assert.equal(h.card()?.sent, 3)
    assert.ok((await c.texts()).some(t => String(t).startsWith('✓ First rows written · 3 so far')))
  },
  async 'a new load that cannot read the store shows no card: it cannot tell whether the card was closed'() {
    const h = host()
    const a = await load(h)
    await a.start()
    assert.equal(await a.shown(), true)
    h.read = () => Promise.reject(new Error('the store could not be read'))
    const b = await load(h)
    await b.start()
    assert.equal(await b.shown(), false)
  },
  async 'an earlier load whose read of the card answers after a later load showed the card never takes it over'() {
    const A = { deadLetterDir: '/home/dev/a/dead-letter' }
    const B = { deadLetterDir: '/home/dev/b/dead-letter' }
    const h = host()
    const a = await load(h, A)
    // The earlier load's read of the card waits (its rank it has).
    const waiting = []
    h.stateRead = key => (key === 'welcome' ? new Promise(resolve => waiting.push(resolve)) : undefined)
    const starting = a.start()
    await settle()
    h.stateRead = undefined
    const b = await load(h, B)
    await b.start()
    assert.equal(h.card()?.destination, 'dry run: /home/dev/b/dry-run')
    for (const go of waiting.splice(0)) go()
    await starting
    await settle()
    assert.equal(h.card()?.destination, 'dry run: /home/dev/b/dry-run')
    assert.equal(await a.shown(), false)
    assert.equal(await b.shown(), true)
  },
  async 'rows that went where the card counted them before it moved, and moved back, are not counted again'() {
    const A = { deadLetterDir: '/home/dev/a/dead-letter' }
    const B = { deadLetterDir: '/home/dev/b/dead-letter' }
    const h = host()
    const a = await load(h, A)
    await a.start()
    await a.land()
    assert.equal(h.card()?.sent, 1)
    const b = await load(h, B)
    await b.start()
    const c = await load(h, A)
    await c.start()
    assert.equal(h.card()?.sent, 0)
    // The first load's writer lands one more row there: one, not two.
    await a.land()
    assert.equal(h.card()?.sent, 1)
    assert.ok((await c.texts()).some(t => String(t).startsWith('✓ First rows written · 1 so far')))
  },
  async 'a reload whose takeover write answers after the earlier load\'s Got it (its state close refused) shows no card: the close is read again'() {
    let holding = false
    const h = host({ refuseState: value => value?.closed === true, holdState: value => holding && typeof value === 'object' && value !== null && 'owner' in value })
    const a = await load(h)
    await a.start()
    holding = true
    const b = await load(h)
    await b.start()
    assert.equal(h.held.filter(w => w.key === 'state').length, 1)
    await a.close()
    assert.equal(h.store.get(CLOSED), true)
    holding = false
    for (const w of h.held.filter(w => w.key === 'state')) h.held.splice(h.held.indexOf(w), 1)[0].release()
    await settle()
    assert.equal(await b.shown(), false)
  },
  async 'two loads whose first card writes both wait: the earlier one\'s lands first, and the later load takes the card over, with one greeting'() {
    let holding = true
    const h = host({ holdState: value => holding && typeof value === 'object' && value !== null && 'owner' in value })
    const a = await load(h)
    await a.start()
    const b = await load(h)
    await b.start()
    const writes = h.held.filter(w => w.key === 'state')
    assert.equal(writes.length, 2)
    holding = false
    for (const w of writes) {
      h.held.splice(h.held.indexOf(w), 1)[0].release()
      await settle()
    }
    assert.equal(await b.shown(), true)
    assert.equal(a.greetings() + b.greetings(), 1)
  },
  async 'a prompt after rows landed, with session-state closes refused, closes the card here and in the store, and a new load shows none'() {
    const h = host({ refuseState: value => value?.closed === true })
    const a = await load(h)
    await a.start()
    await a.land()
    await a.prompt()
    assert.equal(h.store.get(CLOSED), true)
    assert.equal(await a.shown(), false)
    const b = await load(h)
    await b.start()
    assert.equal(await b.shown(), false)
  },
  async 'loads in the same millisecond, or with the clock set back, rank by when they started: the earlier one never takes the card from the later'() {
    const realNow = Date.now
    try {
      for (const clock of [() => 1_000_000, (n => () => (n -= 60_000))(10_000_000)]) {
        Date.now = clock
        const A = { deadLetterDir: '/home/dev/a/dead-letter' }
        const B = { deadLetterDir: '/home/dev/b/dead-letter' }
        const h = host()
        const a = await load(h, A)
        await a.start()
        let holding = true
        const reads = heldReads(h, () => holding)
        const b = await load(h, A)
        await b.start()
        holding = false
        const c = await load(h, B)
        await c.start()
        reads.answer()
        await settle()
        assert.equal(h.card()?.destination, 'dry run: /home/dev/b/dry-run')
        assert.equal(await c.shown(), true)
        assert.equal(await b.shown(), false)
      }
    } finally {
      Date.now = realNow
    }
  },
  ...Object.fromEntries(
    ['write', 'read'].map(step => [
      `a load replaced while its rank ${step} is still out takes nothing over: the later load keeps its destination, counts its rows, and a prompt closes the card`,
      async () => {
        const A = { deadLetterDir: '/home/dev/a/dead-letter' }
        const B = { deadLetterDir: '/home/dev/b/dead-letter' }
        // B's cancelled wait never answers, or is refused.
        for (const refuseWaits of [false, true]) {
          let holding = false
          const h = host({ holdState: value => holding && typeof value === 'number' })
          h.refuseWaits = refuseWaits
          const a = await load(h, A)
          await a.start()
          const reads = []
          if (step === 'write') holding = true
          else h.stateRead = key => (key === 'loads' ? new Promise(resolve => reads.push(resolve)) : undefined)
          const b = await load(h, A)
          await b.start()
          assert.equal(step === 'write' ? h.held.length : reads.length, 1)
          holding = false
          h.stateRead = undefined
          const c = await load(h, B)
          await c.start()
          // B's rank comes back now, above C's: B is no longer the load the host runs.
          if (step === 'write') h.release('state')
          else reads[0]()
          await settle()
          assert.equal(h.state.get('loads').value, 3)
          assert.equal(h.card().destination, 'dry run: /home/dev/b/dry-run')
          assert.equal(await b.shown(), false)
          await c.land()
          assert.equal(h.card().sent, 1)
          assert.equal(h.card().landedTo, 'dry run: /home/dev/b/dry-run')
          assert.ok((await c.texts()).some(text => text.startsWith('✓ First rows written · 1 so far')))
          await c.prompt()
          assert.equal(await c.shown(), false)
          assert.equal(h.store.get(CLOSED), true)
          assert.equal(a.greetings() + b.greetings() + c.greetings(), 1)
        }
      },
    ]),
  ),
  async 'a close an earlier load writes late, its session-state close refused, hides the card a later load took over once it lands, with no reload and no press'() {
    const h = host({ hold: key => key === CLOSED, refuseState: value => value?.closed === true })
    const a = await load(h)
    await a.start()
    await a.close()
    const b = await load(h)
    await b.start()
    // Not in the store yet: nothing says the card was closed.
    assert.equal(await b.shown(), true)
    h.release(CLOSED)
    await settle()
    const asked = b.redraws()
    // A draw reads the close again, and asks for the next, which has no card.
    await b.shown()
    await settle()
    assert.ok(b.redraws() > asked)
    assert.equal(await b.shown(), false)
    assert.equal(h.card().closed, false)
  },
  async 'draws of the card while its read of the close waits start no other read of it'() {
    const h = host()
    const a = await load(h)
    await a.start()
    let holding = true
    const reads = heldReads(h, key => holding && key === CLOSED)
    for (let i = 0; i < 3; i += 1) assert.equal(await a.shown(), true)
    assert.equal(reads.count(), 1)
    holding = false
    reads.answer()
    await settle()
    assert.equal(await a.shown(), true)
  },
}

let failed = 0
for (const [name, run] of Object.entries(tests)) {
  try {
    await run()
    console.log(`ok - ${name}`)
  } catch (err) {
    failed += 1
    console.log(`not ok - ${name}\n  ${err?.message ?? err}`)
  }
}
console.log(`${Object.keys(tests).length - failed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
