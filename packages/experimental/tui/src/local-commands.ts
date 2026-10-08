/**
 * TUI-owned slash commands. Harness commands registered on `ctx.commands`
 * (`/plan`, `/goal`, `/compact`, `/permission`, `/feedback`, …) are listed and
 * dispatched by the bridge directly; these cover the terminal-only surface.
 * @module @deepseek-ai/dsh-experimental-tui/local-commands
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Bridge } from './bridge.ts'
import { DEMO_PROVIDER } from './demo/adapter.ts'
import { formatTokens } from './format.ts'
import { ansi, palette } from './theme.ts'

/** One local command. */
export interface LocalCommand {
  readonly name: string
  readonly aliases?: readonly string[]
  readonly description: string
  readonly hint?: string
  run(bridge: Bridge, input: string, line: string): Promise<void> | void
}

function meter(fraction: number, width: number, color: string): string {
  const filled = Math.max(fraction > 0 ? 1 : 0, Math.round(Math.max(0, Math.min(1, fraction)) * width))
  return ansi.hex(color)('━'.repeat(filled)) + ansi.hex(palette.border)('━'.repeat(Math.max(0, width - filled)))
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${String(s)}s ago`
  if (s < 3600) return `${String(Math.round(s / 60))}m ago`
  if (s < 86_400) return `${String(Math.round(s / 3600))}h ago`
  return `${String(Math.round(s / 86_400))}d ago`
}

const KEYS = [
  ['Enter', 'send · while running, steer the current turn'],
  ['Shift+Enter / Ctrl+J', 'newline (or end a line with `\\`)'],
  ['Esc', 'interrupt the running turn · Esc Esc clears the input'],
  ['Shift+Tab', 'cycle permission mode → plan mode'],
  ['↑ / ↓', 'prompt history · menu navigation'],
  ['Tab', 'accept completion'],
  ['@', 'mention a file (its content is attached)'],
  ['!', 'run a shell command; output is shared with the model'],
  ['#', 'save a note to AGENTS.md'],
  ['Ctrl+O', 'toggle detailed transcript (expand thinking and output)'],
  ['Ctrl+T', 'toggle the todo panel'],
  ['Ctrl+L', 'redraw the screen'],
  ['Ctrl+C', 'clear input · twice to exit'],
] as const

export const LOCAL_COMMANDS: readonly LocalCommand[] = [
  {
    name: 'help',
    aliases: ['?'],
    description: 'Show commands and keyboard shortcuts',
    run(bridge, _input, line) {
      const entries = bridge.slashEntries()
      const local = entries.filter(entry => entry.source === 'tui')
      const harness = entries.filter(entry => entry.source === 'harness')
      const row = (entry: { name: string; hint?: string; description: string }): string =>
        `- \`/${entry.name}${entry.hint === undefined ? '' : ` ${entry.hint}`}\` — ${entry.description}`
      bridge.commandOutput(line, true, [
        '**Harness commands** (served by `ctx.commands`)',
        ...harness.map(row),
        '',
        '**Terminal commands**',
        ...local.map(row),
        '',
        '**Keys**',
        ...KEYS.map(([key, what]) => `- \`${key}\` — ${what}`),
      ].join('\n'), true)
    },
  },
  {
    name: 'clear',
    aliases: ['new', 'reset'],
    description: 'Start a new session (the current one stays resumable)',
    async run(bridge) {
      await bridge.clearConversation()
    },
  },
  {
    name: 'model',
    description: 'Choose the model for this session',
    hint: '[provider/model]',
    async run(bridge, input, line) {
      const catalog = await bridge.modelCatalog()
      const state = bridge.store.get()
      let choice: string | undefined = input === '' ? undefined : input
      if (choice === undefined) {
        choice = await bridge.pick('Select model', catalog.map(model => ({
          label: model.name === model.id ? model.id : model.name,
          value: `${model.provider}/${model.id}`,
          description: `${model.providerName} · ${model.id}${model.description === undefined ? '' : ` · ${model.description}`}`,
          current: model.provider === state.model.provider && model.id === state.model.model,
          ...model.provider === DEMO_PROVIDER ? { badge: 'demo' } : {},
        })), 'Applies from the next request · Enter to select · Esc to cancel')
      }
      if (choice === undefined) return
      const slash = choice.indexOf('/')
      const match = slash > 0
        ? { provider: choice.slice(0, slash), id: choice.slice(slash + 1) }
        : catalog.find(model => model.id === choice)
      if (match === undefined) {
        bridge.commandOutput(line, false, `Unknown model ${choice}`)
        return
      }
      await bridge.setModel(match.provider, match.id)
      const route = bridge.store.get().model
      bridge.commandOutput(line, true, `Model set to **${route.model}** (${route.provider})${route.effort === undefined ? '' : ` · effort ${route.effort}`}`, true)
    },
  },
  {
    name: 'effort',
    description: 'Set reasoning effort for the current model',
    hint: '[level]',
    async run(bridge, input, line) {
      const efforts = await bridge.efforts()
      if (efforts.length === 0) {
        bridge.commandOutput(line, false, 'The current model declares no reasoning efforts.')
        return
      }
      const current = bridge.store.get().model.effort
      const choice = input !== '' ? input : await bridge.pick('Reasoning effort', efforts.map(effort => ({
        label: effort.name,
        value: effort.id,
        ...effort.description === undefined ? {} : { description: effort.description },
        current: effort.id === current,
      })))
      if (choice === undefined) return
      if (!efforts.some(effort => effort.id === choice)) {
        bridge.commandOutput(line, false, `Unknown effort ${choice}; choose one of ${efforts.map(effort => effort.id).join(', ')}`)
        return
      }
      await bridge.setEffort(choice)
      bridge.commandOutput(line, true, `Reasoning effort set to **${choice}**`, true)
    },
  },
  {
    name: 'permissions',
    aliases: ['mode'],
    description: 'Pick a permission preset (sandbox + approval policy)',
    async run(bridge, input, line) {
      const presets = bridge.presets()
      const state = bridge.store.get()
      const choice = input !== '' ? input : await bridge.pick('Permission mode', [
        ...presets.map(preset => ({
          label: preset.name,
          value: preset.value,
          ...preset.description === undefined ? {} : { description: preset.description },
          current: !state.planActive && preset.value === state.preset,
        })),
        { label: 'Plan mode', value: '__plan', description: 'Explore and present a plan for review before executing', current: state.planActive },
      ], 'Shift+Tab cycles these from the prompt')
      if (choice === undefined) return
      if (choice === '__plan') {
        bridge.setPlan(true)
        bridge.commandOutput(line, true, 'Plan mode on')
        return
      }
      if (state.planActive) bridge.setPlan(false)
      const ok = bridge.setPreset(choice)
      bridge.commandOutput(line, ok, ok ? `Permission mode: **${bridge.store.get().presetLabel}**` : `Could not select ${choice}`, true)
    },
  },
  {
    name: 'cost',
    aliases: ['usage'],
    description: 'Token usage for this session',
    run(bridge, _input, line) {
      bridge.refreshMetrics()
      const state = bridge.store.get()
      const u = state.usage
      const total = u.input + u.output + u.cacheRead + u.cacheWrite
      const hit = u.input + u.cacheRead === 0 ? 0 : u.cacheRead / (u.input + u.cacheRead)
      bridge.commandOutput(line, true, [
        '**Token usage** · this session',
        '',
        '| | tokens |',
        '|---|---:|',
        `| Input (uncached) | ${formatTokens(u.input)} |`,
        `| Input (cache hit) | ${formatTokens(u.cacheRead)} |`,
        `| Cache write | ${formatTokens(u.cacheWrite)} |`,
        `| Output | ${formatTokens(u.output)} |`,
        `| **Total** | **${formatTokens(total)}** |`,
        '',
        `Cache hit rate **${(hit * 100).toFixed(1)}%** · model \`${state.model.model}\`${state.demo ? ' · demo model, no billing' : ''}`,
      ].join('\n'), true)
    },
  },
  {
    name: 'context',
    description: 'Visualize context window usage',
    run(bridge, _input, line) {
      bridge.refreshMetrics()
      const state = bridge.store.get()
      const breakdown = bridge.contextBreakdown()
      const window = state.contextWindow ?? 128_000
      const used = state.pressure ?? (breakdown === undefined ? 0 : breakdown.system + breakdown.tools + breakdown.messages)
      const rows = breakdown === undefined ? [] : [
        ['System prompt', breakdown.system],
        ['Tool schemas', breakdown.tools],
        ['Messages', breakdown.messages],
      ] as const
      const pct = (value: number): string => `${((value / window) * 100).toFixed(1)}%`
      const label = (text: string): string => ansi.hex(palette.text)(text.padEnd(15))
      const amount = (value: number): string => ansi.hex(palette.muted)(formatTokens(value).padStart(6))
      bridge.commandOutput(line, true, [
        `${meter(used / window, 40, palette.accent)}  ${ansi.hex(palette.text).bold(formatTokens(used))}${ansi.hex(palette.muted)(` / ${formatTokens(window)} tokens · ${pct(used)}`)}`,
        '',
        ...rows.map(([name, tokens]) => `${label(name)}${amount(tokens)}  ${meter(tokens / Math.max(1, window), 24, palette.accent)}  ${ansi.hex(palette.faint)(pct(tokens))}`),
        `${label('Free space')}${amount(Math.max(0, window - used))}  ${meter((window - used) / Math.max(1, window), 24, palette.muted)}  ${ansi.hex(palette.faint)(pct(Math.max(0, window - used)))}`,
        '',
        ansi.hex(palette.faint)('Estimated by ctx.tokenMeter · /compact summarizes older turns'),
      ].join('\n'))
    },
  },
  {
    name: 'status',
    description: 'Session, model, permissions, and environment',
    run(bridge, _input, line) {
      bridge.refreshModes()
      const state = bridge.store.get()
      bridge.commandOutput(line, true, [
        `- **Version** dsh ${state.version}`,
        `- **Session** \`${state.sessionId ?? '—'}\`${state.title === undefined ? '' : ` · ${state.title}`}`,
        `- **Directory** \`${state.cwd}\`${state.branch === undefined ? '' : ` (git: ${state.branch})`}`,
        `- **Model** \`${state.model.provider}/${state.model.model}\`${state.model.effort === undefined ? '' : ` · effort ${state.model.effort}`}${state.demo ? ' · scripted demo' : ''}`,
        `- **Permissions** ${state.presetLabel} · approval policy \`${state.approvalPolicy}\`${state.planActive ? ' · plan mode' : ''}`,
        `- **Goal** ${state.goal ?? 'none'}`,
        `- **Background jobs** ${String(state.jobs)} · **subagents running** ${String(state.activeSubagents)}`,
        `- **Harness home** \`${process.env.DSH_HOME ?? '~/.dsh'}\``,
        `- **Log** \`${bridge.logs.path}\` (${String(bridge.logs.problems())} warnings)`,
      ].join('\n'), true)
    },
  },
  {
    name: 'config',
    description: 'Show and change TUI defaults',
    async run(bridge, _input, line) {
      const state = bridge.store.get()
      const choice = await bridge.pick('Configuration', [
        { label: 'Default model', value: 'model', description: `Save ${state.model.provider}/${state.model.model} as the default for new sessions` },
        { label: 'Permission mode', value: 'permissions', description: `Currently ${state.presetLabel}` },
        { label: 'Reasoning effort', value: 'effort', description: `Currently ${state.model.effort ?? 'model default'}` },
        { label: 'Detailed transcript', value: 'detail', description: state.detail ? 'On — thinking and full output shown' : 'Off — compact view (Ctrl+O)' },
        { label: 'Todo panel', value: 'todos', description: state.showTodos ? 'Shown while working (Ctrl+T)' : 'Hidden (Ctrl+T)' },
        { label: 'Show composed config path', value: 'paths', description: 'Profile, patches, and logs' },
      ], 'dsh composes its plugin tree from bundle patches; `dsh --profile tui --dump-config` prints it')
      switch (choice) {
        case 'model': {
          const saved = await bridge.saveDefaultModel()
          bridge.commandOutput(line, saved, saved ? `Saved **${state.model.model}** as the default model` : 'No configuration editor is mounted; the default was not saved', true)
          return
        }
        case 'permissions':
          await bridge.runSlash('/permissions')
          return
        case 'effort':
          await bridge.runSlash('/effort')
          return
        case 'detail':
          bridge.store.update((draft) => { draft.detail = !draft.detail })
          bridge.reprint(true)
          return
        case 'todos':
          bridge.store.update((draft) => { draft.showTodos = !draft.showTodos })
          return
        case 'paths': {
          const home = process.env.DSH_HOME ?? '~/.dsh'
          bridge.commandOutput(line, true, [
            `- Profile: \`${home}/profiles/tui\``,
            `- Profile patch: \`${home}/profiles/tui/cordis.patch.yml\``,
            `- Home patch: \`${home}/cordis.patch.yml\``,
            `- Prompt history: \`${home}/tui-history.jsonl\``,
            `- Log: \`${bridge.logs.path}\``,
          ].join('\n'), true)
          return
        }
        default:
      }
    },
  },
  {
    name: 'history',
    description: 'Browse prompt history and re-run an entry',
    async run(bridge, _input, line) {
      const entries = [...new Set([...bridge.history].reverse())].filter(entry => !entry.startsWith('/history')).slice(0, 40)
      if (entries.length === 0) {
        bridge.commandOutput(line, true, 'No prompt history yet.')
        return
      }
      const choice = await bridge.pick('Prompt history', entries.map((entry, index) => ({
        label: entry.split('\n')[0] ?? entry, value: String(index), ...entry.includes('\n') ? { description: `${String(entry.split('\n').length)} lines` } : {},
      })), 'Enter re-runs the prompt · ↑/↓ in the composer also walks history')
      if (choice === undefined) return
      const entry = entries[Number(choice)]
      if (entry !== undefined) await bridge.submit(entry)
    },
  },
  {
    name: 'resume',
    aliases: ['sessions', 'continue'],
    description: 'Resume a previous session from this directory',
    hint: '[session-id]',
    async run(bridge, input, line) {
      if (input !== '') {
        bridge.reprint(false)
        await bridge.resumeSession(input)
        return
      }
      const sessions = await bridge.listResumable()
      if (sessions.length === 0) {
        bridge.commandOutput(line, true, 'No other persisted sessions recorded in this directory.')
        return
      }
      const choice = await bridge.pick('Resume session', sessions.map(session => ({
        label: session.title ?? '(untitled)', value: session.id, description: `${ago(session.createdAt)} · ${session.id}`,
      })))
      if (choice === undefined) return
      bridge.reprint(false)
      await bridge.resumeSession(choice)
    },
  },
  {
    name: 'todos',
    description: 'Show the current todo list',
    run(bridge, _input, line) {
      const todos = bridge.todos()
      bridge.commandOutput(line, true, todos.length === 0
        ? 'No todos. The model maintains this list with `todo_write`.'
        : todos.map(todo => `- [${todo.status === 'completed' ? 'x' : ' '}] ${todo.status === 'in_progress' ? `**${todo.content}**` : todo.content}`).join('\n'), true)
    },
  },
  {
    name: 'tools',
    description: 'List the tools the model can call',
    run(bridge, _input, line) {
      const schemas = bridge.context().get('tools')?.schemas() ?? []
      bridge.commandOutput(line, true, schemas.length === 0 ? 'No tools registered.' : schemas
        .map(schema => `- \`${schema.name}\` — ${(schema.description.split(/(?<=\.)\s/)[0] ?? '').slice(0, 110)}`)
        .join('\n'), true)
    },
  },
  {
    name: 'skills',
    description: 'List available skills',
    async run(bridge, _input, line) {
      const skills = await bridge.context().get('skills')?.list().catch(() => []) ?? []
      bridge.commandOutput(line, true, skills.length === 0
        ? 'No skills found. Add `SKILL.md` folders under `.agents/skills/` or `~/.dsh/skills/`.'
        : skills.map(skill => `- **${skill.name}** — ${skill.description}`).join('\n'), true)
    },
  },
  {
    name: 'jobs',
    description: 'Background jobs started by this session',
    async run(bridge, input, line) {
      const jobs = bridge.context().get('jobs')
      const agent = bridge.agent
      if (jobs === undefined || agent === undefined) {
        bridge.commandOutput(line, false, 'The jobs service is not mounted.')
        return
      }
      const list = jobs.list(agent.id)
      if (list.length === 0) {
        bridge.commandOutput(line, true, 'No background jobs. The model starts them with `bash` + `run_in_background`.')
        return
      }
      const choice = input !== '' ? input : await bridge.pick('Background jobs', list.map(job => ({
        label: job.label, value: job.id, description: `${job.kind} · ${job.status}${job.progress === undefined ? '' : ` · ${job.progress}`}`,
      })), 'Enter shows output')
      if (choice === undefined) return
      try {
        const read = jobs.read(choice as never, agent.id)
        const text = (read as { output?: { text?: string } }).output?.text ?? JSON.stringify(read).slice(0, 2000)
        bridge.commandOutput(line, true, `\`\`\`\n${text.slice(-4000)}\n\`\`\``, true)
      } catch (error: unknown) {
        bridge.commandOutput(line, false, error instanceof Error ? error.message : String(error))
      }
    },
  },
  {
    name: 'agents',
    description: 'Live agents and subagents in this process',
    run(bridge, _input, line) {
      const agents = bridge.context().get('agents')?.list() ?? []
      bridge.commandOutput(line, true, agents.length === 0 ? 'No live agents.' : agents.map((agent) => {
        const self = agent === bridge.agent ? ' (this session)' : ''
        const origin = agent.session.header.origin === 'subagent' ? 'subagent' : 'root'
        return `- \`${agent.id}\` · ${origin} · ${agent.status}${self}`
      }).join('\n'), true)
    },
  },
  {
    name: 'mcp',
    description: 'MCP servers and tools',
    run(bridge, _input, line) {
      const schemas = bridge.context().get('tools')?.schemas() ?? []
      const mcp = schemas.filter(schema => schema.name.includes('__') || schema.name.includes('mcp'))
      bridge.commandOutput(line, true, [
        mcp.length === 0 ? 'No MCP tools are mounted.' : mcp.map(schema => `- \`${schema.name}\``).join('\n'),
        '',
        'MCP servers are trusted executables, so none is enabled by default. Add `@deepseek-ai/dsh-mcp-client` rows to',
        '`~/.dsh/profiles/tui/cordis.patch.yml` (see `apps/cli/config/examples/`) and restart.',
      ].join('\n'), true)
    },
  },
  {
    name: 'memory',
    description: 'Show the AGENTS.md instructions loaded for this directory',
    run(bridge, _input, line) {
      const files = ['AGENTS.md', 'CLAUDE.md'].map(name => join(bridge.cwd, name)).filter(file => existsSync(file))
      if (files.length === 0) {
        bridge.commandOutput(line, true, 'No AGENTS.md here. Start a line with `#` to save a note, or run `/init`.', true)
        return
      }
      const file = files[0] ?? ''
      const text = readFileSync(file, 'utf8')
      bridge.commandOutput(line, true, `\`${file}\`\n\n${text.length > 3000 ? `${text.slice(0, 3000)}\n…` : text}`, true)
    },
  },
  {
    name: 'init',
    description: 'Ask the model to write an AGENTS.md for this repository',
    async run(bridge) {
      await bridge.submit('Please analyze this codebase and create an AGENTS.md file with build/test commands, architecture notes, and code-style conventions a coding agent should follow. Keep it concise.')
    },
  },
  {
    name: 'export',
    description: 'Export the transcript to a Markdown file',
    hint: '[file]',
    run(bridge, input, line) {
      const file = bridge.exportTranscript(input)
      bridge.commandOutput(line, true, `Transcript written to \`${file}\``, true)
    },
  },
  {
    name: 'copy',
    description: 'Copy the last response to the clipboard (OSC 52)',
    run(bridge, _input, line) {
      const last = [...bridge.store.get().items].reverse().find(item => item.kind === 'assistant')
      if (last?.kind !== 'assistant') {
        bridge.commandOutput(line, false, 'Nothing to copy yet.')
        return
      }
      process.stdout.write(`\x1b]52;c;${Buffer.from(last.text).toString('base64')}\x07`)
      bridge.commandOutput(line, true, `Copied ${String(last.text.length)} characters`)
    },
  },
  {
    name: 'diff',
    description: 'Files changed by tools in this session',
    run(bridge, _input, line) {
      const files = bridge.touchedFiles()
      bridge.commandOutput(line, true, files.length === 0 ? 'No files changed yet.' : files.map(file => `- \`${file}\``).join('\n'), true)
    },
  },
  {
    name: 'logs',
    description: 'Recent harness log lines captured by the TUI',
    run(bridge, _input, line) {
      const lines = bridge.logs.lines().slice(-30)
      bridge.commandOutput(line, true, lines.length === 0
        ? `No log output yet · \`${bridge.logs.path}\``
        : `\`\`\`\n${lines.map(entry => `${new Date(entry.time).toISOString().slice(11, 19)} ${entry.level.padEnd(6)} ${entry.text}`).join('\n')}\n\`\`\`\n\`${bridge.logs.path}\``, true)
    },
  },
  {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: 'Exit (the session stays resumable with /resume or -c)',
    run(bridge) {
      bridge.exit()
    },
  },
]
