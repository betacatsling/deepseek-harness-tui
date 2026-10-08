import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { initialState, Store } from '../src/store.ts'
import { parseArgs, projectEvent, visiblePrompt } from '../src/transcript.ts'

const ev = (value: unknown): SessionEvent => value as SessionEvent

describe('transcript projector', () => {
  it('replays human prompts with attachments folded into mentions', () => {
    const store = new Store(initialState('0', '/w'))
    const consumed = projectEvent(store, ev({
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'fix it\n<attached-file path="src/a.js" lines="2">x</attached-file>' }] },
    }), { renderUserMessages: true })
    expect(consumed).toBe(true)
    expect(store.get().items.at(-1)).toMatchObject({ kind: 'user', text: 'fix it', mentions: ['src/a.js'] })
  })

  it('ignores non-human messages and live echoes', () => {
    const store = new Store(initialState('0', '/w'))
    expect(projectEvent(store, ev({ type: 'user/message', data: { source: { kind: 'goal' }, content: [] } }), { renderUserMessages: true })).toBe(false)
    expect(projectEvent(store, ev({ type: 'user/message', data: { source: { kind: 'user' }, content: [] } }), { renderUserMessages: false })).toBe(false)
  })

  it('tracks a tool call through its result and marks denied calls', () => {
    const store = new Store(initialState('0', '/w'))
    projectEvent(store, ev({ type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } }), { renderUserMessages: false })
    expect(store.get().items.at(-1)).toMatchObject({ kind: 'tool', status: 'running', args: { command: 'ls' } })
    projectEvent(store, ev({
      type: 'tool/result', surfaceOp: 'append',
      data: { message: { toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'rejected' }] } },
    }), { renderUserMessages: false, deniedCalls: new Set(['c1']) })
    expect(store.get().items.at(-1)).toMatchObject({ kind: 'tool', status: 'denied', result: 'rejected' })
  })

  it('flags only the first thinking block of a turn', () => {
    const store = new Store(initialState('0', '/w'))
    const thought = ev({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'ok' }] } } })
    projectEvent(store, thought, { renderUserMessages: false })
    projectEvent(store, thought, { renderUserMessages: false })
    const thinking = store.get().items.filter(item => item.kind === 'thinking')
    expect(thinking.map(item => item.kind === 'thinking' && item.first === true)).toEqual([true, false])
  })

  it('parses tool arguments defensively', () => {
    expect(parseArgs('')).toEqual({})
    expect(parseArgs('[1]')).toEqual({ value: [1] })
    expect(parseArgs('{oops')).toEqual({ raw: '{oops' })
    expect(visiblePrompt('hi  ')).toEqual({ text: 'hi', mentions: [] })
  })
})
