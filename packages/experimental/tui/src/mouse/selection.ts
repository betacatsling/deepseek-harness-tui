/**
 * In-app text selection over the rendered transcript: points in content
 * coordinates (line, cell column), word/line units for double and triple
 * clicks, plain-text extraction, and ANSI-preserving highlight of a column
 * range. Gesture rules follow Codex's `text_selection.rs` (400 ms multi-click
 * window on the same cell, clicks cycle char → word → line).
 * @module @deepseek-ai/dsh-experimental-tui/mouse/selection
 */

import { stripVTControlCharacters } from 'node:util'
import textWidth from '../width.ts'

/** A cell position in the transcript (line index into the full transcript). */
export interface Point {
  readonly line: number
  readonly col: number
}

/** Granularity chosen by the click count. */
export type SelectionUnit = 'char' | 'word' | 'line'

/** An active selection. `head` follows the pointer while dragging. */
export interface Selection {
  readonly anchor: Point
  readonly head: Point
  readonly unit: SelectionUnit
}

/** Normalised half-open range: `start` inclusive, `end` exclusive (on its line). */
export interface Range {
  readonly start: Point
  readonly end: Point
}

interface Cell {
  readonly text: string
  readonly col: number
  readonly width: number
  readonly index: number
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Grapheme cells of an ANSI-free string with their starting column. */
export function cellsOf(plain: string): Cell[] {
  const out: Cell[] = []
  let col = 0
  for (const { segment, index } of segmenter.segment(plain)) {
    const width = textWidth(segment)
    out.push({ text: segment, col, width, index })
    col += width
  }
  return out
}

/** Visible text of a rendered line. */
export function plainOf(line: string): string {
  return stripVTControlCharacters(line)
}

function before(a: Point, b: Point): boolean {
  return a.line < b.line || (a.line === b.line && a.col < b.col)
}

/**
 * Expand a selection to its unit and order it.
 * @param selection - anchor/head as dragged.
 * @param plainLine - plain text for a line index (for word/line units).
 */
export function normalize(selection: Selection, plainLine: (line: number) => string): Range {
  const [a, b] = before(selection.head, selection.anchor) ? [selection.head, selection.anchor] : [selection.anchor, selection.head]
  if (selection.unit === 'line') {
    return { start: { line: a.line, col: 0 }, end: { line: b.line, col: Number.MAX_SAFE_INTEGER } }
  }
  if (selection.unit === 'word') {
    const first = wordRange(plainLine(a.line), a.col)
    const last = wordRange(plainLine(b.line), b.col)
    return { start: { line: a.line, col: first.from }, end: { line: b.line, col: Math.max(last.to, b.line === a.line ? first.to : 0) } }
  }
  return { start: a, end: { line: b.line, col: b.col + 1 } }
}

/** Whether a range covers nothing. */
export function isEmpty(range: Range): boolean {
  return range.start.line === range.end.line && range.end.col <= range.start.col
}

/** Columns `[from, to)` of `line` covered by `range` (or undefined). */
export function lineSpan(range: Range, line: number): { from: number; to: number } | undefined {
  if (line < range.start.line || line > range.end.line) return undefined
  const from = line === range.start.line ? range.start.col : 0
  const to = line === range.end.line ? range.end.col : Number.MAX_SAFE_INTEGER
  return to > from ? { from, to } : undefined
}

/** Text of the cells starting inside `[from, to)`. */
export function sliceCols(plain: string, from: number, to: number): string {
  return cellsOf(plain).filter(cell => cell.col >= from && cell.col < to).map(cell => cell.text).join('')
}

/**
 * The text a selection copies: one line per transcript row, trailing padding
 * trimmed, blank edges dropped.
 */
export function selectedText(range: Range, plainLine: (line: number) => string): string {
  const rows: string[] = []
  for (let line = range.start.line; line <= range.end.line; line += 1) {
    const span = lineSpan(range, line)
    rows.push(span === undefined ? '' : sliceCols(plainLine(line), span.from, span.to).replace(/\s+$/u, ''))
  }
  return rows.join('\n').replace(/^\n+|\n+$/g, '')
}

const WORD = /[\p{L}\p{N}_\-./~@:+#%=$]/u

/** Word under a column: letters, digits and the punctuation of paths and identifiers. */
export function wordRange(plain: string, col: number): { from: number; to: number } {
  const cells = cellsOf(plain)
  const at = cells.findIndex(cell => col >= cell.col && col < cell.col + cell.width)
  if (at < 0) return { from: col, to: col }
  const isWord = (cell: Cell | undefined): boolean => cell !== undefined && WORD.test(cell.text)
  const self = cells[at]
  if (self === undefined || !isWord(self)) return { from: self?.col ?? col, to: (self?.col ?? col) + (self?.width ?? 0) }
  let first = at
  let last = at
  while (isWord(cells[first - 1])) first -= 1
  while (isWord(cells[last + 1])) last += 1
  // Sentence punctuation hugging a word is not part of it.
  while (last > first && /[.,:;]/.test(cells[last]?.text ?? '')) last -= 1
  const start = cells[first]
  const end = cells[last]
  return { from: start?.col ?? col, to: (end?.col ?? col) + (end?.width ?? 1) }
}

// CSI (incl. SGR) and OSC sequences.
const ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y

/**
 * Restyle columns `[from, to)` of an ANSI line, keeping the styling on either
 * side intact.
 * @param line - rendered ANSI line.
 * @param from - first selected column.
 * @param to - column after the last selected one.
 * @param style - paints the selected plain text.
 */
export function highlightCols(line: string, from: number, to: number, style: (text: string) => string): string {
  let left = ''
  let middle = ''
  let right = ''
  let sgr: string[] = []
  let col = 0
  let i = 0
  let opened = false
  while (i < line.length) {
    ESCAPE.lastIndex = i
    const escape = ESCAPE.exec(line)
    if (escape !== null) {
      const seq = escape[0]
      if (seq.endsWith('m') && seq.startsWith('\x1b[')) sgr = seq === '\x1b[0m' || seq === '\x1b[m' ? [] : [...sgr, seq]
      if (col < from) left += seq
      else if (col >= to) right += seq
      i += seq.length
      continue
    }
    const cp = line.codePointAt(i) ?? 0
    const ch = String.fromCodePoint(cp)
    const width = textWidth(ch)
    if (col < from) {
      left += ch
    } else if (col < to) {
      middle += ch
    } else {
      if (!opened) {
        right += `\x1b[0m${sgr.join('')}`
        opened = true
      }
      right += ch
    }
    col += width
    i += ch.length
  }
  if (middle === '') return line
  if (!opened && right !== '') right = `\x1b[0m${sgr.join('')}${right}`
  return `${left}\x1b[0m${style(middle)}${right}`
}

/** Counts rapid clicks on one cell: 1 → char, 2 → word, 3 → line, then cycles. */
export class ClickCounter {
  private last: { at: number; x: number; y: number; count: number } | undefined

  constructor(private readonly windowMs = 400) {}

  register(x: number, y: number, now: number): 1 | 2 | 3 {
    const last = this.last
    const count = last !== undefined && now - last.at < this.windowMs && last.x === x && last.y === y ? (last.count % 3) + 1 : 1
    this.last = { at: now, x, y, count }
    return count as 1 | 2 | 3
  }

  reset(): void {
    this.last = undefined
  }
}

/** Unit for a click count. */
export function unitFor(clicks: number): SelectionUnit {
  return clicks === 2 ? 'word' : clicks === 3 ? 'line' : 'char'
}
