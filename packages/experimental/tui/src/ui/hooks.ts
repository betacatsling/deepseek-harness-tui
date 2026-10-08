/**
 * Small Ink hooks: an animation tick that only runs while something animates,
 * and the terminal size.
 * @module @deepseek-ai/dsh-experimental-tui/ui/hooks
 */

import { useStdout } from 'ink'
import { useEffect, useState } from 'react'

/** A frame counter advancing every `ms` while `active`. */
export function useTick(active: boolean, ms = 90): number {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => { setFrame(value => value + 1) }, ms)
    return () => { clearInterval(timer) }
  }, [active, ms])
  return frame
}

/** Terminal columns and rows, updated on resize. */
export function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout()
  const read = (): { columns: number; rows: number } => ({ columns: stdout.columns || 100, rows: stdout.rows || 30 })
  const [size, setSize] = useState(read)
  useEffect(() => {
    const onResize = (): void => { setSize(read()) }
    stdout.on('resize', onResize)
    return () => { stdout.off('resize', onResize) }
  })
  return size
}
