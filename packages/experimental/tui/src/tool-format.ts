/**
 * Claude Code-style presentation of tool calls: a verb with its primary
 * argument for the bullet line, and a compact `⎿` summary of the result.
 * Unknown tools fall back to `name(first-arg)` and the first result lines.
 * @module @deepseek-ai/dsh-experimental-tui/tool-format
 */

import type { TodoEntry } from './store.ts'

/** Display verb per model-visible tool name. */
const VERBS: Record<string, string> = {
  read: 'Read',
  read_image: 'View',
  write: 'Write',
  edit: 'Update',
  str_replace_editor: 'Edit',
  bash: 'Bash',
  pwsh: 'PowerShell',
  glob: 'Search',
  grep: 'Search',
  web_search: 'Web Search',
  web_fetch: 'Fetch',
  todo_write: 'Update Todos',
  subagent: 'Task',
  list_subagent_models: 'List Models',
  list_agents: 'Agents',
  send_message: 'Message Agent',
  interrupt_agent: 'Interrupt Agent',
  ask_user_question: 'Ask User',
  exit_plan_mode: 'Plan Ready',
  skill: 'Skill',
  job_list: 'Jobs',
  job_output: 'Job Output',
  job_kill: 'Kill Job',
  create_goal: 'Set Goal',
  get_goal: 'Goal',
  update_goal: 'Update Goal',
  run_code: 'Program',
  cordis_inspect_list: 'Inspect',
  cordis_inspect_query: 'Inspect',
  workflow: 'Workflow',
  schedule_create: 'Schedule',
  schedule_list: 'Schedules',
  schedule_update: 'Update Schedule',
  schedule_delete: 'Delete Schedule',
  plugin_manager: 'Plugins',
  list_mcp_resources: 'MCP Resources',
  read_mcp_resource: 'MCP Resource',
  terminal_open: 'Terminal',
  terminal_send: 'Terminal',
  terminal_read: 'Terminal',
  lsp: 'LSP',
  present: 'Present',
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** The file a tool call targets (`file_path` in dsh-fs, `path` elsewhere). */
export function filePath(args: Record<string, unknown>): string | undefined {
  const value = args.file_path ?? args.path
  return typeof value === 'string' ? value : undefined
}

function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max - 1)}…` : single
}

/** Primary argument shown in parentheses. */
export function toolArgument(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'bash':
    case 'pwsh': {
      // Heredocs and scripts: the first line names the command; the rest is its body.
      const lines = (str(args.command) ?? '').trim().split('\n')
      const rest = lines.length - 1
      return rest > 0 ? `${clip(lines[0] ?? '', 120)} … +${String(rest)} line${rest === 1 ? '' : 's'}` : clip(lines[0] ?? '', 160)
    }
    case 'glob':
      return `pattern: "${str(args.pattern) ?? str(args.glob) ?? '*'}"${str(args.path) !== undefined ? `, path: "${String(args.path)}"` : ''}`
    case 'grep':
      return `pattern: "${clip(str(args.pattern) ?? str(args.regex) ?? '', 60)}"${str(args.path) !== undefined ? `, path: "${String(args.path)}"` : ''}`
    case 'web_search': {
      const queries = Array.isArray(args.queries) ? args.queries.map(String) : [str(args.query) ?? '']
      return queries.map(query => `"${clip(query, 60)}"`).join(', ')
    }
    case 'web_fetch':
      return str(args.url) ?? ''
    case 'subagent':
      return clip(str(args.description) ?? str(args.name) ?? str(args.task) ?? str(args.prompt) ?? '', 80)
    case 'skill':
      return str(args.name) ?? str(args.skill) ?? ''
    case 'run_code':
      return clip(str(args.description) ?? 'program', 80)
    case 'plugin_manager':
      return [str(args.action), str(args.name) ?? str(args.bundle) ?? str(args.plugin)].filter(Boolean).join(' ')
    case 'cordis_inspect_query':
      return clip(str(args.provider) ?? str(args.target) ?? str(args.query) ?? '', 60)
    case 'update_goal':
      return str(args.action) ?? ''
    case 'ask_user_question': {
      const questions = Array.isArray(args.questions) ? args.questions as { header?: unknown }[] : []
      return clip(questions.map(question => str(question.header)).filter(Boolean).join(', '), 80)
    }
    case 'exit_plan_mode': {
      const heading = /^#+\s+(.+)$/m.exec(str(args.plan) ?? '')
      return clip(heading?.[1]?.trim() ?? '', 80)
    }
    case 'todo_write':
      return ''
    default: {
      const primary = ['file_path', 'path', 'pattern', 'command', 'query', 'url', 'name', 'objective', 'id']
        .map(key => str(args[key])).find(value => value !== undefined)
      return primary === undefined ? '' : clip(primary, 100)
    }
  }
}

/** `Verb(argument)` line for a tool call. */
export function toolTitle(name: string, args: Record<string, unknown>): string {
  const verb = VERBS[name] ?? name
  const arg = toolArgument(name, args)
  return arg === '' ? verb : `${verb}(${arg})`
}

/** Display verb only. */
export function toolVerb(name: string): string {
  return VERBS[name] ?? name
}

function tryJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function countLines(text: string): number {
  return text === '' ? 0 : text.replace(/\n$/, '').split('\n').length
}

/** Diff line for edit previews. */
export interface DiffLine {
  readonly kind: 'add' | 'del' | 'ctx'
  readonly text: string
  readonly oldNo?: number
  readonly newNo?: number
}

/**
 * Line diff via LCS, trimmed to changes with one line of context.
 * @param before - old text.
 * @param after - new text.
 * @returns diff lines.
 */
export function lineDiff(before: string, after: string, offset = 0): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length * b.length > 250_000) {
    return [...a.map(text => ({ kind: 'del' as const, text })), ...b.map(text => ({ kind: 'add' as const, text }))]
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = dp[i] ?? []
      const below = dp[i + 1] ?? []
      row[j] = a[i] === b[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i] ?? '', oldNo: i + 1 + offset, newNo: j + 1 + offset })
      i += 1
      j += 1
    } else if (j < b.length && (i >= a.length || (dp[i]?.[j + 1] ?? 0) > (dp[i + 1]?.[j] ?? 0))) {
      out.push({ kind: 'add', text: b[j] ?? '', newNo: j + 1 + offset })
      j += 1
    } else {
      out.push({ kind: 'del', text: a[i] ?? '', oldNo: i + 1 + offset })
      i += 1
    }
  }
  const keep = new Set<number>()
  out.forEach((line, index) => {
    if (line.kind === 'ctx') return
    for (let k = index - 1; k <= index + 1; k += 1) keep.add(k)
  })
  return out.filter((_, index) => keep.has(index))
}

/** Edit-style argument pairs across the fs tools. */
export function editPair(name: string, args: Record<string, unknown>): { before: string; after: string } | undefined {
  const before = str(args.before) ?? str(args.old_string) ?? str(args.old_str)
  const after = str(args.after) ?? str(args.new_string) ?? str(args.new_str) ?? (name === 'write' ? str(args.content) : undefined)
  if (after === undefined) return undefined
  return { before: before ?? '', after }
}

/** Summary of a finished tool for the `⎿` line(s). */
export interface ToolSummary {
  readonly headline: string
  readonly body?: string
  readonly diff?: DiffLine[]
  readonly todos?: TodoEntry[]
}

/**
 * Summarise a tool result.
 * @param name - tool name.
 * @param args - parsed arguments.
 * @param result - result text.
 * @param isError - whether the tool failed.
 * @returns headline plus optional body/diff/todos.
 */
export function summarizeResult(
  name: string,
  args: Record<string, unknown>,
  result: string,
  isError: boolean,
  lineOffset = 0,
): ToolSummary {
  const json = tryJson(result) as Record<string, unknown> | unknown[] | undefined
  if (isError) {
    const message = json !== undefined && !Array.isArray(json) && typeof json.error === 'string' ? json.error : result
    return { headline: clip(message.split('\n')[0] ?? 'Error', 200), body: message.split('\n').slice(1).join('\n') }
  }
  switch (name) {
    case 'read': {
      const total = /total (\d+) lines?\)/.exec(result)?.[1]
      const numbered = result.split('\n').filter(line => /^\d+: /.test(line)).length
      const lines = total !== undefined ? Number(total) : numbered > 0 ? numbered : countLines(result)
      return { headline: `Read ${String(lines)} line${lines === 1 ? '' : 's'}` }
    }
    case 'write':
    case 'edit':
    case 'str_replace_editor': {
      const pair = editPair(name, args)
      const path = filePath(args) ?? 'file'
      if (pair === undefined) return { headline: clip(result.split('\n')[0] ?? 'Done', 160) }
      const diff = lineDiff(pair.before, pair.after, lineOffset)
      const adds = diff.filter(line => line.kind === 'add').length
      const dels = diff.filter(line => line.kind === 'del').length
      if (name === 'write' && pair.before === '') {
        return { headline: `Wrote ${String(countLines(pair.after))} lines to ${path}`, diff: diff.slice(0, 12) }
      }
      return {
        headline: `Updated ${path} with ${String(adds)} addition${adds === 1 ? '' : 's'} and ${String(dels)} removal${dels === 1 ? '' : 's'}`,
        diff,
      }
    }
    case 'glob': {
      const paths = json !== undefined && !Array.isArray(json) && Array.isArray(json.paths) ? json.paths as unknown[] : result.split('\n').filter(Boolean)
      return { headline: `Found ${String(paths.length)} file${paths.length === 1 ? '' : 's'}`, body: paths.slice(0, 50).map(String).join('\n') }
    }
    case 'grep': {
      type Match = { path?: string; lineNumber?: number; line?: string }
      const matches = json !== undefined && !Array.isArray(json) && Array.isArray(json.matches) ? json.matches as Match[] : undefined
      if (matches !== undefined) {
        const files = new Set(matches.map(match => match.path))
        return {
          headline: `Found ${String(matches.length)} match${matches.length === 1 ? '' : 'es'} in ${String(files.size)} file${files.size === 1 ? '' : 's'}`,
          body: matches.slice(0, 50).map(match => `${match.path ?? ''}:${String(match.lineNumber ?? '')}: ${(match.line ?? '').trim()}`).join('\n'),
        }
      }
      const lines = result.split('\n').filter(Boolean)
      return { headline: `Found ${String(lines.length)} line${lines.length === 1 ? '' : 's'}`, body: result }
    }
    case 'bash':
    case 'pwsh': {
      // The persistent shell appends a status line; only a failure is news.
      const output = bashOutput(json, result).replace(/\n*\[Command finished with exit code 0\]\s*$/, '')
      return { headline: output.trim() === '' ? '(no output)' : '', body: output.replace(/\n+$/, '') }
    }
    case 'todo_write': {
      const todos = Array.isArray(args.todos) ? args.todos as TodoEntry[] : []
      return { headline: '', todos }
    }
    case 'web_search': {
      const results = json !== undefined && !Array.isArray(json) && Array.isArray(json.results) ? json.results.length : undefined
      return { headline: results === undefined ? 'Search complete' : `Found ${String(results)} results` }
    }
    case 'web_fetch':
      return { headline: `Fetched ${String(result.length)} characters` }
    case 'subagent':
      return { headline: 'Done', body: clip(result, 600) }
    case 'run_code':
      return { headline: programHeadline(result), body: result.replace(/\n+$/, '') }
    case 'plugin_manager': {
      const record = json !== undefined && !Array.isArray(json) ? json : undefined
      type Entry = { name?: unknown }
      const entries = Array.isArray(record?.entries) ? record.entries as Entry[] : Array.isArray(json) ? json as Entry[] : undefined
      if (entries === undefined) break
      const noun = str(args.action)?.includes('bundle') === true ? 'bundle' : 'plugin'
      const names = entries.map(entry => str(entry.name) ?? '').filter(Boolean)
      return { headline: `${String(entries.length)} ${noun}${entries.length === 1 ? '' : 's'}`, body: names.join('\n') }
    }
    case 'cordis_inspect_list': {
      const record = json !== undefined && !Array.isArray(json) ? json : undefined
      const providers = Array.isArray(record?.providers) ? record.providers as Record<string, unknown>[] : undefined
      if (providers === undefined) break
      const platforms = [...new Set(providers.map(provider => str(provider.platform) ?? 'unknown'))]
      const names = providers.map(provider => [str(provider.platform), str(provider.name) ?? str(provider.id) ?? str(provider.kind)].filter(Boolean).join(' · '))
      return { headline: `${String(providers.length)} inspect provider${providers.length === 1 ? '' : 's'} · ${platforms.join(', ')}`, body: names.join('\n') }
    }
    case 'skill': {
      const name = str(args.name) ?? str(args.skill) ?? 'skill'
      return { headline: `Loaded ${name} · ${String(countLines(result))} lines`, body: result }
    }
    case 'get_goal':
    case 'create_goal':
    case 'update_goal':
      return { headline: summarizeGoal(json) }
    case 'ask_user_question':
      return { headline: summarizeAnswers(json) }
    case 'exit_plan_mode':
      return { headline: /approv/i.test(result) ? 'User approved the plan' : clip(result.split('\n')[0] ?? '', 160) }
    default:
      break
  }
  const first = clip(result.split('\n')[0] ?? '', 160)
  return { headline: first === '' ? 'Done' : first, body: result.split('\n').slice(1).join('\n') }
}

/**
 * The value a `run_code` program returned: its result text is the captured
 * console output followed by the return value as 2-space JSON.
 */
export function programValue(result: string): { readonly logs: string; readonly value?: unknown } {
  const whole = tryJson(result)
  if (whole !== undefined) return { logs: '', value: whole }
  const start = result.search(/\n[[{]/)
  if (start >= 0) {
    const tail = tryJson(result.slice(start + 1))
    if (tail !== undefined) return { logs: result.slice(0, start), value: tail }
  }
  return { logs: result }
}

/** `Returned 5 rows` / `Returned { fixed, tests }` / the first log line. */
export function programHeadline(result: string): string {
  const { logs, value } = programValue(result)
  if (Array.isArray(value)) return `Returned ${String(value.length)} row${value.length === 1 ? '' : 's'}`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
    return keys.length === 0 ? 'Returned {}' : `Returned { ${clip(keys.join(', '), 80)} }`
  }
  if (value !== undefined) return `Returned ${clip(JSON.stringify(value), 80)}`
  const first = logs.split('\n').find(line => line.trim() !== '')
  return first === undefined ? 'Done' : clip(first, 160)
}

function summarizeGoal(json: unknown): string {
  const goal = typeof json === 'object' && json !== null && 'goal' in json ? (json).goal : undefined
  if (typeof goal !== 'object' || goal === null) return 'No active goal'
  const g = goal as { phase?: unknown; objective?: unknown; roundsStarted?: unknown; maxGoalRounds?: unknown }
  const phase = typeof g.phase === 'string' ? g.phase : 'active'
  const label = phase === 'complete' ? 'Goal complete' : phase === 'blocked' ? 'Goal blocked' : phase === 'paused' ? 'Goal paused' : 'Goal active'
  const rounds = typeof g.roundsStarted === 'number' && typeof g.maxGoalRounds === 'number' ? ` · round ${String(g.roundsStarted)}/${String(g.maxGoalRounds)}` : ''
  const objective = typeof g.objective === 'string' ? ` · ${clip(g.objective, 80)}` : ''
  return `${label}${rounds}${objective}`
}

function bashOutput(json: unknown, raw: string): string {
  if (json !== undefined && json !== null && typeof json === 'object' && !Array.isArray(json)) {
    const record = json as Record<string, unknown>
    const parts = [record.stdout, record.output, record.stderr].filter((part): part is string => typeof part === 'string' && part !== '')
    const exit = typeof record.exitCode === 'number' && record.exitCode !== 0 ? `\n[exit ${String(record.exitCode)}]` : ''
    if (parts.length > 0) return parts.join('\n') + exit
  }
  return raw
}

function summarizeAnswers(json: unknown): string {
  if (json !== null && typeof json === 'object' && 'answers' in json && Array.isArray((json).answers)) {
    const answers = (json as { answers: { selected?: string[]; custom?: string }[] }).answers
    const text = answers.map(answer => [...answer.selected ?? [], ...answer.custom === undefined ? [] : [answer.custom]].join(', ')).filter(Boolean).join(' · ')
    return text === '' ? 'User skipped' : `User answered: ${clip(text, 140)}`
  }
  return 'Answered'
}
