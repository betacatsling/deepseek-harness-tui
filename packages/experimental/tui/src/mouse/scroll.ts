/**
 * Wheel and trackpad normalisation. Terminals report scrolling as bare
 * up/down events with no magnitude, and the number of events per wheel notch
 * differs by terminal (1 in iTerm2 and WezTerm, 3 in Alacritty, kitty,
 * Ghostty, Apple Terminal). Events are grouped into short streams (gaps under
 * 80 ms); a stream whose first notch-worth of events lands almost at once is a
 * wheel and moves a fixed number of lines per notch, while a trackpad's steady
 * trickle accumulates fractional lines with velocity acceleration so a flick
 * travels and a nudge stays precise. Reversing direction drops any
 * fractional carry so the view never lurches backwards.
 *
 * The approach (streams, events-per-tick by terminal, wheel promotion,
 * interval-banded acceleration) is adapted from Grok Build's
 * `xai-grok-pager-render/src/input/mouse.rs` and the fractional-carry rule from
 * Codex's `transcript_view/input.rs`, both Apache-2.0; this is an independent,
 * much smaller TypeScript implementation. See NOTICE.
 * @module @deepseek-ai/dsh-experimental-tui/mouse/scroll
 */

/** Forced classification, or `auto` to detect per stream. */
export type ScrollMode = 'auto' | 'wheel' | 'trackpad'

/** Tunables, normally derived from the terminal and `DSH_TUI_SCROLL_*`. */
export interface ScrollConfig {
  readonly mode: ScrollMode
  /** Events a terminal sends for one wheel notch. */
  readonly eventsPerTick: number
  /** Lines one wheel notch moves. */
  readonly wheelLines: number
  /** Lines one notch-worth of trackpad events moves before acceleration. */
  readonly trackpadLines: number
  /** Natural scrolling. */
  readonly invert: boolean
  /** Overall multiplier. */
  readonly speed: number
}

const STREAM_GAP_MS = 80
const WHEEL_DETECT_MS = 12
const TRACKPAD_INTERVAL_MS = 30
const ACCEL_MIN_INTERVAL_MS = 6
const ACCEL_FAST_MS = 8
const ACCEL_MEDIUM_MS = 20
const ACCEL_WINDOW = 6
const TRACKPAD_EVENTS_PER_TICK = 3

/** Default configuration for the terminal described by `env`. */
export function scrollConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ScrollConfig {
  const program = env.TERM_PROGRAM ?? ''
  const term = env.TERM ?? ''
  const muxed = env.TMUX !== undefined || env.ZELLIJ !== undefined
  let eventsPerTick = 3
  let wheelLines = 3
  // Multiplexers re-encode reports (usually one per notch); iTerm2 and WezTerm
  // also send one event per notch.
  if (muxed || program === 'iTerm.app' || program === 'WezTerm') {
    eventsPerTick = 1
    wheelLines = 1
  } else if (program === 'vscode' || program === 'zed') {
    eventsPerTick = 1
  } else if (program === 'Apple_Terminal' || program === 'ghostty' || term.includes('kitty') || term.includes('alacritty')) {
    eventsPerTick = 3
  }
  const int = (value: string | undefined, fallback: number, max: number): number => {
    const n = Number(value)
    return Number.isFinite(n) && n >= 1 ? Math.min(max, Math.round(n)) : fallback
  }
  const mode = env.DSH_TUI_SCROLL_MODE === 'wheel' || env.DSH_TUI_SCROLL_MODE === 'trackpad' ? env.DSH_TUI_SCROLL_MODE : 'auto'
  const lines = env.DSH_TUI_SCROLL_LINES
  const speed = Number(env.DSH_TUI_SCROLL_SPEED)
  return {
    mode,
    eventsPerTick: int(env.DSH_TUI_SCROLL_EVENTS_PER_TICK, eventsPerTick, 10),
    wheelLines: int(lines, wheelLines, 20),
    trackpadLines: int(lines, 3, 20),
    invert: env.DSH_TUI_SCROLL_INVERT === '1' || env.DSH_TUI_SCROLL_INVERT === 'true',
    speed: Number.isFinite(speed) && speed > 0 ? Math.min(10, speed) : 1,
  }
}

type Kind = 'unknown' | 'wheel' | 'trackpad'

interface Stream {
  readonly direction: 1 | -1
  readonly start: number
  last: number
  events: number
  weighted: number
  applied: number
  kind: Kind
  intervals: number[]
}

/** Turns a stream of wheel events into whole-line scroll deltas. */
export class ScrollNormalizer {
  private stream: Stream | undefined
  private carry = 0
  private carryDirection: 1 | -1 | undefined

  constructor(private config: ScrollConfig, private cap = 24) {}

  /** Replace the configuration (e.g. after a settings change). */
  configure(config: ScrollConfig): void {
    this.config = config
  }

  /** Largest delta one event may deliver (half a viewport keeps flicks readable). */
  setCap(cap: number): void {
    this.cap = Math.max(3, Math.round(cap))
  }

  /** Classification of the current stream, for tests and diagnostics. */
  get kind(): Kind {
    return this.stream?.kind ?? 'unknown'
  }

  /**
   * Register one wheel event.
   * @param raw - +1 for down (towards newer content), -1 for up.
   * @param now - event time in ms.
   * @returns signed whole lines to scroll now (positive = down).
   */
  push(raw: 1 | -1, now: number): number {
    const direction: 1 | -1 = this.config.invert ? (raw === 1 ? -1 : 1) : raw
    let stream = this.stream
    if (stream !== undefined && (now - stream.last > STREAM_GAP_MS || stream.direction !== direction)) {
      this.finish(stream, stream.direction !== direction)
      stream = undefined
    }
    if (stream === undefined) {
      if (this.carryDirection !== direction) {
        this.carry = 0
        this.carryDirection = direction
      }
      stream = { direction, start: now, last: now, events: 0, weighted: 0, applied: 0, kind: this.forcedKind(), intervals: [] }
      this.stream = stream
    }
    const interval = now - stream.last
    if (stream.events > 0 && interval >= ACCEL_MIN_INTERVAL_MS) {
      stream.intervals.push(interval)
      if (stream.intervals.length > ACCEL_WINDOW) stream.intervals.shift()
    }
    stream.last = now
    stream.events += 1
    stream.weighted += this.accel(stream)
    this.classify(stream, now)

    let desired = Math.trunc(this.desired(stream))
    if (this.wheelLike(stream) && desired === 0) desired = 1
    const delta = Math.max(0, Math.min(this.cap, desired - stream.applied))
    stream.applied += delta
    return delta * direction
  }

  /** Forget the current stream (e.g. a click or keypress interrupted it). */
  reset(): void {
    this.stream = undefined
    this.carry = 0
    this.carryDirection = undefined
  }

  private forcedKind(): Kind {
    return this.config.mode === 'wheel' ? 'wheel' : this.config.mode === 'trackpad' ? 'trackpad' : 'unknown'
  }

  private classify(stream: Stream, now: number): void {
    if (stream.kind !== 'unknown') return
    const ept = Math.max(1, this.config.eventsPerTick)
    if (ept <= 1) {
      const avg = average(stream.intervals)
      if (stream.events > 2 && avg !== undefined && avg < TRACKPAD_INTERVAL_MS) stream.kind = 'trackpad'
      return
    }
    if (stream.events >= ept) stream.kind = now - stream.start <= WHEEL_DETECT_MS ? 'wheel' : 'trackpad'
  }

  /** Unclassified events on a one-event-per-notch terminal are notches until proven otherwise. */
  private wheelLike(stream: Stream): boolean {
    return stream.kind === 'wheel' || (stream.kind === 'unknown' && this.config.eventsPerTick <= 1)
  }

  private desired(stream: Stream): number {
    const { speed } = this.config
    if (this.wheelLike(stream)) {
      return stream.events * (this.config.wheelLines / Math.max(1, this.config.eventsPerTick)) * speed
    }
    // Trackpad (and still-ambiguous multi-event streams, biased towards the
    // gentler trackpad pricing so an early guess never overshoots).
    return stream.weighted * (this.config.trackpadLines / TRACKPAD_EVENTS_PER_TICK) * speed + this.carry
  }

  private accel(stream: Stream): number {
    const avg = average(stream.intervals)
    if (avg === undefined) return 1
    if (avg <= ACCEL_FAST_MS) return 2.5
    if (avg <= ACCEL_MEDIUM_MS) return 2.5 + ((avg - ACCEL_FAST_MS) / (ACCEL_MEDIUM_MS - ACCEL_FAST_MS)) * (1.6 - 2.5)
    return 1
  }

  private finish(stream: Stream, reversed: boolean): void {
    if (reversed || this.wheelLike(stream)) {
      this.carry = 0
    } else {
      const remainder = this.desired(stream) - stream.applied
      this.carry = remainder > 0 && remainder < 1 ? remainder : 0
    }
    this.stream = undefined
  }
}

function average(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
