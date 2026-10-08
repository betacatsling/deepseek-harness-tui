/**
 * The TUI palette and glyphs. One restrained accent (DeepSeek blue) over
 * neutral greys; semantic colours are desaturated so tool states read at a
 * glance without turning the transcript into a rainbow.
 * @module @deepseek-ai/dsh-experimental-tui/theme
 */

import { Chalk } from 'chalk'

/** Hex colours used across Ink components and ANSI renderers. */
export const palette = {
  accent: '#6E8BFF',
  accentDim: '#4A5FB8',
  text: '#E6E8EE',
  muted: '#8B93A7',
  faint: '#5B6275',
  border: '#3A4152',
  borderActive: '#6E8BFF',
  success: '#7CC49A',
  error: '#F07A7A',
  warning: '#E8C17A',
  plan: '#5FB8B0',
  danger: '#E8917A',
  user: '#AEB6C8',
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
} as const

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

/** A chalk instance pinned to truecolor so ANSI renderers are deterministic. */
export const ansi = new Chalk({ level: 3 })

/** Paint text with a palette colour. */
export function paint(color: keyof typeof palette, text: string): string {
  return ansi.hex(palette[color])(text)
}
