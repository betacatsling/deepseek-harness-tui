/**
 * A stdin stand-in for Ink. Raw bytes from the real TTY pass through
 * {@link MouseInputFilter}; mouse and focus reports go to a callback and only
 * keys and pastes reach Ink's `useInput`, so a click can never type
 * `[<0;12;5M` into the prompt.
 * @module @deepseek-ai/dsh-experimental-tui/mouse/stdin
 */

import { PassThrough } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { type FocusEvent, type MouseEvent, MouseInputFilter } from './protocol.ts'

/** How long a dangling fragment (e.g. a lone ESC) may wait for the rest of a report. */
const FRAGMENT_MS = 12

/** The handful of `tty.ReadStream` members Ink touches. */
export interface FilteredStdin extends PassThrough {
  readonly isTTY: true
  setRawMode(mode: boolean): this
  ref(): this
  unref(): this
  /** Stop reading the real stdin. */
  dispose(): void
}

/**
 * Wrap `source` (normally `process.stdin`).
 * @param source - the real TTY input.
 * @param onEvent - receives every decoded mouse or focus report.
 */
export function createFilteredStdin(source: NodeJS.ReadStream, onEvent: (event: MouseEvent | FocusEvent) => void): FilteredStdin {
  const out = new PassThrough() as unknown as FilteredStdin & { isTTY: boolean }
  const filter = new MouseInputFilter(true)
  const decoder = new StringDecoder('utf8')
  let timer: NodeJS.Timeout | undefined

  const deliver = (chunk: string): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    const result = filter.push(chunk)
    if (result.text !== '') out.write(result.text)
    for (const event of result.events) {
      try {
        onEvent(event)
      } catch (error: unknown) {
        void error
      }
    }
    if (result.holding) {
      timer = setTimeout(() => {
        timer = undefined
        const stale = filter.flush()
        if (stale !== '') out.write(stale)
      }, FRAGMENT_MS)
    }
  }
  const onData = (data: Buffer | string): void => {
    deliver(typeof data === 'string' ? data : decoder.write(data))
  }

  out.isTTY = true
  out.setRawMode = (mode: boolean) => {
    if (source.isTTY) source.setRawMode(mode)
    return out
  }
  out.ref = () => {
    source.ref()
    return out
  }
  out.unref = () => {
    source.unref()
    return out
  }
  out.dispose = () => {
    if (timer !== undefined) clearTimeout(timer)
    source.off('data', onData)
    source.pause()
  }
  source.on('data', onData)
  // An explicit earlier pause() (e.g. the OSC 11 probe) is not undone by adding a listener.
  source.resume()
  return out
}
