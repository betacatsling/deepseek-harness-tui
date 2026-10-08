/**
 * Terminal cell width. `string-width` counts a few symbols with optional
 * emoji presentation (⏺ ◼ ⏸ ✔ ✳ ⚠) as two cells, but terminals render them
 * in text presentation as one — the same answer as `wcwidth`. Every layout
 * measurement in the TUI goes through this function so borders line up.
 * @module @deepseek-ai/dsh-experimental-tui/width
 */

import stringWidth from 'string-width'

const NARROW = /[\u23FA\u25FC\u23F8\u2714\u2733\u26A0\u23F5]/gu

/** Visible width of an ANSI string in terminal cells. */
export default function textWidth(text: string): number {
  const width = stringWidth(text)
  const narrow = text.match(NARROW)
  return narrow === null ? width : width - narrow.filter(ch => stringWidth(ch) === 2).length
}
