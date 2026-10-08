/**
 * Small persisted TUI preferences in `<dsh home>/tui.json` (currently the
 * theme). Unknown keys are preserved; a broken file is treated as empty.
 * @module @deepseek-ai/dsh-experimental-tui/settings
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ThemeSetting } from './theme.ts'

/** Persisted preferences. */
export interface TuiSettings {
  theme?: ThemeSetting
}

/** Path of the settings file. */
export function settingsPath(home: string): string {
  return join(home, 'tui.json')
}

/** Read settings (empty on any error). */
export function readSettings(home: string): TuiSettings & Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(settingsPath(home), 'utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as TuiSettings & Record<string, unknown> : {}
  } catch (error: unknown) {
    void error
    return {}
  }
}

/** Merge `patch` into the settings file (atomic rename). */
export function writeSettings(home: string, patch: TuiSettings): void {
  const file = settingsPath(home)
  const next = { ...readSettings(home), ...patch }
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${String(process.pid)}.tmp`
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`)
  renameSync(temp, file)
}
