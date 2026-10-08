import { EventEmitter } from 'node:events'
import { Box, render, Text } from 'ink'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { FULLSCREEN_RENDER_OPTIONS, INLINE_RENDER_OPTIONS } from '../src/render-options.ts'

/** A writable that looks like an 80x24 TTY and records every write. */
class FakeTty extends EventEmitter {
  readonly isTTY = true
  readonly columns = 80
  readonly rows = 24
  writes: string[] = []
  write(chunk: string | Uint8Array): boolean {
    this.writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }
}

class FakeStdin extends EventEmitter {
  readonly isTTY = true
  setRawMode(): this { return this }
  setEncoding(): this { return this }
  resume(): this { return this }
  pause(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
  read(): null { return null }
}

const BANNER = Array.from({ length: 8 }, (_, i) => `banner line ${String(i)}`)

/** Banner and transcript above, a bordered prompt and status below. */
function frame(prompt: string): ReturnType<typeof createElement> {
  return createElement(Box, { flexDirection: 'column' },
    createElement(Text, null, BANNER.join('\n')),
    createElement(Text, null, `╭${'─'.repeat(40)}╮\n│ > ${prompt.padEnd(37)}│\n╰${'─'.repeat(40)}╯`),
    createElement(Text, null, '  workspace write · /help for shortcuts'),
    createElement(Text, null, '  model high · 0% ctx'))
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Bytes written for each keystroke after the first frame. */
async function keystrokeWrites(options: Record<string, unknown>): Promise<string[]> {
  const stdout = new FakeTty()
  const instance = render(frame(''), {
    ...options,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    interactive: true,
  })
  cleanups.push(() => { instance.unmount() })
  await sleep(40)
  const perKey: string[] = []
  let typed = ''
  for (const ch of 'hello') {
    typed += ch
    stdout.writes = []
    instance.rerender(frame(typed))
    await sleep(40)
    perKey.push(stdout.writes.join(''))
  }
  return perKey
}

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

describe('render options', () => {
  it('render incrementally in both screen modes', () => {
    expect(INLINE_RENDER_OPTIONS.incrementalRendering).toBe(true)
    expect(FULLSCREEN_RENDER_OPTIONS.incrementalRendering).toBe(true)
    expect(FULLSCREEN_RENDER_OPTIONS.alternateScreen).toBe(true)
    expect('alternateScreen' in INLINE_RENDER_OPTIONS).toBe(false)
  })

  it('repaints only the prompt line when typing inline', async () => {
    const writes = await keystrokeWrites({ ...INLINE_RENDER_OPTIONS })
    for (const out of writes) {
      expect(out).not.toMatch(/\x1b\[2J|\x1b\[3J/) // no screen clear
      expect(out).not.toContain('\x1b[2K') // no line erases
      expect(out).not.toContain('banner line') // rows above untouched
      expect(out).not.toContain('workspace write') // footer untouched
      expect(out).not.toContain('╭') // box borders untouched
    }
    expect(writes.at(-1)).toContain('hello')
    expect(Math.max(...writes.map(out => Buffer.byteLength(out)))).toBeLessThan(200)
  })

  it('documents the regression: the default log update redraws the whole live frame', async () => {
    const { incrementalRendering: _, ...withoutIncremental } = INLINE_RENDER_OPTIONS
    const writes = await keystrokeWrites(withoutIncremental)
    expect(writes.at(-1)).toContain('\x1b[2K')
    expect(writes.at(-1)).toContain('banner line')
  })
})
