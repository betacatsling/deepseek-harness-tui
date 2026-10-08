/** @jsxRuntime automatic */
/**
 * Modal prompts that replace the composer: tool approval, user questions
 * (including plan review), and the generic picker used by /model, /resume,
 * /permissions, /config, and /history.
 * @module @deepseek-ai/dsh-experimental-tui/ui/overlays
 */

import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import stringWidth from '../width.ts'
import { renderMarkdown } from '../markdown.ts'
import type { MouseController } from '../mouse/controller.ts'
import { clipText, pad, renderDiff, wrap } from '../render.ts'
import type { Overlay, QuestionAnswer } from '../store.ts'
import { ansi, glyph, palette, themed } from '../theme.ts'
import { editPair, filePath, lineDiff, toolVerb } from '../tool-format.ts'
import { selectionKey } from './composer.tsx'

const c = themed(() => ({
  text: ansi.hex(palette.text),
  bold: ansi.hex(palette.text).bold,
  muted: ansi.hex(palette.muted),
  faint: ansi.hex(palette.faint),
  accent: ansi.hex(palette.accent),
  warning: ansi.hex(palette.warning),
  danger: ansi.hex(palette.danger),
  plan: ansi.hex(palette.plan),
  success: ansi.hex(palette.success),
  border: ansi.hex(palette.border),
}))

function frame(lines: readonly string[], width: number, color: (s: string) => string): string {
  const inner = width - 4
  return [
    color(`╭${'─'.repeat(width - 2)}╮`),
    ...lines.map(line => `${color('│')} ${pad(line, inner)} ${color('│')}`),
    color(`╰${'─'.repeat(width - 2)}╯`),
  ].join('\n')
}

function option(index: number, active: boolean, label: string, extra = '', hovered = false): string {
  const pointer = active ? c.accent(`${glyph.pointer} `) : hovered ? c.faint(`${glyph.pointer} `) : '  '
  const number = `${String(index + 1)}. `
  if (active) return pointer + c.accent(number + label) + extra
  if (hovered) return pointer + c.text(number) + ansi.underline(c.text(label)) + extra
  return pointer + c.text(number) + c.text(label) + extra
}

/** A clickable line of a modal prompt. */
type Target =
  | { readonly kind: 'option'; readonly index: number }
  | { readonly kind: 'tabs'; readonly spans: readonly { readonly from: number; readonly to: number; readonly tab: number }[] }

interface OverlayMouse {
  click(target: Target, col: number): void
  wheel?(direction: 1 | -1): void
}

/**
 * Register a modal's click targets with the fullscreen mouse router.
 * `targets` is parallel to the framed body lines; row 0 is the top border.
 */
function registerOverlay(
  mouse: MouseController | undefined,
  targets: readonly (Target | undefined)[],
  hover: number | undefined,
  setHover: (index: number | undefined) => void,
  handlers: OverlayMouse,
): void {
  if (mouse === undefined) return
  mouse.registerBottom({
    height: targets.length + 3,
    onMouse(event, row, col) {
      const target = row >= 1 ? targets[row - 1] : undefined
      const index = target?.kind === 'option' ? target.index : undefined
      if (event.kind === 'move' || event.kind === 'drag') {
        if (index !== hover) setHover(index)
        return target !== undefined
      }
      if (event.kind === 'wheel') {
        if (handlers.wheel === undefined) return false
        handlers.wheel(event.direction === 'up' ? -1 : 1)
        return true
      }
      if (event.kind !== 'down' || event.button !== 'left' || target === undefined) return false
      handlers.click(target, col - 2)
      return true
    },
  })
}

function footer(text: string): string {
  return `  ${c.faint(text)}`
}

// ---------------------------------------------------------------- approval

const APPROVAL_TITLES: Record<string, string> = {
  bash: 'Bash command',
  pwsh: 'PowerShell command',
  write: 'Create file',
  edit: 'Edit file',
  str_replace_editor: 'Edit file',
  web_fetch: 'Fetch',
}

function ApprovalPrompt({ overlay, width, mouse }: { overlay: Extract<Overlay, { kind: 'approval' }>; width: number; mouse?: MouseController }): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const [hover, setHover] = useState<number | undefined>(undefined)
  const verb = toolVerb(overlay.toolName)
  const choices = [
    'Yes',
    `Yes, and don't ask again for ${verb} this session`,
    `No, and tell DeepSeek what to do differently ${c.faint('(esc)')}`,
  ]
  const choose = (i: number): void => {
    overlay.resolve(i === 0 ? 'once' : i === 1 ? 'always' : 'reject')
  }
  useInput((input, key) => {
    if (selectionKey(mouse, input, key)) return
    if (key.upArrow) setIndex((index + choices.length - 1) % choices.length)
    else if (key.downArrow || key.tab) setIndex((index + 1) % choices.length)
    else if (key.return) choose(index)
    else if (key.escape) choose(2)
    else if (input === '1' || input === 'y') choose(0)
    else if (input === '2' || input === 'a') choose(1)
    else if (input === '3' || input === 'n') choose(2)
  })
  const inner = width - 4
  const args = overlay.args ?? {}
  const lines: string[] = [c.bold(APPROVAL_TITLES[overlay.toolName] ?? `${verb} tool`), '']
  const why = typeof args.justification === 'string' ? args.justification : typeof args.description === 'string' ? args.description : undefined
  if (overlay.toolName === 'bash' || overlay.toolName === 'pwsh') {
    const command = typeof args.command === 'string' ? args.command : ''
    lines.push(...wrap(command, inner - 4).map(line => `   ${c.text(line)}`))
    if (why !== undefined) lines.push(...wrap(why, inner - 4).map(line => `   ${c.muted(line)}`))
  } else {
    const pair = editPair(overlay.toolName, args)
    const path = filePath(args)
    if (pair !== undefined && path !== undefined) {
      lines.push(`   ${c.text(path)}`, '')
      lines.push(...renderDiff(lineDiff(pair.before, pair.after), inner - 2, path, 12).map(line => `  ${line}`))
    } else {
      const raw = JSON.stringify(args)
      lines.push(...wrap(`${overlay.toolName}(${raw.length > 400 ? `${raw.slice(0, 399)}…` : raw})`, inner - 4).map(line => `   ${c.text(line)}`))
    }
  }
  const reason = overlay.reason?.trim() ?? ''
  const escalation = /^escalate sandbox to ([\w-]+)(?::\s*([\s\S]*))?$/.exec(reason)
  if (escalation !== null) {
    lines.push('', `   ${c.danger('⚠')} ${c.text('Runs outside the sandbox')} ${c.faint(`(${escalation[1] ?? ''})`)}`)
    const extra = escalation[2]?.trim()
    if (extra !== undefined && extra !== '' && extra !== why?.trim()) lines.push(...wrap(extra, inner - 4).map(line => `   ${c.faint(line)}`))
  } else if (reason !== '' && reason !== why?.trim()) {
    lines.push('', ...wrap(reason, inner - 4).map(line => `   ${c.faint(line)}`))
  }
  lines.push('', c.text('Do you want to proceed?'))
  const targets: (Target | undefined)[] = lines.map(() => undefined)
  choices.forEach((label, i) => {
    lines.push(option(i, i === index, label, '', i === hover))
    targets.push({ kind: 'option', index: i })
  })
  registerOverlay(mouse, targets, hover, setHover, {
    click: (target) => { if (target.kind === 'option') choose(target.index) },
  })
  return (
    <Box flexDirection="column">
      <Text>{frame(lines, width, c.warning)}</Text>
      <Text>{footer('↑/↓ to choose · enter to confirm · 1-3 shortcut · esc to decline')}</Text>
    </Box>
  )
}

// ---------------------------------------------------------------- questions

function QuestionPrompt({ overlay, width, mouse }: { overlay: Extract<Overlay, { kind: 'question' }>; width: number; mouse?: MouseController }): React.JSX.Element {
  const questions = overlay.questions
  const [hover, setHover] = useState<number | undefined>(undefined)
  const [tab, setTab] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [answers, setAnswers] = useState<Record<string, { selected: string[]; custom?: string }>>({})
  const [typing, setTyping] = useState<string | undefined>(undefined)
  const multiple = questions.length > 1
  const onSubmitTab = multiple && tab === questions.length
  const question = questions[Math.min(tab, questions.length - 1)]
  const plan = question?.planReview !== undefined
  const optionCount = (question?.options.length ?? 0) + 1

  const finish = (final: Record<string, { selected: string[]; custom?: string }>): void => {
    const list: QuestionAnswer[] = questions.map(q => ({
      id: q.id,
      selected: final[q.id]?.selected ?? [],
      ...final[q.id]?.custom === undefined ? {} : { custom: final[q.id]?.custom ?? '' },
    }))
    overlay.resolve(list)
  }

  const advance = (next: Record<string, { selected: string[]; custom?: string }>): void => {
    setAnswers(next)
    setTyping(undefined)
    setCursor(0)
    if (!multiple) finish(next)
    else setTab(tab + 1)
  }

  /** A click on option `target`: the same as pressing its number key. */
  const clickOption = (target: number): void => {
    if (question === undefined) return
    if (onSubmitTab) {
      finish(answers)
      return
    }
    setCursor(target)
    if (target === optionCount - 1) {
      setTyping(answers[question.id]?.custom ?? '')
      return
    }
    setTyping(undefined)
    const label = question.options[target]?.label ?? ''
    if (question.multiSelect) {
      const current = answers[question.id]?.selected ?? []
      const selected = current.includes(label) ? current.filter(l => l !== label) : [...current, label]
      setAnswers({ ...answers, [question.id]: { selected } })
      return
    }
    advance({ ...answers, [question.id]: { selected: [label] } })
  }

  useInput((input, key) => {
    if (question === undefined) return
    if (selectionKey(mouse, input, key)) return
    if (onSubmitTab) {
      if (key.return) finish(answers)
      else if (key.leftArrow || (key.tab && key.shift)) setTab(tab - 1)
      else if (key.escape) overlay.resolve(undefined)
      return
    }
    const onOther = cursor === optionCount - 1
    if (typing !== undefined && onOther) {
      if (key.return) {
        const text = typing.trim()
        if (text === '') return
        const current = answers[question.id]
        const selected = plan ? [question.options.find(o => o.label !== question.planReview?.approve)?.label ?? 'Keep planning'] : current?.selected ?? []
        advance({ ...answers, [question.id]: { selected, custom: text } })
        return
      }
      if (key.escape) { setTyping(undefined); return }
      if (key.backspace || key.delete) { setTyping(typing.slice(0, -1)); return }
      if (key.upArrow) { setTyping(undefined); setCursor(cursor - 1); return }
      if (input !== '' && !key.ctrl && !key.meta) setTyping(typing + input.replace(/[\r\n]/g, ' '))
      return
    }
    if (key.escape) { overlay.resolve(undefined); return }
    if (key.upArrow) { setCursor((cursor + optionCount - 1) % optionCount); return }
    if (key.downArrow) { setCursor((cursor + 1) % optionCount); return }
    if (multiple && (key.rightArrow || key.tab)) { setTab(Math.min(questions.length, tab + 1)); setCursor(0); return }
    if (multiple && key.leftArrow) { setTab(Math.max(0, tab - 1)); setCursor(0); return }
    const digit = Number(input)
    const pick = Number.isInteger(digit) && digit >= 1 && digit <= optionCount ? digit - 1 : undefined
    const target = pick ?? cursor
    if (pick !== undefined) setCursor(pick)
    if (key.return || pick !== undefined || (question.multiSelect && input === ' ')) {
      if (target === optionCount - 1) { setTyping(answers[question.id]?.custom ?? ''); return }
      const label = question.options[target]?.label ?? ''
      if (question.multiSelect) {
        const current = answers[question.id]?.selected ?? []
        if (key.return && pick === undefined && current.length > 0 && !current.includes(label)) {
          advance(answers)
          return
        }
        const selected = current.includes(label) ? current.filter(l => l !== label) : [...current, label]
        if (key.return && pick === undefined) advance({ ...answers, [question.id]: { selected } })
        else setAnswers({ ...answers, [question.id]: { selected } })
        return
      }
      advance({ ...answers, [question.id]: { selected: [label] } })
      return
    }
    if (input !== '' && !key.ctrl && !key.meta && /\S/.test(input)) {
      setCursor(optionCount - 1)
      setTyping(input)
    }
  })

  const inner = width - 4
  const lines: string[] = []
  const targets: (Target | undefined)[] = []
  const mark = (target?: Target): void => { while (targets.length < lines.length) targets.push(target) }
  if (multiple) {
    const labels = [...questions.map((q, i) => {
      const done = (answers[q.id]?.selected.length ?? 0) > 0 || answers[q.id]?.custom !== undefined
      return `${done ? glyph.todoDone : glyph.todoOpen} ${q.header ?? `Q${String(i + 1)}`}`
    }), `${glyph.check} Submit`]
    const spans: { from: number; to: number; tab: number }[] = [{ from: 0, to: 2, tab: Math.max(0, tab - 1) }]
    let col = 2
    const tabs = labels.map((label, i) => {
      const w = stringWidth(label) + 2
      spans.push({ from: col, to: col + w, tab: i })
      col += w + 1
      return i === tab ? ansi.bgHex(palette.accentDim).hex(palette.onAccent)(` ${label} `) : c.muted(` ${label} `)
    })
    spans.push({ from: col, to: col + 1, tab: Math.min(questions.length, tab + 1) })
    lines.push(`${c.faint('←')} ${tabs.join(' ')} ${c.faint('→')}`)
    mark({ kind: 'tabs', spans })
    lines.push('')
  }

  if (onSubmitTab) {
    lines.push(c.bold('Review your answers'), '')
    for (const q of questions) {
      const a = answers[q.id]
      const text = [...a?.selected ?? [], ...a?.custom === undefined ? [] : [`“${a.custom}”`]].join(', ')
      lines.push(c.muted(`• ${q.question}`), `  ${c.accent('→')} ${text === '' ? c.faint('(skipped)') : c.text(text)}`)
    }
    lines.push('', c.text('Ready to submit your answers?'))
    mark()
    lines.push(option(0, true, 'Submit answers'))
    mark({ kind: 'option', index: 0 })
  } else if (question !== undefined) {
    if (plan) {
      lines.push(c.plan.bold('Here is DeepSeek’s plan:'), '')
      const planLines = renderMarkdown(question.detail ?? '', inner - 4)
      const box = ansi.hex(palette.plan)
      lines.push(box(`╭${'─'.repeat(inner - 2)}╮`))
      for (const line of planLines) lines.push(`${box('│')} ${pad(line, inner - 4)} ${box('│')}`)
      lines.push(box(`╰${'─'.repeat(inner - 2)}╯`), '')
      lines.push(c.text('Would you like to proceed?'))
    } else {
      if (!multiple && question.header !== undefined) lines.push(c.accent(question.header))
      lines.push(...wrap(c.bold(question.question), inner))
      if (question.detail !== undefined) lines.push(...renderMarkdown(question.detail, inner))
      if (question.multiSelect) lines.push(c.faint('Select all that apply'))
      lines.push('')
    }
    const chosen = answers[question.id]?.selected ?? []
    mark()
    question.options.forEach((opt, i) => {
      const active = i === cursor && typing === undefined
      const box = question.multiSelect ? `${chosen.includes(opt.label) ? c.success('[✔]') : c.faint('[ ]')} ` : ''
      const label = plan && opt.label === question.planReview.approve ? `Yes, approve the plan and start ${c.faint('(leave plan mode)')}` : plan ? `No, keep planning ${c.faint('(stay in plan mode)')}` : opt.label
      lines.push(option(i, active, box + label, '', i === hover && !active))
      if (opt.description !== undefined && !plan) lines.push(...wrap(opt.description, inner - 7).map(line => `      ${c.faint(line)}`))
      mark({ kind: 'option', index: i })
    })
    const otherIndex = optionCount - 1
    const otherActive = cursor === otherIndex
    const otherLabel = typing !== undefined && otherActive
      ? c.text(typing) + ansi.inverse(' ')
      : plan ? c.muted('Tell DeepSeek what to change…') : c.muted('Type something else…')
    lines.push(option(otherIndex, otherActive && typing === undefined, otherLabel, '', hover === otherIndex && !otherActive))
    mark({ kind: 'option', index: otherIndex })
  }
  mark()
  registerOverlay(mouse, targets, hover, setHover, {
    click: (target, col) => {
      if (target.kind === 'option') {
        clickOption(target.index)
        return
      }
      const span = target.spans.find(s => col >= s.from && col < s.to)
      if (span === undefined) return
      setTab(span.tab)
      setCursor(0)
      setTyping(undefined)
    },
  })
  const hint = typing !== undefined ? 'enter to send · esc to go back'
    : question?.multiSelect === true ? 'space to toggle · enter to confirm · esc to dismiss'
      : multiple ? '↑/↓ choose · enter select · ←/→ switch question · esc to dismiss'
        : 'enter to select · ↑/↓ to navigate · type to answer freely · esc to dismiss'
  return (
    <Box flexDirection="column">
      <Text>{frame(lines, width, plan ? c.plan : c.accent)}</Text>
      <Text>{footer(hint)}</Text>
    </Box>
  )
}

// ---------------------------------------------------------------- picker

function PickerPrompt({ overlay, width, mouse }: { overlay: Extract<Overlay, { kind: 'picker' }>; width: number; mouse?: MouseController }): React.JSX.Element {
  const [hover, setHover] = useState<number | undefined>(undefined)
  const initial = Math.max(0, overlay.options.findIndex(opt => opt.current === true))
  const [index, setIndex] = useState(initial)
  const [filter, setFilter] = useState('')
  const options = overlay.options.filter(opt => filter === '' || `${opt.label} ${opt.description ?? ''}`.toLowerCase().includes(filter.toLowerCase()))
  const selected = Math.min(index, Math.max(0, options.length - 1))
  useInput((input, key) => {
    if (selectionKey(mouse, input, key)) return
    if (key.escape) { overlay.resolve(undefined); return }
    if (key.upArrow) { setIndex((selected + options.length - 1) % Math.max(1, options.length)); return }
    if (key.downArrow || key.tab) { setIndex((selected + 1) % Math.max(1, options.length)); return }
    if (key.return) { overlay.resolve(options[selected]?.value); return }
    if (key.backspace || key.delete) { setFilter(filter.slice(0, -1)); setIndex(0); return }
    if (input !== '' && !key.ctrl && !key.meta) {
      const digit = Number(input)
      if (filter === '' && Number.isInteger(digit) && digit >= 1 && digit <= Math.min(9, options.length)) {
        overlay.resolve(options[digit - 1]?.value)
        return
      }
      setFilter(filter + input)
      setIndex(0)
    }
  })
  const inner = width - 4
  const size = 10
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), options.length - size))
  const visible = options.slice(start, start + size)
  const labelWidth = Math.min(36, Math.max(10, ...visible.map(opt => stringWidth(opt.label) + 2)))
  const lines: string[] = [c.bold(overlay.title)]
  if (overlay.hint !== undefined) lines.push(...wrap(overlay.hint, inner).map(line => c.faint(line)))
  lines.push(filter === '' ? '' : `${c.faint('filter:')} ${c.text(filter)}${ansi.inverse(' ')}`)
  const targets: (Target | undefined)[] = lines.map(() => undefined)
  visible.forEach((opt, offset) => {
    const i = start + offset
    const active = i === selected
    const hovered = i === hover && !active
    targets.push({ kind: 'option', index: i })
    const mark = opt.current === true ? c.success(` ${glyph.check}`) : ''
    const badge = opt.badge === undefined ? '' : ` ${ansi.bgHex(palette.border).hex(palette.text)(` ${opt.badge} `)}`
    const label = pad(clipText(opt.label, labelWidth - 1), labelWidth)
    const used = 5 + labelWidth + stringWidth(mark) + stringWidth(badge)
    const description = opt.description === undefined ? '' : clipText(opt.description, Math.max(0, inner - used - 1))
    const pointer = active ? c.accent(`${glyph.pointer} `) : hovered ? c.faint(`${glyph.pointer} `) : '  '
    const name = active ? c.accent(label) : hovered ? ansi.underline(c.text(label.trimEnd())) + ' '.repeat(label.length - label.trimEnd().length) : c.text(label)
    lines.push(`${pointer}${c.faint(`${String(i + 1).padStart(2)}.`)} ${name}${active || hovered ? c.muted(description) : c.faint(description)}${badge}${mark}`)
  })
  if (options.length === 0) lines.push(c.faint('  No matches'))
  if (options.length > visible.length) lines.push(c.faint(`  ${String(options.length)} total · ↑/↓ to scroll`))
  while (targets.length < lines.length) targets.push(undefined)
  registerOverlay(mouse, targets, hover, setHover, {
    click: (target) => {
      if (target.kind !== 'option') return
      setIndex(target.index)
      overlay.resolve(options[target.index]?.value)
    },
    wheel: (direction) => {
      if (options.length === 0) return
      setIndex(Math.max(0, Math.min(options.length - 1, selected + direction)))
    },
  })
  return (
    <Box flexDirection="column">
      <Text>{frame(lines, width, c.accent)}</Text>
      <Text>{footer('enter to select · type to filter · esc to cancel')}</Text>
    </Box>
  )
}

/** Render the topmost overlay. */
export function OverlayView({ overlay, width, mouse }: { overlay: Overlay; width: number; mouse?: MouseController }): React.JSX.Element {
  const shared = mouse === undefined ? {} : { mouse }
  switch (overlay.kind) {
    case 'approval':
      return <ApprovalPrompt key={overlay.id} overlay={overlay} width={width} {...shared} />
    case 'question':
      return <QuestionPrompt key={overlay.id} overlay={overlay} width={width} {...shared} />
    case 'picker':
      return <PickerPrompt key={overlay.id} overlay={overlay} width={width} {...shared} />
    default:
      return <Text />
  }
}
