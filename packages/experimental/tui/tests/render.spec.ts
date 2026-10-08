import { stripVTControlCharacters as strip } from 'node:util'
import { describe, expect, it } from 'vitest'
import { renderBanner, renderItem, renderTool } from '../src/render.ts'
import { initialState, type Item } from '../src/store.ts'
import textWidth from '../src/width.ts'

type Tool = Extract<Item, { kind: 'tool' }>
const tool = (patch: Partial<Tool>): Tool => ({
  kind: 'tool', id: 'k', callId: 'c', name: 'bash', args: { command: 'npm test' }, rawArgs: '', status: 'ok', startedAt: 0, ...patch,
})
const plain = (lines: string[]): string[] => lines.map(line => strip(line))

describe('transcript rendering', () => {
  it('draws ⏺ / ⎿ tool blocks with clipped output', () => {
    const lines = plain(renderTool(tool({ result: 'a\nb\nc\nd\ne\nf' }), { width: 80, detail: false }))
    expect(lines[0]).toBe('⏺ Bash(npm test)')
    expect(lines[1]?.startsWith('  ⎿  ')).toBe(true)
    expect(lines.at(-1)).toContain('ctrl+o to expand')
  })

  it('folds a finished subagent under one elbow', () => {
    const lines = plain(renderTool(tool({
      name: 'subagent', args: { description: 'Review' }, result: 'two issues', endedAt: 2_000,
      children: [{ label: 'Read(src/a.js)', status: 'ok' }, { label: 'Search(pattern: "x")', status: 'ok' }],
    }), { width: 80, detail: false }))
    expect(lines.filter(line => line.includes('⎿'))).toHaveLength(1)
    expect(lines.at(-1)).toContain('Done (2 tool uses · 2s)')
  })

  it('shows a waiting state for approvals and a pending command placeholder', () => {
    expect(plain(renderTool(tool({ status: 'waiting' }), { width: 60, detail: false }))[1]).toContain('Waiting for permission')
    const state = initialState('0', '/w')
    const pending = plain(renderItem({ kind: 'command', id: 'x', line: '/compact', ok: true, pending: true }, state, { width: 60, detail: false }))
    expect(pending.at(-1)).toContain('Running…')
  })

  it.each([64, 80, 88, 100, 112, 160])('keeps every banner row aligned at %i columns', (width) => {
    const state = { ...initialState('0.2.1', '/workspace/acme-api'), recent: [{ id: 's', title: 'Explain acme-api', ago: '2m ago' }] }
    const widths = new Set(renderBanner(state, width).map(line => textWidth(line)))
    expect([...widths]).toEqual([Math.min(width, 112)])
  })

  it.each([80, 100])('renders the whale in the welcome banner at %i columns', (width) => {
    const state = { ...initialState('0.2.1', '/workspace/acme-api'), recent: [{ id: 's', title: 'Explain acme-api', ago: '2m ago' }] }
    expect(plain(renderBanner(state, width)).join('\n')).toMatchSnapshot()
  })
})
