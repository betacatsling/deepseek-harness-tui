/**
 * Owns the terminal's mouse and focus reporting modes. Enabling is idempotent;
 * every exit path (normal quit, harness dispose, uncaught crash, SIGHUP or
 * SIGQUIT, Ctrl+Z) resets the modes with a synchronous write so a dead or
 * stopped process can never leave the shell receiving mouse garbage.
 *
 * The shape mirrors Codex's `AlternateScreen` (an atomic "mouse active" flag
 * that panic and exit cleanup can read without borrowing the UI) and Grok
 * Build's `terminal_restore.rs` (one teardown byte order shared by the panic
 * hook, the signal path and the normal restore).
 * @module @deepseek-ai/dsh-experimental-tui/mouse/terminal
 */

import { writeSync } from 'node:fs'
import { FOCUS_OFF, FOCUS_ON, MOUSE_OFF, MOUSE_ON } from './protocol.ts'

/** Something that accepts terminal output (process.stdout in production). */
export interface TerminalSink {
  write(data: string): unknown
  readonly fd?: number
}

const RESTORE_SIGNALS = ['SIGHUP', 'SIGQUIT'] as const

/** Reporting-mode state for one terminal. */
export class TerminalModes {
  private mouse = false
  private focus = false
  private installed = false
  private readonly onExit = (): void => { this.restoreSync() }
  private readonly onSignal = (signal: NodeJS.Signals): void => {
    this.restoreSync()
    // Re-raise with our listener gone so the default action (or Ink's own
    // signal-exit teardown, which only fires when it is the last listener)
    // still runs.
    this.uninstall()
    process.kill(process.pid, signal)
  }

  constructor(private readonly sink: TerminalSink) {}

  /** Whether mouse reports are currently requested. */
  get mouseActive(): boolean {
    return this.mouse
  }

  /** Request mouse (and focus) reporting. Safe to call repeatedly. */
  enable(): void {
    this.install()
    if (!this.mouse) {
      this.mouse = true
      this.sink.write(MOUSE_ON)
    }
    if (!this.focus) {
      this.focus = true
      this.sink.write(FOCUS_ON)
    }
  }

  /** Re-send the enable sequence (after focus returns; relays can strip DEC modes). */
  reassert(): void {
    if (this.mouse) this.sink.write(MOUSE_ON)
  }

  /** Stop mouse reporting; focus reports stay on so a later enable can re-assert. */
  disableMouse(): void {
    if (!this.mouse) return
    this.mouse = false
    this.sink.write(MOUSE_OFF)
  }

  /** Turn every mode off (async write through the stream). */
  disable(): void {
    this.disableMouse()
    if (this.focus) {
      this.focus = false
      this.sink.write(FOCUS_OFF)
    }
  }

  /**
   * Synchronous best-effort reset for exit and crash paths. Writes the resets
   * whether or not we believe they are on: a partial earlier write may have
   * enabled reporting anyway.
   */
  restoreSync(): void {
    if (!this.installed && !this.mouse && !this.focus) return
    this.mouse = false
    this.focus = false
    const bytes = MOUSE_OFF + FOCUS_OFF
    try {
      if (typeof this.sink.fd === 'number') writeSync(this.sink.fd, bytes)
      else this.sink.write(bytes)
    } catch (error: unknown) {
      void error
    }
  }

  /** Remove process hooks (after a clean shutdown). */
  uninstall(): void {
    if (!this.installed) return
    this.installed = false
    process.off('exit', this.onExit)
    for (const signal of RESTORE_SIGNALS) process.off(signal, this.onSignal)
  }

  private install(): void {
    if (this.installed) return
    this.installed = true
    process.on('exit', this.onExit)
    if (process.platform !== 'win32') {
      for (const signal of RESTORE_SIGNALS) process.on(signal, this.onSignal)
    }
  }
}
