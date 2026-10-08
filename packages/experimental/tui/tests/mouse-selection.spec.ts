import { describe, expect, it } from 'vitest'
import { stripVTControlCharacters as strip } from 'node:util'
import { osc52 } from '../src/mouse/clipboard.ts'
import { ClickCounter, highlightCols, isEmpty, lineSpan, normalize, selectedText, unitFor, wordRange } from '../src/mouse/selection.ts'
import { ansi } from '../src/theme.ts'

const lines = ['⏺ Fixed. refill() treated ms as seconds', '  • see https://example.com/a.', '']
const plain = (line: number): string => lines[line] ?? ''

describe('selection model', () => {
  it('normalises a backwards drag and extracts the text', () => {
    const range = normalize({ anchor: { line: 1, col: 6 }, head: { line: 0, col: 2 }, unit: 'char' }, plain)
    expect(range.start).toEqual({ line: 0, col: 2 })
    expect(selectedText(range, plain)).toBe('Fixed. refill() treated ms as seconds\n  • see')
    expect(lineSpan(range, 0)).toEqual({ from: 2, to: Number.MAX_SAFE_INTEGER })
  })

  it('expands double and triple clicks to a word and a line', () => {
    const word = normalize({ anchor: { line: 1, col: 12 }, head: { line: 1, col: 12 }, unit: 'word' }, plain)
    expect(selectedText(word, plain)).toBe('https://example.com/a')
    const line = normalize({ anchor: { line: 0, col: 5 }, head: { line: 0, col: 5 }, unit: 'line' }, plain)
    expect(selectedText(line, plain)).toBe(lines[0])
    expect(wordRange('foo bar', 5)).toEqual({ from: 4, to: 7 })
  })

  it('treats a stationary click as an empty selection', () => {
    expect(isEmpty({ start: { line: 0, col: 3 }, end: { line: 0, col: 3 } })).toBe(true)
  })

  it('highlights cells without losing the colours on either side', () => {
    const line = `${ansi.red('ab')}${ansi.blue('cdef')}`
    const out = highlightCols(line, 1, 3, s => `[${s}]`)
    expect(strip(out)).toBe('a[bc]def')
    expect(out).toContain('\x1b[34m')
  })

  it('counts multi-clicks on one cell within the window', () => {
    const counter = new ClickCounter(400)
    expect(counter.register(3, 3, 0)).toBe(1)
    expect(counter.register(3, 3, 100)).toBe(2)
    expect(counter.register(3, 3, 200)).toBe(3)
    expect(counter.register(4, 3, 250)).toBe(1)
    expect(counter.register(4, 3, 900)).toBe(1)
    expect(unitFor(2)).toBe('word')
  })
})

describe('clipboard', () => {
  it('encodes OSC 52 and wraps it for tmux passthrough', () => {
    expect(osc52('hi', false)).toBe('\x1b]52;c;aGk=\x07')
    expect(osc52('hi', true)).toBe('\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\')
  })
})
