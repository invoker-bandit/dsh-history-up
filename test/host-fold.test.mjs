/** Executable checks for the Host half's fold. Run: node --test /tmp/hut/test.mjs */
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, Config } from './.build/plugin.mjs'

/** Collect the unit the plugin registers, without a real Cordis context. */
function unitFor(config) {
  const ctx = harness()
  apply(ctx, config)
  return ctx.registered
}

/**
 * A context carrying both registries the plugin plugs into.
 *
 * The captured command and the state `stateOf` answers from live on the same
 * object the registries write to, so a test can drive the `/history` handler
 * against whatever history it folded first.
 *
 * @returns {object} the fake context, also holding `registered` and `command`.
 */
function harness() {
  const ctx = {
    registered: undefined,
    sessionProjections: {
      register: d => {
        ctx.registered = d
        return () => {}
      },
      stateOf: (_session, key) => (key === 'inputHistory' ? ctx.history : undefined),
    },
    commands: {
      register: definition => {
        ctx.command = definition
        return () => { ctx.disposed = true }
      },
    },
    effect: fn => fn(),
  }
  return ctx
}

/** Build the entry list a folded state would hold for these prompts. */
function historyOf(...prompts) {
  return prompts.map((p, i) => ({ seq: i + 1, time: 1000 + i, text: p }))
}

const text = (t) => ({ type: 'text', text: t })
const userMsg = (t, extra = {}) => ({
  type: 'user/message',
  seq: extra.seq ?? 1,
  time: extra.time ?? 1000,
  data: { role: 'user', content: [text(t)], source: { kind: 'user' } },
  surfaceOp: 'append',
})

test('declares only the projection registry, and no host command', () => {
  assert.deepEqual(inject, ['sessionProjections'])
  const ctx = harness()
  apply(ctx)
  assert.equal(ctx.command, undefined, 'a host command would collide with the client contribution')
})

test('records a submitted prompt', () => {
  const d = unitFor()
  const next = d.apply({ entries: [] }, userMsg('hello'))
  assert.deepEqual(next.entries, [{ seq: 1, time: 1000, text: 'hello' }])
})

test('ignores injected context and unrelated events', () => {
  const d = unitFor()
  const state = { entries: [] }
  const injected = {
    ...userMsg('from a goal'),
    data: { role: 'user', content: [text('from a goal')], source: { kind: 'goal', form: 'notice' } },
  }
  assert.equal(d.apply(state, injected), state, 'goal-sourced message')
  assert.equal(d.apply(state, { type: 'turn/end', seq: 2, time: 1, data: { turn: 1 } }), state)
  assert.equal(d.apply(state, userMsg('   ').data ? { ...userMsg(''), data: { ...userMsg('').data, content: [text('')] } } : null), state)
})

test('skips prompts with no text (image/file only)', () => {
  const d = unitFor()
  const state = { entries: [] }
  const imageOnly = { ...userMsg('x'), data: { role: 'user', content: [{ type: 'image', imageId: 'i' }], source: { kind: 'user' } } }
  assert.equal(d.apply(state, imageOnly), state)
})

test('returns the same state reference for every ignored event', () => {
  const d = unitFor()
  const state = d.apply({ entries: [] }, userMsg('first'))
  for (const ev of [{ type: 'step/start', seq: 2, time: 1, data: {} }, { type: 'tool/result', seq: 3, time: 1, data: {} }]) {
    assert.equal(d.apply(state, ev), state)
  }
})

test('caps history at maxEntries, dropping the oldest', () => {
  const d = unitFor({ maxEntries: 3 })
  let state = { entries: [] }
  for (let i = 1; i <= 5; i += 1) state = d.apply(state, userMsg(`m${i}`, { seq: i }))
  assert.deepEqual(state.entries.map((e) => e.text), ['m3', 'm4', 'm5'])
})

test('falls back to the default cap on a malformed config', () => {
  for (const bad of [undefined, null, {}, { maxEntries: 'x' }, { maxEntries: 0 }, { maxEntries: -5 }]) {
    const d = unitFor(bad)
    let state = { entries: [] }
    for (let i = 1; i <= 205; i += 1) state = d.apply(state, userMsg(`m${i}`, { seq: i }))
    assert.equal(state.entries.length, 200, JSON.stringify(bad))
  }
})

test('a surface replacement drops the rows it shadows', () => {
  const d = unitFor()
  let state = { entries: [] }
  state = d.apply(state, userMsg('one', { seq: 1 }))
  state = d.apply(state, userMsg('two', { seq: 2 }))
  state = d.apply(state, userMsg('three', { seq: 3 }))
  const replaced = { type: 'assistant/message', seq: 4, time: 1, data: {}, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 } }
  assert.deepEqual(d.apply(state, replaced).entries.map((e) => e.text), ['one', 'three'])
})

test('a malformed replace range cannot wipe the history', () => {
  const d = unitFor()
  let state = d.apply({ entries: [] }, userMsg('one', { seq: 1 }))
  const bad = { type: 'assistant/message', seq: 2, time: 1, data: {}, surfaceOp: { op: 'replace' } }
  assert.equal(d.apply(state, bad), state, 'must be a no-op, not an empty history')
})

test('the view returns the same reference as the state', () => {
  const d = unitFor()
  const state = d.apply({ entries: [] }, userMsg('hello'))
  assert.equal(d.wire.view(state), state)
  d.wire.viewSchema.parse(d.wire.view(state))
  d.stateSchema.parse(state)
})

test('a model-only replacement copy is not recorded as a new prompt', () => {
  const d = unitFor()
  let state = d.apply({ entries: [] }, userMsg('real prompt', { seq: 1 }))
  // A replacement `user/message` shadows earlier events; it is model-only.
  const copy = {
    type: 'user/message',
    seq: 2,
    time: 2000,
    data: { role: 'user', content: [text('compacted summary')], source: { kind: 'user' } },
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 },
  }
  state = d.apply(state, copy)
  assert.deepEqual(state.entries, [], 'shadowed rows dropped, copy not added')
})

test('a prompt missing surfaceOp is ignored', () => {
  const d = unitFor()
  const state = { entries: [] }
  const noOp = { type: 'user/message', seq: 1, time: 1, data: userMsg('x').data }
  assert.equal(d.apply(state, noOp), state)
})

/* --------------------------------------------------------------------- Config */

test('declares a Config so the detail page can configure the entry cap', () => {
  assert.equal(typeof Config, 'function', 'a schemastery schema is callable')
  // A volatile field resolves to a cell, so read it the way the plugin does.
  const read = input => Config(input).maxEntries.get()
  assert.equal(read({}), 200, 'the default fills a missing key')
  assert.equal(read({ maxEntries: 5 }), 5, 'an explicit value wins')
})

test('Config bounds the entry cap the panel can write', () => {
  // The expected messages are the real schemastery wording, so these regexes
  // hold against the installed library as well as the stand-in.
  assert.throws(() => Config({ maxEntries: 0 }), /maxEntries expected number >= 1 but got 0/)
  assert.throws(() => Config({ maxEntries: -1 }), /maxEntries expected number >= 1 but got -1/)
  assert.throws(() => Config({ maxEntries: 5001 }), /maxEntries expected number <= 5000 but got 5001/)
  assert.throws(() => Config({ maxEntries: 1.5 }), /maxEntries expected number multiple of 1 but got 1.5/)
  assert.throws(() => Config({ maxEntries: 'many' }), /maxEntries expected number but got many/)
})

test('a configured cap reaches the fold', () => {
  const d = unitFor(Config({ maxEntries: 2 }))
  let state = d.init({}, 0)
  for (let i = 1; i <= 4; i += 1) state = d.apply(state, userMsg(`m${i}`, { seq: i }))
  assert.deepEqual(state.entries.map((e) => e.text), ['m3', 'm4'])
})

test('a volatile maxEntries is unwrapped, not coerced to NaN', () => {
  // `.volatile()` resolves a field to a cell with `get()`, so reading
  // `config.maxEntries` directly yields an object and `Number(...)` gives NaN —
  // which would pin the cap at the default and ignore the user's setting. A bare
  // number must still work, for a row whose config bypassed the provider.
  const viaCell = unitFor(Config({ maxEntries: 3 }))
  let state = viaCell.init({}, 0)
  for (let i = 1; i <= 4; i += 1) state = viaCell.apply(state, userMsg(`m${i}`, { seq: i }))
  assert.deepEqual(state.entries.map((e) => e.text), ['m2', 'm3', 'm4'], 'cap 3 came from the volatile cell')
  for (const plain of [{ maxEntries: 1 }, { maxEntries: 300 }]) {
    const d = unitFor(plain)
    let s = d.init({}, 0)
    for (let i = 1; i <= 4; i += 1) s = d.apply(s, userMsg(`m${i}`, { seq: i }))
    // The cap bounds the list; it does not pad it.
    assert.equal(s.entries.length, Math.min(4, plain.maxEntries), JSON.stringify(plain))
  }
})

test('maxEntries is volatile, or the Host drops the whole namespace', () => {
  // `dsh-settings` keeps only volatile fields when deciding which entries the
  // Plugins page may edit (`volatileForm`, dsh-settings/lib/index.js). A plain
  // scalar contributes nothing, so an all-scalar Config folds to an empty object
  // and the row gets no form at all. This is the regression that left the
  // control permanently disabled.
  assert.equal(Config.dict.maxEntries.meta.volatile, true)
})

test('the Config survives the Host volatile fold', () => {
  // The shape of `volatileForm` verbatim, over our real schema.
  const volatileForm = schema => {
    if (schema.meta.volatile) return schema
    if (schema.type !== 'object') return undefined
    const dict = Object.fromEntries(
      Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = volatileForm(child)
        return field === undefined ? [] : [[key, field]]
      }),
    )
    return Object.keys(dict).length === 0 ? undefined : { type: 'object', dict }
  }
  const folded = volatileForm(Config)
  assert.notEqual(folded, undefined, 'the namespace must survive, or no form is rendered')
  assert.ok(folded.dict.maxEntries, 'maxEntries must survive the fold')
})

test('the Config is a native schemastery schema the Host recognises', () => {
  // `isNativeConfigSchema` (dsh-app-boot) is the other half of the contract:
  // without the schemastery marker and a string `type`, the entry reports
  // `unsupported` and is skipped.
  assert.equal(Reflect.get(Config, Symbol.for('schemastery')), true)
  assert.equal(typeof Reflect.get(Config, 'type'), 'string')
  assert.notEqual(Reflect.get(Config, 'meta'), null)
})
