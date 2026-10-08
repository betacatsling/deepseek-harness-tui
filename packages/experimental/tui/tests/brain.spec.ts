import type { GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { planReply, readTurn } from '../src/demo/brain.ts'

const user = (text: string, source: Record<string, unknown> = { kind: 'user' }): RequestMessage =>
  ({ role: 'user', content: [{ type: 'text', text }], source }) as unknown as RequestMessage
const assistant = (calls: { id: string; name: string }[]): RequestMessage =>
  ({ role: 'assistant', content: calls.map(call => ({ type: 'tool-call', id: call.id, name: call.name, arguments: '{}' })) }) as unknown as RequestMessage
const result = (id: string, text: string, isError = false): RequestMessage =>
  ({ role: 'tool', toolCallId: id, isError, content: [{ type: 'text', text }] }) as unknown as RequestMessage
const options = (messages: RequestMessage[], tools = 1): GenerateOptions =>
  ({ messages, tools: Array.from({ length: tools }, () => ({})) }) as unknown as GenerateOptions

describe('demo brain', () => {
  it('reconstructs the turn since the last human prompt', () => {
    const turn = readTurn([user('old'), user('Why do tests fail?'), assistant([{ id: 't1', name: 'bash' }]), result('t1', 'fail 1', true)])
    expect(turn.prompt).toBe('Why do tests fail?')
    expect(turn.step).toBe(1)
    expect(turn.results).toEqual([{ name: 'bash', text: 'fail 1', isError: true }])
  })

  it('starts the fix scenario with a todo list and a test run', () => {
    const reply = planReply(options([user('The tests are failing, fix them')]))
    expect(reply.toolCalls?.map(call => call.name)).toContain('todo_write')
  })

  it('closes automatic goal rounds through update_goal', () => {
    const goal = user('Continue the goal', { kind: 'goal', goalId: 'g1', revision: 2, round: 1 })
    expect(planReply(options([goal])).toolCalls?.[0]?.name).toBe('grep')
    const second = planReply(options([goal, assistant([{ id: 'a', name: 'grep' }]), result('a', 'src/limiter.js:3')]))
    expect(second.toolCalls?.[0]).toEqual({ name: 'update_goal', args: { goal_id: 'g1', revision: 2, action: 'complete' } })
  })

  it('answers title and compaction requests without tools', () => {
    const title = planReply(options([user('add redis', { kind: 'dsh-session-title-llm' })]))
    expect(title.text).toBe('Redis-backed rate limit store')
    expect(planReply(options([user('summarize')], 0)).text).toMatch(/^Summary:/)
  })
})
