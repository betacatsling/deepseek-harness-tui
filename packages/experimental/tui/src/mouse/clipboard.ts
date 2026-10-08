/**
 * Clipboard writes for selections and /copy. OSC 52 reaches the local
 * terminal's clipboard even over SSH (wrapped for tmux passthrough); a native
 * helper (pbcopy, wl-copy, xclip, xsel, clip.exe) is tried too when one is on
 * PATH, since some terminals ignore OSC 52. Codex's clipboard_copy routes the
 * same way (native, tmux, then OSC 52).
 * @module @deepseek-ai/dsh-experimental-tui/mouse/clipboard
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** Largest payload most terminals accept in one OSC 52 write. */
const OSC52_MAX_BYTES = 100_000

/** The OSC 52 sequence for `text`, tmux-wrapped when needed. */
export function osc52(text: string, tmux = process.env.TMUX !== undefined): string {
  const body = `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`
  return tmux ? `\x1bPtmux;${body.replaceAll('\x1b', '\x1b\x1b')}\x1b\\` : body
}

function onPath(command: string): boolean {
  return (process.env.PATH ?? '').split(delimiter).some(dir => dir !== '' && existsSync(join(dir, command)))
}

function nativeHelper(): readonly string[] | undefined {
  if (process.env.SSH_CONNECTION !== undefined) return undefined
  if (process.platform === 'darwin') return onPath('pbcopy') ? ['pbcopy'] : undefined
  if (process.platform === 'win32') return ['clip.exe']
  if (process.env.WAYLAND_DISPLAY !== undefined && onPath('wl-copy')) return ['wl-copy']
  if (process.env.DISPLAY !== undefined) {
    if (onPath('xclip')) return ['xclip', '-selection', 'clipboard']
    if (onPath('xsel')) return ['xsel', '--clipboard', '--input']
  }
  if (onPath('clip.exe')) return ['clip.exe']
  return undefined
}

/**
 * Copy text to the system clipboard.
 * @param text - what to copy.
 * @param write - terminal writer (process.stdout.write).
 * @returns the routes attempted, for the confirmation toast.
 */
export function copyToClipboard(text: string, write: (data: string) => unknown): string[] {
  const routes: string[] = []
  if (Buffer.byteLength(text, 'utf8') <= OSC52_MAX_BYTES) {
    write(osc52(text))
    routes.push('osc52')
  }
  const helper = nativeHelper()
  if (helper !== undefined) {
    try {
      const [command, ...args] = helper
      const child = spawn(command ?? '', args, { stdio: ['pipe', 'ignore', 'ignore'], detached: false })
      child.on('error', () => {})
      child.stdin.on('error', () => {})
      child.stdin.end(text)
      routes.push(command ?? '')
    } catch (error: unknown) {
      void error
    }
  }
  return routes
}
