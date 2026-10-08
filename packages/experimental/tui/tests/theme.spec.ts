import { stripVTControlCharacters as strip } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { renderBanner } from '../src/render.ts'
import { initialState } from '../src/store.ts'
import {
  chooseTheme, luminance, parseOsc11, parseThemeSetting, type Rgb, themeForBackground, themeFromAppleProfile, themeFromColorFgBg,
} from '../src/terminal-theme.ts'
import { ansi, darkPalette, lightPalette, type Palette, palette, setTheme, themed, themeName } from '../src/theme.ts'

const channel = (hex: string, at: number): number => Number.parseInt(hex.slice(at, at + 2), 16) / 255
const rgb = (hex: string): Rgb => ({ r: channel(hex, 1), g: channel(hex, 3), b: channel(hex, 5) })
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

afterEach(() => { setTheme('dark') })

describe('terminal background detection', () => {
  it('parses OSC 11 replies in 16- and 8-bit forms with either terminator', () => {
    expect(parseOsc11('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')).toEqual({ r: 1, g: 1, b: 1 })
    expect(parseOsc11('junk\x1b]11;rgb:00/80/ff\x07')?.g).toBeCloseTo(128 / 255)
    expect(parseOsc11('\x1b[?62c')).toBeUndefined()
  })

  it('classifies backgrounds and COLORFGBG', () => {
    expect(themeForBackground(rgb('#FFFFFF'))).toBe('light')
    expect(themeForBackground(rgb('#FDF6E3'))).toBe('light')
    expect(themeForBackground(rgb('#1E1E1E'))).toBe('dark')
    expect(themeForBackground(rgb('#002B36'))).toBe('dark')
    expect(themeFromColorFgBg('0;15')).toBe('light')
    expect(themeFromColorFgBg('15;default;0')).toBe('dark')
    expect(themeFromColorFgBg('garbage')).toBeUndefined()
    expect(themeFromAppleProfile('Basic\n')).toBe('light')
    expect(themeFromAppleProfile('Pro')).toBeUndefined()
    expect(parseThemeSetting(' Light ')).toBe('light')
    expect(parseThemeSetting('blue')).toBeUndefined()
  })

  it('prefers an explicit choice, then OSC 11, then COLORFGBG, then a profile guess', async () => {
    const never = async (): Promise<Rgb | undefined> => { throw new Error('must not probe') }
    expect(await chooseTheme({ setting: 'light', source: 'flag' }, {}, never)).toMatchObject({ theme: 'light', source: 'flag' })
    const white = async (): Promise<Rgb | undefined> => rgb('#FFFFFF')
    expect(await chooseTheme(undefined, { COLORFGBG: '15;0' }, white)).toMatchObject({ theme: 'light', source: 'osc11' })
    const silent = async (): Promise<Rgb | undefined> => undefined
    expect(await chooseTheme(undefined, { COLORFGBG: '0;15' }, silent)).toMatchObject({ theme: 'light', source: 'COLORFGBG' })
    expect(await chooseTheme(undefined, {}, silent, () => 'light')).toMatchObject({ theme: 'light', source: 'terminal profile' })
    expect(await chooseTheme({ setting: 'auto', source: 'config' }, {}, silent)).toMatchObject({ theme: 'dark', source: 'default' })
  })
})

describe('palettes', () => {
  const check = (p: Palette, backgrounds: string[]): void => {
    for (const bg of backgrounds) {
      expect(contrast(p.text, bg), `text on ${bg}`).toBeGreaterThanOrEqual(7)
      expect(contrast(p.muted, bg), `muted on ${bg}`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(p.faint, bg), `faint on ${bg}`).toBeGreaterThanOrEqual(3)
      for (const role of ['accent', 'success', 'error', 'warning', 'plan', 'danger', 'inlineCode', 'synKeyword', 'synString', 'synNumber', 'synFunction', 'synType', 'synMeta', 'synAttr'] as const) {
        expect(contrast(p[role], bg), `${role} on ${bg}`).toBeGreaterThanOrEqual(4.5)
      }
    }
    expect(contrast(p.onAccent, p.accentDim), 'pill/tab text').toBeGreaterThanOrEqual(4.5)
    expect(contrast(p.selectionFg, p.selectionBg), 'selection').toBeGreaterThanOrEqual(7)
    expect(contrast(p.diffAddFg, p.diffAddBg), 'diff add').toBeGreaterThanOrEqual(4.5)
    expect(contrast(p.diffDelFg, p.diffDelBg), 'diff del').toBeGreaterThanOrEqual(4.5)
    expect(contrast(p.text, p.diffAddBg), 'code on diff add').toBeGreaterThanOrEqual(7)
    expect(contrast(p.user, p.userBg), 'user prompt').toBeGreaterThanOrEqual(7)
  }

  it('keeps every light role readable on white and off-white backgrounds', () => {
    check(lightPalette, ['#FFFFFF', '#FDF6E3', '#F5F5F5'])
  })

  it('keeps every dark role readable on black and VS Code-style backgrounds', () => {
    check(darkPalette, ['#000000', '#1E1E1E'])
  })

  it('rebuilds themed style tables in place when the theme switches', () => {
    const table = themed(() => ({ text: ansi.hex(palette.text) }))
    expect(table.text('x')).toContain('38;2;230;232;238')
    setTheme('light')
    expect(themeName()).toBe('light')
    expect(table.text('x')).toContain('38;2;31;35;40')
  })

  it('renders the banner title in dark text on light terminals', () => {
    setTheme('light')
    const banner = renderBanner(initialState('1.0.0', '/tmp'), 100).join('\n')
    expect(banner).toContain('\x1b[38;2;31;35;40m\x1b[1mWelcome to DeepSeek Harness')
    expect(strip(banner)).toContain('Tips for getting started')
  })
})
