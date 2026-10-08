import { describe, expect, it } from 'vitest'
import { decodeButton, MOUSE_OFF, MOUSE_ON, MouseInputFilter } from '../src/mouse/protocol.ts'

const sgr = (code: number, x: number, y: number, release = false): string => `\x1b[<${String(code)};${String(x)};${String(y)}${release ? 'm' : 'M'}`

describe('SGR mouse decoding', () => {
  it('decodes buttons, motion, wheel and modifiers (0-based cells)', () => {
    expect(decodeButton(0, 4, 2, false)).toMatchObject({ kind: 'down', button: 'left', x: 4, y: 2, shift: false, alt: false, ctrl: false })
    expect(decodeButton(0, 4, 2, true)).toMatchObject({ kind: 'up', button: 'left' })
    expect(decodeButton(2, 0, 0, false)).toMatchObject({ kind: 'down', button: 'right' })
    expect(decodeButton(1, 0, 0, false)).toMatchObject({ kind: 'down', button: 'middle' })
    expect(decodeButton(32, 9, 9, false)).toMatchObject({ kind: 'drag', button: 'left' })
    expect(decodeButton(35, 9, 9, false)).toMatchObject({ kind: 'move', button: 'none' })
    expect(decodeButton(64, 1, 1, false)).toMatchObject({ kind: 'wheel', direction: 'up' })
    expect(decodeButton(65, 1, 1, false)).toMatchObject({ kind: 'wheel', direction: 'down' })
    expect(decodeButton(0 | 4 | 8 | 16, 0, 0, false)).toMatchObject({ shift: true, alt: true, ctrl: true })
  })

  it('enables SGR reporting with alternate scroll off, and resets every mode', () => {
    for (const mode of ['1000h', '1002h', '1003h', '1006h', '1007l']) expect(MOUSE_ON).toContain(`\x1b[?${mode}`)
    for (const mode of ['1000l', '1002l', '1003l', '1006l']) expect(MOUSE_OFF).toContain(`\x1b[?${mode}`)
  })
})

describe('MouseInputFilter', () => {
  it('strips reports and passes keys through', () => {
    const filter = new MouseInputFilter()
    const result = filter.push(`ab${sgr(0, 5, 3)}c${sgr(0, 5, 3, true)}\x1b[A`)
    expect(result.text).toBe('abc\x1b[A')
    expect(result.events).toEqual([
      expect.objectContaining({ kind: 'down', x: 4, y: 2 }),
      expect.objectContaining({ kind: 'up', x: 4, y: 2 }),
    ])
    expect(result.holding).toBe(false)
  })

  it('reassembles a report split across reads at every byte', () => {
    const report = sgr(64, 120, 40)
    for (let cut = 1; cut < report.length; cut += 1) {
      const filter = new MouseInputFilter()
      const first = filter.push(`x${report.slice(0, cut)}`)
      expect(first.text).toBe('x')
      expect(first.holding).toBe(true)
      const second = filter.push(`${report.slice(cut)}y`)
      expect(second.text).toBe('y')
      expect(second.events).toEqual([expect.objectContaining({ kind: 'wheel', direction: 'up', x: 119, y: 39 })])
    }
  })

  it('releases a lone Escape on flush', () => {
    const filter = new MouseInputFilter()
    expect(filter.push('\x1b')).toEqual({ text: '', events: [], holding: true })
    expect(filter.flush()).toBe('\x1b')
  })

  it('never touches bracketed paste content, even report-shaped text', () => {
    const filter = new MouseInputFilter()
    const paste = `\x1b[200~look ${sgr(0, 1, 1)} here\x1b[201~`
    const first = filter.push(paste.slice(0, 14))
    const second = filter.push(paste.slice(14))
    expect(first.text + second.text).toBe(paste)
    expect([...first.events, ...second.events]).toEqual([])
  })

  it('decodes legacy X10 reports and focus events', () => {
    const filter = new MouseInputFilter()
    const x10 = `\x1b[M${String.fromCharCode(32 + 0, 33 + 7, 33 + 2)}`
    const result = filter.push(`${x10}\x1b[I\x1b[O`)
    expect(result.text).toBe('')
    expect(result.events).toEqual([
      expect.objectContaining({ kind: 'down', button: 'left', x: 7, y: 2 }),
      { kind: 'focus', focused: true },
      { kind: 'focus', focused: false },
    ])
  })

  it('drops late terminal replies (OSC 11 colour, DA1) instead of typing them', () => {
    const filter = new MouseInputFilter()
    expect(filter.push('a\x1b]11;rgb:ffff/ffff/ffff\x1b\\b\x1b[?62;22cc').text).toBe('abc')
    expect(filter.push('\x1b]11;rgb:0000/0000/0000\x07').text).toBe('')
  })
})
