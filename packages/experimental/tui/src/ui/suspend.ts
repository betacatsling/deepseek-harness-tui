/**
 * Ctrl+Z: hand the terminal back to the shell (leave the alternate screen,
 * turn mouse and focus reporting off, restore cooked mode), stop with
 * SIGTSTP, and on SIGCONT take the terminal back and redraw. This mirrors
 * Codex's `tui/job_control.rs` and Grok Build's suspend path.
 * @module @deepseek-ai/dsh-experimental-tui/ui/suspend
 */

import type { SuspendTerminal } from 'ink'

/** The part of {@link MouseController} the suspend path needs. */
interface ReportingOwner {
  release(): void
  reclaim(): void
}

let suspended = false

/**
 * Suspend the process like a shell job.
 * @param suspendTerminal - Ink's `useApp().suspendTerminal`.
 * @param mouse - fullscreen mouse owner (absent in inline mode).
 */
export async function suspendToShell(suspendTerminal: SuspendTerminal, mouse?: ReportingOwner): Promise<void> {
  if (process.platform === 'win32' || suspended) return
  suspended = true
  try {
    mouse?.release()
    const suspension = await suspendTerminal()
    await new Promise<void>((resolve) => {
      process.once('SIGCONT', () => { resolve() })
      process.kill(process.pid, 'SIGTSTP')
    })
    mouse?.reclaim()
    await suspension.resume()
  } finally {
    suspended = false
  }
}
