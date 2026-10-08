/**
 * Ink render options for the two screen modes.
 *
 * Both use incremental rendering, so Ink rewrites only the lines that changed
 * since the previous frame. Typing then repaints the prompt line alone. The
 * inline mode used to rely on Ink's default log update, which erased the whole
 * live region (spacer, composer box, footer and status line) and drew it again
 * on every keystroke; terminals that ignore synchronized output (DEC mode
 * 2026, which macOS Terminal.app does not implement) show that erase as a
 * flicker. Ink still wraps each frame in synchronized output where the
 * terminal supports it.
 * @module @deepseek-ai/dsh-experimental-tui/render-options
 */

const shared = { exitOnCtrlC: false, patchConsole: false, maxFps: 60, incrementalRendering: true } as const

/** Classic inline UI: settled transcript in scrollback, live region below. */
export const INLINE_RENDER_OPTIONS = shared

/** Fullscreen alternate-screen UI (the caller adds the filtered stdin). */
export const FULLSCREEN_RENDER_OPTIONS = { ...shared, alternateScreen: true } as const
