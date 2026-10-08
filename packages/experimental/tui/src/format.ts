/**
 * Small number and time formatters shared by the status line and commands.
 * @module @deepseek-ai/dsh-experimental-tui/format
 */

/** 1234 → 1.2k, 1234567 → 1.23M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${String(Math.round(n / 1000))}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** Elapsed seconds as `12s` / `3m 04s`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${String(total)}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m)}m ${String(s).padStart(2, '0')}s`
}

/** Collapse the home directory to `~`. */
export function tildify(path: string, home: string): string {
  return home !== '' && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}
