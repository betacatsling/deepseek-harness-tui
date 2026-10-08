import { describe, expect, it } from 'vitest'
import { formatElapsed, formatTokens, tildify } from '../src/format.ts'

describe('format', () => {
  it('formats token counts compactly', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(12_400)).toBe('12k')
    expect(formatTokens(1_250_000)).toBe('1.25M')
  })

  it('formats elapsed time', () => {
    expect(formatElapsed(4_200)).toBe('4s')
    expect(formatElapsed(125_000)).toBe('2m 05s')
  })

  it('shortens the home directory', () => {
    expect(tildify('/home/me/project', '/home/me')).toBe('~/project')
    expect(tildify('/srv/app', '/home/me')).toBe('/srv/app')
  })
})
