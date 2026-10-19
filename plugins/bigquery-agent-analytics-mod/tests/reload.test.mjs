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

// What outlives a load of the code: the store, the session's state, and the
// store writes still to answer (`hold` picks the keys whose writes wait).
function host(hold = () => false) {
  const store = new Map()
  const state = new Map()
  const held = []
  const write = (key, value) => {
    const land = () => store.set(key, structuredClone(value))
    if (!hold(key)) return Promise.resolve(land())
    return new Promise(resolve => held.push({ key, release: () => resolve(land()) }))
  }
  return { store, state, held, write, release: key => held.splice(held.findIndex(h => h.key === key), 1)[0].release() }
}

let loads = 0
// One load of the code against `h`.
async function load(h) {
  const { register } = await import(`${REGISTER}?load=${++loads}`)
  const hooks = new Map()
  const timers = []
  const lines = []
  const on = (name, ...args) => {
    hooks.set(name, args.at(-1))
    return { catch: () => undefined }
  }
  register(on, { project: 'my-gcp-project', dataset: 'agent_analytics', dryRun: true })
  const $ = {
    env: { get: async name => ({ HOME: '/home/dev' })[name] },
    store: { get: async key => structuredClone(h.store.get(key)), set: h.write, delete: async key => void h.store.delete(key), keys: async () => [...h.store.keys()] },
    state: {
      get: async ref => ({ value: structuredClone(h.state.get(ref.key)), version: 0 }),
      set: async (ref, value) => {
        h.state.set(ref.key, structuredClone(value))
        return { isSet: true, version: 0 }
      },
    },
    session: { id: async () => SESSION, version: async () => ({ version: 'test' }) },
    clock: { every: (ms, fn) => (timers.push(fn), { cancel() {} }), after: () => ({ cancel() {} }) },
    command: { register: async () => undefined },
    plugin: { root: '/opt/mods/bigquery-agent-analytics-mod' },
    ui: {
      log: text => void lines.push(text),
      toast: () => undefined,
      status: () => undefined,
      invalidate: () => undefined,
      resolve: () => Object.fromEntries(['Box', 'Text', 'Button'].map(type => [type, props => ({ type, props })])),
    },
    fs: { write: async () => undefined, read: async () => '', list: async () => [], exists: async () => false },
    http: { fetch: async () => Promise.reject(new Error('no network here')) },
    process: { run: async () => Promise.reject(new Error('no processes here')) },
  }
  const fire = (name, e) => hooks.get(name)($, e, async x => (name === 'ui.render' ? null : x))
  const walk = n => (n ? [n, ...(Array.isArray(n.props?.children) ? n.props.children.flatMap(walk) : typeof n.props?.children === 'object' ? walk(n.props.children) : [])] : [])
  const button = async () => walk(await fire('ui.render', { component: 'AbovePrompt', props: { hasSurvey: false, maxRows: 10 } })).find(n => n.type === 'Button')
  return {
    greetings: () => lines.filter(line => line.startsWith('bqaa: BigQuery Agent Analytics mod')).length,
    start: async () => {
      await fire('session.start', START)
      await settle()
    },
    shown: async () => (await button()) !== undefined,
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
    const h = host(() => true)
    const a = await load(h)
    await a.start()
    await a.close()
    const b = await load(h)
    await b.start()
    assert.equal(await b.shown(), false)
    assert.equal(a.greetings() + b.greetings(), 1)
  },
  async 'a greeting still being written gives one transcript line across loads, and the same card'() {
    const h = host(() => true)
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
        const h = host(key => key === OWN)
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
