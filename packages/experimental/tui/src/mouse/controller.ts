/**
 * Routes mouse reports for the fullscreen UI. The last committed frame's
 * geometry (viewport rows, the line shown at each row, where the bottom
 * component starts) is the single source for hit-testing, as in Codex's
 * transcript view and Grok Build's cached click rects: wheel → transcript
 * scroll (or the open menu), left-drag → selection with copy-on-release,
 * click on a tool header → expand/collapse, click on a link → open it, click
 * on the follow pill or scrollbar → jump, and everything in the composer or a
 * modal goes to that component in its own coordinates.
 * @module @deepseek-ai/dsh-experimental-tui/mouse/controller
 */

import { spawn } from 'node:child_process'
import type { LineInfo } from '../viewport.ts'
import textWidth from '../width.ts'
import { copyToClipboard } from './clipboard.ts'
import type { FocusEvent, MouseEvent } from './protocol.ts'
import { type ScrollConfig, scrollConfigFromEnv, ScrollNormalizer } from './scroll.ts'
import { ClickCounter, isEmpty, normalize, plainOf, type Point, type Selection, selectedText, unitFor } from './selection.ts'
import type { TerminalModes } from './terminal.ts'

/** What the pointer is over in the transcript. */
export type Hover =
  | { readonly kind: 'toggle'; readonly itemId: string }
  | { readonly kind: 'pill' }
  | { readonly kind: 'scrollbar' }
  | { readonly kind: 'link'; readonly line: number; readonly from: number; readonly to: number }

/** View state owned by the controller and rendered by the fullscreen app. */
export interface ViewState {
  /** Stick to the newest line. */
  readonly follow: boolean
  /** Absolute end line (exclusive) while scrolled back. */
  readonly end: number
  readonly expanded: ReadonlySet<string>
  readonly selection: Selection | undefined
  readonly hover: Hover | undefined
  /** Mouse reporting requested (false after /mouse off). */
  readonly capture: boolean
  /** Keep this item's header in view after a toggle (resolved on the next frame). */
  readonly reveal: { readonly itemId: string; readonly end: number; readonly header: number } | undefined
}

/** The composer or modal under the transcript. */
export interface BottomHandler {
  readonly height: number
  /** Handle an event in component-local coordinates; return true when consumed. */
  onMouse(event: MouseEvent, row: number, col: number): boolean
}

/** Geometry of the last committed frame. */
export interface Geometry {
  readonly rows: number
  readonly columns: number
  readonly viewportHeight: number
  /** Transcript line drawn at screen row 0. */
  readonly firstLine: number
  readonly end: number
  readonly lines: readonly string[]
  readonly info: readonly (LineInfo | undefined)[]
  readonly pill: { readonly row: number; readonly from: number; readonly to: number } | undefined
  readonly scrollbar: { readonly col: number; readonly thumbTop: number; readonly thumbHeight: number } | undefined
}

/** Side effects the controller needs from its host. */
export interface ControllerHost {
  readonly modes: TerminalModes
  write(data: string): void
  toast(text: string, tone?: 'info' | 'warn' | 'error' | 'success'): void
  copyOnSelect?: boolean
  scroll?: ScrollConfig
  openUrl?: (url: string) => void
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,:;!?]/g

/** URL covering column `col` of a plain line. */
export function linkAt(plain: string, col: number): { url: string; from: number; to: number } | undefined {
  URL_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = URL_PATTERN.exec(plain)) !== null) {
    // URLs are ASCII, so code units after the match start are cells; the
    // prefix may hold wide glyphs, so measure it.
    const from = textWidth(plain.slice(0, match.index))
    const to = from + match[0].length
    if (col >= from && col < to) return { url: match[0], from, to }
  }
  return undefined
}

function defaultOpen(url: string): void {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch (error: unknown) {
    void error
  }
}

interface Press {
  readonly at: Point
  readonly row: number
  readonly x: number
  moved: boolean
  readonly toggle: string | undefined
  readonly link: string | undefined
}

/** Mouse routing and transcript view state for fullscreen mode. */
export class MouseController {
  private state: ViewState
  private readonly listeners = new Set<() => void>()
  private geometry: Geometry | undefined
  private bottom: BottomHandler | undefined
  private readonly clicks = new ClickCounter()
  private readonly scroller: ScrollNormalizer
  private press: Press | undefined
  private dragging = false
  private barDrag = false
  private pillPressed = false
  private autoscroll: NodeJS.Timeout | undefined
  private autoscrollDirection: 1 | -1 = 1
  private lastPointer: { x: number; y: number } | undefined

  constructor(private readonly host: ControllerHost, capture: boolean) {
    this.state = { follow: true, end: 0, expanded: new Set(), selection: undefined, hover: undefined, capture, reveal: undefined }
    this.scroller = new ScrollNormalizer(host.scroll ?? scrollConfigFromEnv())
  }

  // ------------------------------------------------------------ store

  get(): ViewState {
    return this.state
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): ViewState => this.state

  private set(change: Partial<ViewState>): void {
    this.state = { ...this.state, ...change }
    for (const listener of this.listeners) listener()
  }

  // ------------------------------------------------------------ layout

  /** Record the geometry of the frame that was just committed. */
  setGeometry(geometry: Geometry): void {
    this.geometry = geometry
    this.scroller.setCap(Math.max(3, Math.floor(geometry.viewportHeight / 2)))
  }

  /** The composer or modal registers itself on every render. */
  registerBottom(handler: BottomHandler): void {
    this.bottom = handler
  }

  /** Height of the bottom component in the last render (0 before the first). */
  get bottomHeight(): number {
    return this.bottom?.height ?? 0
  }

  /** Accept a reveal resolved by the renderer. */
  settleReveal(end: number, total: number): void {
    this.state = { ...this.state, reveal: undefined, follow: end >= total, end }
  }

  // ------------------------------------------------------------ scrolling

  private currentEnd(): number {
    const g = this.geometry
    if (g === undefined) return 0
    return this.state.follow ? g.lines.length : Math.min(this.state.end, g.lines.length)
  }

  /** Scroll by `delta` lines (positive = towards newer content). */
  scrollBy(delta: number): void {
    const g = this.geometry
    if (g === undefined || delta === 0) return
    const total = g.lines.length
    const height = Math.max(1, g.viewportHeight)
    if (total <= height) {
      if (!this.state.follow) this.set({ follow: true, end: total })
      return
    }
    const end = Math.max(height, Math.min(total, this.currentEnd() + delta))
    this.set({ follow: end >= total, end, hover: this.state.hover?.kind === 'pill' ? undefined : this.state.hover })
  }

  /** Page up/down (keeps one line of overlap). */
  page(direction: 1 | -1): void {
    const height = Math.max(1, (this.geometry?.viewportHeight ?? 2) - 1)
    this.scrollBy(direction * height)
  }

  toTop(): void {
    const g = this.geometry
    if (g === undefined) return
    this.scrollBy(-g.lines.length)
  }

  toBottom(): void {
    const g = this.geometry
    this.set({ follow: true, end: g?.lines.length ?? 0, hover: undefined })
  }

  /** Lines below the viewport while scrolled back. */
  linesBelow(total: number): number {
    return this.state.follow ? 0 : Math.max(0, total - this.state.end)
  }

  // ------------------------------------------------------------ expansion

  /** Expand or collapse one item, keeping its header in view. */
  toggleItem(itemId: string): void {
    const g = this.geometry
    const expanded = new Set(this.state.expanded)
    if (expanded.has(itemId)) expanded.delete(itemId)
    else expanded.add(itemId)
    const header = g?.info.findIndex(info => info?.itemId === itemId) ?? -1
    this.set({
      expanded,
      selection: undefined,
      reveal: g === undefined || header < 0 ? undefined : { itemId, end: this.currentEnd(), header },
    })
  }

  // ------------------------------------------------------------ selection

  hasSelection(): boolean {
    return this.state.selection !== undefined
  }

  /** Copy the selection (Ctrl+C / right click); returns false when there is none. */
  copySelection(clear = true): boolean {
    const text = this.selectionText()
    if (text === undefined || text === '') return false
    this.copy(text)
    if (clear) this.set({ selection: undefined })
    return true
  }

  /** Drop the selection; returns whether there was one. */
  clearSelection(): boolean {
    if (this.state.selection === undefined) return false
    this.endDrag()
    this.set({ selection: undefined })
    return true
  }

  /** Plain text of the current selection. */
  selectionText(): string | undefined {
    const g = this.geometry
    const selection = this.state.selection
    if (g === undefined || selection === undefined) return undefined
    const plain = (line: number): string => plainOf(g.lines[line] ?? '')
    const range = normalize(selection, plain)
    return isEmpty(range) ? undefined : selectedText(range, plain)
  }

  private copy(text: string): void {
    const routes = copyToClipboard(text, (data) => { this.host.write(data) })
    const chars = Array.from(text).length
    this.host.toast(routes.length === 0 ? 'Could not reach a clipboard' : `Copied ${String(chars)} character${chars === 1 ? '' : 's'}`, routes.length === 0 ? 'warn' : 'success')
  }

  // ------------------------------------------------------------ capture

  /** Turn mouse reporting on or off at runtime (/mouse). */
  setCapture(on: boolean): void {
    if (on) this.host.modes.enable()
    else this.host.modes.disableMouse()
    this.endDrag()
    this.set({ capture: on, hover: undefined, selection: on ? this.state.selection : undefined })
  }

  /** Turn every reporting mode off while another program owns the terminal (Ctrl+Z). */
  release(): void {
    this.endDrag()
    this.host.modes.disable()
    if (this.state.hover !== undefined) this.set({ hover: undefined })
  }

  /** Take reporting back after {@link release}. */
  reclaim(): void {
    if (this.state.capture) this.host.modes.enable()
  }

  /** Forget transcript-relative state (after /clear). */
  reset(): void {
    this.endDrag()
    this.set({ follow: true, end: 0, expanded: new Set(), selection: undefined, hover: undefined, reveal: undefined })
  }

  dispose(): void {
    this.endDrag()
    this.listeners.clear()
  }

  // ------------------------------------------------------------ events

  /** Entry point for every decoded report. */
  handle(event: MouseEvent | FocusEvent): void {
    if (event.kind === 'focus') {
      if (event.focused) this.host.modes.reassert()
      else this.endDrag()
      return
    }
    if (!this.state.capture) return
    const g = this.geometry
    if (g === undefined) return
    this.lastPointer = { x: event.x, y: event.y }

    if (this.dragging || this.press !== undefined) {
      if (this.onSelectionGesture(event, g)) return
    }
    if (this.barDrag) {
      if (event.kind === 'drag') {
        this.scrollToRow(event.y, g)
        return
      }
      if (event.kind === 'up') {
        this.barDrag = false
        return
      }
    }

    const bottomTop = g.rows - this.bottomHeight
    if (event.kind === 'wheel') {
      if (event.direction === 'left' || event.direction === 'right') return
      if (event.y >= bottomTop && this.bottom?.onMouse(event, event.y - bottomTop, event.x) === true) return
      const lines = this.scroller.push(event.direction === 'up' ? -1 : 1, Date.now())
      if (lines !== 0) this.scrollBy(lines)
      return
    }
    if (event.y >= bottomTop) {
      if (event.kind === 'down') this.clearSelection()
      if (this.state.hover !== undefined) this.set({ hover: undefined })
      this.bottom?.onMouse(event, event.y - bottomTop, event.x)
      return
    }
    if (event.y >= g.viewportHeight) {
      if (this.state.hover !== undefined) this.set({ hover: undefined })
      this.bottom?.onMouse({ ...event, kind: event.kind === 'drag' ? 'drag' : 'move' }, -1, event.x)
      return
    }
    this.bottom?.onMouse({ ...event, kind: 'move' }, -1, event.x)
    this.onTranscript(event, g)
  }

  private onTranscript(event: MouseEvent, g: Geometry): void {
    const line = g.firstLine + event.y
    const bar = g.scrollbar
    if (bar !== undefined && event.x >= bar.col) {
      if (event.kind === 'down' && event.button === 'left') {
        this.barDrag = true
        this.scrollToRow(event.y, g)
      } else if (event.kind === 'move') {
        this.hover({ kind: 'scrollbar' })
      }
      return
    }
    const pill = g.pill
    const onPill = pill !== undefined && event.y === pill.row && event.x >= pill.from && event.x < pill.to
    if (event.kind === 'move') {
      this.hover(this.hoverAt(event.x, line, g, onPill))
      return
    }
    if (event.kind === 'down' && event.button === 'left' && onPill) {
      this.pillPressed = true
      return
    }
    if (event.kind === 'up' && this.pillPressed) {
      this.pillPressed = false
      if (onPill) this.toBottom()
      return
    }
    if (event.kind === 'down' && event.button === 'right') {
      if (this.state.selection !== undefined) this.copySelection(false)
      return
    }
    if (event.kind !== 'down' || event.button !== 'left') return
    this.scroller.reset()
    const at: Point = { line, col: event.x }
    if (event.shift && this.state.selection !== undefined) {
      this.dragging = true
      this.set({ selection: { ...this.state.selection, head: at } })
      return
    }
    const clicks = this.clicks.register(event.x, event.y, Date.now())
    const info = g.info[line]
    const plain = plainOf(g.lines[line] ?? '')
    const plainClick = clicks === 1 && !event.ctrl && !event.alt
    this.press = {
      at,
      row: event.y,
      x: event.x,
      moved: clicks > 1,
      toggle: plainClick && info?.toggle === true ? info.itemId : undefined,
      link: plainClick ? linkAt(plain, event.x)?.url : undefined,
    }
    this.dragging = true
    this.set({ selection: { anchor: at, head: at, unit: unitFor(clicks) }, hover: undefined })
  }

  /** Drag, release, and autoscroll of a selection that began in the transcript. */
  private onSelectionGesture(event: MouseEvent, g: Geometry): boolean {
    const selection = this.state.selection
    if (event.kind === 'drag' && event.button === 'left') {
      if (selection === undefined) return true
      const row = Math.max(0, Math.min(g.viewportHeight - 1, event.y))
      const head: Point = { line: g.firstLine + row, col: event.x }
      if (this.press !== undefined && (head.line !== this.press.at.line || head.col !== this.press.at.col)) this.press.moved = true
      this.set({ selection: { ...selection, head } })
      this.updateAutoscroll(event.y, g)
      return true
    }
    if (event.kind === 'wheel') {
      // Scrolling while holding the button keeps extending from the new viewport.
      return false
    }
    if (event.kind === 'up') {
      const press = this.press
      this.endDrag()
      if (press !== undefined && !press.moved && selection?.unit === 'char') {
        this.set({ selection: undefined })
        if (press.toggle !== undefined && event.y === press.row) this.toggleItem(press.toggle)
        else if (press.link !== undefined && event.y === press.row) this.openLink(press.link)
        return true
      }
      const text = this.selectionText()
      if (text === undefined || text === '') {
        this.set({ selection: undefined })
        return true
      }
      if (this.host.copyOnSelect !== false) this.copy(text)
      return true
    }
    return event.kind !== 'move'
  }

  private updateAutoscroll(y: number, g: Geometry): void {
    const direction = y <= 0 ? -1 : y >= g.viewportHeight ? 1 : 0
    if (direction === 0) {
      this.stopAutoscroll()
      return
    }
    this.autoscrollDirection = direction
    if (this.autoscroll !== undefined) return
    this.autoscroll = setInterval(() => {
      const geometry = this.geometry
      const selection = this.state.selection
      if (geometry === undefined || selection === undefined || !this.dragging) {
        this.stopAutoscroll()
        return
      }
      this.scrollBy(this.autoscrollDirection)
      const after = this.geometry ?? geometry
      const row = this.autoscrollDirection < 0 ? 0 : after.viewportHeight - 1
      // The frame for the new scroll position has not committed yet; predict it.
      const firstLine = Math.max(0, this.currentEnd() - after.viewportHeight)
      this.set({ selection: { ...selection, head: { line: firstLine + row, col: this.lastPointer?.x ?? 0 } } })
    }, 50)
  }

  private stopAutoscroll(): void {
    if (this.autoscroll !== undefined) clearInterval(this.autoscroll)
    this.autoscroll = undefined
  }

  private endDrag(): void {
    this.stopAutoscroll()
    this.dragging = false
    this.press = undefined
    this.barDrag = false
    this.pillPressed = false
  }

  private scrollToRow(y: number, g: Geometry): void {
    const total = g.lines.length
    const height = Math.max(1, g.viewportHeight)
    if (total <= height) return
    const fraction = Math.max(0, Math.min(1, y / Math.max(1, height - 1)))
    const end = Math.round(height + fraction * (total - height))
    this.set({ follow: end >= total, end })
  }

  private hoverAt(x: number, line: number, g: Geometry, onPill: boolean): Hover | undefined {
    if (onPill) return { kind: 'pill' }
    const raw = g.lines[line]
    if (raw === undefined) return undefined
    const link = linkAt(plainOf(raw), x)
    if (link !== undefined) return { kind: 'link', line, from: link.from, to: link.to }
    const info = g.info[line]
    if (info?.toggle === true) return { kind: 'toggle', itemId: info.itemId }
    return undefined
  }

  private hover(next: Hover | undefined): void {
    const current = this.state.hover
    if (JSON.stringify(current) === JSON.stringify(next)) return
    this.set({ hover: next })
  }

  private openLink(url: string): void {
    ;(this.host.openUrl ?? defaultOpen)(url)
    this.host.toast(`Opening ${url.length > 60 ? `${url.slice(0, 59)}…` : url}`, 'info')
  }
}
