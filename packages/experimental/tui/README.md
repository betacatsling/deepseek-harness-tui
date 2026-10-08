---
description: "A Claude Code-style terminal UI for DeepSeek Harness, with fullscreen mouse support and dark and light themes, installed as the `tui` profile bundle."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-tui

## Summary

A Claude Code–style terminal UI for DeepSeek Harness, packaged as a profile
bundle (`dsh --profile tui`). It runs in-process on the real harness: agents,
tools, sandbox approvals, plan mode, questions, sessions, compaction, goals,
subagents and the command registry are the harness's own services.

## Table of Contents

- [Run](#run)
- [Features](#features)
- [Mouse](#mouse)
- [Themes](#themes)
- [Test](#test)
- [Dev Note](#dev-note)

## Run

```bash
packages/experimental/tui/bin/dsh-tui            # real models (needs DEEPSEEK_API_KEY or `dsh auth`)
packages/experimental/tui/bin/dsh-tui --demo     # scripted demo model, no key needed
packages/experimental/tui/bin/dsh-tui -c         # continue the latest session here
packages/experimental/tui/bin/dsh-tui -r <id>    # resume a session
packages/experimental/tui/bin/dsh-tui --no-mouse # classic inline UI (native scrollback and selection)
packages/experimental/tui/bin/dsh-tui --theme light
```

With no credentials and no `-m`, the TUI starts on a clearly labelled scripted
demo model (`dsh-tui-demo/scripted-v1`). It only replaces the LLM. The tool
calls it emits still run through the harness's real tools, sandbox and approvals.

## Features

- Welcome banner with a blue, six-row Unicode block whale, a forked tail and a pectoral fin.
- Chat REPL with a bordered composer, multi-line editing (Shift+Enter / Ctrl+J / `\`), emacs keys, history (↑/↓), bracketed paste.
- Streaming Markdown with syntax-highlighted code blocks and boxed tables.
- `⏺` / `⎿` tool-step blocks with live status, real-line-number diffs, and folded subagent steps.
- Permission prompts (Yes / don't ask again / No), clarifying-question tabs, and a plan-review overlay.
- Shift+Tab cycles workspace-write → plan mode → full access. Esc interrupts. Ctrl+O toggles the detailed transcript.
- `@file` mentions with fuzzy autocomplete, `!` shell mode and `#` memory notes.
- Status line: model, effort, a context meter, tokens, cwd and git branch, goal and jobs.
- Fullscreen transcript with full mouse support (see below); `--no-mouse` keeps the classic inline UI.
- Dark and light themes with terminal background detection (`/theme`).
- Slash commands: /help /clear /model /effort /permissions /cost /context /status /config /history /resume /todos /tools /skills /jobs /agents /mcp /memory /init /export /copy /diff /logs /mouse /theme /exit. Harness commands such as /compact and /goal also appear in the menu.

## Mouse

The TUI runs fullscreen (alternate screen) with mouse reporting on by default.

| Do | Result |
| --- | --- |
| Wheel / trackpad | Scroll the transcript. Wheel notches move a fixed step; trackpad streams scroll smoothly with acceleration. Over an open menu or picker, the wheel moves its selection. |
| Click a tool header or `(click to expand)` | Expand or collapse that block. Hovering a header shows `▸ click to expand`. |
| Drag | Select text. On release it is copied (OSC 52, plus `pbcopy`/`wl-copy`/`xclip`/`xsel`/`clip.exe` when available). Dragging past the top or bottom edge auto-scrolls. |
| Double / triple click | Select a word / a line. Shift-click extends the selection. Right-click copies it again. |
| Ctrl+C / Esc with a selection | Copy it / clear it (before their usual meaning). |
| Click a link | Open it in the browser. |
| Click `↓ N lines below · Back to bottom` or the scrollbar | Jump to the bottom / seek. |
| Click in the prompt | Place the cursor there. |
| Click a slash or `@` menu row, an approval option, a question option or tab, a picker row | Choose it (the same as its number key). |
| Click the mode hint / model name / `esc to interrupt` in the footer | Cycle the mode / open `/model` / interrupt. |

Keyboard scrolling: PgUp/PgDn, Shift+↑/↓, Ctrl+Home/Ctrl+End.

**Native terminal selection.** While the app captures the mouse, hold a
modifier to let the terminal select instead: Shift+drag in most terminals
(GNOME Terminal, Konsole, kitty, WezTerm, Alacritty, Windows Terminal,
xterm), ⌥ Option+drag in iTerm2, fn+drag in macOS Terminal (or toggle
View ▸ Allow Mouse Reporting with ⌘R). Or run `/mouse off` to give the mouse
back to the terminal (PgUp/PgDn still scroll; `/mouse on` restores it), or
start with `--no-mouse` for the classic inline UI with native scrollback.

Defaults adapt to the environment: inline under Zellij and iTerm2's tmux
integration (`tmux -CC`), and fullscreen without capture when tmux's own
`mouse` option is off. Mouse and focus reporting are switched off on every
exit path: `/exit`, Ctrl+C, Ctrl+Z (re-enabled after `fg`), SIGTERM/SIGHUP,
and crashes. When the app leaves fullscreen it prints the conversation to the
normal screen so it stays in your scrollback.

| Environment variable | Effect |
| --- | --- |
| `DSH_TUI_MOUSE=0` / `1` | Same as `--no-mouse` / `--mouse`. |
| `DSH_TUI_COPY_ON_SELECT=0` | Do not copy on release (Ctrl+C, right-click or `/copy` still copy). |
| `DSH_TUI_SCROLL_MODE=auto\|wheel\|trackpad` | Force how wheel events are interpreted. |
| `DSH_TUI_SCROLL_LINES`, `DSH_TUI_SCROLL_SPEED`, `DSH_TUI_SCROLL_INVERT=1`, `DSH_TUI_SCROLL_EVENTS_PER_TICK` | Tune scrolling. |

## Themes

Dark and light palettes. Every colour role keeps readable contrast on its
background (the tests check WCAG ratios), and the light theme never relies on
SGR dim. The theme is chosen in this order:

1. `--theme auto|dark|light`, then `DSH_TUI_THEME`, then `/theme`, which is
   saved to `$DSH_HOME/tui.json`.
2. `auto`: ask the terminal for its background colour (OSC 11, with a short
   timeout), then `COLORFGBG`, then the default Terminal.app profile on macOS,
   and finally dark.

`/theme` with no argument opens a picker that shows what was detected.

## Test

```bash
npx vitest run packages/experimental/tui
npx tsx scripts/run-oxlint.ts packages/experimental/tui
```

## Dev Note

- From a source checkout, `bin/dsh-tui` runs `src/` directly (tsx resolves the package through the `tsconfig.base.json` alias), so the `.tsx` files carry an `@jsxRuntime automatic` pragma. `npx tsc -b && node scripts/bundle.mjs` builds `lib/` for packaging.
- Mouse code lives in `src/mouse/` (protocol filter, scroll normaliser, selection, clipboard, controller); the fullscreen layout is `src/ui/fullscreen.tsx` and the transcript line map is `src/viewport.ts`. Terminal modes are restored by `src/mouse/terminal.ts` on every exit path.
- Both screen modes render with Ink's incremental renderer (`src/render-options.ts`), so a keystroke repaints only the prompt line. `tests/render-options.spec.ts` guards this: without it, inline mode erased and redrew the whole live region on every keystroke, which flickers on terminals without synchronized output such as macOS Terminal.app.
- Colour tables are built with `themed()` from `src/theme.ts` so that `/theme` can rebuild them; add new colours as palette roles, not literal hex values.
- The mouse design follows OpenAI Codex and xAI Grok Build (both Apache-2.0); see [NOTICE](NOTICE).
