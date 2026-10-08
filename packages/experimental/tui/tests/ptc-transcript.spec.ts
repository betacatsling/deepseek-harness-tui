import { describe, expect, it } from 'vitest'
import { renderTool, type RenderOptions } from '../src/render.ts'
import { initialState, Store } from '../src/store.ts'
import { projectEvent } from '../src/transcript.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const ev = (value: unknown): SessionEvent => value as SessionEvent
const hooks = { renderUserMessages: false }

describe('ptc dispatch folding', () => {
  it('nests dispatch events under their run_code call with live status', () => {
    const store = new Store(initialState('0', '/w'))
    projectEvent(store, ev({ type: 'tool/call', data: { callId: 'c1', name: 'run_code', arguments: '{"description":"Count lines","code":"const x = 1"}' } }), hooks)
    projectEvent(store, ev({ type: 'tool/ptc-dispatch-start', data: { rootCallId: 'c1', parentCallId: 'c1', subCallId: 'c1:ptc:0', name: 'glob', arguments: { pattern: '*.js' } } }), hooks)
    projectEvent(store, ev({ type: 'tool/ptc-dispatch-start', data: { rootCallId: 'c1', parentCallId: 'c1', subCallId: 'c1:ptc:1', name: 'read', arguments: { file_path: 'a.js' } } }), hooks)
    projectEvent(store, ev({ type: 'tool/ptc-dispatch', data: { rootCallId: 'c1', subCallId: 'c1:ptc:0', name: 'glob', isError: false, content: '[]' } }), hooks)
    const item = store.get().items.at(-1)
    expect(item).toMatchObject({ kind: 'tool', name: 'run_code', status: 'running' })
    expect(item?.kind === 'tool' ? item.children?.map(child => [child.label, child.status]) : []).toEqual([['Search(pattern: "*.js")', 'ok'], ['Read(a.js)', 'running']])
  })

  it('mirrors a nested todo_write onto the checklist', () => {
    const store = new Store(initialState('0', '/w'))
    projectEvent(store, ev({ type: 'tool/call', data: { callId: 'c1', name: 'run_code', arguments: '{}' } }), hooks)
    projectEvent(store, ev({ type: 'tool/ptc-dispatch-start', data: { rootCallId: 'c1', subCallId: 'c1:ptc:0', name: 'todo_write', arguments: { todos: [{ content: 'Fix it', status: 'completed' }] } } }), hooks)
    expect(store.get().todos).toEqual([{ content: 'Fix it', status: 'completed' }])
  })
})

describe('program card', () => {
  it('renders the description as title and the highlighted program', () => {
    const store = new Store(initialState('0', '/w'))
    projectEvent(store, ev({ type: 'tool/call', data: { callId: 'c1', name: 'run_code', arguments: '{"description":"Count lines","code":"const { paths } = await tools.glob({})"}' } }), hooks)
    projectEvent(store, ev({ type: 'tool/ptc-dispatch-start', data: { rootCallId: 'c1', subCallId: 'c1:ptc:0', name: 'glob', arguments: {} } }), hooks)
    const item = store.get().items.at(-1)
    if (item?.kind !== 'tool') throw new Error('expected a tool item')
    const opts: RenderOptions = { width: 60, detail: false, now: item.startedAt + 3000 }
    const text = renderTool(item, opts).join('\n').replace(/\x1B\[[0-9;]*m/g, '')
    expect(text).toContain('Program(Count lines)')
    expect(text).toContain('TypeScript')
    expect(text).toContain('await tools.glob')
    expect(text).toContain('Search')
    expect(text).toContain('Running… · 1 call (3s)')
  })
})
