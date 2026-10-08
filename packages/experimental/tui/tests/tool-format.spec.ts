import { describe, expect, it } from 'vitest'
import { lineDiff, summarizeResult, toolArgument, toolTitle } from '../src/tool-format.ts'

describe('tool formatting', () => {
  it('titles calls like Claude Code', () => {
    expect(toolTitle('read', { file_path: 'src/limiter.js' })).toBe('Read(src/limiter.js)')
    expect(toolTitle('bash', { command: 'npm test' })).toBe('Bash(npm test)')
    expect(toolTitle('grep', { pattern: 'buckets', path: 'src' })).toBe('Search(pattern: "buckets", path: "src")')
    expect(toolTitle('todo_write', { todos: [] })).toBe('Update Todos')
    expect(toolArgument('update_goal', { action: 'complete' })).toBe('complete')
    expect(toolTitle('ask_user_question', { questions: [{ header: 'Redis client' }, { header: 'Outage' }] })).toBe('Ask User(Redis client, Outage)')
    expect(toolTitle('exit_plan_mode', { plan: '# Redis store\n\n1. Do it' })).toBe('Plan Ready(Redis store)')
  })

  it('diffs with deletions before additions and real line numbers', () => {
    const diff = lineDiff('a\nb\nc', 'a\nB\nc', 10)
    expect(diff.map(line => line.kind)).toEqual(['ctx', 'del', 'add', 'ctx'])
    expect(diff[1]).toMatchObject({ text: 'b', oldNo: 12 })
    expect(diff[2]).toMatchObject({ text: 'B', newNo: 12 })
  })

  it('trims unchanged regions to one line of context', () => {
    const before = ['1', '2', '3', '4', '5', '6'].join('\n')
    const after = ['1', '2', '3', '4', 'five', '6'].join('\n')
    expect(lineDiff(before, after).map(line => line.text)).toEqual(['4', '5', 'five', '6'])
  })

  it('summarizes results', () => {
    expect(summarizeResult('read', {}, '<content>\n1: a\n2: b\n(End of file - total 42 lines)', false).headline).toBe('Read 42 lines')
    const edit = summarizeResult('edit', { file_path: 'x.js', old_string: 'a\nb', new_string: 'a\nc\nd' }, 'ok', false)
    expect(edit.headline).toBe('Updated x.js with 2 additions and 1 removal')
    expect(summarizeResult('glob', {}, 'a.js\nb.js\nc.js', false).headline).toBe('Found 3 files')
    expect(summarizeResult('bash', {}, 'boom', true).headline).toBe('boom')
    const goal = JSON.stringify({ goal: { phase: 'complete', objective: 'Ship it', roundsStarted: 1, maxGoalRounds: 8 } })
    expect(summarizeResult('update_goal', {}, goal, false).headline).toBe('Goal complete · round 1/8 · Ship it')
  })
})
