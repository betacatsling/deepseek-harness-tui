import { describe, expect, it, vi } from 'vitest'
import { type BottomHandler, type Geometry, linkAt, MouseController } from '../src/mouse/controller.ts'
import { decodeButton, type MouseEvent } from '../src/mouse/protocol.ts'
import type { TerminalModes } from '../src/mouse/terminal.ts'
import type { LineInfo } from '../src/viewport.ts'

/** Ten transcript lines; line 2 is a toggleable tool header; line 5 holds a link. */
const LINES = Array.from({ length: 40 }, (_, i) => `line ${String(i)}`)
LINES[2] = '⏺ Bash(npm test)'
LINES[5] = '  see https://example.com/docs for more'
const INFO: (LineInfo | undefined)[] = LINES.map((_, i) => (i >= 2 && i <= 4 ? { itemId: 'tool', row: i - 2, toggle: i === 2 } : undefined))

function setup(options: { capture?: boolean } = {}) {
  const writes: string[] = []
  const toasts: string[] = []
  const opened: string[] = []
  const spies = { enable: vi.fn(), disableMouse: vi.fn(), disable: vi.fn(), reassert: vi.fn() }
  const modes = spies as unknown as TerminalModes
  const controller = new MouseController({
    modes,
    write: (data) => { writes.push(data) },
    toast: (text) => { toasts.push(text) },
    openUrl: (url) => { opened.push(url) },
    scroll: { mode: 'wheel', eventsPerTick: 1, wheelLines: 3, trackpadLines: 3, invert: false, speed: 1 },
  }, options.capture ?? true)
  // A 30-row screen: 10 transcript rows at the top showing lines 0-9 while scrolled to the top.
  const geometry = (firstLine: number): Geometry => ({
    rows: 30, columns: 80, viewportHeight: 10, firstLine, end: firstLine + 10, lines: LINES, info: INFO,
    pill: firstLine + 10 < LINES.length ? { row: 9, from: 20, to: 50 } : undefined,
    scrollbar: { col: 79, thumbTop: 0, thumbHeight: 2 },
  })
  return { controller, writes, toasts, opened, spies, geometry }
}

const ev = (code: number, x: number, y: number, release = false): MouseEvent => decodeButton(code, x, y, release)
const click = (c: MouseController, x: number, y: number): void => { c.handle(ev(0, x, y)); c.handle(ev(0, x, y, true)) }

describe('MouseController hit-testing', () => {
  it('scrolls the transcript with the wheel and stops following', () => {
    const { controller, geometry } = setup()
    controller.setGeometry(geometry(30))
    controller.handle(ev(64, 10, 5))
    expect(controller.get()).toMatchObject({ follow: false, end: 37 })
    controller.handle(ev(65, 10, 5))
    expect(controller.get().follow).toBe(true)
  })

  it('toggles a tool block when its header is clicked, not when dragged', () => {
    const { controller, geometry } = setup()
    controller.setGeometry(geometry(0))
    vi.useFakeTimers({ now: 0 })
    click(controller, 4, 2)
    expect(controller.get().expanded.has('tool')).toBe(true)
    expect(controller.get().reveal).toMatchObject({ itemId: 'tool', header: 2 })
    // A second click inside the multi-click window would select a word; wait it out.
    vi.setSystemTime(1000)
    click(controller, 4, 2)
    expect(controller.get().expanded.has('tool')).toBe(false)
    // A click on a non-header row of the block does nothing.
    vi.setSystemTime(2000)
    click(controller, 4, 3)
    expect(controller.get().expanded.size).toBe(0)
    vi.useRealTimers()
  })

  it('opens a link on a stationary click', () => {
    const { controller, geometry, opened } = setup()
    controller.setGeometry(geometry(0))
    click(controller, 10, 5)
    expect(opened).toEqual(['https://example.com/docs'])
    expect(linkAt(LINES[5] ?? '', 2)).toBeUndefined()
  })

  it('drag-selects, copies on release via OSC 52, and keeps the highlight', () => {
    const { controller, geometry, writes, toasts } = setup()
    controller.setGeometry(geometry(0))
    controller.handle(ev(0, 0, 6))
    controller.handle(ev(32, 3, 7))
    controller.handle(ev(0, 3, 7, true))
    expect(controller.selectionText()).toBe('line 6\nline')
    expect(writes.join('')).toContain(`\x1b]52;c;${Buffer.from('line 6\nline').toString('base64')}`)
    expect(toasts.at(-1)).toBe('Copied 11 characters')
    expect(controller.hasSelection()).toBe(true)
    expect(controller.clearSelection()).toBe(true)
  })

  it('selects a word on double click and extends with shift-click', () => {
    const { controller, geometry } = setup()
    controller.setGeometry(geometry(0))
    click(controller, 7, 5)
    click(controller, 7, 5)
    expect(controller.selectionText()).toBe('https://example.com/docs')
    controller.handle(ev(4, 3, 6))
    controller.handle(ev(4, 3, 6, true))
    expect(controller.selectionText()).toContain('for more\nline')
  })

  it('jumps back to the bottom from the pill and seeks with the scrollbar', () => {
    const { controller, geometry } = setup()
    controller.setGeometry(geometry(0))
    controller.scrollBy(-100)
    controller.handle(ev(0, 79, 0))
    controller.handle(ev(0, 79, 0, true))
    expect(controller.get().end).toBe(10)
    controller.handle(ev(0, 30, 9))
    controller.handle(ev(0, 30, 9, true))
    expect(controller.get().follow).toBe(true)
  })

  it('routes events below the viewport to the bottom component in local coordinates', () => {
    const { controller, geometry } = setup()
    controller.setGeometry(geometry(0))
    const seen: [string, number, number][] = []
    const bottom: BottomHandler = { height: 6, onMouse: (e, row, col) => { seen.push([e.kind, row, col]); return e.kind === 'wheel' } }
    controller.registerBottom(bottom)
    controller.handle(ev(0, 12, 26))
    controller.handle(ev(64, 12, 25))
    expect(seen).toEqual([['down', 2, 12], ['wheel', 1, 12]])
    expect(controller.get().follow).toBe(true)
  })

  it('reports hover targets for headers, links and the pill', () => {
    const { controller, geometry } = setup()
    controller.setGeometry(geometry(0))
    controller.handle(ev(35, 3, 2))
    expect(controller.get().hover).toEqual({ kind: 'toggle', itemId: 'tool' })
    controller.handle(ev(35, 8, 5))
    expect(controller.get().hover).toMatchObject({ kind: 'link', line: 5, from: 6 })
    controller.handle(ev(35, 25, 9))
    expect(controller.get().hover).toEqual({ kind: 'pill' })
  })

  it('ignores reports while capture is off and re-asserts on focus', () => {
    const { controller, geometry, spies } = setup({ capture: false })
    controller.setGeometry(geometry(30))
    controller.handle(ev(64, 1, 1))
    expect(controller.get().follow).toBe(true)
    controller.handle({ kind: 'focus', focused: true })
    expect(spies.reassert).toHaveBeenCalled()
    controller.setCapture(true)
    expect(spies.enable).toHaveBeenCalled()
  })
})
