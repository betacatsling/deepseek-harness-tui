/**
 * How the scripted demo model adapts to the agent mode it runs under. It reads
 * the tool schemas in the request, exactly as a real model would:
 * - `native` (Standard, Creator): call tools directly;
 * - `ptc`: only `run_code` is offered, so each scripted step becomes one
 *   TypeScript program that calls the same tools through the generated SDK
 *   (`await tools.read({...})`); independent calls run under `Promise.all`;
 * - `minimal`: a single persistent `bash`, so scripts use shell commands.
 * @module @deepseek-ai/dsh-experimental-tui/demo/surface
 */

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/** The tool surface one request offers. */
export type ToolSurface = 'native' | 'ptc' | 'minimal'

/** A scripted tool call (mirrors brain.ts). */
interface Call {
  readonly name: string
  readonly args: Record<string, unknown>
}

/**
 * Classify a request's tool surface.
 * @param options - the request.
 * @returns which surface the scripts should target.
 */
export function toolSurface(options: Pick<GenerateOptions, 'tools'>): ToolSurface {
  const names = new Set((options.tools ?? []).map(tool => tool.name))
  if (names.has('run_code') && !names.has('read')) return 'ptc'
  if (names.has('bash') && !names.has('read') && !names.has('glob')) return 'minimal'
  return 'native'
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/** Literals that fit this many columns (indent included) stay on one line. */
const FLAT_WIDTH = 88

/**
 * Format a JSON value as a readable JavaScript literal (single quotes, bare keys).
 * @param value - JSON value.
 * @param indent - current indentation.
 * @returns source text.
 */
export function jsLiteral(value: unknown, indent = ''): string {
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  const inner = `${indent}  `
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const flat = `[${value.map(item => jsLiteral(item, inner)).join(', ')}]`
    if (indent.length + flat.length <= FLAT_WIDTH && !flat.includes('\n')) return flat
    return `[\n${value.map(item => `${inner}${jsLiteral(item, inner)}`).join(',\n')},\n${indent}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return '{}'
  const key = (name: string): string => IDENTIFIER.test(name) ? name : jsLiteral(name)
  const flat = `{ ${entries.map(([name, item]) => `${key(name)}: ${jsLiteral(item, inner)}`).join(', ')} }`
  if (indent.length + flat.length <= FLAT_WIDTH && !flat.includes('\n')) return flat
  return `{\n${entries.map(([name, item]) => `${inner}${key(name)}: ${jsLiteral(item, inner)}`).join(',\n')},\n${indent}}`
}

function camel(name: string): string {
  return name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

/** Variable names for a step's calls, unique and in call order. */
function bindings(calls: readonly Call[]): string[] {
  const seen = new Map<string, number>()
  return calls.map((call) => {
    const base = call.name === 'todo_write' ? 'todos' : camel(call.name)
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    return count === 1 ? base : `${base}${String(count)}`
  })
}

/**
 * One `run_code` program performing a scripted step's tool calls.
 * @param calls - the native calls the step would make.
 * @param description - the UI label for the program.
 * @returns `run_code` arguments, `description` first as the schema asks.
 */
export function ptcProgram(calls: readonly Call[], description: string): { description: string; code: string } {
  const names = bindings(calls)
  const invoke = (call: Call, indent: string): string => `tools.${call.name}(${jsLiteral(call.args, indent)})`
  let code: string
  if (calls.length === 1 && calls[0] !== undefined) {
    code = `const ${names[0] ?? 'result'} = await ${invoke(calls[0], '')}\nreturn { ${names[0] ?? 'result'} }`
  } else {
    code = [
      '// Independent calls run concurrently',
      `const [${names.join(', ')}] = await Promise.all([`,
      ...calls.map(call => `  ${invoke(call, '  ')},`),
      '])',
      `return { ${names.join(', ')} }`,
    ].join('\n')
  }
  return { description, code }
}

/**
 * The tool names a `run_code` program calls, in source order.
 * @param code - program source.
 * @returns tool names.
 */
export function programCalls(code: string): string[] {
  return [...code.matchAll(/tools\.([A-Za-z_]\w*)\(/g)].map(match => match[1] ?? '')
}

/** One tool's share of a program result. */
export interface ProgramStepResult {
  readonly name: string
  readonly text: string
  readonly isError: boolean
}

/**
 * Split a `run_code` result back into per-tool results, for programs from
 * {@link ptcProgram} (one returned key per call, in call order).
 * @param code - the program.
 * @param text - the result text (two-space JSON of the returned object).
 * @param isError - whether the program failed.
 * @returns per-tool results, or undefined when the shape does not match.
 */
export function splitProgramResult(code: string, text: string, isError: boolean): ProgramStepResult[] | undefined {
  const names = programCalls(code)
  if (names.length === 0) return undefined
  if (isError) return names.map(name => ({ name, text, isError: true }))
  const start = text.indexOf('{')
  if (start < 0) return undefined
  try {
    const value = JSON.parse(text.slice(start)) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const values = Object.values(value as Record<string, unknown>)
    if (values.length !== names.length) return undefined
    return names.map((name, index) => {
      const item = values[index]
      return { name, text: typeof item === 'string' ? item : JSON.stringify(item), isError: false }
    })
  } catch {
    return undefined
  }
}
