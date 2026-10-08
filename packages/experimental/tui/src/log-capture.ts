/**
 * Divert console and stderr output while the TUI owns the terminal. Cordis
 * loggers write through `console.log`; any line that reached the TTY would
 * corrupt Ink's frame, so lines go to a log file plus a bounded in-memory ring
 * that `/logs` can show.
 * @module @deepseek-ai/dsh-experimental-tui/log-capture
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { format } from 'node:util'

/** One captured line. */
export interface CapturedLine {
  readonly time: number
  readonly level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'stderr'
  readonly text: string
}

/** Strip ANSI escapes so the log file and ring stay plain text. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
}

/** The live capture handle. */
export interface LogCapture {
  readonly path: string
  lines(): readonly CapturedLine[]
  /** Count of warn/error lines since start. */
  problems(): number
  subscribe(listener: () => void): () => void
  restore(): void
}

/**
 * Start capturing.
 * @param path - log file path; parent directories are created.
 * @param limit - ring size.
 * @returns the capture handle; call `restore()` before exiting.
 */
export function captureLogs(path: string, limit = 500): LogCapture {
  mkdirSync(dirname(path), { recursive: true })
  const ring: CapturedLine[] = []
  const listeners = new Set<() => void>()
  let problemCount = 0
  const push = (level: CapturedLine['level'], raw: string): void => {
    const text = stripAnsi(raw).replace(/\s+$/, '')
    if (text === '') return
    const line: CapturedLine = { time: Date.now(), level, text }
    ring.push(line)
    if (ring.length > limit) ring.shift()
    if (level === 'warn' || level === 'error' || /\b(error|warn)/i.test(text.slice(0, 40))) problemCount += 1
    try {
      appendFileSync(path, `${new Date(line.time).toISOString()} ${level} ${text}\n`)
    } catch (error: unknown) {
      // The log file is best-effort; the in-memory ring still carries the line.
      void error
    }
    for (const listener of listeners) listener()
  }
  const original = {
    log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug,
    stderrWrite: process.stderr.write.bind(process.stderr),
  }
  console.log = (...args: unknown[]) => { push('log', format(...args)) }
  console.info = (...args: unknown[]) => { push('info', format(...args)) }
  console.warn = (...args: unknown[]) => { push('warn', format(...args)) }
  console.error = (...args: unknown[]) => { push('error', format(...args)) }
  console.debug = (...args: unknown[]) => { push('debug', format(...args)) }
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    push('stderr', typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    const callback = rest.find((item): item is () => void => typeof item === 'function')
    callback?.()
    return true
  })
  return {
    path,
    lines: () => ring,
    problems: () => problemCount,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    restore() {
      console.log = original.log
      console.info = original.info
      console.warn = original.warn
      console.error = original.error
      console.debug = original.debug
      process.stderr.write = original.stderrWrite
    },
  }
}
