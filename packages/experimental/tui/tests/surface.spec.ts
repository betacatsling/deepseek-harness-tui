import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { jsLiteral, programCalls, ptcProgram, splitProgramResult, toolSurface } from '../src/demo/surface.ts'

const schema = (name: string): ToolSchema => ({ name, description: name, parameters: { type: 'object', properties: {} } })

describe('tool surface', () => {
  it('classifies the four shipped modes', () => {
    expect(toolSurface({ tools: [schema('read'), schema('bash')] })).toBe('native')
    expect(toolSurface({ tools: [schema('run_code')] })).toBe('ptc')
    expect(toolSurface({ tools: [schema('run_code'), schema('read')] })).toBe('native')
    expect(toolSurface({ tools: [schema('bash')] })).toBe('minimal')
    expect(toolSurface({})).toBe('native')
  })
})

describe('ptc programs', () => {
  it('formats compact literals and one program per step', () => {
    const single = ptcProgram([{ name: 'grep', args: { pattern: 'a|b', path: 'src' } }], 'Search')
    expect(single.description).toBe('Search')
    expect(single.code).toBe("const grep = await tools.grep({ pattern: 'a|b', path: 'src' })\nreturn { grep }")
    const pair = ptcProgram([{ name: 'glob', args: { pattern: '*.js' } }, { name: 'read', args: { file_path: 'a.js' } }], 'Both')
    expect(programCalls(pair.code)).toEqual(['glob', 'read'])
    expect(pair.code).toContain('Promise.all')
  })

  it('splits a program result back into per-tool results', () => {
    const code = ptcProgram([{ name: 'bash', args: { command: 'ls' } }], 'List').code
    const split = splitProgramResult(code, 'log line\n{\n  "bash": "ok"\n}', false)
    expect(split).toEqual([{ name: 'bash', text: 'ok', isError: false }])
    expect(splitProgramResult(code, 'boom', true)).toEqual([{ name: 'bash', text: 'boom', isError: true }])
    expect(splitProgramResult('return 1', '{}', false)).toBeUndefined()
  })

  it('keeps one-line literals under the width budget', () => {
    expect(jsLiteral({ a: 'b', c: 'd' })).not.toContain('\n')
  })
})
