/**
 * Terminal mouse protocol: the DEC private modes that turn reporting on and
 * off, and a streaming filter that lifts SGR (1006) and legacy X10 mouse
 * reports plus focus reports out of raw stdin before Ink's key parser sees
 * them. Everything else (keys, bracketed paste) passes through untouched.
 *
 * Mode choice follows OpenAI Codex's owned-transcript screen
 * (codex-rs/tui/src/tui/alternate_screen.rs, Apache-2.0): button + drag +
 * any-motion tracking (1000/1002/1003) so hover can be tracked, SGR encoding
 * (1006) so coordinates past column 223 survive, and alternate scroll (1007)
 * explicitly off so a wheel never turns into ↑/↓ history keys. Teardown resets
 * every mode individually, as both Codex and Grok Build do, so a partial write
 * cannot leave the terminal reporting.
 * @module @deepseek-ai/dsh-experimental-tui/mouse/protocol
 */

/** Mouse buttons as reported by the terminal. */
export type MouseButton = 'left' | 'middle' | 'right' | 'none'

/** One decoded mouse report. Coordinates are zero-based cells. */
export interface MouseEvent {
  readonly kind: 'down' | 'up' | 'drag' | 'move' | 'wheel'
  readonly button: MouseButton
  /** Wheel direction; vertical wheels are the common case. */
  readonly direction?: 'up' | 'down' | 'left' | 'right'
  readonly x: number
  readonly y: number
  readonly shift: boolean
  readonly alt: boolean
  readonly ctrl: boolean
}

/** A focus report (DEC 1004). */
export interface FocusEvent {
  readonly kind: 'focus'
  readonly focused: boolean
}

/** Mouse tracking on: buttons, drag, any motion, SGR coordinates; wheel never becomes arrows. */
export const MOUSE_ON = '\x1b[?1007l\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h'
/** Every tracking mode off, one reset per mode. */
export const MOUSE_OFF = '\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l'
/** Focus in/out reports, used to re-assert capture after a relay strips it. */
export const FOCUS_ON = '\x1b[?1004h'
export const FOCUS_OFF = '\x1b[?1004l'

const BUTTONS: readonly MouseButton[] = ['left', 'middle', 'right', 'none']
const WHEEL: readonly ('up' | 'down' | 'left' | 'right')[] = ['up', 'down', 'left', 'right']

/**
 * Decode an xterm button byte (already offset-free) into an event.
 * @param code - the Cb value: low bits button, 4 shift, 8 meta, 16 ctrl, 32 motion, 64 wheel.
 * @param x - zero-based column.
 * @param y - zero-based row.
 * @param release - SGR `m` final byte.
 */
export function decodeButton(code: number, x: number, y: number, release: boolean): MouseEvent {
  const shift = (code & 4) !== 0
  const alt = (code & 8) !== 0
  const ctrl = (code & 16) !== 0
  const motion = (code & 32) !== 0
  const low = code & 3
  const base = { x, y, shift, alt, ctrl }
  if ((code & 64) !== 0 && (code & 128) === 0) {
    return { ...base, kind: 'wheel', button: 'none', direction: WHEEL[low] ?? 'down' }
  }
  const button = (code & 128) !== 0 ? 'none' : BUTTONS[low] ?? 'none'
  if (motion) return { ...base, kind: button === 'none' ? 'move' : 'drag', button }
  if (release || button === 'none') return { ...base, kind: 'up', button: release ? button : 'none' }
  return { ...base, kind: 'down', button }
}

// SGR: ESC [ < Cb ; Cx ; Cy (M|m)
const SGR = /^\x1b\[<(\d{1,4});(\d{1,5});(\d{1,5})([Mm])/
// A prefix that could still grow into an SGR report.
const SGR_PARTIAL = /^\x1b(?:\[(?:<(?:\d{0,4}(?:;(?:\d{0,5}(?:;\d{0,5})?)?)?)?)?)?$/
/** Complete terminal replies (late OSC 10/11 colour answers, DA1/DA2) that must never reach the prompt. */
const REPLY = /^(?:\x1b\]\d+;[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[?>][\d;]*c)/
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/** Output of one filter step. */
export interface FilterResult {
  /** Bytes for Ink (keys and paste), mouse and focus reports removed. */
  readonly text: string
  readonly events: readonly (MouseEvent | FocusEvent)[]
  /** True when a trailing fragment is held back awaiting the rest of a report. */
  readonly holding: boolean
}

/**
 * Streaming mouse/focus report filter. Reports split across reads are held
 * until complete (Grok Build's CSI fragment filter solves the same problem);
 * {@link MouseInputFilter.flush} releases a stale fragment as plain input.
 */
export class MouseInputFilter {
  private held = ''
  private inPaste = false

  /**
   * @param focusReports - also strip `ESC [ I` / `ESC [ O` (only when 1004 is on).
   */
  constructor(private readonly focusReports = true) {}

  /** Feed one decoded chunk. */
  push(chunk: string): FilterResult {
    const input = this.held + chunk
    this.held = ''
    let text = ''
    const events: (MouseEvent | FocusEvent)[] = []
    let i = 0
    while (i < input.length) {
      if (this.inPaste) {
        const end = input.indexOf(PASTE_END, i)
        if (end < 0) {
          // Keep a possible partial end marker for the next read.
          const tail = partialSuffix(input.slice(i), PASTE_END)
          text += input.slice(i, input.length - tail)
          if (tail > 0) this.held = input.slice(input.length - tail)
          return { text, events, holding: tail > 0 }
        }
        text += input.slice(i, end + PASTE_END.length)
        i = end + PASTE_END.length
        this.inPaste = false
        continue
      }
      const esc = input.indexOf('\x1b', i)
      if (esc < 0) {
        text += input.slice(i)
        break
      }
      text += input.slice(i, esc)
      const rest = input.slice(esc)
      if (rest.startsWith(PASTE_START)) {
        this.inPaste = true
        text += PASTE_START
        i = esc + PASTE_START.length
        continue
      }
      const sgr = SGR.exec(rest)
      if (sgr !== null) {
        const code = Number(sgr[1])
        events.push(decodeButton(code, Math.max(0, Number(sgr[2]) - 1), Math.max(0, Number(sgr[3]) - 1), sgr[4] === 'm'))
        i = esc + sgr[0].length
        continue
      }
      // Legacy X10: ESC [ M Cb Cx Cy, each byte offset by 32 (sent if 1006 is unsupported).
      if (rest.startsWith('\x1b[M')) {
        if (rest.length < 6) {
          this.held = rest
          return { text, events, holding: true }
        }
        const cb = rest.charCodeAt(3) - 32
        const cx = rest.charCodeAt(4) - 33
        const cy = rest.charCodeAt(5) - 33
        events.push(decodeButton(cb, Math.max(0, cx), Math.max(0, cy), false))
        i = esc + 6
        continue
      }
      if (this.focusReports && (rest.startsWith('\x1b[I') || rest.startsWith('\x1b[O'))) {
        events.push({ kind: 'focus', focused: rest[2] === 'I' })
        i = esc + 3
        continue
      }
      const reply = REPLY.exec(rest)
      if (reply !== null) {
        i = esc + reply[0].length
        continue
      }
      if (SGR_PARTIAL.test(rest) || rest === '\x1b[M' || partialSuffix(rest, PASTE_START) === rest.length) {
        this.held = rest
        return { text, events, holding: true }
      }
      text += '\x1b'
      i = esc + 1
    }
    return { text, events, holding: false }
  }

  /** Release a held fragment as ordinary input (it was not a report after all). */
  flush(): string {
    const out = this.held
    this.held = ''
    return out
  }
}

/** Length of the longest suffix of `text` that is a proper prefix of `marker`. */
function partialSuffix(text: string, marker: string): number {
  for (let n = Math.min(marker.length - 1, text.length); n > 0; n -= 1) {
    if (text.endsWith(marker.slice(0, n))) return n
  }
  return 0
}
