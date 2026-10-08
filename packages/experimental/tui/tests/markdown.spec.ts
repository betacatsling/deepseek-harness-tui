import { stripVTControlCharacters as strip } from 'node:util'
import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderStreamingMarkdown } from '../src/markdown.ts'
import textWidth from '../src/width.ts'

const plain = (source: string, width = 60): string[] => renderMarkdown(source, width).map(line => strip(line))

describe('markdown', () => {
  it('renders headings, emphasis and inline code without markup', () => {
    expect(plain('# Title\n\nSome **bold** and `code`.')).toEqual(['Title', '', 'Some bold and code.'])
  })

  it('frames fenced code with its language', () => {
    const lines = plain('```js\nconst a = 1\n```')
    expect(lines[0]).toBe('╭─ js')
    expect(lines[1]).toBe('│ const a = 1')
    expect(lines[2]).toBe('╰─')
  })

  it('closes an unterminated fence while streaming', () => {
    const lines = renderStreamingMarkdown('```ts\nlet x', 40).map(line => strip(line))
    expect(lines.at(-1)).toBe('╰─')
  })

  it('boxes tables and right-aligns numeric columns', () => {
    const lines = plain('| name | n |\n|---|---:|\n| a | 1 |\n| bb | 22 |')
    expect(lines[0]?.startsWith('┌')).toBe(true)
    expect(lines).toContain('│ a    │   1 │')
    const widths = new Set(lines.map(line => textWidth(line)))
    expect(widths.size).toBe(1)
  })

  it('wraps lists with hanging indents', () => {
    const lines = plain('- alpha beta gamma delta epsilon zeta', 20)
    expect(lines[0]?.startsWith('• ')).toBe(true)
    expect(lines.slice(1).every(line => line.startsWith('  '))).toBe(true)
  })
})
