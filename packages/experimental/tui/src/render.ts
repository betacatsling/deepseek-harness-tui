/**
 * Transcript item renderers. Every item becomes pre-wrapped ANSI text for a
 * given width so the same output feeds Ink's <Static> scrollback, the live
 * region, tests, and Markdown export previews. Layout follows the Claude Code
 * grammar: `⏺` bullets for model actions, `⎿` elbows for results, a quiet
 * gutter for user turns.
 * @module @deepseek-ai/dsh-experimental-tui/render
 */

import stringWidth from './width.ts'
import wrapAnsi from 'wrap-ansi'
import { formatElapsed, tildify } from './format.ts'
import { highlightCode, languageForPath } from './highlight.ts'
import { renderMarkdown } from './markdown.ts'
import type { ChildStep, Item, TodoEntry, UiState } from './store.ts'
import { ansi, glyph, palette } from './theme.ts'
import { type DiffLine, editPair, filePath, summarizeResult, toolArgument, toolVerb } from './tool-format.ts'

const c = {
  text: ansi.hex(palette.text),
  bold: ansi.hex(palette.text).bold,
  muted: ansi.hex(palette.muted),
  faint: ansi.hex(palette.faint),
  accent: ansi.hex(palette.accent),
  success: ansi.hex(palette.success),
  error: ansi.hex(palette.error),
  warning: ansi.hex(palette.warning),
  plan: ansi.hex(palette.plan),
  bash: ansi.hex(palette.synAttr),
  border: ansi.hex(palette.border),
  user: ansi.hex(palette.user),
}

/** Render options shared by all items. */
export interface RenderOptions {
  readonly width: number
  /** Ctrl+O detailed transcript. */
  readonly detail: boolean
  /** Animation frame for running bullets. */
  readonly frame?: number
  readonly now?: number
}

/** Hard-wrap ANSI text to `width` columns, preserving explicit newlines. */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(8, width)
  return text.split('\n').flatMap(line => wrapAnsi(line, w, { hard: true, trim: false }).split('\n'))
}

/** Prefix the first line with `first` and the rest with `rest`. */
export function hang(first: string, rest: string, lines: readonly string[]): string[] {
  return lines.map((line, index) => (index === 0 ? first : rest) + line)
}

/** Pad an ANSI string to a visible width. */
export function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - stringWidth(text)))
}

/** Clip an ANSI-free string to a visible width with an ellipsis. */
export function clipText(text: string, width: number): string {
  if (stringWidth(text) <= width) return text
  let out = ''
  for (const ch of text) {
    if (stringWidth(out + ch) > width - 1) break
    out += ch
  }
  return `${out}…`
}

const ELBOW = `  ${glyph.elbow}  `
const ELBOW_REST = '     '

/** Lines hanging under a `⎿` elbow, wrapped to the remaining width. */
function elbow(lines: readonly string[], width: number, wrapLines = true): string[] {
  const inner = width - ELBOW.length
  const wrapped = wrapLines ? lines.flatMap(line => wrap(line, inner)) : lines.map(line => line)
  return hang(c.faint(ELBOW), ELBOW_REST, wrapped)
}

function moreLine(hidden: number, what = 'lines'): string {
  return c.faint(`… +${String(hidden)} ${what} `) + c.faint.italic('(ctrl+o to expand)')
}

// ---------------------------------------------------------------- banner

// Trailing spaces keep the whale aligned when the banner centers each row.
const LOGO = [
  ' ▄▄▄  ▄▄▄       ▄▄▄▄▄▄▄     ',
  '  ▀█▄▄█▀    ▄████████████▄  ',
  '    ▀█▄   ▄████████████▀███ ',
  '      ▀███████████████████▀ ',
  '          ▀▀███████████▀▀   ',
  '                 ███▀       ',
]

/** Welcome box: logo and setup on the left, tips and recent sessions on the right. */
export function renderBanner(state: UiState, width: number): string[] {
  const home = process.env.HOME ?? ''
  const total = Math.max(40, Math.min(width, 112))
  const inner = total - 4
  const two = inner >= 84
  const leftWidth = two ? 38 : inner
  const rightWidth = two ? inner - leftWidth - 3 : inner
  const model = `${state.model.model}${state.model.effort === undefined ? '' : ` · ${state.model.effort}`}`
  const left = [
    '',
    c.bold('Welcome to DeepSeek Harness'),
    '',
    ...LOGO.map(line => c.accent(line)),
    '',
    c.muted(clipText(model, leftWidth)) + (state.demo ? c.warning(' (demo)') : ''),
    c.faint(clipText(tildify(state.cwd, home), leftWidth)),
  ]
  const recent = state.recent.filter(session => session.title !== undefined).slice(0, 3)
  const right = [
    c.accent('Tips for getting started'),
    c.text('Ask anything, or try ') + c.bold('/init') + c.text(' for AGENTS.md'),
    c.text('Use ') + c.bold('@') + c.text(' to attach files, ') + c.bold('!') + c.text(' for shell'),
    c.bold('shift+tab') + c.text(' cycles permission & plan mode'),
    c.faint('─'.repeat(Math.min(rightWidth, 40))),
    c.accent('Recent activity'),
    ...recent.length === 0
      ? [c.faint('No recent sessions in this folder')]
      : recent.map(session => c.text(clipText(session.title ?? '(untitled)', rightWidth - 10)) + c.faint(` · ${session.ago}`)),
    c.faint('/resume for more'),
  ]
  const rows: string[] = []
  const border = (s: string): string => c.border(s)
  const title = ` ${c.accent('✻')} ${c.bold('DeepSeek Harness')} ${c.faint(`v${state.version}`)} `
  rows.push(border('╭─') + title + border(`${'─'.repeat(Math.max(0, total - 3 - stringWidth(title)))}╮`))
  if (two) {
    const height = Math.max(left.length, right.length + 1)
    for (let i = 0; i < height; i += 1) {
      const l = left[i] ?? ''
      const r = i === 0 ? '' : right[i - 1] ?? ''
      const lPad = Math.floor((leftWidth - stringWidth(l)) / 2)
      rows.push(`${border('│')} ${pad(' '.repeat(Math.max(0, lPad)) + l, leftWidth)} ${border('│')} ${pad(r, rightWidth)} ${border('│')}`)
    }
  } else {
    for (const line of [...left, '', ...right]) rows.push(`${border('│')} ${pad(line, inner)} ${border('│')}`)
  }
  rows.push(border(`╰${'─'.repeat(total - 2)}╯`))
  return rows
}

// ---------------------------------------------------------------- items

function renderUser(text: string, width: number, mentions: readonly string[] | undefined, steered: boolean | undefined): string[] {
  const bg = ansi.bgHex('#1F232C')
  const body = wrap(text, width - 4)
  const lines = body.map((line, index) => bg(pad(`${index === 0 ? c.faint(' > ') : '   '}${c.user(line)}`, width - 1)))
  const out = [...lines]
  if (steered === true) out.push(c.faint(`  ${glyph.elbow}  sent while working · steering the current turn`))
  for (const mention of mentions ?? []) out.push(c.faint(`  ${glyph.elbow}  Read `) + c.muted(mention))
  return out
}

function renderAssistant(text: string, width: number): string[] {
  const lines = renderMarkdown(text, width - 2)
  return hang(`${c.text(glyph.bullet)} `, '  ', lines)
}

function renderThinking(text: string, ms: number | undefined, opts: RenderOptions): string[] {
  const label = ms === undefined ? 'Thought' : `Thought for ${formatElapsed(Math.max(1000, ms))}`
  if (!opts.detail) return [c.faint(`${glyph.spark} ${label} `) + c.faint.italic('(ctrl+o to expand)')]
  return [
    c.faint(`${glyph.spark} ${label}`),
    ...wrap(text, opts.width - 4).map(line => `  ${ansi.hex(palette.muted).italic(line)}`),
  ]
}

function statusBullet(status: string, frame: number): string {
  switch (status) {
    case 'running':
      return frame % 10 < 5 ? c.text(glyph.bullet) : c.faint(glyph.bullet)
    case 'waiting':
      return frame % 10 < 5 ? c.warning(glyph.bullet) : c.faint(glyph.bullet)
    case 'ok':
      return c.success(glyph.bullet)
    case 'error':
      return c.error(glyph.bullet)
    case 'denied':
      return c.warning(glyph.bullet)
    default:
      return c.faint(glyph.bullet)
  }
}

/** Render a todo checklist. */
export function renderTodos(todos: readonly TodoEntry[], width: number): string[] {
  return todos.flatMap((todo) => {
    const lines = wrap(todo.content, width - 2)
    if (todo.status === 'completed') return hang(c.success(`${glyph.todoDone} `), '  ', lines.map(line => c.faint.strikethrough(line)))
    if (todo.status === 'in_progress') return hang(c.accent(`${glyph.todoActive} `), '  ', lines.map(line => c.bold(line)))
    return hang(c.muted(`${glyph.todoOpen} `), '  ', lines.map(line => c.text(line)))
  })
}

/** Render diff rows with gutters and tinted backgrounds. */
export function renderDiff(diff: readonly DiffLine[], width: number, path: string | undefined, limit: number): string[] {
  const lang = path === undefined ? undefined : languageForPath(path)
  const numberWidth = Math.max(3, ...diff.map(line => String(line.newNo ?? line.oldNo ?? 0).length))
  const shown = diff.slice(0, limit)
  const rows = shown.map((line) => {
    const no = String(line.kind === 'del' ? line.oldNo ?? '' : line.newNo ?? line.oldNo ?? '').padStart(numberWidth)
    const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
    const code = highlightCode(line.text, lang)[0] ?? line.text
    const budget = width - numberWidth - 3
    const visible = stringWidth(line.text) > budget ? wrapAnsi(code, budget, { hard: true, trim: false }).split('\n')[0] ?? '' : code
    const row = `${no} ${sign} ${visible}`
    if (line.kind === 'add') return ansi.bgHex(palette.diffAddBg)(pad(`${c.faint(no)} ${ansi.hex(palette.diffAddFg)(sign)} ${visible}`, width))
    if (line.kind === 'del') return ansi.bgHex(palette.diffDelBg)(pad(`${c.faint(no)} ${ansi.hex(palette.diffDelFg)(sign)} ${visible}`, width))
    void row
    return `${c.faint(no)}   ${ansi.dim(visible)}`
  })
  if (diff.length > shown.length) rows.push(moreLine(diff.length - shown.length))
  return rows
}

function renderChildren(children: readonly ChildStep[], width: number, detail: boolean): string[] {
  const shown = detail ? children : children.slice(-3)
  const hidden = children.length - shown.length
  const lines = shown.map((child) => {
    const mark = child.status === 'running' ? c.muted('…') : child.status === 'error' ? c.error(glyph.cross) : c.success(glyph.check)
    return `${mark} ${c.muted(clipText(child.label, width - 10))}`
  })
  if (hidden > 0) lines.unshift(c.faint(`+${String(hidden)} more tool use${hidden === 1 ? '' : 's'}`))
  return lines
}

export function boxed(lines: readonly string[], width: number, color: (s: string) => string, title?: string): string[] {
  const inner = width - 4
  const head = title === undefined ? '─'.repeat(width - 2) : `─ ${title} ${'─'.repeat(Math.max(0, width - 5 - stringWidth(title)))}`
  return [
    color(`╭${head}╮`),
    ...lines.map(line => `${color('│')} ${pad(line, inner)} ${color('│')}`),
    color(`╰${'─'.repeat(width - 2)}╯`),
  ]
}

/** Test-runner style marks keep their meaning: green passes, red failures. */
function shellLine(line: string): string {
  const pass = /^(\s*)(✔|✓|ok\b)(.*)$/.exec(line)
  if (pass !== null) return c.muted(pass[1] ?? '') + c.success(pass[2] ?? '') + c.muted(pass[3] ?? '')
  if (/^\s*(✖|✗|not ok\b|FAIL\b)/.test(line)) return c.error(line)
  return c.muted(line)
}

/** Render one tool block. */
export function renderTool(item: Extract<Item, { kind: 'tool' }>, opts: RenderOptions): string[] {
  const width = opts.width
  const frame = opts.frame ?? 0
  const now = opts.now ?? Date.now()
  const verb = toolVerb(item.name)
  const arg = toolArgument(item.name, item.args)
  const head = wrap(c.bold(verb) + (arg === '' ? '' : c.text(`(${arg})`)), width - 2)
  const out = hang(`${statusBullet(item.status, frame)} `, '  ', head)
  const kids = item.children !== undefined && item.children.length > 0 ? renderChildren(item.children, width - 5, opts.detail) : []
  // Finished subagents fold their tool list and the summary under one elbow.
  if (kids.length > 0 && (item.status === 'running' || item.status === 'waiting')) out.push(...elbow(kids, width, false))

  switch (item.status) {
    case 'running': {
      if (item.name === 'todo_write') break
      const elapsed = now - item.startedAt
      if (item.name === 'ask_user_question' || item.name === 'exit_plan_mode') {
        out.push(...elbow([c.warning(item.name === 'exit_plan_mode' ? 'Waiting for your review…' : 'Waiting for your answer…')], width))
      } else if (item.children === undefined || item.children.length === 0) {
        out.push(...elbow([c.faint(`Running…${elapsed > 2000 ? ` (${formatElapsed(elapsed)})` : ''}`)], width))
      }
      return out
    }
    case 'waiting':
      out.push(...elbow([c.warning('Waiting for permission…')], width))
      return out
    case 'denied':
      out.push(...elbow([c.warning('Declined by user') + c.faint(' · DeepSeek was told not to run this')], width))
      return out
    case 'cancelled':
      out.push(...elbow([c.error('Interrupted')], width))
      return out
    default:
  }

  const summary = summarizeResult(item.name, item.args, item.result ?? '', item.status === 'error', item.lineOffset ?? 0)
  const body: string[] = []

  if (item.name === 'exit_plan_mode' && typeof item.args.plan === 'string') {
    const planLines = renderMarkdown(item.args.plan, width - 9)
    body.push(...boxed(planLines, width - 5, c.plan, c.plan.bold('Plan')))
    body.push(summary.headline === '' ? '' : (/approv/i.test(summary.headline) ? c.success(summary.headline) : c.muted(summary.headline)))
    out.push(...elbow(body.filter(line => line !== ''), width, false))
    return out
  }

  if (summary.todos !== undefined) {
    out.push(...elbow(renderTodos(summary.todos, width - 5), width, false))
    return out
  }

  if (item.status === 'error') {
    body.push(c.error(summary.headline))
    const extra = (summary.body ?? '').split('\n').filter(Boolean)
    const shown = opts.detail ? extra : extra.slice(0, 3)
    const isShell = item.name === 'bash' || item.name === 'pwsh'
    body.push(...shown.map(line => isShell ? shellLine(line) : c.muted(line)))
    if (extra.length > shown.length) body.push(moreLine(extra.length - shown.length))
    out.push(...elbow(body, width))
    return out
  }

  if (summary.diff !== undefined) {
    body.push(c.text(summary.headline.replace(/(\d+) addition/, (_m, n: string) => `${c.success(n)} addition`).replace(/(\d+) removal/, (_m, n: string) => `${c.error(n)} removal`)))
    const pair = editPair(item.name, item.args)
    if (pair !== undefined) body.push(...renderDiff(summary.diff, width - 5, filePath(item.args), opts.detail ? 400 : 14))
    out.push(...elbow(body, width, false))
    return out
  }

  const bodyLines = (summary.body ?? '').split('\n')
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') bodyLines.pop()
  const compactLimit = item.name === 'bash' || item.name === 'pwsh' ? 4 : item.name === 'subagent' ? 0 : ['glob', 'grep', 'read'].includes(item.name) ? 0 : 3
  const limit = opts.detail ? 300 : compactLimit
  const shown = bodyLines.slice(0, limit)
  const quietBody = limit === 0 && bodyLines.some(Boolean)
  if (summary.headline !== '') body.push(c.text(summary.headline) + (quietBody ? ` ${c.faint.italic('(ctrl+o to expand)')}` : ''))
  const shell = item.name === 'bash' || item.name === 'pwsh'
  body.push(...shown.map(line => shell ? shellLine(line) : c.muted(line)))
  const hidden = bodyLines.filter(Boolean).length - shown.filter(Boolean).length
  if (hidden > 0 && !quietBody) body.push(moreLine(hidden))
  if (body.length === 0) body.push(c.faint('Done'))
  if (item.name === 'subagent' && kids.length > 0) {
    const uses = item.children?.length ?? 0
    const took = item.endedAt === undefined ? '' : ` · ${formatElapsed(item.endedAt - item.startedAt)}`
    body[0] = c.text('Done') + c.faint(` (${String(uses)} tool use${uses === 1 ? '' : 's'}${took})`) + (quietBody ? ` ${c.faint.italic('(ctrl+o to expand)')}` : '')
    out.push(...elbow([...kids, ...body], width, false))
    return out
  }
  out.push(...elbow(body, width))
  return out
}

function noticeIcon(tone: string): string {
  switch (tone) {
    case 'error': return c.error(glyph.elbow)
    case 'warn': return c.warning('▲')
    case 'success': return c.success(glyph.check)
    case 'info': return c.accent('›')
    default: return c.faint('•')
  }
}

function toneColor(tone: string): (s: string) => string {
  switch (tone) {
    case 'error': return c.error
    case 'warn': return c.warning
    case 'success': return c.success
    case 'info': return c.text
    default: return c.muted
  }
}

/** Render any transcript item to ANSI lines. */
export function renderItem(item: Item, state: UiState, opts: RenderOptions): string[] {
  const width = Math.max(30, opts.width)
  switch (item.kind) {
    case 'banner':
      return renderBanner(state, width)
    case 'user':
      return renderUser(item.text, width, item.mentions, item.steered)
    case 'assistant':
      return renderAssistant(item.text, width)
    case 'thinking':
      // Compact view keeps one thinking marker per turn; Ctrl+O shows all.
      return !opts.detail && item.first !== true ? [] : renderThinking(item.text, item.ms, { ...opts, width })
    case 'tool':
      return renderTool(item, { ...opts, width })
    case 'todos':
      return hang(`${c.text(glyph.bullet)} `, '  ', [c.bold('Todos'), ...renderTodos(item.todos, width - 2)])
    case 'notice': {
      const color = toneColor(item.tone)
      const first = wrap(item.text, width - 5)
      const prefix = item.tone === 'error' ? `  ${noticeIcon(item.tone)}  ` : `${noticeIcon(item.tone)} `
      const rest = ' '.repeat(stringWidth(prefix))
      const lines = hang(prefix, rest, first.map(line => color(line)))
      if (item.detail !== undefined) lines.push(...wrap(item.detail, width - 5).map(line => rest + c.faint(line)))
      return lines
    }
    case 'command': {
      const header = renderUser(item.line, width, undefined, undefined)
      if (item.pending === true) return [...header, ...elbow([c.faint('Running…')], width)]
      if (item.output === undefined) return header
      const body = item.markdown === true && item.ok ? renderMarkdown(item.output, width - 5) : wrap(item.output, width - 5).map(line => item.ok ? (line.includes('\x1b[') ? line : c.muted(line)) : c.error(line))
      return [...header, ...hang(c.faint(ELBOW), ELBOW_REST, body)]
    }
    case 'shell': {
      const header = wrap(c.bash('! ') + c.text(item.command), width)
      const lines = item.output.replace(/\n+$/, '').split('\n')
      const shown = opts.detail ? lines : lines.slice(0, 8)
      const body = item.output.trim() === '' ? [c.faint('(no output)')] : shown.map(line => shellLine(line))
      if (lines.length > shown.length) body.push(moreLine(lines.length - shown.length))
      if (item.code !== 0) body.push(c.error(`exit ${String(item.code)}`))
      return [...header, ...elbow(body, width)]
    }
    case 'memory':
      return [c.plan('# ') + c.text(item.text), ...elbow([c.faint(`Saved to ${item.file} · loaded into context on the next session`)], width)]
    case 'compacted':
      return [c.faint(`${glyph.spark} ${item.text} `) + c.faint.italic('(ctrl+o for history)')]
    default:
      return []
  }
}
