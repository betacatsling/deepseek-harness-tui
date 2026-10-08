# @deepseek-ai/dsh-experimental-tui

A Claude Code–style terminal UI for DeepSeek Harness, packaged as a profile
bundle (`dsh --profile tui`). It runs in-process on the real harness: agents,
tools, sandbox approvals, plan mode, questions, sessions, compaction, goals,
subagents and the command registry are the harness's own services.

## Run

```bash
(cd packages/experimental/tui && npx tsc -b && node scripts/bundle.mjs)
packages/experimental/tui/bin/dsh-tui            # real models (needs DEEPSEEK_API_KEY or `dsh auth`)
packages/experimental/tui/bin/dsh-tui --demo     # scripted demo model, no key needed
packages/experimental/tui/bin/dsh-tui -c         # continue the latest session here
packages/experimental/tui/bin/dsh-tui -r <id>    # resume a session
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
- Slash commands: /help /clear /model /effort /permissions /cost /context /status /config /history /resume /todos /tools /skills /jobs /agents /mcp /memory /init /export /copy /diff /logs /exit. Harness commands such as /compact and /goal also appear in the menu.

## Test

```bash
npx vitest run packages/experimental/tui
npx tsx scripts/run-oxlint.ts packages/experimental/tui
```
