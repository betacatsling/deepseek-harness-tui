import { describe, expect, it } from 'vitest'
import textWidth from '../src/width.ts'

describe('textWidth', () => {
  it('counts terminal-narrow symbols as one cell', () => {
    expect(textWidth('⏺ Read')).toBe(6)
    expect(textWidth('✔ ◼ ⏸')).toBe(5)
  })

  it('keeps CJK wide and ignores ANSI', () => {
    expect(textWidth('深度求索')).toBe(8)
    expect(textWidth('\u001B[31mred\u001B[39m')).toBe(3)
  })
})
