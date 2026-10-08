import { stripVTControlCharacters as strip } from 'node:util'
import { describe, expect, it } from 'vitest'
import { indexAt, layoutRows } from '../src/editor.ts'
import { chooseScreen } from '../src/screen-mode.ts'
import { initialState, type Item, type UiState } from '../src/store.ts'
import { buildTranscript } from '../src/viewport.ts'
import textWidth from '../src/width.ts'

type Tool = Extract<Item, { kind: 'tool' }>
const tool = (patch: Partial<Tool>): Tool => ({
  kind: 'tool', id: 't1', callId: 'c', name: 'bash', args: { command: 'npm test' }, rawArgs: '', status: 'ok', startedAt: 0, ...patch,
})
const state = (items: Item[], patch: Partial<UiState> = {}): UiState => ({ ...initialState('0.0.0', '/tmp'), items, flushed: items.length, ...patch })

describe('fullscreen transcript map', () => {
  const items: Item[] = [
    { kind: 'user', id: 'u1', text: 'run the tests' },
    tool({ result: Array.from({ length: 12 }, (_, i) => `out ${String(i)}`).join('\n') }),
  ]

  it('maps every line to its item and marks the click targets', () => {
    const t = buildTranscript(state(items), { width: 80, expanded: new Set(), frame: 0, hint: 'click' })
    expect(t.lines).toHaveLength(t.info.length)
    expect(t.toggleable.has('t1')).toBe(true)
    const header = t.info.findIndex(info => info?.itemId === 't1')
    expect(strip(t.lines[header] ?? '')).toBe('⏺ Bash(npm test)')
    expect(t.info[header]?.toggle).toBe(true)
    const more = t.lines.findIndex(line => strip(line).includes('(click to expand)'))
    expect(more).toBeGreaterThan(header)
    expect(t.info[more]?.toggle).toBe(true)
    expect(t.info[header + 1]?.toggle).toBe(false)
  })

  it('expands one item without the global detail toggle', () => {
    const compact = buildTranscript(state(items), { width: 80, expanded: new Set(), frame: 0, hint: 'click' })
    const open = buildTranscript(state(items), { width: 80, expanded: new Set(['t1']), frame: 0, hint: 'click' })
    expect(open.lines.length).toBeGreaterThan(compact.lines.length)
    expect(open.lines.map(line => strip(line))).toContain('     out 11')
  })

  it('has nothing to toggle when detail is already on', () => {
    const t = buildTranscript(state(items, { detail: true }), { width: 80, expanded: new Set(), frame: 0, hint: 'click' })
    expect(t.toggleable.size).toBe(0)
  })
})

describe('composer layout for click-to-cursor', () => {
  it('wraps on spaces and maps cells back to text indexes', () => {
    const text = 'hello brave new world\nnext'
    const rows = layoutRows(text, 12, textWidth)
    expect(rows.map(row => text.slice(row.start, row.end))).toEqual(['hello brave ', 'new world', 'next'])
    expect(indexAt(text, rows, 0, 6, textWidth)).toBe(6)
    expect(indexAt(text, rows, 1, 0, textWidth)).toBe(12)
    expect(indexAt(text, rows, 1, 50, textWidth)).toBe(21)
    expect(indexAt(text, rows, 9, 2, textWidth)).toBe(24)
  })

  it('accounts for wide characters', () => {
    const text = '中文ab'
    const rows = layoutRows(text, 10, textWidth)
    expect(indexAt(text, rows, 0, 2, textWidth)).toBe(1)
    expect(indexAt(text, rows, 0, 4, textWidth)).toBe(2)
  })
})

describe('screen mode', () => {
  it('defaults to fullscreen with capture, inline under Zellij or tmux -CC', () => {
    expect(chooseScreen(undefined, {}, () => undefined)).toEqual({ fullscreen: true, capture: true })
    expect(chooseScreen(undefined, { ZELLIJ: '0' }, () => undefined)).toEqual({ fullscreen: false, capture: false })
    expect(chooseScreen(undefined, { TMUX: 'x' }, () => '1 1').fullscreen).toBe(false)
    expect(chooseScreen(false, {}, () => undefined).fullscreen).toBe(false)
    expect(chooseScreen(true, { ZELLIJ: '0' }, () => undefined)).toEqual({ fullscreen: true, capture: true })
  })

  it('does not grab the mouse when tmux mouse mode is off', () => {
    expect(chooseScreen(undefined, { TMUX: 'x' }, () => '0 0')).toMatchObject({ fullscreen: true, capture: false })
    expect(chooseScreen(undefined, { TMUX: 'x' }, () => '1 0')).toMatchObject({ fullscreen: true, capture: true })
  })
})
