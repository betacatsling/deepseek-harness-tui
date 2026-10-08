/**
 * The TUI palette and glyphs. One restrained accent (DeepSeek blue) over
 * neutral greys; semantic colours are desaturated so tool states read at a
 * glance without turning the transcript into a rainbow.
 * @module @deepseek-ai/dsh-experimental-tui/theme
 */

import { Chalk } from 'chalk'

/** A chalk instance pinned to truecolor so ANSI renderers are deterministic (see {@link setColorLevel}). */
export const ansi = new Chalk({ level: 3 })

/** Colour roles used across Ink components and ANSI renderers. */
export interface Palette {
  accent: string
  /** Filled accent surfaces (tabs, pills) under {@link Palette.onAccent} text. */
  accentDim: string
  onAccent: string
  text: string
  muted: string
  faint: string
  border: string
  borderActive: string
  success: string
  error: string
  warning: string
  plan: string
  danger: string
  user: string
  userBg: string
  selectionBg: string
  selectionFg: string
  shimmer1: string
  shimmer2: string
  shimmer3: string
  diffAddBg: string
  diffAddFg: string
  diffDelBg: string
  diffDelFg: string
  codeBg: string
  synKeyword: string
  synString: string
  synNumber: string
  synComment: string
  synFunction: string
  synType: string
  synVariable: string
  synMeta: string
  synAttr: string
  inlineCode: string
}

/** For dark terminal backgrounds (the original palette). */
export const darkPalette: Readonly<Palette> = {
  accent: '#6E8BFF',
  accentDim: '#4A5FB8',
  onAccent: '#FFFFFF',
  text: '#E6E8EE',
  muted: '#8B93A7',
  faint: '#666E82',
  border: '#3A4152',
  borderActive: '#6E8BFF',
  success: '#7CC49A',
  error: '#F07A7A',
  warning: '#E8C17A',
  plan: '#5FB8B0',
  danger: '#E8917A',
  user: '#AEB6C8',
  userBg: '#1F232C',
  selectionBg: '#2F3B66',
  selectionFg: '#F2F4F8',
  shimmer1: '#DCE3FF',
  shimmer2: '#A9B8FF',
  shimmer3: '#8CA0FF',
  diffAddBg: '#16341F',
  diffAddFg: '#9BE0B0',
  diffDelBg: '#3D1B1F',
  diffDelFg: '#F2A4A4',
  codeBg: '#1A1D25',
  // Syntax colours: muted, low-saturation, one hue per token family.
  synKeyword: '#B39DF2',
  synString: '#A9D18E',
  synNumber: '#E6A66E',
  synComment: '#6A7287',
  synFunction: '#7FB0F5',
  synType: '#E8C77A',
  synVariable: '#E6E8EE',
  synMeta: '#6FC2C9',
  synAttr: '#E89BB0',
  inlineCode: '#B9B4F0',
}

/**
 * For light terminal backgrounds. Every foreground role keeps at least 4.5:1
 * contrast on white (text and muted much more), except `faint` and `border`,
 * which stay above 3:1 for hints and rules. Nothing relies on SGR dim, which
 * many light themes render as near-invisible grey.
 */
export const lightPalette: Readonly<Palette> = {
  accent: '#3451C7',
  accentDim: '#3451C7',
  onAccent: '#FFFFFF',
  text: '#1F2328',
  muted: '#4F5763',
  faint: '#6A727D',
  border: '#B8C0CC',
  borderActive: '#3451C7',
  success: '#1A7F37',
  error: '#C4202C',
  warning: '#8A5A00',
  plan: '#0B7268',
  danger: '#B4430A',
  user: '#2B3139',
  userBg: '#EDF0F4',
  selectionBg: '#C9D5FF',
  selectionFg: '#111418',
  shimmer1: '#8EA2F2',
  shimmer2: '#6A83E6',
  shimmer3: '#4D69D9',
  diffAddBg: '#DCF5E3',
  diffAddFg: '#116329',
  diffDelBg: '#FDE4E4',
  diffDelFg: '#A40E26',
  codeBg: '#F2F4F7',
  synKeyword: '#7340C9',
  synString: '#17672F',
  synNumber: '#9A3D00',
  synComment: '#626A75',
  synFunction: '#0B4FA8',
  synType: '#7A4D00',
  synVariable: '#1F2328',
  synMeta: '#0A6B70',
  synAttr: '#A8306F',
  inlineCode: '#5B33B0',
}

/** A concrete theme. */
export type ThemeName = 'dark' | 'light'
/** What the user asked for. */
export type ThemeSetting = 'auto' | ThemeName

/** The live palette; mutated in place by {@link setTheme}. */
export const palette: Palette = { ...darkPalette }

let current: ThemeName = 'dark'
const rebuilders: (() => void)[] = []

/**
 * A colour table that follows the active theme. Modules build their chalk
 * styles once through this; {@link setTheme} rebuilds every table in place,
 * so `c.text(…)` always paints with the current palette.
 * @param build - creates the table from {@link palette} and {@link ansi}.
 */
export function themed<T extends object>(build: () => T): T {
  const table = build()
  rebuilders.push(() => { Object.assign(table, build()) })
  return table
}

/** Switch the palette (and every {@link themed} table). */
export function setTheme(name: ThemeName): void {
  current = name
  Object.assign(palette, name === 'light' ? lightPalette : darkPalette)
  for (const rebuild of rebuilders) rebuild()
}

/** The active theme. */
export function themeName(): ThemeName {
  return current
}

/** Change the chalk colour level (3 = truecolor, 2 = 256 colours) and rebuild styles. */
export function setColorLevel(level: 0 | 1 | 2 | 3): void {
  ansi.level = level
  for (const rebuild of rebuilders) rebuild()
}

/** Glyphs shared by transcript blocks. */
export const glyph = {
  bullet: '⏺',
  elbow: '⎿',
  prompt: '>',
  spark: '✻',
  check: '✔',
  cross: '✘',
  todoOpen: '☐',
  todoDone: '☒',
  todoActive: '◼',
  pointer: '❯',
  arrowRight: '⏵',
  pause: '⏸',
  dot: '·',
  ellipsis: '…',
} as const

/** Spinner frames for the in-flight status line (Claude Code-like star pulse). */
export const spinnerFrames = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'] as const

/** Gerunds rotated in the working indicator. */
export const workingVerbs = [
  'Thinking', 'Pondering', 'Reasoning', 'Composing', 'Weaving', 'Considering', 'Distilling', 'Mulling',
] as const


/** Paint text with a palette colour. */
export function paint(color: keyof Palette, text: string): string {
  return ansi.hex(palette[color])(text)
}
