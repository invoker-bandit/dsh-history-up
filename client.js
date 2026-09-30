/**
 * Client half of `@invoker-bandit/dsh-history-up`.
 *
 * The Host half records the prompts a session received. This half reads that
 * served projection and writes the composer draft: Up walks back through the
 * list, Down walks forward, and walking past the newest entry restores whatever
 * you had typed.
 *
 * Keyboard handling is worth a note, because the composer offers no key hook of
 * its own. It is a host-owned Lexical editor whose keymap deliberately leaves
 * every key it does not claim to the editor, and the shell publishes no editor
 * handle, ref, or command registration. What it does publish is
 * `ctx.shortcuts.observeFixedInput()` — a documented feature-plugin hook that
 * observes arbitrated input and hands back the focused DOM element plus a
 * `consume()`. Because it runs in the bubble phase on `window` it is *after*
 * the editor, but the caret movement it needs to suppress is a default action
 * that only runs once dispatch completes, and the editor's own ArrowUp handler
 * calls no `preventDefault` when no trigger menu is open. So `consume()` lands
 * in time. This mirrors how the composer package's own stop-shortcut resolves
 * its target, by reading the host's stable `data-conversation-*` attributes.
 *
 * The observer is global, but everything it touches is per-session, so a module
 * map bridges the two: the dock entry publishes a handler for its `sessionId`
 * while it is mounted, and the observer routes a keystroke to the entry that
 * owns the session it landed in.
 *
 * That same bridge carries `/history`: a client command contribution whose
 * popupSelect lists the entries the dock entry already has, and whose pick
 * writes through the same `inputActions` the arrow keys use. The popup receives
 * only a `sessionId`, so the dock entry is what owns both halves.
 */
window.__ModuleLoader__.load({
  id: '@invoker-bandit/dsh-history-up',
  factory(require) {
    const React = require('react');
    const { useEffect, useRef, useState, createElement: h } = React;

    /**
     * Key the Plugins page dispatches a row's configuration under: the bundle's
     * package name and the row id its patch declares. Registering an entry under
     * this exact key is what gives the row its **Configure** control — the page
     * holds no registry of configurable rows of its own.
     */
    const CONFIG_KEY = '@invoker-bandit/dsh-history-up#dsh-history-up';

    /** The `/history` contribution's name; must not collide with a host command. */
    const COMMAND_NAME = 'history';

    /** Entries the picker offers, newest first. */
    const PICKER_ROWS = 20;

    /** Characters of one prompt shown before it is elided. */
    const PICKER_PREVIEW_WIDTH = 72;

    /** The cap `Config` defaults to, mirrored for the form's placeholder. */
    const DEFAULT_MAX_ENTRIES = 200;

    /** Lower and upper bound, matching the Host `Config` schema exactly. */
    const MIN_MAX_ENTRIES = 1;
    const MAX_MAX_ENTRIES = 5000;

    /** Session id to the mounted dock entry that owns that session. */
    const bridges = new Map();

    /** Stable identity for "no history yet". */
    const NO_ENTRIES = Object.freeze([]);

    /** Idle: not browsing, so no stash and no cursor. */
    const IDLE = Object.freeze({ index: -1, list: NO_ENTRIES, stash: '' });

    /**
     * Whether the caret sits on the first visual line of the editor.
     *
     * A shell only recalls history on the first line; above it, Up belongs to
     * the editor as ordinary line movement. Reading the text before the
     * selection answers that without subscribing to selection changes.
     *
     * @param {Element} editor - the composer contenteditable, or a descendant.
     * @returns {boolean} true when Up may be claimed for history.
     */
    function caretOnFirstLine(editor) {
      const doc = editor.ownerDocument;
      const selection = doc === null ? null : doc.getSelection();
      if (selection === null || selection.rangeCount === 0) return true;
      const range = selection.getRangeAt(0).cloneRange();
      range.setStart(editor, 0);
      return !range.toString().includes('\n');
    }

    /**
     * Resolve which session a key landed in, and whether it landed in a composer.
     *
     * Follows the composer package's own stop-shortcut: the nearest
     * `data-conversation-region` ancestor must be the composer seat, it must sit
     * inside a `data-conversation-session` body, and the key must not come from
     * an approval surface, an embedded frame, a terminal, or inert content.
     *
     * @param {Element} target - the focused element reported by the shortcut hook.
     * @returns {string | undefined} the session id, or undefined when unhandled.
     */
    function sessionOf(target) {
      const occurrence = target.closest('[data-conversation-session]');
      const region = target.closest('[data-conversation-region]');
      if (occurrence === null || region === null || !occurrence.contains(region)) return undefined;
      if (region.getAttribute('data-conversation-region') !== 'composer') return undefined;
      if (target.closest('[data-approval-key], iframe, .xterm, [inert]') !== null) return undefined;
      const sessionId = occurrence.getAttribute('data-conversation-session');
      return sessionId === null || sessionId === '' ? undefined : sessionId;
    }

    /**
     * The dock entry: history recall for one session.
     *
     * Renders nothing — the feature is a keybinding, and the dock is a narrow
     * strip where a caption would be noise. All state lives in a ref because no
     * render depends on it.
     *
     * @param {object} props - the session-scoped slot props.
     * @returns {null} always; the entry contributes behavior, not markup.
     */
    function HistoryUp(props) {
      const { sessionId, useProjection, useInput, inputActions } = props;

      const view = useProjection('inputHistory');
      const draft = typeof useInput === 'function' ? useInput(s => s.draft) : '';
      const claim = typeof useInput === 'function' ? useInput(s => s.claim) : undefined;

      // Everything the key handler needs, readable at event time without
      // re-registering the global listener on every render.
      const live = useRef(null);
      if (live.current === null) live.current = { browse: IDLE, written: undefined };
      live.current.entries = view === undefined || view === null ? NO_ENTRIES : view.entries;
      live.current.draft = draft;
      live.current.claim = claim;

      /**
       * Write a draft and remember that this plugin wrote it.
       *
       * @param {string} text - the text to place in the composer.
       */
      const setDraft = text => {
        live.current.written = text;
        inputActions.setDraft(text);
      };

      /**
       * Move one step through the history.
       *
       * @param {number} direction - -1 for Up, +1 for Down.
       * @returns {boolean} whether the step was applied and the key consumed.
       */
      const step = direction => {
        const { entries } = live.current;
        if (entries.length === 0) return false;
        // A slash-command claim owns the arrow keys while it is being typed.
        if (live.current.claim !== undefined) return false;

        const current = live.current.browse;
        if (current.index < 0) {
          // Nothing is being browsed, so there is nothing "after" the present:
          // Down belongs to the editor until an Up press starts a walk.
          if (direction > 0) return false;
          // The first press stashes what is on screen and narrows the list the
          // way a shell does: a partially typed first line becomes a prefix.
          const prefix = live.current.draft.split('\n')[0];
          const list = prefix === '' ? entries : entries.filter(entry => entry.text.startsWith(prefix));
          if (list.length === 0) return false;
          const index = list.length - 1;
          setDraft(list[index].text);
          live.current.browse = { index, list, stash: live.current.draft };
          return true;
        }

        const next = current.index + direction;
        // Past the newest entry, the stash is the honest answer.
        if (next >= current.list.length) {
          setDraft(current.stash);
          live.current.browse = IDLE;
          return true;
        }
        // Already at the oldest entry: swallow Up rather than let the caret
        // jump, since the user is clearly walking the list.
        if (next < 0) return true;
        setDraft(current.list[next].text);
        live.current.browse = { ...current, index: next };
        return true;
      };

      // The bridge outlives individual renders, so it calls through a ref
      // rather than closing over the first render's `step`.
      const handler = useRef(step);
      handler.current = step;

      // A draft change this plugin did not cause means the user is editing, so
      // the stash and the cursor no longer describe what they want.
      useEffect(() => {
        const state = live.current;
        if (state.written !== undefined && draft !== state.written) {
          state.written = undefined;
          state.browse = IDLE;
        }
      }, [draft]);

      useEffect(() => {
        // Without a draft writer the entry has nothing to offer, so it declines
        // the bridge rather than throwing inside the shortcut hook.
        if (sessionId === undefined || sessionId === null) return undefined;
        if (inputActions === undefined || inputActions === null) return undefined;
        const bridge = {
          step: direction => handler.current(direction),
          // `/history` reads these: the popup only receives a `sessionId`, so
          // the mounted entry is the only place that can answer for it. A pick
          // goes through the same `setDraft`, so the arrow-key walk resets and
          // the text lands exactly as a recall would leave it.
          entries: () => live.current.entries,
          write: text => setDraft(text),
        };
        bridges.set(sessionId, bridge);
        return () => {
          if (bridges.get(sessionId) === bridge) bridges.delete(sessionId);
        };
      }, [sessionId, inputActions]);

      return null;
    }

    /**
     * The menu glyph for `/history`.
     *
     * Written here rather than imported: `practices.md` forbids loading any
     * Harness Client package (these icons change without notice), and the host
     * only requires a component taking `{ size, className }` that inherits its
     * colour from `currentColor`.
     *
     * @param {object} props - `{ size, className }` from the menu.
     * @returns {object} a React element.
     */
    /**
     * The glyph on one recalled prompt inside the drilled list.
     *
     * @param {object} props - `{ size, className }` from the menu.
     * @returns {object} a React element.
     */
    function HistoryEntryIcon(props) {
      const { size, className } = props;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          className,
          'aria-hidden': true,
        },
        h('path', { d: 'M4 12a8 8 0 1 0 2.34-5.66' }),
        h('path', { d: 'M4 4v4h4' }),
      );
    }

    function HistoryIcon(props) {
      const { size, className } = props;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          className,
          'aria-hidden': true,
        },
        h('path', { d: 'M12 20V6' }),
        h('path', { d: 'm6 12 6-6 6 6' }),
        h('path', { d: 'M5 21h14' }),
      );
    }

    /**
     * The `/history` group's one-line form of a prompt.
     *
     * @param {string} text - the recalled prompt.
     * @returns {string} a single-line preview, possibly elided.
     */
    function pickerLabel(text) {
      const firstLine = text.split('\n', 1)[0].trim();
      if (firstLine.length <= PICKER_PREVIEW_WIDTH) return firstLine;
      return `${firstLine.slice(0, PICKER_PREVIEW_WIDTH - 1)}…`;
    }

    /** A group's own row: the root the drill descends from. */
    const ROOT_VALUE = 'root';

    /** An entry's `value` prefix; the seq follows. */
    const ENTRY_VALUE = 'entry:';

    /**
     * Whether the menu has descended into this session's prompts.
     *
     * Two routes reach the same level, deliberately. A drill (Tab or the row's
     * chevron) sets `drilled`, and the root row's own pick re-enters the trigger
     * with `continue: true`, which leaves `/history` in the draft as the query —
     * so typing it also opens the list. Only a bare `/` shows the root.
     *
     * @param {object} req - the candidate request.
     * @returns {boolean} whether the entry list is showing.
     */
    function isPicked(req) {
      return req.drilled === true || req.query.trim() === COMMAND_NAME;
    }

    /**
     * The `/history` rows for one session.
     *
     * @param {object} session - the `ClientSessionContext` handed to a source.
     * @param {object} req - the candidate request.
     * @returns {Promise<readonly object[]>} the rows to show.
     */
    function historyCandidates(session, req) {
      const bridge = bridges.get(session.sessionId);
      if (bridge === undefined) return Promise.resolve([]);
      if (req.signal.aborted) return Promise.resolve([]);

      if (!isPicked(req)) {
        return Promise.resolve([
          {
            name: COMMAND_NAME,
            label: '历史输入',
            description: '本会话提交过的提示词',
            icon: HistoryIcon,
            // The chevron the pipeline renders for a drill; Tab or a click on it
            // descends. A plain Enter returns the trigger below instead, which
            // re-queries this same function into the entry list.
            drill: true,
            value: ROOT_VALUE,
          },
        ]);
      }

      const all = bridge.entries();
      const shown = all.length > PICKER_ROWS ? all.slice(all.length - PICKER_ROWS) : all;
      // Newest first, the order a user reaching for a past prompt scans in.
      return Promise.resolve(
        shown
          .slice()
          .reverse()
          .map(entry => ({
            name: pickerLabel(entry.text) || '(空)',
            icon: HistoryEntryIcon,
            ...(entry.text.split('\n').slice(1).join(' ').trim() === ''
              ? {}
              : { description: entry.text.split('\n').slice(1).join(' ').trim() }),
            value: `${ENTRY_VALUE}${entry.seq}`,
          })),
      );
    }

    /**
     * The breadcrumb shown above a drilled list, so the root is one click away.
     *
     * @param {object} _session - the session, unused: the level is the only input.
     * @param {object} req - the header request.
     * @returns {readonly object[] | undefined} the crumbs, or none at the root.
     */
    function historyHeader(_session, req) {
      if (req.drilled !== true) return undefined;
      return [{ label: '历史输入', value: ROOT_VALUE }];
    }

    /**
     * A pick on a `/history` row: descend, or write the prompt into the composer.
     *
     * `continue: true` on the root is what keeps the trigger alive, which is how
     * the same source answers the next `candidates` with the entry list. The
     * source never calls `setDraft` itself — the pipeline inserts the text, so
     * the composer and the arrow-key walk stay consistent by construction.
     *
     * @param {object} pick - the settled pick.
     * @returns {object | undefined} the outcome, or undefined for an unknown row.
     */
    function historyPick(pick) {
      const { candidate, action, session } = pick;
      const value = candidate.value;
      if (value === ROOT_VALUE) return { text: `/${COMMAND_NAME}`, continue: true };
      if (typeof value !== 'string' || !value.startsWith(ENTRY_VALUE)) return undefined;

      const bridge = bridges.get(session.sessionId);
      if (bridge === undefined) return undefined;
      const seq = Number(value.slice(ENTRY_VALUE.length));
      const entry = bridge.entries().find(candidate2 => candidate2.seq === seq);
      if (entry === undefined) return undefined;
      // A drill on an entry re-issues the trigger rather than inserting, so a
      // chevron click and a plain click cannot disagree about what was taken.
      if (action === 'drill') return { text: `/${COMMAND_NAME}`, continue: true };
      return { text: entry.text };
    }

    /** Theme-token styling, copied in shape from the Plugins page's own inputs. */
    const LABEL = {
      color: 'var(--dsw-alias-label-primary, inherit)',
      fontSize: '13px',
      fontWeight: '500',
      lineHeight: '20px',
    };
    const INPUT = {
      border: '0.5px solid var(--dsw-alias-border-l4, currentColor)',
      borderRadius: 'var(--dsw-radius-md, 6px)',
      background: 'var(--dsw-alias-bg-layer-3, transparent)',
      height: '40px',
      font: 'inherit',
      color: 'var(--dsw-alias-label-primary, inherit)',
      outline: 'none',
      padding: '0 14px',
      fontSize: '13px',
    };
    const HINT = {
      color: 'var(--dsw-alias-label-tertiary, inherit)',
      fontSize: '12px',
      lineHeight: '18px',
    };
    const OK = {
      color: 'var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary, inherit))',
      fontSize: '12px',
      lineHeight: '18px',
    };
    const WARN = {
      color: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-label-secondary, inherit))',
      fontSize: '12px',
      lineHeight: '18px',
    };
    const BUTTON = {
      border: 'none',
      borderRadius: 'var(--dsw-radius-md, 6px)',
      height: '32px',
      padding: '0 16px',
      font: 'inherit',
      fontSize: '13px',
      color: 'var(--dsw-alias-label-inverse, #fff)',
      background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-state-business-primary, currentColor))',
    };

    /**
     * Read the cap the Host currently resolves, tolerating every shape the
     * owner may hand over.
     *
     * The page passes `form` only once the Host's settings mirror lists this
     * row as a served namespace, so `form` itself can be absent; its `state`
     * can be pre-first-read, and `value` can be undefined while loading.
     *
     * @param {object | undefined} form - the owner-supplied `ConfigPageForm`.
     * @returns {{ value: number, status: string, writable: boolean, revision: number | undefined }} the read view.
     */
    function readCap(form) {
      const state = form === undefined || form === null ? undefined : form.state;
      if (state === undefined || state === null) {
        return { value: DEFAULT_MAX_ENTRIES, status: 'unavailable', writable: false, revision: undefined };
      }
      const raw = state.value === undefined || state.value === null ? undefined : state.value.maxEntries;
      return {
        value: typeof raw === 'number' ? raw : DEFAULT_MAX_ENTRIES,
        status: state.status,
        writable: state.writable === true,
        revision: state.revision,
      };
    }

    /**
     * The row's configuration form on the plugin detail page.
     *
     * `view: 'summary'` is the one-liner the Plugins page shows under a row
     * that has no package description; `view: 'page'` is the form itself, with
     * its own save control. There is no shared settings control to borrow, so
     * this writes plain elements styled from the host's own theme tokens — the
     * same variables the Plugins page's own inputs use.
     *
     * @param {object} props - `{ view, form }` from the slot owner.
     * @returns {object} a React element.
     */
    function MaxEntriesConfig(props) {
      const { view, form } = props;
      const cap = readCap(form);
      const [draft, setDraft] = useState(String(cap.value));
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState(null);

      // A Host-side change (another window, a profile edit) replaces the value
      // under the editor. Adopt it unless the user is mid-edit on a dirty draft,
      // so a save in flight is never silently overwritten.
      const accepted = useRef(String(cap.value));
      useEffect(() => {
        const next = String(cap.value);
        if (next === accepted.current) return;
        accepted.current = next;
        setDraft(next);
      }, [cap.value]);

      if (view === 'summary') {
        return h('span', null, `每个会话保留 ${cap.value} 条提示词`);
      }

      const parsed = Number(draft.trim());
      const usable = Number.isInteger(parsed) && parsed >= MIN_MAX_ENTRIES && parsed <= MAX_MAX_ENTRIES;
      const dirty = usable && parsed !== cap.value;
      const disabled = !cap.writable || busy || !usable;

      /** Write the staged value through the owner's atomic mutation. */
      const save = () => {
        if (form === undefined || form === null || typeof form.mutate !== 'function') return;
        setBusy(true);
        setNote(null);
        form
          .mutate([{ op: 'set', path: ['maxEntries'], value: parsed }], cap.revision)
          .then(ok => {
            if (ok) {
              // Not `accepted.current`: that name is the ref above, and reusing
              // it as the result binding would try to write a property onto a
              // boolean.
              accepted.current = String(parsed);
              setNote({ ok: true, text: '已保存，重启 Harness 后生效' });
            } else {
              setNote({ ok: false, text: '保存被拒绝，值未改变' });
            }
          })
          .catch(error => {
            setNote({ ok: false, text: `保存失败：${error instanceof Error ? error.message : String(error)}` });
          })
          .then(() => setBusy(false));
      };

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '420px' } },
        h('label', { style: LABEL, htmlFor: 'dsh-history-up-max-entries' }, '每个会话保留的提示词条数'),
        h('input', {
          id: 'dsh-history-up-max-entries',
          type: 'number',
          min: MIN_MAX_ENTRIES,
          max: MAX_MAX_ENTRIES,
          step: 1,
          value: draft,
          disabled: !cap.writable || busy,
          'aria-invalid': usable ? undefined : true,
          onChange: event => setDraft(event.target.value),
          onKeyDown: event => {
            if (event.key === 'Enter' && !disabled) {
              event.preventDefault();
              save();
            }
          },
          style: INPUT,
        }),
        h('div', { style: HINT }, `整数，${MIN_MAX_ENTRIES}–${MAX_MAX_ENTRIES}，默认 ${DEFAULT_MAX_ENTRIES}。超出的从最早一条开始丢弃。`),
        cap.status === 'unavailable'
          ? h('div', { style: WARN }, '这个部署没有把本插件的配置暴露给页面，值只能在 cordis.patch.yml 里改。')
          : null,
        note === null
          ? null
          : h('div', { style: note.ok ? OK : WARN }, note.text),
        h(
          'div',
          null,
          h(
            'button',
            {
              type: 'button',
              disabled,
              onClick: save,
              style: {
                ...BUTTON,
                opacity: disabled ? 0.5 : 1,
                cursor: disabled ? 'default' : 'pointer',
              },
            },
            busy ? '保存中…' : '保存',
          ),
        ),
      );
    }

    return {
      inject: ['slots', 'shortcuts', 'inputTriggers'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'dsh-history-up',
              order: 10,
            },
            HistoryUp,
          ),
        );

        /**
         * `/history`: a `/`-triggered group that drills into this session's
         * prompts, each pick writing the text into the composer.
         *
         * An input-trigger source rather than a `commandUi` contribution, and the
         * reason is what the shipped app actually does: every one of the menu's
         * other icon-bearing rows — file, goal, plan, feedback — is an
         * input-trigger source, and `commandUi.register` (contributions) is not
         * called anywhere in the installation. Only `decorate` is. A source also
         * brings the one thing the user asked for that a command row cannot do:
         * `drill`, the chevron/Tab descent into a second level.
         */
        ctx.effect(() =>
          ctx.inputTriggers.registerSource({
            trigger: '/',
            // Unique per trigger; a duplicate registration throws.
            name: 'history-input',
            order: 20,
            // Each row carries its own label, so the group needs no heading.
            showGroupTitle: false,
            candidates: historyCandidates,
            header: historyHeader,
            onPick: historyPick,
          }),
        );

        // The Plugins page derives a row's Configure control purely from this
        // registration, keyed `<package name>#<row id>`; it keeps no registry of
        // configurable rows itself, so without it the Host `Config` is invisible
        // there and `maxEntries` is only editable in the patch file.
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.row.config',
              key: CONFIG_KEY,
            },
            MaxEntriesConfig,
          ),
        );

        ctx.effect(() => {
          /**
           * Route an arrow key in a composer to that session's dock entry.
           *
           * @param {object} input - one observed fixed input.
           */
          return ctx.shortcuts.observeFixedInput(input => {
            if (input.type !== 'keydown') return;
            const { gesture, context, consume } = input;
            if (gesture.code !== 'ArrowUp' && gesture.code !== 'ArrowDown') return;
            // Modifiers mean the user asked the editor for something else, and
            // key repeat means they are holding the key rather than stepping.
            if (gesture.control || gesture.alt || gesture.shift || gesture.meta) return;
            if (gesture.repeat || gesture.composing || gesture.defaultPrevented) return;
            if (context.modal !== null || context.target === null) return;

            const sessionId = sessionOf(context.target);
            if (sessionId === undefined) return;
            const bridge = bridges.get(sessionId);
            if (bridge === undefined) return;

            const direction = gesture.code === 'ArrowUp' ? -1 : 1;
            // Up belongs to the editor above the first line, where a shell
            // would move the caret between lines instead of recalling.
            if (
              direction < 0 &&
              !caretOnFirstLine(context.target.closest('[data-composer-input]') ?? context.target)
            ) {
              return;
            }
            if (bridge.step(direction)) consume();
          });
        });
      },
    };
  },
});