/**
 * Host half of `@invoker-bandit/dsh-history-up`.
 *
 * Owns one session projection, `inputHistory`, that folds the committed Session
 * log into the ordered list of prompts the user actually submitted in that
 * session. The browser half only reads the served view and writes drafts, so it
 * never folds log events itself — the split `references/practices.md` asks for
 * ("declare `wire.view` on the Host projection ... the Client does not fold
 * session events itself").
 *
 * Why the log rather than local state: the Session log is the only source of
 * truth, so the history survives reload, survives a browser that never saw the
 * submission, and is rebuilt from a checkpoint on a cold read.
 *
 * This half also registers the `/history` command, which lists the same rows
 * the arrow keys walk. A slash command is logged as `command/run` /
 * `command/done` rather than a `user/message`, so running `/history` never
 * adds itself to the history it prints.
 */
import { z } from 'zod'
import Schema from '@deepseek-ai/schemastery'

/** The projection registry this unit plugs into. */
export const inject = ['sessionProjections']

/** Upper bound on entries kept per session; older rows fall off the front. */
const DEFAULT_MAX_ENTRIES = 200

/**
 * The settings the plugin detail page renders a form for.
 *
 * `Config` is a schemastery schema, not a zod one: declaring it is what makes
 * the row configurable in the Plugins panel, and the Loader validates the
 * row's `config` against it at activation. `maxEntries` is bounded rather than
 * free so a typo cannot ask the fold to retain a meaningless number of rows.
 *
 * The field MUST be marked `volatile()`. `dsh-settings` decides which entries
 * are editable by folding each schema through `volatileForm`
 * (`dsh-settings/lib/index.js`), which keeps a volatile field and recurses into
 * object children — but a plain scalar contributes nothing. A Config whose every
 * field is a plain scalar therefore folds to an empty object, the namespace is
 * dropped, the page passes no `form`, and the row renders with no editable
 * control at all. Every shipped plugin with a user-editable setting marks its
 * fields volatile (`dsh-client-ui-theme`'s `fontSize` is the same shape as this
 * one), and `maxEntries` is that kind of setting: a preference the user tunes at
 * runtime, not a deployment-time constant.
 */
export const Config = Schema.object({
  maxEntries: Schema.number().step(1).min(1).max(5000).default(DEFAULT_MAX_ENTRIES).volatile(),
})

/**
 * One recalled prompt. `seq` ties the row to its log event, so a surface
 * replacement can drop exactly the rows it shadows; `time` is the Host event
 * clock, not the browser's.
 */
const entrySchema = z.object({
  seq: z.number(),
  time: z.number(),
  text: z.string(),
})

/** The Host-side state the registry folds and checkpoints. */
const stateSchema = z.object({
  entries: z.array(entrySchema),
})

/**
 * The value the browser half receives.
 *
 * Structurally the whole state today; declaring it separately leaves room to
 * serve a smaller shape later without a wire change.
 */
const viewSchema = z.object({
  entries: z.array(entrySchema),
})

/**
 * Read the row's `maxEntries`, falling back to the default.
 *
 * The declared `Config` already bounds this value, so the checks below are
 * belt-and-braces rather than the primary guard: a schemastery default fills a
 * missing key, but a row whose config is edited by hand in the patch — the one
 * path that skips the form — must not be able to make the fold keep zero rows
 * or a non-integer count.
 *
 * @param {unknown} config - the row's resolved `config` object.
 * @returns {number} a positive integer entry cap.
 */
function readMaxEntries(config) {
  const raw = config !== null && typeof config === 'object' ? config.maxEntries : undefined
  // A `volatile()` field does not resolve to the value: it resolves to a cell
  // carrying `get()`, exactly as `dsh-client-ui-theme` reads
  // `config.fontSize.get()`. Reading the cell itself would stringify to `[object
  // Object]`, coerce to NaN, and silently pin the cap at the default — so the
  // field is unwrapped here, and a plain scalar still works for a row whose
  // config never went through the settings provider.
  const value = Number(
    raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw,
  )
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_ENTRIES
}

/**
 * Join the plain-text blocks of a `user/message` payload.
 *
 * Only `text` blocks contribute: image, file, and reference blocks are carried
 * as other content types and have no faithful plain-text rendering, so a
 * prompt that is only an attachment records as an empty string and is skipped.
 *
 * @param {readonly unknown[]} content - the message's `content` blocks.
 * @returns {string} the concatenated text, or `''` when there is none.
 */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      text += block.text
    }
  }
  return text
}

/**
 * Whether a `user/message` is one the user typed and sent.
 *
 * Injected context is logged as a separate `user/message` whose `source.kind`
 * is the injecting domain (`goal`, `schedule`, `subagent-settled`,
 * `agent-message`, `cordis-host-runner`, ...). Only `kind: 'user'` is the
 * person at the keyboard, so the fold keys on exactly that.
 *
 * @param {unknown} data - the event payload.
 * @returns {boolean} whether the payload is a user-submitted prompt.
 */
function isUserPrompt(data) {
  if (data === null || typeof data !== 'object') return false
  const source = data.source
  return source !== null && typeof source === 'object' && source.kind === 'user'
}

/**
 * Build the projection definition for one entry cap.
 *
 * @param {number} maxEntries - how many prompts to retain per session.
 * @returns {object} a `ProjectionDefinition` for the registry.
 */
function definitionFor(maxEntries) {
  return {
    key: 'inputHistory',
    stateVersion: 1,
    stateSchema,

    init: () => ({ entries: [] }),

    /**
     * Advance the history by one committed Session event.
     *
     * Returns the same state reference for every event that is not a submitted
     * prompt, which is what makes the registry's `Object.is` gates skip all
     * downstream view work for the overwhelming majority of the log.
     *
     * @param {{ entries: readonly object[] }} state - history before the event.
     * @param {{ type: string, seq: number, time: number, data: unknown, surfaceOp?: unknown }} event - next committed event.
     * @returns {{ entries: readonly object[] }} the original or advanced history.
     */
    apply: (state, event) => {
      // A surface replacement (an edited or retracted message) drops the rows it
      // shadows, so recall never offers text the transcript no longer shows.
      // `surfaceOp` is `'append'` for an ordinary append and
      // `{ op: 'replace', startSeq, endSeq }` for a replacement.
      const op = event.surfaceOp
      if (op !== null && typeof op === 'object' && op.op === 'replace') {
        const start = Number(op.startSeq)
        const end = Number(op.endSeq)
        // A malformed range compares false against everything, which would drop
        // the entire history. An unusable range is left to the surface fold.
        if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end) {
          const kept = state.entries.filter(entry => entry.seq < start || entry.seq > end)
          if (kept.length === state.entries.length) return state
          return { entries: kept }
        }
      }

      if (event.type !== 'user/message' || !isUserPrompt(event.data)) return state
      // `surfaceOp` is `'append'` for an ordinary prompt and
      // `{ op: 'replace', ... }` for a model-only replacement copy. Only an
      // append is a line the user actually wrote: the model-visible surface
      // deliberately shadows replaced ranges, so reading it as a transcript
      // would both invent prompts and erase ones already shown.
      if (event.surfaceOp !== 'append') return state

      const text = textOf(event.data.content)
      if (text === '') return state

      const entries = [...state.entries, { seq: event.seq, time: event.time, text }]
      return { entries: entries.length > maxEntries ? entries.slice(entries.length - maxEntries) : entries }
    },

    wire: {
      viewSchema,
      /**
       * Project the Host state to the value the browser half receives.
       *
       * Returns `state` itself so an unchanged value keeps its reference and
       * suppresses publication across internal-only state changes.
       *
       * @param {{ entries: readonly object[] }} state - the live Host state.
       * @returns {{ entries: readonly object[] }} the served view.
       */
      view: state => state,
    },
  }
}

/**
 * Register the input-history projection.
 *
 * There is deliberately NO `/history` host command. `/history` is a client
 * `commandUi` contribution instead: it renders a picker of this session's
 * prompts and writes the chosen one into the composer. A contribution and a
 * host command cannot share a name — `dsh-client-ui-commands` throws while
 * synthesising menu candidates when one collides with the other — and only the
 * contribution can carry the menu glyph and open a popup, neither of which a
 * host command descriptor can do.
 *
 * @param {object} ctx - the plugin context, carrying `sessionProjections`.
 * @param {unknown} [config] - the row's resolved `config`, validated against `Config`.
 */
export function apply(ctx, config) {
  ctx.sessionProjections.register(definitionFor(readMaxEntries(config)))
}
