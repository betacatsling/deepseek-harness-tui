/** @jsxRuntime automatic */
/**
 * The fullscreen (alternate-screen) root: a scrollable transcript viewport
 * with a scrollbar and a "back to bottom" pill, the working line and todo
 * panel, and the composer or modal pinned to the bottom. All mouse
 * interaction is routed by {@link MouseController}; this component renders
 * its view state and reports the committed geometry back for hit-testing.
 * @module @deepseek-ai/dsh-experimental-tui/ui/fullscreen
 */

import { Box, Text, useApp, useInput } from 'ink'
import { useEffect, useLayoutEffect, useReducer, useSyncExternalStore } from 'react'
import wrapAnsi from 'wrap-ansi'
import type { Bridge } from '../bridge.ts'
import type { FileIndex } from '../files.ts'
import type { Geometry, MouseController, ViewState } from '../mouse/controller.ts'
import { highlightCols, lineSpan, normalize, plainOf } from '../mouse/selection.ts'
import { hang, renderTodos } from '../render.ts'
import type { UiState } from '../store.ts'
import { ansi, glyph, palette, spinnerFrames, themed } from '../theme.ts'
import { buildTranscript } from '../viewport.ts'
import stringWidth from '../width.ts'
import { Composer } from './composer.tsx'
import { useTerminalSize, useTick } from './hooks.ts'
import { OverlayView } from './overlays.tsx'
import { workingLine } from './status.ts'
import { suspendToShell } from './suspend.ts'

const c = themed(() => ({
  faint: ansi.hex(palette.faint),
  muted: ansi.hex(palette.muted),
  track: ansi.hex(palette.border),
  accent: ansi.hex(palette.accent),
}))
const fx = themed(() => ({
  select: ansi.bgHex(palette.selectionBg).hex(palette.selectionFg),
  pill: ansi.bgHex(palette.accentDim).hex(palette.onAccent),
  pillHover: ansi.bgHex(palette.accent).hex(palette.onAccent).bold,
}))

/** Root props. */
export interface FullscreenAppProps {
  readonly bridge: Bridge
  readonly files: FileIndex
  readonly mouse: MouseController
}

function animating(state: UiState): boolean {
  return state.running || state.phase === 'booting' || state.items.some(item => item.kind === 'tool' && item.status === 'running')
}

function clip(line: string, width: number): string {
  return stringWidth(line) <= width ? line : (wrapAnsi(line, width, { hard: true, trim: false }).split('\n')[0] ?? '')
}

/** Rows of the scrollbar thumb for a viewport `[first, first+height)` over `total` lines. */
export function thumb(total: number, height: number, first: number): { top: number; size: number } {
  const size = Math.max(1, Math.round((height * height) / Math.max(total, 1)))
  const travel = Math.max(0, height - size)
  const top = total <= height ? 0 : Math.round((first / (total - height)) * travel)
  return { top, size }
}

/** Resolve a pending toggle reveal into a new end line. */
function resolveEnd(view: ViewState, info: readonly ({ itemId: string } | undefined)[], total: number, height: number): number {
  const reveal = view.reveal
  if (reveal !== undefined) {
    let header = -1
    let last = -1
    info.forEach((entry, index) => {
      if (entry?.itemId !== reveal.itemId) return
      if (header < 0) header = index
      last = index
    })
    if (header >= 0) {
      const wanted = Math.min(Math.max(last + 1, reveal.end), header + height)
      return Math.max(Math.min(height, total), Math.min(total, wanted))
    }
  }
  return view.follow ? total : Math.min(view.end, total)
}

export function FullscreenApp({ bridge, files, mouse }: FullscreenAppProps): React.JSX.Element {
  const state = useSyncExternalStore(bridge.store.subscribe, bridge.store.getSnapshot)
  const view = useSyncExternalStore(mouse.subscribe, mouse.getSnapshot)
  const { columns, rows } = useTerminalSize()
  const frame = useTick(animating(state))
  const [, force] = useReducer((n: number) => n + 1, 0)
  const { suspendTerminal } = useApp()
  const width = Math.max(40, columns - 1)
  const overlay = state.overlays[state.overlays.length - 1]

  // Screen hooks for the bridge (/clear, Ctrl+L, /mouse, /copy).
  useEffect(() => {
    const repaint = (): void => {
      void (async () => {
        process.stdout.write('\x1b[?2026h')
        try {
          const suspension = await suspendTerminal()
          await suspension.resume()
        } finally {
          process.stdout.write('\x1b[?2026l')
        }
      })()
    }
    bridge.screen = {
      repaint,
      reset: () => { mouse.reset() },
      setMouse: (on) => {
        const next = on ?? !mouse.get().capture
        mouse.setCapture(next)
        bridge.store.update((draft) => { draft.mouseOff = !next })
        return next
      },
      copySelection: () => mouse.copySelection(false),
    }
    bridge.suspend = () => suspendToShell(suspendTerminal, mouse)
    return () => {
      bridge.screen = undefined
      bridge.suspend = undefined
    }
  }, [bridge, mouse, suspendTerminal])

  useInput((input, key) => {
    if (key.ctrl && input === 'o') {
      bridge.store.update((draft) => { draft.detail = !draft.detail })
      mouse.toBottom()
      bridge.toast(bridge.store.get().detail ? 'Detailed transcript on · ctrl+o to collapse' : 'Compact transcript', 'info')
    } else if (key.ctrl && input === 't') {
      bridge.store.update((draft) => { draft.showTodos = !draft.showTodos })
    } else if (key.ctrl && input === 'l') {
      bridge.screen?.repaint()
    } else if (key.ctrl && input === 'z') {
      void bridge.suspend?.()
    } else if (key.pageUp) {
      mouse.page(-1)
    } else if (key.pageDown) {
      mouse.page(1)
    } else if (key.shift && key.upArrow) {
      mouse.scrollBy(-3)
    } else if (key.shift && key.downArrow) {
      mouse.scrollBy(3)
    } else if (key.ctrl && key.home) {
      mouse.toTop()
    } else if (key.ctrl && key.end) {
      mouse.toBottom()
    }
  })

  // ------------------------------------------------------------ layout
  const openTodos = state.todos.some(todo => todo.status !== 'completed')
  const justPrinted = state.items.slice(-3).some(item => item.kind === 'tool' && item.name === 'todo_write')
  const todoLines = state.showTodos && state.running && openTodos && !justPrinted
    ? hang(c.faint(`  ${glyph.elbow}  `), '     ', renderTodos(state.todos, width - 6).slice(0, 8))
    : []
  const working = state.running ? ['', workingLine(state, frame)] : []
  // The composer/modal registers its height while rendering, after this
  // component; use last frame's value and correct it in the layout effect.
  const registered = mouse.bottomHeight
  const bottomHeight = registered || 8
  const height = Math.max(3, rows - working.length - todoLines.length - 1 - bottomHeight)
  const contentWidth = Math.max(38, columns - 3)
  const transcript = state.phase === 'ready'
    ? buildTranscript(state, { width: contentWidth, expanded: view.expanded, frame, hint: 'click' })
    : { lines: [], info: [], toggleable: new Set<string>() }
  const total = transcript.lines.length
  const end = resolveEnd(view, transcript.info, total, height)
  const first = total <= height ? 0 : Math.max(0, end - height)
  const scrollable = total > height
  const below = scrollable ? total - (first + height) : 0

  // Selection, hover decorations, pill and scrollbar.
  const range = view.selection === undefined ? undefined : normalize(view.selection, line => plainOf(transcript.lines[line] ?? ''))
  const bar = scrollable ? thumb(total, height, first) : undefined
  const hoverItem = view.hover?.kind === 'toggle' ? view.hover.itemId : undefined
  let pill: Geometry['pill']
  const out: string[] = []
  for (let row = 0; row < height; row += 1) {
    const index = first + row
    let line = clip(transcript.lines[index] ?? '', contentWidth)
    const info = transcript.info[index]
    if (hoverItem !== undefined && info?.itemId === hoverItem && info.row === 0) {
      const tag = c.faint(view.expanded.has(hoverItem) ? '▾ click to collapse' : '▸ click to expand')
      const room = contentWidth - stringWidth(line) - stringWidth(tag)
      if (room >= 2) line += ' '.repeat(room) + tag
    }
    if (view.hover?.kind === 'link' && view.hover.line === index) line = highlightCols(line, view.hover.from, view.hover.to, s => ansi.underline(c.accent(s)))
    const span = range === undefined ? undefined : lineSpan(range, index)
    if (span !== undefined) {
      const plainWidth = stringWidth(plainOf(line))
      // Whole-line selections paint to the edge so empty lines show as selected.
      const to = Math.min(span.to, span.to === Number.MAX_SAFE_INTEGER ? Math.max(plainWidth, 1) : span.to)
      line = highlightCols(line + (to > plainWidth ? ' '.repeat(to - plainWidth) : ''), span.from, to, fx.select)
    }
    if (row === height - 1 && below > 0) {
      const label = ` ↓ ${String(below)} line${below === 1 ? '' : 's'} below · Back to bottom `
      const from = Math.max(0, Math.floor((contentWidth - stringWidth(label)) / 2))
      pill = { row, from, to: from + stringWidth(label) }
      line = ' '.repeat(from) + (view.hover?.kind === 'pill' ? fx.pillHover(label) : fx.pill(label))
    }
    const pad = Math.max(0, contentWidth - stringWidth(line))
    const thumbOn = bar !== undefined && row >= bar.top && row < bar.top + bar.size
    const barChar = bar === undefined ? ' ' : thumbOn ? (view.hover?.kind === 'scrollbar' ? c.accent('┃') : c.muted('┃')) : c.track('│')
    out.push(`${line}${' '.repeat(pad)} ${barChar}`)
  }

  // Report the committed frame for hit-testing; fix the one-frame lag of the
  // bottom component's height (children register after this render).
  useLayoutEffect(() => {
    mouse.setGeometry({
      rows,
      columns,
      viewportHeight: height,
      firstLine: first,
      end,
      lines: transcript.lines,
      info: transcript.info,
      pill,
      scrollbar: bar === undefined ? undefined : { col: contentWidth + 1, thumbTop: bar.top, thumbHeight: bar.size },
    })
    if (view.reveal !== undefined) mouse.settleReveal(end, total)
    if (state.phase === 'ready' && mouse.bottomHeight !== registered) force()
  })

  if (state.phase === 'booting') {
    return <Text>{`${c.accent(spinnerFrames[frame % spinnerFrames.length] ?? '✻')} ${c.faint('Starting DeepSeek Harness…')}`}</Text>
  }
  if (state.phase === 'fatal') {
    return <Text>{ansi.hex(palette.error)(`✘ ${state.fatal ?? 'startup failed'}`)}</Text>
  }
  return (
    <Box flexDirection="column" height={rows}>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden" justifyContent="flex-end">
        <Box flexShrink={0}>
          <Text>{out.join('\n')}</Text>
        </Box>
      </Box>
      {working.length > 0 ? <Box flexShrink={0}><Text>{working.join('\n')}</Text></Box> : null}
      {todoLines.length > 0 ? <Box flexShrink={0}><Text>{todoLines.join('\n')}</Text></Box> : null}
      <Box marginTop={1} flexDirection="column" flexShrink={0}>
        {overlay !== undefined
          ? <OverlayView overlay={overlay} width={width} mouse={mouse} />
          : <Composer bridge={bridge} files={files} state={state} width={width} frame={frame} mouse={mouse} />}
      </Box>
    </Box>
  )
}
