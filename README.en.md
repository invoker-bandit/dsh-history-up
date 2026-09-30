# dsh-history-up

[中文](README.md) · Technical notes: [TECHNICAL.en.md](TECHNICAL.en.md)

A DeepSeek Harness plugin that records the prompts you submit in each session
and recalls them with the <kbd>↑</kbd> arrow key — or picks one from the
<kbd>/</kbd> menu straight into the composer. Shell-style input history, per
session.

## What it does

- **Records** every prompt you submit in a session. Injected context (`goal`,
  `schedule`, subagent messages, tool notifications, …) is not recorded.
- **Recalls** with <kbd>↑</kbd> / <kbd>↓</kbd> in the composer:
  - <kbd>↑</kbd> walks backwards through the session's prompts, most recent first.
  - <kbd>↓</kbd> walks forwards; walking past the newest entry restores the text
    you had typed before you started browsing.
  - Typing a partial line first narrows the list to prompts starting with it,
    the way `fish` does.
- **Picks from a menu.** Type <kbd>/</kbd>, choose **历史输入**, and a second
  level lists this session's prompts; picking one fills the composer.
- **Is per session.** Opening a different session gives you that session's
  history.

## Usage

### Recalling with the arrow keys

Clear the composer and press <kbd>↑</kbd> repeatedly to walk back through your
prompts. Pressing <kbd>↑</kbd> at the oldest entry does not move the caret.
<kbd>↓</kbd> walks forward, and past the newest entry it restores what you had
typed.

### Picking from the menu

1. Press <kbd>/</kbd>. A **历史输入** group appears, with a glyph.
2. Pick that row — by click or Enter — to open the **second level**: this
   session's prompts, **newest first**. A **历史输入** breadcrumb appears above
   the list; click it to go back.
3. Pick a row and it goes straight into the composer, ready to send.

The second level shows at most 20 rows. Each shows its first line (elided past
72 characters); the remaining lines appear as the row's detail.

### Behaviour details worth knowing

| Situation | Result |
|---|---|
| Caret on the first line | <kbd>↑</kbd> recalls history |
| Caret on a later line | <kbd>↑</kbd> moves the caret, as in a shell |
| Slash-command claim open (`/…`) | Arrows belong to the trigger menu |
| Any modifier, or key held down | The editor's own behaviour is untouched |
| Draft you started browsing, then edited | The walk restarts, filtered by what you now have typed |
| A prompt sent as only an image/file | Not recorded — no plain text to recall |
| A prompt that failed to send | Not recorded; the draft is restored instead, so re-sending records it |
| A forked session | Shows the prompts the fork's log actually contains, which includes the parent's up to the fork point |

## Configuration

Editable from the plugin's detail page: sidebar **Plugins** → open this bundle
→ click the `dsh-history-up` row.

| Setting | Type | Default | Range | Meaning |
|---|---|---|---|---|
| `maxEntries` | integer | `200` | 1–5000 | prompts retained per session; older ones fall off the front |

Press save. **A restart of Harness is required for it to take effect.**

You can also edit `cordis.patch.yml` directly:

```yaml
- insert:
    - id: dsh-history-up
      name: '@invoker-bandit/dsh-history-up'
      config:
        maxEntries: 200
```

> This plugin draws that form itself. Three constraints govern it (the
> `plugins.row.config` slot, `.volatile()`, and cell reads) — read
> [TECHNICAL.en.md](TECHNICAL.en.md#the-three-traps-in-the-config-form)
> before changing the code.

## Interface language

The panel's title and description are Chinese by default; an English interface
shows English.

## Install

Package: `@invoker-bandit/dsh-history-up` ([npm](https://www.npmjs.com/package/@invoker-bandit/dsh-history-up)).

### Route 1 — from npm (recommended)

In the sidebar **Plugins** panel, choose add, and put this in the package-name
field:

```
@invoker-bandit/dsh-history-up
```

Then enable it in the list. If it reports a restart, restart Harness.

### Route 2 — from a local directory

For an unpublished copy, or to install your own changes. In the sidebar
**Plugins** panel, add, and paste the **absolute** path of this directory:

```
/absolute/path/to/dsh-history-up
```

> **When installing from a local path, run `npm install` in the plugin directory
> first.** The installer only links the directory into the profile with `link:`
> and never installs its `dependencies`; without this step you get
> `Cannot find package 'zod'` and
> `1 entry did not activate dsh-history-up` on the console.
>
> Installing from npm needs no such step — the dependencies resolve normally
> with the package.
>
> Green unit tests do not rule this out: the tests use stand-ins from
> `test/setup.mjs`.

### Other notes

- Do not hand-edit the profile's `package.json` or `cordis.patch.yml`, do not
  create packages under `$DSH_HOME`, and do not run `pnpm` in the profile
  directory; the installer performs those steps.
- To uninstall, remove it from the panel.
- The bundle declares no `dsh.peers`, so installation skips the DSH version
  compatibility pre-check. The cost is no compatibility warning after a DSH
  upgrade.

## Troubleshooting

**The console reports `1 entry did not activate dsh-history-up`.**
A local-path install skipped `npm install`, so `node_modules` is missing. Run
it in the plugin directory, then restart Harness.

**「历史输入」is missing from the menu, or has no glyph.**
The client code did not reload. Refresh the page; if it persists, remove it from
the panel, install again, and restart Harness.

**`maxEntries` was changed but nothing happened.**
A restart is required — replacing an installed package needs a fresh JavaScript
module generation.

**The configuration input is greyed out and cannot be edited.**
The Host is not exposing this row's configuration to the page, so the value can
only be changed in `cordis.patch.yml` for now. See
[TECHNICAL.en.md](TECHNICAL.en.md#the-three-traps-in-the-config-form).

## Development

```bash
node test/run.mjs
```

54 unit tests, no browser required. Coverage and the stand-in notes are in
[TECHNICAL.en.md](TECHNICAL.en.md#tests).

## Possible next steps

- Register a fixed shortcut with `ctx.shortcuts.registerFixed({ code: 'ArrowUp' })`
  so the binding appears in the shortcut reference panel.
- Show the current position during a walk (e.g. `3 / 12`) in the dock.
