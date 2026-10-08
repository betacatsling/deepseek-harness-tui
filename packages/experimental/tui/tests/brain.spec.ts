import type { GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { autoReview, planReply, readTurn } from '../src/demo/brain.ts'

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

  describe('modes', () => {
    const toolset = (...names: string[]): GenerateOptions['tools'] => names.map(name => ({ name })) as unknown as GenerateOptions['tools']
    const withTools = (messages: RequestMessage[], ...names: string[]): GenerateOptions =>
      ({ messages, tools: toolset(...names) }) as unknown as GenerateOptions

    it('wraps a PTC step into one run_code program, checklist last', () => {
      const reply = planReply(withTools([user('The tests are failing, fix them')], 'run_code'))
      expect(reply.toolCalls).toHaveLength(1)
      const call = reply.toolCalls?.[0]
      expect(call?.name).toBe('run_code')
      const code = String(call?.args.code)
      expect(code.indexOf('tools.bash')).toBeLessThan(code.indexOf('tools.todo_write'))
      expect(typeof call?.args.description).toBe('string')
    })

    it('surveys with one program in PTC and with glob + reads natively', () => {
      const ptc = planReply(withTools([user('Survey the codebase')], 'run_code'))
      expect(String(ptc.toolCalls?.[0]?.args.code)).toContain('Promise.all(paths.map')
      const native = planReply(withTools([user('Survey the codebase')], 'read', 'glob', 'bash'))
      expect(native.toolCalls?.[0]?.name).toBe('glob')
      const rows = '[\n  {\n    "file": "src/a.js",\n    "lines": 3,\n    "exports": 1,\n    "tests": 0\n  }\n]'
      const done = planReply(withTools([user('Survey the codebase'), assistant([{ id: 'p', name: 'run_code' }]), result('p', rows)], 'run_code'))
      expect(done.text).toContain('| `src/a.js` | 3 | 1 | 0 |')
    })

    it('fixes through the one shell in Minimal mode', () => {
      const reply = planReply(withTools([user('The tests are failing, fix them')], 'bash'))
      expect(reply.toolCalls).toEqual([{ name: 'bash', args: { command: 'npm test --silent' } }])
    })

    it('loads the authoring skill first in Creator mode', () => {
      const reply = planReply(withTools([user('Create a new mode for code review')], 'read', 'bash', 'skill', 'cordis_inspect_list', 'plugin_manager'))
      expect(reply.toolCalls?.[0]).toEqual({ name: 'skill', args: { name: 'editing-cordis-compositions' } })
    })
  })

  it('answers Auto review requests with the exact decision objects', () => {
    expect(autoReview('ENVIRONMENT\n\nPENDING_ACTION\n\n{"name":"read"}')).toBe('{"risk":"low","decision":"allow"}')
    expect(autoReview('PENDING_ACTION {"command":"npm view ioredis version"}')).toBe('{"risk":"medium","decision":"allow"}')
    expect(JSON.parse(autoReview('PENDING_ACTION {"command":"git push --force"}'))).toMatchObject({ risk: 'medium', decision: 'deny' })
    const review = planReply({ system: 'REVIEW_POLICY\n...', messages: [user('PENDING_ACTION {}')] } as unknown as GenerateOptions)
    expect(review.text).toBe('{"risk":"low","decision":"allow"}')
  })
})
