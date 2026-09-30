# dsh-history-up — technical notes

User-facing documentation: [README.en.md](README.en.md) (中文 [README.md](README.md)).
This file covers mechanism and trade-offs only.

## Architecture

Two halves, on two different load paths:

| Half | File | How it loads |
|---|---|---|
| Host | `index.js` | imported by the Loader — needs a **restart** for a new module generation |
| Client | `client.js` | fetched by the browser's module loader — a page refresh is enough |

That skew cost the most debugging time in this project: editing `client.js`
shows up on refresh, editing `index.js` does not. When "I changed it and nothing
happened", establish which generation the running process holds before anything
else.

**Only `index.js`'s projection is the data source.** `client.js` never folds log
events itself; it reads the served projection and writes drafts. The history is
therefore rebuilt from the log after a reload and on a cold read, and a browser
that never saw a submission does not affect it.

## Recording (Host)

The Host registers one `sessionProjections` unit keyed `inputHistory` and folds
committed Session events.

**Three filters, all required:**

| Condition | What it excludes |
|---|---|
| `type === 'user/message'` | tool calls, lifecycle events, everything else |
| `surfaceOp === 'append'` | the model-visible surface deliberately shadows replaced ranges, so a replacement copy is not a new prompt |
| `data.source.kind === 'user'` | `goal`, `schedule`, `subagent-settled`, `agent-message` and other injected context |

**Why the log rather than local state**: the Session log is the only source of
truth. An input that never reached the model is not part of the session, so
"a failed send is not recorded" falls out as a consequence rather than a special
case. The alternative — capturing the browser's local submission echo so failed
prompts survive — would mean a second, client-owned store that can disagree with
the log after a reload.

**Reference stability** is deliberate: every irrelevant log event returns the
**same state reference** (`Object.is` hit), so the registry skips all downstream
view work. `apply` must therefore be pure and must not mutate the state it is
given.

**The entry cap** truncates during the fold (`entries.slice(-maxEntries)`), not
at render time — otherwise the overflow would sit in the checkpoint forever.

## Arrow keys (Client)

The composer is a host-owned Lexical editor. It publishes **no** editor handle,
ref, or command registration, and deliberately leaves unclaimed keys to the
editor. So key observation goes through `ctx.shortcuts.observeFixedInput()` — a
documented, feature-plugin hook returning the focused DOM element plus a
`consume()`.

It runs in the bubble phase on `window`, **after** the editor; but the caret
movement it must suppress is a default action that only runs once dispatch
completes, and the editor's ArrowUp handler calls no `preventDefault` when no
trigger menu is open — so `consume()` lands in time.

**Session routing** copies the composer package's own stop-shortcut: the nearest
`data-conversation-region` ancestor must be the composer seat, must sit inside a
`data-conversation-session` body, and the key must not come from an approval
surface, an embedded frame, a terminal, or inert content.

The observer is global while everything it touches is per session, so a
module-level `bridges: Map<sessionId, bridge>` bridges the two: the dock entry
publishes its handler while mounted, and the observer routes a keystroke to the
entry that owns the session it landed in.

**The dock entry renders nothing** — this is a keybinding, and the dock is a
narrow strip where a caption would be noise.

## The `/history` two-level menu

Entirely client-side, registered on `ctx.inputTriggers`.

### Why an input-trigger source, not a command

Three reasons, all enforced by the Host:

1. **The glyph.** Every other icon-bearing row in that menu — file, goal, plan,
   feedback — is an input-trigger source. `commandUi.register` (contributions)
   is called **nowhere** in the installed app; only `decorate` is (5 times). A
   command row renders through
   `builtinRowFace(c, t) ?? { description: c.description }`, which gives a
   third-party command neither `label` nor `icon`. That is the direct cause of
   the missing icon.
2. **The second level.** Only a source has `drill`:

   > The row offers a drill action beside the settling pick: Tab or the row's
   > chevron refines the query in place (directory descent) instead of resolving
   > the candidate.

3. **It cannot also be a host command.** While `dsh-client-ui-commands`
   synthesises candidates, `seen.has(contribution.name)` **throws**. A `/history`
   that is both a host command and a client row would break the entire `/` menu.
   So `index.js` no longer registers `/history` and keeps only the projection.

> The cost: there is no longer a Host `/history`, so any non-desktop or
> scripted "list my history" affordance is gone. The desktop UI does not need
> one.

### The drill protocol

The authoritative shape comes from the shipped `dsh-client-ui-reference`
directory drill:

```js
if (directory && action === 'drill') return { text: value.mention, continue: true }
```

`continue: true` keeps the trigger alive; `drilled` is set and the menu re-fetches.

Both routes into the second level are kept:

| Gesture | Path |
|---|---|
| Click / Enter | `onPick` returns `{ text: '/history', continue: true }` → the trigger survives → `candidates` sees `query === 'history'` |
| Chevron / <kbd>Tab</kbd> | `action === 'drill'` → `drilled` is set → `candidates` sees `req.drilled` |

Only a bare `/` shows the first level. `header()` returns a breadcrumb only
while drilled; clicking it routes back through `action: 'drill'`.

**Writes go through the pipeline**: `onPick` returns `{ text }`, which
input-trigger inserts through the `slash/input-insert-text` event. The source
never touches the composer, so "pick a row" and "recall with ↑" are consistent
by construction.

Each row carries its own `value` (`root` / `entry:<seq>`) and `onPick` dispatches
on it; an unknown value returns `undefined` rather than a guess.

### Icons

`HistoryIcon` (an up arrow) and `HistoryEntryIcon` (a rewind arrow) are drawn
here, take only `{ size, className }`, and inherit their colour from
`currentColor`.

**No** import of `@deepseek-ai/dsh-client-ui-primitives`: `practices.md` forbids
loading any Harness Client package (those icons change without notice and carry
no type check). The `icon` field is declared `ComponentType<IconProps>`, so a
locally drawn component satisfies it.

## The three traps in the config form

Three conditions must hold together for a row to be editable on its detail page.
Miss any one and the control is **greyed out with no error**.

### Trap one — `Config` alone is not enough

`dsh-client-ui-plugin-manager` decides a row is configurable by exactly one
mechanism: whether the Client registered an entry in the `plugins.row.config`
slot under the key `<package name>#<row id>`.

```js
has: (row) => ledger.rows.has(rowConfigKey(pkg.name, row.rowId))
```

The Host has **no** generic bridge turning a `Config` into a form.
`dsh-session-log-export` declares a `Config` too and its detail page has no form
either.

So this plugin draws its own (`MaxEntriesConfig`):

- The key must be `@invoker-bandit/dsh-history-up#dsh-history-up`; the row id is the
  `id` in `cordis.patch.yml`.
- The page hands the entry a `form` (`ConfigPageForm`) prop. `form` may be
  entirely `undefined` — the Host only supplies it once the settings mirror
  lists the row as a served namespace. The form degrades to a note saying the
  value can only be changed in `cordis.patch.yml` instead of throwing.
- Read through `form.state`, save through `form.mutate(ops, revision)`, fenced by
  the `revision` that was read.
- Styling uses theme tokens only; no package is imported.

### Trap two — the field must be `.volatile()`

`dsh-settings` folds each schema through `volatileForm` to decide which entries
are editable:

```js
function volatileForm(schema) {
  if (schema.meta.volatile) return plainSchema(schema)   // volatile → kept
  if (schema.type === "object") { /* recurses into object children only */ }
  // a plain scalar falls off the end and returns undefined
}
```

A `Config` whose every field is a plain scalar folds to an empty object, so the
**namespace is discarded**, no `form` is passed, and the control stays disabled
forever. Every shipped editable setting marks its fields (`dsh-client-ui-theme`'s
`fontSize` has this exact shape).

### Trap three — a `.volatile()` field resolves to a cell

It must be read as `config.maxEntries.get()`, exactly as
`dsh-client-ui-theme` reads `config.fontSize.get()`.

```js
// what you actually get
maxEntries: { get: [Function], Symbol(cosmokit.volatile.write): [Function] }
```

Reading `config.maxEntries` yields an object, `Number()` gives `NaN`, and the cap
is **silently** pinned at the default so the user's setting does nothing.
`readMaxEntries` therefore accepts either the cell or a bare scalar.

> All three traps fail silently: no exception, no warning — just a dead control
> or an ignored setting. Run those three regression tests before touching this.

## Dependencies: your own job for a path install, npm's for a registry install

Installing **from npm** resolves dependencies normally with the package and
needs nothing extra.

Installing **from a local path** requires `npm install` in this directory
first. The installer only links the directory into the profile with `link:` and
never installs its `dependencies`; Node resolves the symlink's real path, so
resolution walks the workspace side of the link — and the profile's
`node_modules` holds no dependency of this bundle. Without that step the Host's
import throws `Cannot find package 'zod'` and the console reports
`1 entry did not activate dsh-history-up`.

Two real dependencies: `zod` (the projection schemas) and
`@deepseek-ai/schemastery` (`Config`).

## Publishing to npm

`cordis.patch.yml` **must** be in the `files` allowlist — `dsh.bundle.patch`
points at it, and without it the published package is not a bundle at all and
the installer rejects it with "declares no bundle". npm auto-includes only
`README*`, `LICENSE` and `package.json`, so `TECHNICAL*.md` has to be listed
explicitly too.

An npm package name is permanently taken once published; it cannot be renamed
or reused after deletion.

Renaming the package means changing three places: `name` in `package.json`, the
row's `name` in `cordis.patch.yml`, and the slot key used in `client.js`
(`<package name>#<row id>`) — `configure.has(row)` matches on that string, so
missing it makes the configure entry vanish silently.

## locale must nest under `meta`

The Loader reads `parsed.meta.title` (`dsh-app-boot`):

```json
{ "meta": { "title": "历史输入", "description": "…" } }
```

A flat `{"title", "description"}` is **silently ignored** — the title falls back
to the package name and the description to `package.json`. Both are set in
Chinese, because `package.json`'s `description` is the final fallback when
neither language file supplies text.

## Files

| File | Role |
|---|---|
| `package.json` | Bundle manifest: `dsh.bundle.patch`, `icon`, `dsh.client` |
| `cordis.patch.yml` | Inserts the one Host row |
| `index.js` | Host half: the `inputHistory` projection and `Config` |
| `client.js` | Client half: dock entry, arrow-key observer, the `/history` source, the config form |
| `locale/en.json`, `locale/zh.json` | Panel title and description |
| `icon.svg` | Panel icon |
| `test/` | Unit tests and their runner (not part of the published bundle) |

## Tests

```bash
node test/run.mjs
```

54 tests, needing neither a browser nor `node_modules`. `test/setup.mjs` stages
a stand-in for each of `zod` and `@deepseek-ai/schemastery`.

**The schemastery stand-in deliberately copies the real behaviour** — bounds,
defaults, rejection wording, the `volatile()` marker, and the volatile cell
wrapper. That is not fastidiousness: two of the three config traps above were
found *only* because the stand-in was faithful. An earlier version had neither
`volatile()` nor cells, so "the field is not marked volatile" and "it forgets
`.get()`" both passed the suite while being real bugs.

- `test/host-fold.test.mjs` drives the fold over synthetic Session events
  (recording, injected context, surface replacement, the entry cap, reference
  stability, malformed input) and covers `Config` (default, range rejection, the
  cap reaching the fold, the volatile marker, surviving the Host's volatile
  fold, native-schema recognition, cell unwrapping), plus "must not register a
  host command".
- `test/client-recall.test.mjs` runs the **real** `client.js` through a minimal
  hook harness and a fake element tree, covering the walk, the prefix filter, the
  first-line rule, every modifier/repeat/composition/modal guard, session routing,
  cleanup on unmount, the two-level `/history` source (glyph, drill, breadcrumb,
  ordering, the 20-row cap, elision and detail, an empty session, a cancelled
  signal, a pick writing through, unknown-value refusal), and the config form
  (reading the Host value, saving with the revision fence, refusing an
  out-of-range draft, degrading when `form` is absent or read-only, the summary
  view).

> When a test stand-in drifts from the real package, **verify against the real
> package**. Both times a change landed successfully yet behaved wrongly here,
> the root cause was pinned by
> `cd $DSH_PROFILE_DIR && node -e "import('@invoker-bandit/dsh-history-up')"`.

## Verification status

**Unit-tested.** Behaviour in a real browser can only be confirmed by the person
running it — the sessions that wrote this plugin had neither `plugin_manager` nor
`cordis_inspect_query` available. The checklist is in
[README.en.md](README.en.md#troubleshooting).

## Known trade-offs

- **`/history` is client-only.** See "Why an input-trigger source" above.
- **Replacing an installed bundle needs a restart.** An unchanged slot id does
  not imply updated browser code.
- **No `dsh.peers`.** Installation skips the version pre-check; the cost is no
  compatibility warning after a DSH upgrade.
