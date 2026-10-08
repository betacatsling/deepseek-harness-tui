/**
 * Which screen the TUI takes: fullscreen with mouse capture (default),
 * fullscreen without capture, or the classic inline UI.
 * @module @deepseek-ai/dsh-experimental-tui/screen-mode
 */

import { execFileSync } from 'node:child_process'

/** Fullscreen with mouse capture, fullscreen without, or the classic inline UI. */
export function chooseScreen(
  flag: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
  tmuxState: () => string | undefined = readTmuxState,
): { fullscreen: boolean; capture: boolean; note?: string } {
  const tmux = env.TMUX !== undefined && flag === undefined ? tmuxState()?.split(' ') : undefined
  // Zellij and iTerm2's tmux integration (-CC) keep their own scrollback and
  // selection; like Grok Build, stay inline there.
  const fullscreen = flag ?? (env.ZELLIJ === undefined && tmux?.[1] !== '1')
  if (!fullscreen) return { fullscreen: false, capture: false }
  // Like Codex: when tmux's own mouse mode is off, do not grab the mouse either.
  if (tmux?.[0] === '0') {
    return { fullscreen: true, capture: false, note: 'tmux mouse is off, so mouse capture is off · /mouse on to enable · PgUp/PgDn scroll' }
  }
  return { fullscreen: true, capture: true }
}

/** `"<mouse> <control mode>"`, e.g. `"1 0"`. */
function readTmuxState(): string | undefined {
  try {
    return execFileSync('tmux', ['display-message', '-p', '#{mouse} #{client_control_mode}'], { timeout: 300, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch (error: unknown) {
    void error
    return undefined
  }
}
