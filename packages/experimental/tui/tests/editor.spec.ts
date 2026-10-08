import { describe, expect, it } from 'vitest'
import {
  backspace, deleteForward, empty, fromText, insert, killToLineEnd, killToLineStart, killWordBack,
  left, lineEnd, lineStart, position, right, verticalMove, wordLeft, wordRight,
} from '../src/editor.ts'

describe('editor', () => {
  it('inserts and deletes around the cursor', () => {
    let state = insert(empty, 'helo')
    state = left(state)
    state = insert(state, 'l')
    expect(state).toEqual({ text: 'hello', cursor: 4 })
    expect(backspace(state)).toEqual({ text: 'helo', cursor: 3 })
    expect(deleteForward(state)).toEqual({ text: 'hell', cursor: 4 })
    expect(right(right(state)).cursor).toBe(5)
  })

  it('moves by words and kills backwards', () => {
    const state = fromText('npm run test')
    expect(wordLeft(state).cursor).toBe(8)
    expect(wordRight(fromText('npm run')).cursor).toBe(7)
    expect(killWordBack(state).text).toBe('npm run ')
  })

  it('handles multi-line buffers', () => {
    const state = { text: 'one\ntwo\nthree', cursor: 6 }
    expect(position(state)).toEqual({ line: 1, column: 2, lines: 3 })
    expect(lineStart(state).cursor).toBe(4)
    expect(lineEnd(state).cursor).toBe(7)
    expect(killToLineStart(state).text).toBe('one\no\nthree')
    expect(killToLineEnd(state).text).toBe('one\ntw\nthree')
    expect(verticalMove(state, -1)?.cursor).toBe(2)
    expect(verticalMove(state, 1)?.cursor).toBe(10)
    expect(verticalMove({ text: 'single', cursor: 2 }, -1)).toBeUndefined()
  })
})
