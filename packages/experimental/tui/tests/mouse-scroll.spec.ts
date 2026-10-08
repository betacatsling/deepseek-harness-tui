import { describe, expect, it } from 'vitest'
import { type ScrollConfig, scrollConfigFromEnv, ScrollNormalizer } from '../src/mouse/scroll.ts'

const config = (patch: Partial<ScrollConfig>): ScrollConfig => ({ ...scrollConfigFromEnv({}), ...patch })

describe('scroll configuration', () => {
  it('knows which terminals send one event per wheel notch', () => {
    expect(scrollConfigFromEnv({ TERM_PROGRAM: 'iTerm.app' })).toMatchObject({ eventsPerTick: 1, wheelLines: 1 })
    expect(scrollConfigFromEnv({ TMUX: '/tmp/tmux,1,0' })).toMatchObject({ eventsPerTick: 1, wheelLines: 1 })
    expect(scrollConfigFromEnv({ TERM_PROGRAM: 'vscode' })).toMatchObject({ eventsPerTick: 1 })
    expect(scrollConfigFromEnv({ TERM_PROGRAM: 'Apple_Terminal' })).toMatchObject({ eventsPerTick: 3, wheelLines: 3 })
  })

  it('honours explicit environment overrides', () => {
    const c = scrollConfigFromEnv({ DSH_TUI_SCROLL_MODE: 'wheel', DSH_TUI_SCROLL_LINES: '5', DSH_TUI_SCROLL_INVERT: '1' })
    expect(c).toMatchObject({ mode: 'wheel', wheelLines: 5, invert: true })
  })
})

describe('ScrollNormalizer', () => {
  it('turns a 3-event wheel notch into wheelLines lines', () => {
    const n = new ScrollNormalizer(config({ eventsPerTick: 3, wheelLines: 3 }))
    const total = n.push(-1, 0) + n.push(-1, 2) + n.push(-1, 4)
    expect(total).toBe(-3)
    expect(n.kind).toBe('wheel')
  })

  it('moves at least one line per notch on one-event terminals', () => {
    const n = new ScrollNormalizer(config({ eventsPerTick: 1, wheelLines: 1 }))
    expect(n.push(1, 0)).toBe(1)
    expect(n.push(1, 200)).toBe(1)
  })

  it('prices a fast trackpad stream gently and smoothly', () => {
    const n = new ScrollNormalizer(config({ eventsPerTick: 1, wheelLines: 1, trackpadLines: 3 }))
    const deltas: number[] = []
    for (let i = 0; i < 30; i += 1) deltas.push(n.push(1, i * 16))
    expect(n.kind).toBe('trackpad')
    expect(deltas.every(delta => delta >= 0 && delta <= 3)).toBe(true)
    const total = deltas.reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThan(10)
    expect(total).toBeLessThan(90)
  })

  it('drops the fractional remainder when the direction reverses', () => {
    const n = new ScrollNormalizer(config({ mode: 'trackpad', trackpadLines: 1 }))
    n.push(1, 0)
    expect(n.push(-1, 10)).toBeLessThanOrEqual(0)
    expect(n.push(-1, 1000)).toBeLessThanOrEqual(0)
  })

  it('caps one event to the configured maximum and supports inversion', () => {
    const n = new ScrollNormalizer(config({ mode: 'wheel', eventsPerTick: 1, wheelLines: 50 }), 24)
    n.setCap(5)
    expect(n.push(1, 0)).toBe(5)
    const inverted = new ScrollNormalizer(config({ eventsPerTick: 1, wheelLines: 1, invert: true }))
    expect(inverted.push(1, 0)).toBe(-1)
  })
})
