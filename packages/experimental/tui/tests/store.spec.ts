import { describe, expect, it } from 'vitest'
import { computeFlushed, initialState, type Item, Store } from '../src/store.ts'

const tool = (id: string, status: 'running' | 'ok'): Item => ({
  kind: 'tool', id, callId: id, name: 'read', args: {}, rawArgs: '{}', status, startedAt: 0,
})

describe('store', () => {
  it('flushes settled items up to the first in-flight one', () => {
    const items: Item[] = [{ kind: 'banner', id: 'b' }, tool('k1', 'ok'), tool('k2', 'running'), { kind: 'assistant', id: 'a', text: 'hi' }]
    expect(computeFlushed(items, 0)).toBe(2)
    items[2] = tool('k2', 'ok')
    expect(computeFlushed(items, 2)).toBe(4)
  })

  it('holds a pending command in the live region until it settles', () => {
    const items: Item[] = [{ kind: 'command', id: 'x', line: '/compact', ok: true, pending: true }]
    expect(computeFlushed(items, 0)).toBe(0)
  })

  it('coalesces bursts of updates into one notification', async () => {
    const store = new Store(initialState('0.0.0', '/tmp'))
    let calls = 0
    store.subscribe(() => { calls += 1 })
    store.push({ kind: 'notice', id: store.nextId('n'), tone: 'info', text: 'a' })
    store.push({ kind: 'notice', id: store.nextId('n'), tone: 'info', text: 'b' })
    await Promise.resolve()
    expect(calls).toBe(1)
    expect(store.get().items).toHaveLength(3)
    expect(store.get().flushed).toBe(3)
  })
})
