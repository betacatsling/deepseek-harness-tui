import { describe, expect, it } from 'vitest'
import { AGENT_MODES, modeInfo, resolveModeId } from '../src/modes.ts'

describe('agent modes', () => {
  it('ships the four presets and resolves labels and aliases', () => {
    expect(AGENT_MODES.map(mode => mode.id)).toEqual(['standard', 'ptc', 'minimal', 'cordis'])
    expect(resolveModeId('Creator')).toBe('cordis')
    expect(resolveModeId('code')).toBe('ptc')
    expect(resolveModeId('PTC')).toBe('ptc')
  })

  it('resolves custom presets the registry declares and rejects the rest', () => {
    expect(resolveModeId(' Reviewer ', ['standard', 'reviewer'])).toBe('reviewer')
    expect(resolveModeId('creator', ['standard'])).toBeUndefined()
    expect(resolveModeId('', ['standard'])).toBeUndefined()
    expect(modeInfo('reviewer').label).toBe('Reviewer')
  })
})
