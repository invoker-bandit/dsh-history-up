/**
 * Executable checks for the Client half, driving the real client.js through a
 * minimal hook harness and a fake element tree (no React, no browser).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CLIENT = new URL('../client.js', import.meta.url).pathname

/* ------------------------------------------------------------------ fake DOM */

/** Match the selector forms this plugin actually uses. */
function matches(el, sel) {
  for (const part of sel.split(',')) {
    const s = part.trim()
    if (s === 'iframe' && el.tag === 'iframe') return true
    if (s.startsWith('.')) {
      if (el.cls && el.cls.split(' ').includes(s.slice(1))) return true
      continue
    }
    const m = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(s)
    if (m && m[1] in el.attrs) {
      if (m[2] === undefined || el.attrs[m[1]] === m[2]) return true
    }
  }
  return false
}

function makeEl(tag, attrs, cls, doc) {
  const el = { tag, attrs, cls, ownerDocument: doc }
  el.getAttribute = (n) => (n in attrs ? attrs[n] : null)
  el.closest = (sel) => {
    let node = el
    while (node) {
      if (matches(node, sel)) return node
      node = node.parent
    }
    return null
  }
  el.contains = (other) => {
    let node = other
    while (node) {
      if (node === el) return true
      node = node.parent
    }
    return false
  }
  return el
}

/** A composer editor inside the seat inside the session body. */
function makeTree({ selectionText = '' } = {}) {
  const doc = {
    getSelection: () => ({
      rangeCount: 1,
      getRangeAt: () => ({
        cloneRange() {
          return { setStart() {}, toString: () => selectionText }
        },
      }),
    }),
  }
  const body = makeEl('div', { 'data-conversation-session': 'S1', 'data-conversation-region': 'chat' }, null, doc)
  const seat = makeEl('div', { 'data-conversation-region': 'composer' }, null, doc)
  seat.parent = body
  const editor = makeEl('div', { 'data-composer-input': '' }, null, doc)
  editor.parent = seat
  return { doc, body, seat, editor, selectionText }
}

/* -------------------------------------------------------------- fake React */

function makeReact() {
  const cells = []
  let i = 0
  const pending = []
  let rerenderHook = null
  /**
   * A minimal `createElement` producing `{ type, props }` with children folded
   * into `props.children` — the shape the config-form tests walk. Children are
   * always an array so the walker has one shape to recurse into. No rendering
   * happens: the form is inspected, not mounted.
   */
  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 0 ? [] : children },
  })
  return {
    createElement,
    hooks: {
      useRef(initial) {
        const n = i++
        if (cells[n] === undefined) cells[n] = { current: initial }
        return cells[n]
      },
      useState(initial) {
        const n = i++
        if (cells[n] === undefined) cells[n] = { value: typeof initial === 'function' ? initial() : initial }
        const cell = cells[n]
        const set = next => {
          cell.value = typeof next === 'function' ? next(cell.value) : next
          // A real render cycle: re-run every effect, as React would.
          if (rerenderHook !== null) rerenderHook()
        }
        return [cell.value, set]
      },
      useEffect(fn, deps) {
        const n = i++
        const prev = cells[n]
        if (prev === undefined || deps.some((d, k) => !Object.is(d, prev.deps?.[k]))) {
          cells[n] = { deps, fn }
          pending.push(fn)
        }
      },
    },
    /** Re-run the mounted component so effects and rendered output settle. */
    rerender(render) {
      rerenderHook = () => {
        if (render === undefined) return
        i = 0
        render()
        this.flush()
      }
    },
    clearRerender: () => {
      rerenderHook = null
    },
    flush: () => {
      while (pending.length) pending.shift()()
    },
    /** Unmount: run every recorded effect's cleanup, as React would. */
    allCleanups: () => {
      const out = []
      for (const cell of cells) {
        if (cell && typeof cell.fn === 'function') {
          const cleanup = cell.fn()
          if (typeof cleanup === 'function') out.push(cleanup)
        }
      }
      return out
    },
    reset: () => {
      i = 0
    },
  }
}

/* ----------------------------------------------------------- plugin harness */

function boot() {
  const src = readFileSync(CLIENT, 'utf8')
  let captured
  new Function('window', src)({ __ModuleLoader__: { load: (m) => (captured = m) } })

  const react = makeReact()
  // client.js does `const React = require('react')` and destructures both the
  // hooks and `createElement` off it.
  const exported = captured.factory((name) => {
    if (name === 'react') return { ...react.hooks, createElement: react.createElement }
    throw new Error(`unexpected require(${name})`)
  })

  // The plugin injects two slots; `requested` remembers which one is being
  // injected so each registration lands under its own name.
  let requested = null
  const registered = new Map()
  let observer = null
  let source = null
  const ctx = {
    slots: {
      inject: (name, fn) => {
        requested = name
        fn()
        requested = null
      },
      register: (s, c) => {
        registered.set(requested, { spec: s, comp: c })
        return { spec: s, comp: c }
      },
    },
    shortcuts: { observeFixedInput: (fn) => ((observer = fn), () => {}) },
    inputTriggers: { registerSource: (s) => ((source = s), () => {}) },
    effect: (fn) => fn(),
  }
  exported.apply(ctx)

  const dock = registered.get('conversation.composer.dock')
  const config = registered.get('plugins.row.config')
  return {
    component: dock.comp,
    spec: dock.spec,
    configComponent: config.comp,
    configSpec: config.spec,
    source,
    observer,
    react,
  }
}

/** Mount the entry for a session and return its bridge. */
function mount(plugin, { entries = [], draft = '', claim } = {}) {
  const { component, react } = plugin
  const written = []
  const state = { draft, claim, entries }
  const props = {
    sessionId: 'S1',
    useProjection: () => ({ entries }),
    useInput: (selector) => selector(state),
    inputActions: { setDraft: (t) => { written.push(t); state.draft = t } },
  }
  react.reset()
  const out = component(props)
  react.flush()
  return {
    out,
    written,
    state,
    setDraft: (t) => { state.draft = t },
    rerender: () => { react.reset(); component(props); react.flush() },
  }
}

/** Deliver one arrow keydown to the observed handler. */
function key(plugin, { code = 'ArrowUp', target, selectionText = '', ...over } = {}) {
  let consumed = false
  const tree = makeTree({ selectionText })
  const element = target ?? tree.editor
  plugin.observer({
    type: 'keydown',
    gesture: {
      code,
      control: false,
      alt: false,
      shift: false,
      meta: false,
      repeat: false,
      composing: false,
      defaultPrevented: false,
      ...over,
    },
    context: { region: 'editable', modal: null, target: element },
    consume: () => {
      consumed = true
    },
  })
  return consumed
}

/* -------------------------------------------------------------------- tests */

test('registers a session-scoped dock entry and declares its services', () => {
  const plugin = boot()
  assert.deepEqual(plugin.spec, {
    name: 'conversation.composer.dock',
    id: 'dsh-history-up',
    order: 10,
  })
  assert.equal(mount(plugin).out, null, 'entry renders nothing')
})

test('Up walks backwards through the session prompts and consumes the key', () => {
  const plugin = boot()
  const m = mount(plugin, { entries: [{ text: 'one' }, { text: 'two' }] })
  assert.equal(key(plugin), true)
  assert.equal(key(plugin), true)
  assert.deepEqual(m.written, ['two', 'one'])
})

test('Down past the newest entry restores the stashed draft', () => {
  const plugin = boot()
  const m = mount(plugin, { entries: [{ text: 'work a' }, { text: 'work b' }, { text: 'work c' }], draft: 'work' })
  key(plugin) // newest: 'work c'
  key(plugin) // 'work b'
  key(plugin) // oldest: 'work a'
  assert.equal(m.state.draft, 'work a')
  key(plugin, { code: 'ArrowDown' })
  assert.equal(m.state.draft, 'work b', 'Down moves toward newer')
  key(plugin, { code: 'ArrowDown' })
  assert.equal(m.state.draft, 'work c')
  key(plugin, { code: 'ArrowDown' })
  assert.equal(m.state.draft, 'work', 'past the newest entry the stash returns')
  assert.deepEqual(m.written, ['work c', 'work b', 'work a', 'work b', 'work c', 'work'])
  // The walk is over, so Down now belongs to the editor again.
  assert.equal(key(plugin, { code: 'ArrowDown' }), false)
})

test('Down does nothing before any Up has started a walk', () => {
  const plugin = boot()
  const m = mount(plugin, { entries: [{ text: 'one' }], draft: 'typing' })
  assert.equal(key(plugin, { code: 'ArrowDown' }), false, 'key is not consumed')
  assert.deepEqual(m.written, [])
})

test('a typed first line filters the list by prefix', () => {
  const plugin = boot()
  const m = mount(plugin, {
    entries: [{ text: 'git status' }, { text: 'npm test' }, { text: 'git commit -m x' }],
    draft: 'git',
  })
  key(plugin)
  key(plugin)
  key(plugin)
  assert.deepEqual(m.written, ['git commit -m x', 'git status'])
})

test('a prefix that matches nothing leaves the key to the editor', () => {
  const plugin = boot()
  const m = mount(plugin, { entries: [{ text: 'npm test' }], draft: 'zzz' })
  assert.equal(key(plugin), false)
  assert.deepEqual(m.written, [])
})

test('Up stays with the editor when the caret is below the first line', () => {
  const plugin = boot()
  const m = mount(plugin, { entries: [{ text: 'one' }], draft: 'a\nb' })
  assert.equal(key(plugin, { selectionText: 'a\n' }), false)
  assert.deepEqual(m.written, [])
})

test('Up is claimed once the caret is back on the first line', () => {
  const plugin = boot()
  // The first line is the prefix, so it has to match for a recall to happen.
  const m = mount(plugin, { entries: [{ text: 'one' }], draft: 'one\nsecond line' })
  assert.equal(key(plugin, { selectionText: 'one\n' }), false, 'caret below line one')
  assert.equal(key(plugin, { selectionText: '' }), true, 'caret back on line one')
  assert.deepEqual(m.written, ['one'])
})

test('a slash-command claim owns the arrow keys', () => {
  const plugin = boot()
  const m = mount(plugin, { entries: [{ text: 'one' }], claim: { token: '/mod' } })
  assert.equal(key(plugin), false)
  assert.deepEqual(m.written, [])
})

test('keys with modifiers, repeats, composition, or a modal are ignored', () => {
  const plugin = boot()
  for (const over of [{ control: true }, { alt: true }, { shift: true }, { meta: true }, { repeat: true }, { composing: true }, { defaultPrevented: true }]) {
    const m = mount(plugin, { entries: [{ text: 'one' }] })
    assert.equal(key(plugin, over), false, JSON.stringify(over))
    assert.deepEqual(m.written, [])
  }
  const m = mount(plugin, { entries: [{ text: 'one' }] })
  let consumed = false
  plugin.observer({
    type: 'keydown',
    gesture: { code: 'ArrowUp', control: false, alt: false, shift: false, meta: false, repeat: false, composing: false, defaultPrevented: false },
    context: { region: 'editable', modal: 'confirm', target: makeTree().editor },
    consume: () => { consumed = true },
  })
  assert.equal(consumed, false, 'a modal blocks it')
})

test('a key outside the composer region is ignored', () => {
  const plugin = boot()
  const tree = makeTree()
  const chat = makeEl('div', { 'data-composer-input': '' }, null, tree.doc)
  chat.parent = tree.body // the chat region, not the composer seat
  const m = mount(plugin, { entries: [{ text: 'one' }] })
  assert.equal(key(plugin, { target: chat }), false)
  assert.deepEqual(m.written, [])
})

test('a key from another session is ignored', () => {
  const plugin = boot()
  const doc = { getSelection: () => null }
  const other = makeEl('div', { 'data-conversation-session': 'OTHER', 'data-conversation-region': 'chat' }, null, doc)
  const seat = makeEl('div', { 'data-conversation-region': 'composer' }, null, doc)
  seat.parent = other
  const editor = makeEl('div', { 'data-composer-input': '' }, null, doc)
  editor.parent = seat
  const m = mount(plugin, { entries: [{ text: 'one' }] })
  assert.equal(key(plugin, { target: editor }), false)
  assert.deepEqual(m.written, [])
})

test('an empty history leaves the key alone', () => {
  const plugin = boot()
  const m = mount(plugin, { entries: [] })
  assert.equal(key(plugin), false)
  assert.deepEqual(m.written, [])
})

test('Up at the oldest entry is swallowed instead of moving the caret', () => {
  const plugin = boot()
  const m = mount(plugin, { entries: [{ text: 'one' }] })
  key(plugin)
  assert.equal(key(plugin), true, 'still consumed, caret stays put')
  assert.deepEqual(m.written, ['one'])
})

test('editing a recalled draft resets the walk', () => {
  const plugin = boot()
  const m = mount(plugin, { entries: [{ text: 'aa 1' }, { text: 'bb 1' }, { text: 'aa 2' }] })
  key(plugin) // newest: 'aa 2'
  key(plugin) // back one: 'bb 1'
  assert.deepEqual(m.written, ['aa 2', 'bb 1'])

  // The user types, which re-anchors the walk on their new text.
  m.setDraft('aa')
  m.rerender()
  key(plugin)

  // Restarted at the newest match for 'aa' rather than continuing the old walk,
  // which had one step left and would have offered 'aa 1'.
  assert.deepEqual(m.written, ['aa 2', 'bb 1', 'aa 2'])
})

test('a missing inputActions face declines the bridge rather than throwing', () => {
  const plugin = boot()
  const { component, react } = plugin
  const props = { sessionId: 'S1', useProjection: () => ({ entries: [] }), useInput: (s) => s({ draft: '' }) }
  react.reset()
  assert.doesNotThrow(() => { component(props); react.flush() })
  assert.equal(key(plugin), false, 'no bridge was published')
})

test('the bridge is withdrawn when the entry unmounts', () => {
  const plugin = boot()
  const { component, react, observer } = plugin
  const written = []
  const props = {
    sessionId: 'S1',
    useProjection: () => ({ entries: [{ text: 'one' }] }),
    useInput: (s) => s({ draft: '' }),
    inputActions: { setDraft: (t) => written.push(t) },
  }
  react.reset()
  component(props)
  react.flush()
  assert.equal(key(plugin), true, 'mounted entry answers')
  assert.deepEqual(written, ['one'])

  // Unmount: React runs the effect cleanup, which must withdraw the bridge.
  react.reset()
  for (const cell of react.allCleanups()) cell()
  assert.equal(key(plugin), false, 'no bridge remains after unmount')
  assert.deepEqual(written, ['one'], 'nothing further was written')
  assert.ok(observer)
})

/* -------------------------------------------------- plugins.row.config form */

/** Walk a rendered element tree, collecting every node. */
function walk(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  if (Array.isArray(node.props?.children)) node.props.children.forEach(child => walk(child, out))
  return out
}

/** Every text string inside a rendered tree, in order. */
function textsOf(node, out = []) {
  for (const child of node?.props?.children ?? []) {
    if (typeof child === 'string') out.push(child)
    else if (child !== null && typeof child === 'object') textsOf(child, out)
  }
  return out
}
function mountConfig(plugin, { view = 'page', value = 200, status = 'ready', writable = true, revision = 7, withForm = true } = {}) {
  const { configComponent, react } = plugin
  const calls = []
  const form = withForm
    ? {
        state: { status, value: { maxEntries: value }, revision, writable },
        mutate: (ops, rev) => {
          calls.push({ ops, rev })
          return Promise.resolve(true)
        },
      }
    : undefined
  react.reset()
  const out = configComponent({ view, form })
  react.flush()
  return { out, calls, react, render: () => mountConfig(plugin, { view, value, status, writable, revision, withForm }) }
}

test('registers a plugins.row.config entry keyed by package and row id', () => {
  const plugin = boot()
  assert.equal(plugin.configSpec.name, 'plugins.row.config')
  assert.equal(plugin.configSpec.key, '@local/dsh-history-up#dsh-history-up')
})

test('the config form shows the cap the Host resolves', () => {
  const plugin = boot()
  const nodes = walk(mountConfig(plugin, { value: 42 }).out)
  const input = nodes.find(n => n.type === 'input')
  assert.ok(input, 'a number input is rendered')
  assert.equal(input.props.value, '42')
  assert.equal(input.props.min, 1)
  assert.equal(input.props.max, 5000)
})

test('saving writes maxEntries through the owner mutate with the read revision', async () => {
  const plugin = boot()
  const m = mountConfig(plugin, { value: 200, revision: 7 })
  const input = walk(m.out).find(n => n.type === 'input')
  input.props.onChange({ target: { value: '300' } })
  const after = m.render()
  const button = walk(after.out).find(n => n.type === 'button')
  button.props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(after.calls.length, 1)
  assert.deepEqual(after.calls[0].ops, [{ op: 'set', path: ['maxEntries'], value: 300 }])
  assert.equal(after.calls[0].rev, 7, 'the write is fenced by the revision the editor read')
})

test('an out-of-range or non-integer draft cannot be saved', () => {
  const plugin = boot()
  for (const bad of ['0', '5001', '1.5', '', 'abc']) {
    const m = mountConfig(plugin, { value: 200 })
    walk(m.out).find(n => n.type === 'input').props.onChange({ target: { value: bad } })
    const after = m.render()
    const button = walk(after.out).find(n => n.type === 'button')
    assert.equal(button.props.disabled, true, `draft ${JSON.stringify(bad)} must not be savable`)
    assert.equal(after.calls.length, 0)
  }
})

test('a missing or unwritable form degrades instead of throwing', () => {
  const plugin = boot()
  const absent = mountConfig(plugin, { withForm: false })
  const nodes = walk(absent.out)
  assert.ok(nodes.some(n => n.type === 'input'), 'the control still renders')
  assert.equal(nodes.find(n => n.type === 'input').props.disabled, true)
  assert.ok(
    textsOf(absent.out).some(t => t.includes('cordis.patch.yml')),
    'it says where the value can still be changed',
  )

  const readOnly = mountConfig(plugin, { writable: false })
  assert.equal(walk(readOnly.out).find(n => n.type === 'input').props.disabled, true)
})

test('the summary view is a one-liner, not a form', () => {
  const plugin = boot()
  const m = mountConfig(plugin, { view: 'summary', value: 77 })
  const nodes = walk(m.out)
  assert.equal(nodes.some(n => n.type === 'input'), false)
  assert.equal(nodes.some(n => n.type === 'button'), false)
  assert.ok(textsOf(m.out).some(t => t.includes('77')))
})

/* ----------------------------------------------------- /history picker menu */

/** Mount the dock entry, then drive the registered trigger source. */
function picker(plugin, { entries = [], sessionId = 'S1', mountIt = true } = {}) {
  if (mountIt) mount(plugin, { entries }).rerender()
  const controller = new AbortController()
  return { source: plugin.source, session: { sessionId }, controller, get signal() { return controller.signal } }
}

/** A candidate request at one query/drill level. */
function req({ query = '', drilled = false, signal } = {}) {
  return { query, drilled, position: 'leading', quoted: false, signal }
}

test('registers a / trigger source for the history group', () => {
  const plugin = boot()
  assert.equal(plugin.source.trigger, '/')
  assert.equal(plugin.source.name, 'history-input')
  assert.equal(plugin.source.showGroupTitle, false)
  assert.equal(typeof plugin.source.candidates, 'function')
  assert.equal(typeof plugin.source.onPick, 'function')
  assert.equal(typeof plugin.source.header, 'function')
})

test('a bare / offers one drillable row carrying a glyph', async () => {
  const plugin = boot()
  const p = picker(plugin, { entries: [{ seq: 0, text: 'alpha' }] })
  const rows = await p.source.candidates(p.session, req({ signal: p.signal }))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].label, '历史输入')
  assert.equal(typeof rows[0].icon, 'function', 'the row needs a glyph')
  assert.equal(rows[0].drill, true, 'the chevron is what opens the second level')
  assert.equal(rows[0].value, 'root')
})

test('drilling or typing /history opens the prompt list', async () => {
  const plugin = boot()
  const p = picker(plugin, { entries: [{ seq: 0, text: 'alpha' }, { seq: 1, text: 'beta' }] })
  const drilled = await p.source.candidates(p.session, req({ drilled: true, signal: p.signal }))
  const typed = await p.source.candidates(p.session, req({ query: 'history', signal: p.signal }))
  for (const rows of [drilled, typed]) {
    assert.deepEqual(rows.map(r => r.name), ['beta', 'alpha'], 'newest first')
    assert.deepEqual(rows.map(r => r.value), ['entry:1', 'entry:0'])
    assert.equal(typeof rows[0].icon, 'function')
  }
})

test('the list shows a first line and carries the rest as a description', async () => {
  const plugin = boot()
  const p = picker(plugin, { entries: [{ seq: 0, text: 'one\ntwo' }, { seq: 1, text: 'x'.repeat(200) }] })
  const rows = await p.source.candidates(p.session, req({ drilled: true, signal: p.signal }))
  assert.equal(rows.find(r => r.value === 'entry:0').name, 'one')
  assert.equal(rows.find(r => r.value === 'entry:0').description, 'two')
  const long = rows.find(r => r.value === 'entry:1')
  assert.equal(long.name.length, 72)
  assert.ok(long.name.endsWith('…'))
  assert.equal(long.description, undefined, 'a single-line prompt needs no description')
})

test('the list is capped at 20 rows, newest kept', async () => {
  const plugin = boot()
  const entries = Array.from({ length: 25 }, (_, i) => ({ seq: i, text: `m${i + 1}` }))
  const p = picker(plugin, { entries })
  const rows = await p.source.candidates(p.session, req({ drilled: true, signal: p.signal }))
  assert.equal(rows.length, 20)
  assert.equal(rows[0].name, 'm25')
  assert.equal(rows.at(-1).name, 'm6')
})

test('a session with no mounted entry lists nothing at either level', async () => {
  const plugin = boot()
  const p = picker(plugin, { entries: [{ seq: 0, text: 'a' }] })
  assert.deepEqual(await p.source.candidates({ sessionId: 'NOPE' }, req({ signal: p.signal })), [])
  assert.deepEqual(await p.source.candidates({ sessionId: 'NOPE' }, req({ drilled: true, signal: p.signal })), [])
})

test('a cancelled request lists nothing', async () => {
  const plugin = boot()
  const p = picker(plugin, { entries: [{ seq: 0, text: 'a' }] })
  p.controller.abort()
  assert.deepEqual(await p.source.candidates(p.session, req({ signal: p.signal })), [])
})

test('picking the root re-enters the trigger so the list opens', () => {
  const plugin = boot()
  const p = picker(plugin, { entries: [{ seq: 0, text: 'a' }] })
  for (const action of ['pick', 'drill']) {
    const outcome = p.source.onPick({ candidate: { value: 'root' }, action, session: p.session })
    assert.deepEqual(outcome, { text: '/history', continue: true }, action)
  }
})

test('picking a prompt yields the text the pipeline inserts', () => {
  const plugin = boot()
  const p = picker(plugin, { entries: [{ seq: 0, text: 'alpha' }, { seq: 1, text: 'beta' }] })
  const outcome = p.source.onPick({ candidate: { value: 'entry:0' }, action: 'pick', session: p.session })
  assert.deepEqual(outcome, { text: 'alpha' })
})

test('an unknown or missing value is declined rather than guessed at', () => {
  const plugin = boot()
  const p = picker(plugin, { entries: [{ seq: 0, text: 'alpha' }] })
  assert.equal(p.source.onPick({ candidate: { value: 'entry:99' }, action: 'pick', session: p.session }), undefined)
  assert.equal(p.source.onPick({ candidate: { value: 'other:1' }, action: 'pick', session: p.session }), undefined)
  assert.equal(
    p.source.onPick({ candidate: { value: 'entry:0' }, action: 'pick', session: { sessionId: 'NOPE' } }),
    undefined,
    'a pick after unmount must not throw',
  )
})

test('a drill on an entry re-opens the list instead of inserting it', () => {
  const plugin = boot()
  const p = picker(plugin, { entries: [{ seq: 0, text: 'alpha' }] })
  assert.deepEqual(
    p.source.onPick({ candidate: { value: 'entry:0' }, action: 'drill', session: p.session }),
    { text: '/history', continue: true },
  )
})

test('the breadcrumb appears only at the drilled level', () => {
  const plugin = boot()
  const p = picker(plugin, { entries: [{ seq: 0, text: 'a' }] })
  assert.equal(p.source.header(p.session, { query: 'history', drilled: false }), undefined)
  assert.deepEqual(p.source.header(p.session, { query: 'history', drilled: true }), [{ label: '历史输入', value: 'root' }])
})
