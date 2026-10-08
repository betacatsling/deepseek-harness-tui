/** @jsxRuntime automatic */
/**
 * The bordered prompt box: multi-line editing, persistent history, slash and
 * `@file` completion menus, bracketed paste collapsing, mode-aware borders,
 * and the two footer lines (mode hint + status line).
 * @module @deepseek-ai/dsh-experimental-tui/ui/composer
 */

import { Box, Text, useInput, usePaste } from 'ink'
import { useEffect, useMemo, useRef, useState } from 'react'
import stringWidth from '../width.ts'
import type { Bridge, SlashEntry } from '../bridge.ts'
import * as ed from '../editor.ts'
import { type FileIndex, mentionAt } from '../files.ts'
import type { MouseController } from '../mouse/controller.ts'
import type { MouseEvent } from '../mouse/protocol.ts'
import { pad } from '../render.ts'
import type { UiState } from '../store.ts'
import { ansi, palette, themed } from '../theme.ts'
import { modeBadgeText, modeHint, statusLine, statusModeSpan, statusModelSpan } from './status.ts'

const c = themed(() => ({
  text: ansi.hex(palette.text),
  muted: ansi.hex(palette.muted),
  faint: ansi.hex(palette.faint),
  accent: ansi.hex(palette.accent),
  border: ansi.hex(palette.border),
  bash: ansi.hex(palette.synAttr),
  plan: ansi.hex(palette.plan),
  warning: ansi.hex(palette.warning),
}))

interface MenuRow {
  readonly key: string
  readonly label: string
  readonly description: string
  readonly kind: 'slash' | 'file'
  readonly entry?: SlashEntry
}

/** Draft carried across remounts (a modal prompt replaces the composer). */
const carried: { buffer: ed.EditorState } = { buffer: ed.empty }

const PASTE_TOKEN = /\[Pasted text #(\d+) \+\d+ lines\]/g

/** Rank slash entries for a typed prefix. */
export function matchSlash(entries: readonly SlashEntry[], query: string): SlashEntry[] {
  const q = query.toLowerCase()
  const starts = entries.filter(entry => entry.name.startsWith(q))
  const contains = entries.filter(entry => !entry.name.startsWith(q)
    && (entry.name.includes(q) || entry.description.toLowerCase().includes(q)))
  return q === '' ? [...entries] : [...starts, ...contains]
}

/** Composer props. */
export interface ComposerProps {
  readonly bridge: Bridge
  readonly files: FileIndex
  readonly state: UiState
  readonly width: number
  readonly frame: number
  /** Fullscreen mouse routing; absent in inline mode. */
  readonly mouse?: MouseController
}

type HoverPart = { readonly kind: 'menu'; readonly index: number } | { readonly kind: 'body' | 'mode' | 'model' | 'agentMode' | 'interrupt' }

/** Ctrl+C copies and Esc clears a transcript selection before anything else. */
export function selectionKey(mouse: MouseController | undefined, input: string, key: { ctrl: boolean; escape: boolean }): boolean {
  if (mouse === undefined) return false
  if (key.ctrl && input === 'c') return mouse.copySelection()
  if (key.escape) return mouse.clearSelection()
  return false
}

/** Keys the fullscreen viewport owns (scrolling), which the composer must ignore. */
interface ViewportKey {
  shift: boolean
  ctrl: boolean
  upArrow: boolean
  downArrow: boolean
  home: boolean
  end: boolean
  pageUp: boolean
  pageDown: boolean
}

export function isViewportKey(key: ViewportKey): boolean {
  return key.pageUp || key.pageDown || (key.shift && (key.upArrow || key.downArrow)) || (key.ctrl && (key.home || key.end))
}

export function Composer({ bridge, files, state, width, frame, mouse }: ComposerProps): React.JSX.Element {
  const [hover, setHover] = useState<HoverPart | undefined>(undefined)
  const [buffer, setBuffer] = useState<ed.EditorState>(() => carried.buffer)
  const [menuIndex, setMenuIndex] = useState(0)
  const [dismissed, setDismissed] = useState<string | undefined>(undefined)
  const [hint, setHint] = useState<{ text: string; at: number } | undefined>(undefined)
  const [filesVersion, setFilesVersion] = useState(0)
  const history = useRef<{ index: number | undefined; draft: string }>({ index: undefined, draft: '' })
  const pastes = useRef(new Map<number, string>())
  const armed = useRef<{ esc: number; exit: number }>({ esc: 0, exit: 0 })

  // Keep a draft across modal prompts, which unmount the composer.
  useEffect(() => { carried.buffer = buffer }, [buffer])

  // ---------------------------------------------------------------- completion
  const slashMatch = buffer.cursor === buffer.text.length ? /^\/([a-z0-9_-]*)$/.exec(buffer.text) : null
  const mention = slashMatch === null ? mentionAt(buffer.text, buffer.cursor) : undefined
  const menuKey = slashMatch !== null ? `slash:${slashMatch[1] ?? ''}` : mention !== undefined ? `file:${String(mention.start)}:${mention.query}` : undefined

  useEffect(() => {
    if (mention === undefined) return
    let live = true
    void files.ensure().then(() => { if (live) setFilesVersion(v => v + 1) })
    return () => { live = false }
  }, [mention?.start, files])

  const rows: MenuRow[] = useMemo(() => {
    if (menuKey === undefined || menuKey === dismissed) return []
    if (slashMatch !== null) {
      return matchSlash(bridge.slashEntries(), slashMatch[1] ?? '').map(entry => ({
        key: entry.name, label: `/${entry.name}`, description: entry.description, kind: 'slash' as const, entry,
      }))
    }
    if (mention !== undefined) {
      return files.search(mention.query, 8).map(path => ({ key: path, label: path, description: '', kind: 'file' as const }))
    }
    return []
  }, [menuKey, dismissed, filesVersion, state.sessionId])
  const selected = rows.length === 0 ? 0 : Math.min(menuIndex, rows.length - 1)

  useEffect(() => { setMenuIndex(0) }, [menuKey])

  const flash = (text: string): void => { setHint({ text, at: Date.now() }) }
  useEffect(() => {
    if (hint === undefined) return undefined
    const timer = setTimeout(() => { setHint(undefined) }, 1600)
    return () => { clearTimeout(timer) }
  }, [hint])

  // ---------------------------------------------------------------- actions
  const set = (next: ed.EditorState): void => {
    setBuffer(next)
    setDismissed(undefined)
  }

  const submit = (raw: string): void => {
    const expanded = raw.replace(PASTE_TOKEN, (match, n: string) => pastes.current.get(Number(n)) ?? match)
    pastes.current.clear()
    history.current = { index: undefined, draft: '' }
    setBuffer(ed.empty)
    setDismissed(undefined)
    void bridge.submit(expanded).catch((error: unknown) => {
      bridge.notice('error', error instanceof Error ? error.message : String(error))
    })
  }

  const accept = (run: boolean, index = selected): void => {
    const row = rows[index]
    if (row === undefined) return
    if (row.kind === 'slash') {
      const needsInput = row.entry?.hint?.startsWith('<') === true
      if (run && !needsInput) {
        submit(`/${row.key}`)
        return
      }
      set(ed.fromText(`/${row.key} `))
      return
    }
    if (mention === undefined) return
    const isDir = row.key.endsWith('/')
    const before = buffer.text.slice(0, mention.start)
    const after = buffer.text.slice(buffer.cursor)
    const inserted = `@${row.key}${isDir ? '' : ' '}`
    set({ text: before + inserted + after, cursor: before.length + inserted.length })
  }

  const historyMove = (delta: -1 | 1): void => {
    const list = bridge.history
    if (list.length === 0) return
    const h = history.current
    if (delta < 0) {
      if (h.index === undefined) {
        h.draft = buffer.text
        h.index = list.length - 1
      } else {
        h.index = Math.max(0, h.index - 1)
      }
    } else {
      if (h.index === undefined) return
      h.index += 1
      if (h.index >= list.length) {
        h.index = undefined
        set(ed.fromText(h.draft))
        return
      }
    }
    set(ed.fromText(list[h.index] ?? ''))
  }

  usePaste((text) => {
    const normalized = text.replace(/\r\n?/g, '\n')
    const lines = normalized.split('\n').length
    if (normalized.length > 600 || lines > 6) {
      const n = pastes.current.size + 1
      pastes.current.set(n, normalized)
      set(ed.insert(buffer, `[Pasted text #${String(n)} +${String(lines)} lines]`))
      return
    }
    set(ed.insert(buffer, normalized))
  })

  useInput((input, key) => {
    const now = Date.now()
    if (selectionKey(mouse, input, key)) return
    if (mouse !== undefined && isViewportKey(key)) return
    // Shift+Tab arrives as tab+shift.
    if (key.tab && key.shift) {
      bridge.cycleMode()
      return
    }
    if (key.ctrl && input === 'c') {
      if (buffer.text !== '') {
        set(ed.empty)
        return
      }
      if (bridge.interrupt()) return
      if (now - armed.current.exit < 2000) {
        bridge.exit()
        return
      }
      armed.current.exit = now
      flash('Press Ctrl-C again to exit')
      return
    }
    if (key.ctrl && input === 'd') {
      if (buffer.text === '') bridge.exit()
      else set(ed.deleteForward(buffer))
      return
    }
    if (key.escape) {
      if (rows.length > 0) {
        setDismissed(menuKey)
        return
      }
      if (bridge.interrupt()) return
      if (buffer.text !== '') {
        if (now - armed.current.esc < 1200) {
          set(ed.empty)
          armed.current.esc = 0
        } else {
          armed.current.esc = now
          flash('Esc again to clear')
        }
      }
      return
    }
    if (key.upArrow || (key.ctrl && input === 'p')) {
      if (rows.length > 0) {
        setMenuIndex((selected - 1 + rows.length) % rows.length)
        return
      }
      const moved = ed.verticalMove(buffer, -1)
      if (moved !== undefined) setBuffer(moved)
      else historyMove(-1)
      return
    }
    if (key.downArrow || (key.ctrl && input === 'n')) {
      if (rows.length > 0) {
        setMenuIndex((selected + 1) % rows.length)
        return
      }
      const moved = ed.verticalMove(buffer, 1)
      if (moved !== undefined) setBuffer(moved)
      else historyMove(1)
      return
    }
    if (key.tab) {
      if (rows.length > 0) accept(false)
      return
    }
    if (key.return) {
      if (key.meta || key.shift) {
        set(ed.insert(buffer, '\n'))
        return
      }
      if (rows.length > 0) {
        accept(true)
        return
      }
      if (buffer.text.slice(0, buffer.cursor).endsWith('\\')) {
        set(ed.insert(ed.backspace(buffer), '\n'))
        return
      }
      if (buffer.text.trim() !== '') submit(buffer.text)
      return
    }
    if (input === '\n') {
      set(ed.insert(buffer, '\n'))
      return
    }
    if (key.backspace) {
      set(key.meta ? ed.killWordBack(buffer) : ed.backspace(buffer))
      return
    }
    if (key.delete) {
      set(ed.deleteForward(buffer))
      return
    }
    if (key.leftArrow) {
      setBuffer(key.ctrl || key.meta ? ed.wordLeft(buffer) : ed.left(buffer))
      return
    }
    if (key.rightArrow) {
      setBuffer(key.ctrl || key.meta ? ed.wordRight(buffer) : ed.right(buffer))
      return
    }
    if (key.home) {
      setBuffer(ed.lineStart(buffer))
      return
    }
    if (key.end) {
      setBuffer(ed.lineEnd(buffer))
      return
    }
    if (key.ctrl) {
      switch (input) {
        case 'a': setBuffer(ed.lineStart(buffer)); return
        case 'e': setBuffer(ed.lineEnd(buffer)); return
        case 'b': setBuffer(ed.left(buffer)); return
        case 'f': setBuffer(ed.right(buffer)); return
        case 'w': set(ed.killWordBack(buffer)); return
        case 'u': set(ed.killToLineStart(buffer)); return
        case 'k': set(ed.killToLineEnd(buffer)); return
        case 'j': set(ed.insert(buffer, '\n')); return
        default: return
      }
    }
    if (key.meta) {
      if (input === 'b') setBuffer(ed.wordLeft(buffer))
      else if (input === 'f') setBuffer(ed.wordRight(buffer))
      return
    }
    if (input === '') return
    // Unbracketed multi-character chunks may carry a trailing Enter.
    const clean = input.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    if (clean === '') return
    set(ed.insert(buffer, clean))
  })

  // ---------------------------------------------------------------- render
  const inner = width - 4
  const mode = buffer.text.startsWith('!') ? 'bash' : buffer.text.startsWith('#') && !buffer.text.startsWith('##') ? 'memory' : 'prompt'
  let borderColor = mode === 'bash' ? c.bash : mode === 'memory' ? c.plan : state.planActive ? c.plan : c.border
  const promptGlyph = mode === 'bash' ? c.bash('!') : mode === 'memory' ? c.plan('#') : c.muted('>')
  // The mode glyph replaces the typed marker; a single space after it is absorbed too.
  const skip = mode === 'prompt' ? 0 : buffer.text[1] === ' ' ? 2 : 1
  const shown = skip === 0 ? buffer : { text: buffer.text.slice(skip), cursor: Math.max(0, buffer.cursor - skip) }
  void frame
  const lines = renderBuffer(shown, inner - 2, true, state.running)
  const hovering = hover?.kind === 'body' && mode === 'prompt' && !state.planActive
  if (hovering) borderColor = c.muted
  const top = borderColor(`╭${'─'.repeat(width - 2)}╮`)
  const bottom = borderColor(`╰${'─'.repeat(width - 2)}╯`)
  const body = lines.map((line, index) => `${borderColor('│')} ${index === 0 ? promptGlyph : ' '} ${pad(line, inner - 2)} ${borderColor('│')}`)

  const visibleRows = rows.length === 0 ? [] : windowed(rows, selected, 8)
  const labelWidth = Math.min(28, Math.max(...rows.map(row => stringWidth(row.label))) + 2)
  const menu = visibleRows.map(({ row, index }) => {
    const active = index === selected
    const label = pad(row.label, labelWidth)
    const description = row.description === '' ? '' : clipDescription(row.description, width - labelWidth - 6)
    if (active) return `  ${c.accent(label)}${c.text(description)}`
    if (hover?.kind === 'menu' && hover.index === index) return `  ${c.text(label)}${c.muted(description)}`
    return `  ${c.muted(label)}${c.faint(description)}`
  })
  const more = rows.length > visibleRows.length ? c.faint(`${String(rows.length - visibleRows.length)} more · keep typing to filter`) : ''

  const left = hint !== undefined ? c.warning(hint.text)
    : rows.length > 0 ? more
      : mode === 'bash' ? c.bash('! bash mode') + c.faint(' · runs locally, output is shared with DeepSeek')
        : mode === 'memory' ? c.plan('# memory mode') + c.faint(' · saves a note to AGENTS.md')
          : state.toast !== undefined ? toastColor(state.toast.tone)(state.toast.text)
            : modeHint(state)
  const leftIsMode = hint === undefined && rows.length === 0 && mode === 'prompt' && state.toast === undefined
  const decoratedLeft = leftIsMode && hover?.kind === 'mode' ? ansi.underline(left) : left
  const right = rows.length > 0 ? c.faint('tab to complete · enter to run · esc to close')
    : state.running ? (hover?.kind === 'interrupt' ? ansi.underline(c.muted('esc to interrupt')) : c.faint('esc to interrupt'))
      : c.faint('/help for shortcuts')
  const room = width - 4 - stringWidth(left) - stringWidth(right)
  const footer = room >= 2 ? `  ${decoratedLeft}${' '.repeat(room)}${right}` : `  ${decoratedLeft}`
  const status = menu.length === 0 ? statusLine(state, width - 2) : undefined
  const modelSpan = statusModelSpan(state)
  const agentModeSpan = statusModeSpan(state)
  const decoratedStatus = status !== undefined && hover?.kind === 'model'
    ? `${status.slice(0, status.indexOf(state.model.model))}${ansi.underline(c.text(state.model.model))}${status.slice(status.indexOf(state.model.model) + state.model.model.length)}`
    : status !== undefined && hover?.kind === 'agentMode' ? `  ${ansi.underline(c.text(modeBadgeText(state)))}${status.slice(status.indexOf(modeBadgeText(state)) + modeBadgeText(state).length)}`
      : status

  // ---------------------------------------------------------------- mouse
  if (mouse !== undefined) {
    const bodyTop = 1
    const menuTop = lines.length + 2
    const footerRow = menuTop + menu.length
    const statusRow = footerRow + 1
    const height = statusRow + (status === undefined ? 0 : 1)
    const target = (row: number, col: number): HoverPart | undefined => {
      if (row >= bodyTop && row < bodyTop + lines.length) return { kind: 'body' }
      if (row >= menuTop && row < footerRow) {
        const entry = visibleRows[row - menuTop]
        return entry === undefined ? undefined : { kind: 'menu', index: entry.index }
      }
      if (row === footerRow) {
        if (leftIsMode && col >= 2 && col < 2 + stringWidth(left)) return { kind: 'mode' }
        if (state.running && rows.length === 0 && room >= 2 && col >= width - 2 - stringWidth(right)) return { kind: 'interrupt' }
      }
      if (row === statusRow && status !== undefined && col >= modelSpan.from && col < modelSpan.to) return { kind: 'model' }
      if (row === statusRow && status !== undefined && col >= agentModeSpan.from && col < agentModeSpan.to) return { kind: 'agentMode' }
      return undefined
    }
    const onMouse = (event: MouseEvent, row: number, col: number): boolean => {
      const part = row < 0 ? undefined : target(row, col)
      if (event.kind === 'move' || event.kind === 'drag') {
        if (event.kind === 'drag' && part?.kind === 'body') placeCursor(row - bodyTop, col)
        if (JSON.stringify(part) !== JSON.stringify(hover)) setHover(part)
        return part !== undefined
      }
      if (event.kind === 'wheel') {
        if (part?.kind !== 'menu' || rows.length === 0) return false
        setMenuIndex(Math.max(0, Math.min(rows.length - 1, selected + (event.direction === 'up' ? -1 : 1))))
        return true
      }
      if (event.kind !== 'down' || event.button !== 'left' || part === undefined) return false
      switch (part.kind) {
        case 'body': placeCursor(row - bodyTop, col); break
        case 'menu': setMenuIndex(part.index); accept(true, part.index); break
        case 'mode': bridge.cycleMode(); break
        case 'interrupt': bridge.interrupt(); break
        case 'model': void bridge.runSlash('/model'); break
        case 'agentMode': void bridge.runSlash('/mode'); break
      }
      return true
    }
    const placeCursor = (row: number, col: number): void => {
      if (buffer.text === '' || skip > 0 && buffer.text.length <= skip) return
      const layout = ed.layoutRows(shown.text, inner - 3, stringWidth)
      const index = ed.indexAt(shown.text, layout, row, col - 4, stringWidth) + skip
      if (index !== buffer.cursor) setBuffer({ ...buffer, cursor: index })
    }
    mouse.registerBottom({ height, onMouse })
  }

  return (
    <Box flexDirection="column">
      <Text>{[top, ...body, bottom].join('\n')}</Text>
      {menu.length > 0 ? <Text>{menu.join('\n')}</Text> : null}
      <Text>{footer}</Text>
      {decoratedStatus !== undefined ? <Text>{decoratedStatus}</Text> : null}
    </Box>
  )
}

function toastColor(tone: string): (s: string) => string {
  return tone === 'error' ? ansi.hex(palette.error) : tone === 'warn' ? c.warning : tone === 'success' ? ansi.hex(palette.success) : c.text
}

function clipDescription(text: string, width: number): string {
  if (width < 8) return ''
  return stringWidth(text) > width ? `${text.slice(0, width - 1)}…` : text
}

function windowed<T>(rows: readonly T[], selected: number, size: number): { row: T; index: number }[] {
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), rows.length - size))
  return rows.slice(start, start + size).map((row, offset) => ({ row, index: start + offset }))
}

/**
 * Render the buffer with an inverse-video cursor, wrapped to `width`.
 * @param buffer - text and cursor.
 * @param width - inner width.
 * @param showCursor - blink phase.
 * @param running - whether a turn is in flight (placeholder wording).
 * @returns display lines.
 */
export function renderBuffer(buffer: ed.EditorState, width: number, showCursor: boolean, running: boolean): string[] {
  const cursor = (ch: string): string => showCursor ? ansi.inverse(ch) : ch
  if (buffer.text === '') {
    const placeholder = running
      ? 'Type to steer the current turn · esc to interrupt'
      : 'Ask DeepSeek anything · @ to attach files · / for commands'
    return [cursor(placeholder[0] ?? ' ') + c.faint(placeholder.slice(1))]
  }
  const text = buffer.text
  // One cell is kept free so the cursor can sit after the last character.
  const layout = ed.layoutRows(text, Math.max(4, width) - 1, stringWidth)
  const decorate = (s: string): string => c.text(s.replace(PASTE_TOKEN, match => c.accent(match)))
  return layout.map((row, index) => {
    const slice = text.slice(row.start, row.end)
    const next = layout[index + 1]
    const endsLogicalLine = next === undefined || next.start !== row.end
    if (buffer.cursor >= row.start && buffer.cursor < row.end) {
      const offset = buffer.cursor - row.start
      const at = Array.from(slice.slice(offset))[0] ?? ' '
      return decorate(slice.slice(0, offset)) + cursor(at) + decorate(slice.slice(offset + at.length))
    }
    if (buffer.cursor === row.end && endsLogicalLine) return decorate(slice) + cursor(' ')
    return decorate(slice)
  })
}
