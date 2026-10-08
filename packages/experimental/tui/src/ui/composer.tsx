/**
 * The bordered prompt box: multi-line editing, persistent history, slash and
 * `@file` completion menus, bracketed paste collapsing, mode-aware borders,
 * and the two footer lines (mode hint + status line).
 * @module @deepseek-ai/dsh-experimental-tui/ui/composer
 */

import { Box, Text, useInput, usePaste } from 'ink'
import { useEffect, useMemo, useRef, useState } from 'react'
import stringWidth from '../width.ts'
import wrapAnsi from 'wrap-ansi'
import type { Bridge, SlashEntry } from '../bridge.ts'
import * as ed from '../editor.ts'
import { type FileIndex, mentionAt } from '../files.ts'
import { pad } from '../render.ts'
import type { UiState } from '../store.ts'
import { ansi, palette } from '../theme.ts'
import { modeHint, statusLine } from './status.ts'

const c = {
  text: ansi.hex(palette.text),
  muted: ansi.hex(palette.muted),
  faint: ansi.hex(palette.faint),
  accent: ansi.hex(palette.accent),
  border: ansi.hex(palette.border),
  bash: ansi.hex(palette.synAttr),
  plan: ansi.hex(palette.plan),
  warning: ansi.hex(palette.warning),
}

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
}

export function Composer({ bridge, files, state, width, frame }: ComposerProps): React.JSX.Element {
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

  const accept = (run: boolean): void => {
    const row = rows[selected]
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
  const borderColor = mode === 'bash' ? c.bash : mode === 'memory' ? c.plan : state.planActive ? c.plan : c.border
  const promptGlyph = mode === 'bash' ? c.bash('!') : mode === 'memory' ? c.plan('#') : c.muted('>')
  // The mode glyph replaces the typed marker; a single space after it is absorbed too.
  const skip = mode === 'prompt' ? 0 : buffer.text[1] === ' ' ? 2 : 1
  const shown = skip === 0 ? buffer : { text: buffer.text.slice(skip), cursor: Math.max(0, buffer.cursor - skip) }
  void frame
  const lines = renderBuffer(shown, inner - 2, true, state.running)
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
    return `  ${c.muted(label)}${c.faint(description)}`
  })
  const more = rows.length > visibleRows.length ? c.faint(`${String(rows.length - visibleRows.length)} more · keep typing to filter`) : ''

  const left = hint !== undefined ? c.warning(hint.text)
    : rows.length > 0 ? more
      : mode === 'bash' ? c.bash('! bash mode') + c.faint(' · runs locally, output is shared with DeepSeek')
        : mode === 'memory' ? c.plan('# memory mode') + c.faint(' · saves a note to AGENTS.md')
          : state.toast !== undefined ? toastColor(state.toast.tone)(state.toast.text)
            : modeHint(state)
  const right = rows.length > 0 ? c.faint('tab to complete · enter to run · esc to close') : state.running ? c.faint('esc to interrupt') : c.faint('/help for shortcuts')
  const room = width - 4 - stringWidth(left) - stringWidth(right)
  const footer = room >= 2 ? `  ${left}${' '.repeat(room)}${right}` : `  ${left}`

  return (
    <Box flexDirection="column">
      <Text>{[top, ...body, bottom].join('\n')}</Text>
      {menu.length > 0 ? <Text>{menu.join('\n')}</Text> : null}
      <Text>{footer}</Text>
      {menu.length === 0 ? <Text>{statusLine(state, width - 2)}</Text> : null}
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
  const before = buffer.text.slice(0, buffer.cursor)
  const at = buffer.text[buffer.cursor]
  const after = buffer.text.slice(buffer.cursor + (at === undefined || at === '\n' ? 0 : at.length))
  const atChar = at === undefined || at === '\n' ? ' ' : at
  const decorate = (s: string): string => s.replace(PASTE_TOKEN, match => c.accent(match))
  const composed = c.text(decorate(before)) + cursor(atChar) + c.text(decorate(after))
  return composed.split('\n').flatMap(line => wrapAnsi(line, Math.max(4, width), { hard: true, trim: false }).split('\n'))
}
