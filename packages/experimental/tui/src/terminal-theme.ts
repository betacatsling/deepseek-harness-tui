/**
 * Pick the dark or light palette. An explicit choice (`--theme`,
 * `DSH_TUI_THEME`, or `/theme`, persisted in `~/.dsh/tui.json`) wins;
 * otherwise the terminal is asked for its background colour with OSC 11,
 * falling back to `COLORFGBG` and finally to dark.
 * @module @deepseek-ai/dsh-experimental-tui/terminal-theme
 */

import type { ThemeName, ThemeSetting } from './theme.ts'

/** An sRGB colour with 0–1 channels. */
export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

const OSC11 = /\x1b\]11;(rgba?):([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)(?:\/[0-9a-f]+)?(?:\x07|\x1b\\)/i
const DA1 = /\x1b\[\?[\d;]*c/

/** Parse an OSC 11 reply (`ESC ] 11 ; rgb:RRRR/GGGG/BBBB BEL|ST`). */
export function parseOsc11(data: string): Rgb | undefined {
  const match = OSC11.exec(data)
  if (match === null) return undefined
  const channel = (hex: string | undefined): number => {
    if (hex === undefined || hex === '') return 0
    return Number.parseInt(hex, 16) / (16 ** hex.length - 1)
  }
  return { r: channel(match[2]), g: channel(match[3]), b: channel(match[4]) }
}

/** WCAG relative luminance. */
export function luminance({ r, g, b }: Rgb): number {
  const lin = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** Light when black text would contrast better than white on this background. */
export function themeForBackground(rgb: Rgb): ThemeName {
  const l = luminance(rgb)
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? 'light' : 'dark'
}

/** Interpret `COLORFGBG` (`fg;bg` or `fg;default;bg`, ANSI indexes). */
export function themeFromColorFgBg(value: string | undefined): ThemeName | undefined {
  if (value === undefined || value === '') return undefined
  const bg = Number(value.split(';').at(-1))
  if (!Number.isInteger(bg) || bg < 0 || bg > 15) return undefined
  return bg === 7 || bg >= 9 ? 'light' : 'dark'
}

/** Normalise a user-supplied theme value. */
export function parseThemeSetting(value: string | undefined): ThemeSetting | undefined {
  const v = value?.trim().toLowerCase()
  return v === 'auto' || v === 'dark' || v === 'light' ? v : undefined
}

/**
 * Ask the terminal for its background with OSC 11, followed by a DA1 query
 * that every terminal answers, so terminals without OSC 11 cost one round
 * trip instead of the whole timeout. Bytes typed meanwhile are pushed back.
 * @param timeoutMs - give up after this long (slow SSH links).
 */
export function queryBackground(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, timeoutMs = 250): Promise<Rgb | undefined> {
  if (!stdin.isTTY || !stdout.isTTY) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    let buffer = ''
    let done = false
    const wasRaw = stdin.isRaw
    const finish = (rgb: Rgb | undefined): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      stdin.off('data', onData)
      try {
        stdin.setRawMode(wasRaw)
      } catch (error: unknown) {
        void error
      }
      stdin.pause()
      // Keep anything that is not part of our replies (typeahead).
      const rest = buffer.replace(OSC11, '').replace(DA1, '')
      if (rest !== '') stdin.unshift(Buffer.from(rest, 'utf8'))
      resolve(rgb)
    }
    const onData = (data: Buffer | string): void => {
      buffer += typeof data === 'string' ? data : data.toString('utf8')
      const rgb = parseOsc11(buffer)
      if (rgb !== undefined) finish(rgb)
      else if (DA1.test(buffer)) finish(undefined)
    }
    const timer = setTimeout(() => { finish(undefined) }, timeoutMs)
    try {
      stdin.setRawMode(true)
      stdin.on('data', onData)
      stdin.resume()
      stdout.write('\x1b]11;?\x1b\\\x1b[c')
    } catch (error: unknown) {
      void error
      finish(undefined)
    }
  })
}

/** Terminal.app profiles that ship with a light background. */
const LIGHT_APPLE_PROFILES = new Set(['Basic', 'Man Page', 'Novel', 'Silver Aerogel'])

/**
 * Last-resort guess for macOS Terminal.app when it does not answer OSC 11:
 * its built-in default profile ("Basic") is black on white.
 * @param profile - `defaults read com.apple.Terminal "Default Window Settings"`.
 */
export function themeFromAppleProfile(profile: string | undefined): ThemeName | undefined {
  const name = profile?.trim()
  if (name === undefined || name === '') return undefined
  return LIGHT_APPLE_PROFILES.has(name) ? 'light' : undefined
}

/** Where the effective theme came from (for `/theme` output). */
export type ThemeSource = 'flag' | 'env' | 'config' | 'osc11' | 'COLORFGBG' | 'terminal profile' | 'default'

/** The effective theme and why. */
export interface ThemeChoice {
  readonly setting: ThemeSetting
  readonly theme: ThemeName
  readonly source: ThemeSource
  /** What auto-detection found (used when switching back to auto). */
  readonly detected: ThemeName
  readonly detectedFrom: ThemeSource
}

/**
 * Resolve the theme at startup.
 * @param explicit - from the flag, env or config, with its source.
 * @param probe - OSC 11 query (skipped when an explicit theme is set).
 */
export async function chooseTheme(
  explicit: { setting: ThemeSetting; source: ThemeSource } | undefined,
  env: NodeJS.ProcessEnv,
  probe: () => Promise<Rgb | undefined>,
  guess: () => ThemeName | undefined = () => undefined,
): Promise<ThemeChoice> {
  const setting = explicit?.setting ?? 'auto'
  if (setting !== 'auto' && explicit !== undefined) {
    const fallback = themeFromColorFgBg(env.COLORFGBG)
    return { setting, theme: setting, source: explicit.source, detected: fallback ?? setting, detectedFrom: fallback === undefined ? 'default' : 'COLORFGBG' }
  }
  const rgb = await probe()
  if (rgb !== undefined) {
    const theme = themeForBackground(rgb)
    return { setting, theme, source: 'osc11', detected: theme, detectedFrom: 'osc11' }
  }
  const fromEnv = themeFromColorFgBg(env.COLORFGBG)
  if (fromEnv !== undefined) return { setting, theme: fromEnv, source: 'COLORFGBG', detected: fromEnv, detectedFrom: 'COLORFGBG' }
  const guessed = guess()
  if (guessed !== undefined) return { setting, theme: guessed, source: 'terminal profile', detected: guessed, detectedFrom: 'terminal profile' }
  return { setting, theme: 'dark', source: 'default', detected: 'dark', detectedFrom: 'default' }
}
