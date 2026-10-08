import { stripVTControlCharacters as strip } from 'node:util'
import { describe, expect, it } from 'vitest'
import { initialState } from '../src/store.ts'
import { modeHint, statusLine } from '../src/ui/status.ts'

describe('status line', () => {
  const base = { ...initialState('0', '/srv/acme'), model: { provider: 'p', model: 'deepseek-v4-pro', effort: 'high' }, contextWindow: 100_000, pressure: 25_000 }

  it('names the permission or plan mode', () => {
    expect(strip(modeHint(base))).toBe('⏵ workspace write · asks before escalating (shift+tab to cycle)')
    expect(strip(modeHint({ ...base, planActive: true }))).toBe('⏸ plan mode on (shift+tab to cycle)')
    expect(strip(modeHint({ ...base, preset: 'danger-full-access' }))).toContain('⏵⏵ full access')
  })

  it('shows model, context, tokens and cwd, dropping parts when narrow', () => {
    const wide = strip(statusLine({ ...base, branch: 'main' }, 200))
    expect(wide).toContain('deepseek-v4-pro high')
    expect(wide).toContain('25% ctx')
    expect(wide).toContain('/srv/acme ⎇ main')
    const narrow = strip(statusLine(base, 40))
    expect(narrow).toContain('deepseek-v4-pro')
    expect(narrow).not.toContain('/srv/acme')
  })
})
