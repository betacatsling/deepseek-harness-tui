/**
 * The fullscreen transcript as one array of rendered lines, plus a per-line
 * map back to the item that produced it so clicks can be routed (expand a
 * tool block, follow a link) and selections copied. Settled items are cached
 * per render variant, so scrolling a long session re-renders nothing.
 * @module @deepseek-ai/dsh-experimental-tui/viewport
 */

import { stripVTControlCharacters } from 'node:util'
import { renderStreamingMarkdown } from './markdown.ts'
import { hang, renderItem, type RenderOptions, wrap } from './render.ts'
import { isSettled, type Item, type UiState } from './store.ts'
import { ansi, glyph, palette, themeName } from './theme.ts'

/** What a transcript line belongs to. */
export interface LineInfo {
  readonly itemId: string
  /** Line index within the item. */
  readonly row: number
  /** A click here toggles the item's expansion. */
  readonly toggle: boolean
}

/** The rendered transcript. */
export interface TranscriptLayout {
  readonly lines: readonly string[]
  readonly info: readonly (LineInfo | undefined)[]
  /** Items whose compact and expanded renders differ. */
  readonly toggleable: ReadonlySet<string>
}

/** Options for {@link buildTranscript}. */
export interface TranscriptOptions {
  readonly width: number
  readonly expanded: ReadonlySet<string>
  readonly frame: number
  readonly hint?: 'keyboard' | 'click'
}

type Cache = WeakMap<Item, Map<string, readonly string[]>>
const sharedCache: Cache = new WeakMap()

const EXPANDABLE = new Set<Item['kind']>(['tool', 'thinking', 'shell'])

function cached(cache: Cache, item: Item, key: string, render: () => readonly string[]): readonly string[] {
  if (item.kind === 'banner' || !isSettled(item)) return render()
  let entry = cache.get(item)
  if (entry === undefined) {
    entry = new Map()
    cache.set(item, entry)
  }
  const hit = entry.get(key)
  if (hit !== undefined) return hit
  const lines = render()
  entry.set(key, lines)
  return lines
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index])
}

/** Lines for the streaming tail of the current attempt (thinking, text). */
export function liveTail(state: UiState, width: number): string[] {
  const out: string[] = []
  const live = state.live
  if (live === undefined) return out
  if (state.detail && live.reasoning !== '') {
    out.push('', ansi.hex(palette.faint)(`${glyph.spark} Thinking…`), ...wrap(live.reasoning.trim(), width - 4).map(line => `  ${ansi.hex(palette.muted).italic(line)}`))
  }
  if (live.text !== '') {
    out.push('', ...hang(`${ansi.hex(palette.text)(glyph.bullet)} `, '  ', renderStreamingMarkdown(live.text, width - 2)))
  }
  return out
}

const HINT_ROW = /\((?:click|ctrl\+o) to expand\)/

/**
 * Render every item (settled and in flight) followed by the streaming tail.
 * @param state - UI state.
 * @param options - width, per-item expansion, animation frame.
 * @param cache - render cache (shared by default).
 */
export function buildTranscript(state: UiState, options: TranscriptOptions, cache: Cache = sharedCache): TranscriptLayout {
  const lines: string[] = []
  const info: (LineInfo | undefined)[] = []
  const toggleable = new Set<string>()
  const base: Omit<RenderOptions, 'detail'> = { width: options.width, frame: options.frame, ...options.hint === undefined ? {} : { hint: options.hint } }
  const variant = (detail: boolean): string => `${String(options.width)}|${detail ? 'd' : 'c'}|${options.hint ?? 'k'}|${themeName()}`
  for (const item of state.items) {
    const open = state.detail || options.expanded.has(item.id)
    const rendered = cached(cache, item, variant(open), () => renderItem(item, state, { ...base, detail: open }))
    if (rendered.length === 0) continue
    let canToggle = false
    if (!state.detail && EXPANDABLE.has(item.kind)) {
      const other = cached(cache, item, variant(!open), () => renderItem(item, state, { ...base, detail: !open }))
      canToggle = other.length > 0 && !same(rendered, other)
    }
    if (canToggle) toggleable.add(item.id)
    if (lines.length > 0) {
      lines.push('')
      info.push(undefined)
    }
    rendered.forEach((line, row) => {
      lines.push(line)
      info.push({ itemId: item.id, row, toggle: canToggle && (row === 0 || HINT_ROW.test(stripVTControlCharacters(line))) })
    })
  }
  for (const line of liveTail(state, options.width)) {
    lines.push(line)
    info.push(undefined)
  }
  return { lines, info, toggleable }
}
