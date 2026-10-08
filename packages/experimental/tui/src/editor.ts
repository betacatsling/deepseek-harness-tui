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
