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
import { clipText, pad, renderDiff, wrap } from '../render.ts'
import type { Overlay, QuestionAnswer } from '../store.ts'
import { ansi, glyph, palette } from '../theme.ts'
import { editPair, filePath, lineDiff, toolVerb } from '../tool-format.ts'

const c = {
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
}

function frame(lines: readonly string[], width: number, color: (s: string) => string): string {
  const inner = width - 4
  return [
    color(`╭${'─'.repeat(width - 2)}╮`),
    ...lines.map(line => `${color('│')} ${pad(line, inner)} ${color('│')}`),
    color(`╰${'─'.repeat(width - 2)}╯`),
  ].join('\n')
}

function option(index: number, active: boolean, label: string, extra = ''): string {
  const pointer = active ? c.accent(`${glyph.pointer} `) : '  '
  const number = `${String(index + 1)}. `
  return pointer + (active ? c.accent(number + label) : c.text(number) + c.text(label)) + extra
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

function ApprovalPrompt({ overlay, width }: { overlay: Extract<Overlay, { kind: 'approval' }>; width: number }): React.JSX.Element {
  const [index, setIndex] = useState(0)
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
  choices.forEach((label, i) => { lines.push(option(i, i === index, label)) })
  return (
    <Box flexDirection="column">
      <Text>{frame(lines, width, c.warning)}</Text>
      <Text>{footer('↑/↓ to choose · enter to confirm · 1-3 shortcut · esc to decline')}</Text>
    </Box>
  )
}

// ---------------------------------------------------------------- questions

function QuestionPrompt({ overlay, width }: { overlay: Extract<Overlay, { kind: 'question' }>; width: number }): React.JSX.Element {
  const questions = overlay.questions
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

  useInput((input, key) => {
    if (question === undefined) return
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
  if (multiple) {
    const tabs = questions.map((q, i) => {
      const done = (answers[q.id]?.selected.length ?? 0) > 0 || answers[q.id]?.custom !== undefined
      const label = `${done ? glyph.todoDone : glyph.todoOpen} ${q.header ?? `Q${String(i + 1)}`}`
      return i === tab ? ansi.bgHex(palette.accentDim).hex('#FFFFFF')(` ${label} `) : c.muted(` ${label} `)
    })
    tabs.push(onSubmitTab ? ansi.bgHex(palette.accentDim).hex('#FFFFFF')(` ${glyph.check} Submit `) : c.muted(` ${glyph.check} Submit `))
    lines.push(`${c.faint('←')} ${tabs.join(' ')} ${c.faint('→')}`, '')
  }

  if (onSubmitTab) {
    lines.push(c.bold('Review your answers'), '')
    for (const q of questions) {
      const a = answers[q.id]
      const text = [...a?.selected ?? [], ...a?.custom === undefined ? [] : [`“${a.custom}”`]].join(', ')
      lines.push(c.muted(`• ${q.question}`), `  ${c.accent('→')} ${text === '' ? c.faint('(skipped)') : c.text(text)}`)
    }
    lines.push('', c.text('Ready to submit your answers?'), option(0, true, 'Submit answers'))
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
    question.options.forEach((opt, i) => {
      const active = i === cursor && typing === undefined
      const box = question.multiSelect ? `${chosen.includes(opt.label) ? c.success('[✔]') : c.faint('[ ]')} ` : ''
      const label = plan && opt.label === question.planReview.approve ? `Yes, approve the plan and start ${c.faint('(leave plan mode)')}` : plan ? `No, keep planning ${c.faint('(stay in plan mode)')}` : opt.label
      lines.push(option(i, active, box + label))
      if (opt.description !== undefined && !plan) lines.push(...wrap(opt.description, inner - 7).map(line => `      ${c.faint(line)}`))
    })
    const otherIndex = optionCount - 1
    const otherActive = cursor === otherIndex
    const otherLabel = typing !== undefined && otherActive
      ? c.text(typing) + ansi.inverse(' ')
      : plan ? c.muted('Tell DeepSeek what to change…') : c.muted('Type something else…')
    lines.push(option(otherIndex, otherActive && typing === undefined, otherLabel))
  }
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

function PickerPrompt({ overlay, width }: { overlay: Extract<Overlay, { kind: 'picker' }>; width: number }): React.JSX.Element {
  const initial = Math.max(0, overlay.options.findIndex(opt => opt.current === true))
  const [index, setIndex] = useState(initial)
  const [filter, setFilter] = useState('')
  const options = overlay.options.filter(opt => filter === '' || `${opt.label} ${opt.description ?? ''}`.toLowerCase().includes(filter.toLowerCase()))
  const selected = Math.min(index, Math.max(0, options.length - 1))
  useInput((input, key) => {
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
  visible.forEach((opt, offset) => {
    const i = start + offset
    const active = i === selected
    const mark = opt.current === true ? c.success(` ${glyph.check}`) : ''
    const badge = opt.badge === undefined ? '' : ` ${ansi.bgHex(palette.border).hex(palette.text)(` ${opt.badge} `)}`
    const label = pad(clipText(opt.label, labelWidth - 1), labelWidth)
    const used = 5 + labelWidth + stringWidth(mark) + stringWidth(badge)
    const description = opt.description === undefined ? '' : clipText(opt.description, Math.max(0, inner - used - 1))
    lines.push(`${active ? c.accent(`${glyph.pointer} `) : '  '}${c.faint(`${String(i + 1).padStart(2)}.`)} ${active ? c.accent(label) : c.text(label)}${active ? c.muted(description) : c.faint(description)}${badge}${mark}`)
  })
  if (options.length === 0) lines.push(c.faint('  No matches'))
  if (options.length > visible.length) lines.push(c.faint(`  ${String(options.length)} total · ↑/↓ to scroll`))
  return (
    <Box flexDirection="column">
      <Text>{frame(lines, width, c.accent)}</Text>
      <Text>{footer('enter to select · type to filter · esc to cancel')}</Text>
    </Box>
  )
}

/** Render the topmost overlay. */
export function OverlayView({ overlay, width }: { overlay: Overlay; width: number }): React.JSX.Element {
  switch (overlay.kind) {
    case 'approval':
      return <ApprovalPrompt key={overlay.id} overlay={overlay} width={width} />
    case 'question':
      return <QuestionPrompt key={overlay.id} overlay={overlay} width={width} />
    case 'picker':
      return <PickerPrompt key={overlay.id} overlay={overlay} width={width} />
    default:
      return <Text />
  }
}
