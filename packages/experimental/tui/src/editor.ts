/**
 * A tiny immutable multi-line text editor model for the composer: cursor
 * motion, word and line kills, and history-aware line queries. Pure functions
 * so key handling is unit-testable without a terminal.
 * @module @deepseek-ai/dsh-experimental-tui/editor
 */

/** Editor buffer. */
export interface EditorState {
  readonly text: string
  readonly cursor: number
}

export const empty: EditorState = { text: '', cursor: 0 }

/** Buffer with the cursor at the end. */
export function fromText(text: string): EditorState {
  return { text, cursor: text.length }
}

export function insert(state: EditorState, chunk: string): EditorState {
  const text = state.text.slice(0, state.cursor) + chunk + state.text.slice(state.cursor)
  return { text, cursor: state.cursor + chunk.length }
}

export function backspace(state: EditorState): EditorState {
  if (state.cursor === 0) return state
  const prev = previousBoundary(state.text, state.cursor)
  return { text: state.text.slice(0, prev) + state.text.slice(state.cursor), cursor: prev }
}

export function deleteForward(state: EditorState): EditorState {
  if (state.cursor >= state.text.length) return state
  const next = nextBoundary(state.text, state.cursor)
  return { text: state.text.slice(0, state.cursor) + state.text.slice(next), cursor: state.cursor }
}

export function left(state: EditorState): EditorState {
  return { ...state, cursor: previousBoundary(state.text, state.cursor) }
}

export function right(state: EditorState): EditorState {
  return { ...state, cursor: nextBoundary(state.text, state.cursor) }
}

/** Start of the current line. */
export function lineStart(state: EditorState): EditorState {
  return { ...state, cursor: state.text.lastIndexOf('\n', state.cursor - 1) + 1 }
}

/** End of the current line. */
export function lineEnd(state: EditorState): EditorState {
  const next = state.text.indexOf('\n', state.cursor)
  return { ...state, cursor: next < 0 ? state.text.length : next }
}

function isWord(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch)
}

export function wordLeft(state: EditorState): EditorState {
  let i = state.cursor
  while (i > 0 && !isWord(state.text[i - 1])) i -= 1
  while (i > 0 && isWord(state.text[i - 1])) i -= 1
  return { ...state, cursor: i }
}

export function wordRight(state: EditorState): EditorState {
  let i = state.cursor
  while (i < state.text.length && !isWord(state.text[i])) i += 1
  while (i < state.text.length && isWord(state.text[i])) i += 1
  return { ...state, cursor: i }
}

/** Ctrl+W: delete the word before the cursor. */
export function killWordBack(state: EditorState): EditorState {
  const target = wordLeft(state).cursor
  return { text: state.text.slice(0, target) + state.text.slice(state.cursor), cursor: target }
}

/** Ctrl+U: delete to the start of the line. */
export function killToLineStart(state: EditorState): EditorState {
  const start = lineStart(state).cursor
  const from = start === state.cursor && start > 0 ? start - 1 : start
  return { text: state.text.slice(0, from) + state.text.slice(state.cursor), cursor: from }
}

/** Ctrl+K: delete to the end of the line. */
export function killToLineEnd(state: EditorState): EditorState {
  const end = lineEnd(state).cursor
  const to = end === state.cursor && end < state.text.length ? end + 1 : end
  return { text: state.text.slice(0, state.cursor) + state.text.slice(to), cursor: state.cursor }
}

/** Zero-based line and column of the cursor. */
export function position(state: EditorState): { line: number; column: number; lines: number } {
  const before = state.text.slice(0, state.cursor)
  const line = before.split('\n').length - 1
  const column = state.cursor - (before.lastIndexOf('\n') + 1)
  return { line, column, lines: state.text.split('\n').length }
}

/** Move one line up or down keeping the column; `undefined` at the edge. */
export function verticalMove(state: EditorState, delta: -1 | 1): EditorState | undefined {
  const { line, column, lines } = position(state)
  const target = line + delta
  if (target < 0 || target >= lines) return undefined
  const all = state.text.split('\n')
  let offset = 0
  for (let i = 0; i < target; i += 1) offset += (all[i] ?? '').length + 1
  return { ...state, cursor: offset + Math.min(column, (all[target] ?? '').length) }
}

function previousBoundary(text: string, index: number): number {
  if (index <= 0) return 0
  const code = text.charCodeAt(index - 1)
  // Step over a surrogate pair as one character.
  if (code >= 0xDC00 && code <= 0xDFFF && index >= 2) return index - 2
  return index - 1
}

function nextBoundary(text: string, index: number): number {
  if (index >= text.length) return text.length
  const code = text.charCodeAt(index)
  if (code >= 0xD800 && code <= 0xDBFF && index + 1 < text.length) return index + 2
  return index + 1
}

/** One wrapped display row of the editor: `[start, end)` into the text. */
export interface VisualRow {
  readonly start: number
  readonly end: number
}

/**
 * Word-wrap `text` into display rows of at most `width` cells. Explicit
 * newlines always break; long words hard-break. Rendering and click-to-cursor
 * share this layout so a click lands exactly where the character is drawn.
 */
export function layoutRows(text: string, width: number, measure: (s: string) => number): VisualRow[] {
  const w = Math.max(1, width)
  const rows: VisualRow[] = []
  let lineStart = 0
  for (const line of text.split('\n')) {
    const lineEnd = lineStart + line.length
    if (line === '') rows.push({ start: lineStart, end: lineStart })
    let pos = lineStart
    while (pos < lineEnd) {
      let used = 0
      let cut = pos
      let lastBreak = -1
      for (const ch of text.slice(pos, lineEnd)) {
        const cw = measure(ch)
        if (used + cw > w) break
        used += cw
        cut += ch.length
        if (ch === ' ') lastBreak = cut
      }
      if (cut >= lineEnd) {
        rows.push({ start: pos, end: lineEnd })
        break
      }
      const end = lastBreak > pos ? lastBreak : Math.max(cut, pos + 1)
      rows.push({ start: pos, end })
      pos = end
    }
    lineStart = lineEnd + 1
  }
  return rows
}

/**
 * The text index under a display cell, for click-to-place-cursor.
 * @param rows - layout from {@link layoutRows}.
 * @param row - display row (clamped).
 * @param col - display column within the row.
 */
export function indexAt(text: string, rows: readonly VisualRow[], row: number, col: number, measure: (s: string) => number): number {
  const target = rows[Math.max(0, Math.min(rows.length - 1, row))]
  if (target === undefined) return 0
  let used = 0
  let index = target.start
  for (const ch of text.slice(target.start, target.end)) {
    const cw = measure(ch)
    if (used + cw / 2 > col) return index
    used += cw
    index += ch.length
  }
  // Past the end of a soft-wrapped row, stay on this row: before its last char.
  const softWrapped = target.end > target.start && target.end < text.length && text[target.end] !== '\n'
  if (softWrapped) {
    const last = Array.from(text.slice(target.start, target.end)).at(-1) ?? ''
    return target.end - last.length
  }
  return index
}
