/** @jsxRuntime automatic */
/**
 * The root Ink component: settled transcript in <Static> scrollback, a live
 * region for in-flight tools and streaming text, the working indicator with
 * the todo panel, and the composer or the active modal prompt.
 * @module @deepseek-ai/dsh-experimental-tui/ui/app
 */

import { Box, Static, Text, useApp, useInput } from 'ink'
import { useEffect, useSyncExternalStore } from 'react'
import type { Bridge } from '../bridge.ts'
import type { FileIndex } from '../files.ts'
import { hang, renderItem, renderTodos } from '../render.ts'
import { liveTail } from '../viewport.ts'
import type { Item, UiState } from '../store.ts'
import { ansi, glyph, palette, spinnerFrames } from '../theme.ts'
import { Composer } from './composer.tsx'
import { useTerminalSize, useTick } from './hooks.ts'
import { OverlayView } from './overlays.tsx'
import { workingLine } from './status.ts'
import { suspendToShell } from './suspend.ts'

const faint = (text: string): string => ansi.hex(palette.faint)(text)

/** Root props. */
export interface AppProps {
  readonly bridge: Bridge
  readonly files: FileIndex
}

function animating(state: UiState): boolean {
  return state.running || state.phase === 'booting' || state.items.slice(state.flushed).some(item => item.kind === 'tool')
}

/**
 * Lines for the live (repainted) region, clamped to the screen so Ink never
 * has to clear the whole terminal.
 */
export function liveLines(state: UiState, width: number, frame: number, budget: number): string[] {
  const out: string[] = []
  const pending = state.items.slice(state.flushed)
  for (const item of pending) {
    const lines = renderItem(item, state, { width, detail: state.detail, frame })
    if (lines.length > 0) out.push('', ...lines)
  }
  out.push(...liveTail(state, width))
  if (out.length > budget) {
    const hidden = out.length - budget + 1
    return [faint(`  ⋮ +${String(hidden)} lines`), ...out.slice(-budget + 1)]
  }
  return out
}

interface StaticItemProps {
  readonly item: Item
  readonly state: UiState
  readonly width: number
  readonly first: boolean
}

function StaticItem({ item, state, width, first }: StaticItemProps): React.JSX.Element | null {
  const lines = renderItem(item, state, { width, detail: state.detail })
  if (lines.length === 0) return null
  return <Text>{(first ? '' : '\n') + lines.join('\n')}</Text>
}

export function App({ bridge, files }: AppProps): React.JSX.Element {
  const state = useSyncExternalStore(bridge.store.subscribe, bridge.store.getSnapshot)
  const { columns, rows } = useTerminalSize()
  const frame = useTick(animating(state))
  const width = Math.max(40, columns - 1)
  const overlay = state.overlays[state.overlays.length - 1]
  const { suspendTerminal } = useApp()
  useEffect(() => {
    bridge.suspend = () => suspendToShell(suspendTerminal)
    return () => { bridge.suspend = undefined }
  }, [bridge, suspendTerminal])

  useInput((input, key) => {
    if (key.ctrl && input === 'o') {
      bridge.store.update((draft) => { draft.detail = !draft.detail })
      bridge.reprint(true)
      bridge.toast(bridge.store.get().detail ? 'Detailed transcript on · ctrl+o to collapse' : 'Compact transcript', 'info')
    } else if (key.ctrl && input === 't') {
      bridge.store.update((draft) => { draft.showTodos = !draft.showTodos })
    } else if (key.ctrl && input === 'l') {
      bridge.reprint(true)
    } else if (key.ctrl && input === 'z') {
      void bridge.suspend?.()
    }
  })

  if (state.phase === 'booting') {
    return <Text>{`${ansi.hex(palette.accent)(spinnerFrames[frame % spinnerFrames.length] ?? '✻')} ${faint('Starting DeepSeek Harness…')}`}</Text>
  }
  if (state.phase === 'fatal') {
    return <Text>{ansi.hex(palette.error)(`✘ ${state.fatal ?? 'startup failed'}`)}</Text>
  }

  const settled = state.items.slice(0, state.flushed)
  const openTodos = state.todos.filter(todo => todo.status !== 'completed').length > 0
  // The panel repeats the list under the spinner, unless it was just printed.
  const justPrinted = state.items.slice(-3).some(item => item.kind === 'tool' && item.name === 'todo_write')
  const todoLines = state.showTodos && state.running && openTodos && !justPrinted
    ? hang(faint(`  ${glyph.elbow}  `), '     ', renderTodos(state.todos, width - 6).slice(0, 8))
    : []
  const reserved = 12 + todoLines.length + (overlay === undefined ? 0 : 18)
  const live = liveLines(state, width, frame, Math.max(6, rows - reserved))

  return (
    <Box flexDirection="column">
      <Static key={state.epoch} items={settled}>
        {(item, index) => <StaticItem key={item.id} item={item} state={state} width={width} first={index === 0} />}
      </Static>
      {live.length > 0 ? <Text>{live.join('\n')}</Text> : null}
      {state.running ? <Text>{`\n${workingLine(state, frame)}`}</Text> : null}
      {todoLines.length > 0 ? <Text>{todoLines.join('\n')}</Text> : null}
      <Box marginTop={1} flexDirection="column">
        {overlay !== undefined
          ? <OverlayView overlay={overlay} width={width} />
          : <Composer bridge={bridge} files={files} state={state} width={width} frame={frame} />}
      </Box>
    </Box>
  )
}
