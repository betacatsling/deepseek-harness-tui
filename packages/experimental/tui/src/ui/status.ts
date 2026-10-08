/**
 * Footer strings: the permission/plan mode hint, the status line (model,
 * context, tokens, cwd), and the animated working indicator.
 * @module @deepseek-ai/dsh-experimental-tui/ui/status
 */

import stringWidth from '../width.ts'
import { formatElapsed, formatTokens, tildify } from '../format.ts'
import { modeInfo } from '../modes.ts'
import type { UiState } from '../store.ts'
import { ansi, glyph, palette, spinnerFrames, themed, workingVerbs } from '../theme.ts'

const c = themed(() => ({
  text: ansi.hex(palette.text),
  muted: ansi.hex(palette.muted),
  faint: ansi.hex(palette.faint),
  accent: ansi.hex(palette.accent),
  plan: ansi.hex(palette.plan),
  warning: ansi.hex(palette.warning),
  danger: ansi.hex(palette.danger),
  success: ansi.hex(palette.success),
}))

/** Left footer hint for the current permission or plan mode. */
export function modeHint(state: UiState): string {
  const cycle = c.faint(' (shift+tab to cycle)')
  if (state.preset === 'auto') {
    return c.warning(`${glyph.arrowRight} auto review`) + c.warning(' ᴱˣᴾ') + c.faint(' · the model reviews each call') + cycle
  }
  if (state.planActive) return c.plan(`${glyph.pause} plan mode on`) + cycle
  if (state.planPending) return c.plan(`${glyph.pause} plan mode queued · applies after this turn`)
  const label = state.presetLabel.toLowerCase()
  switch (state.preset) {
    case 'read-only':
      return c.muted(`${glyph.arrowRight} ${label}`) + cycle
    case 'danger-full-access':
      return c.danger(`${glyph.arrowRight}${glyph.arrowRight} full access`) + c.faint(' · no approval prompts') + cycle
    case 'workspace-write':
      return c.accent(`${glyph.arrowRight} workspace write`) + c.faint(' · asks before escalating') + cycle
    default:
      return c.muted(`${glyph.arrowRight} ${label}`) + cycle
  }
}

function meter(fraction: number, cells: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * cells)
  const color = fraction > 0.85 ? c.warning : fraction > 0.6 ? c.muted : c.accent
  return color('▰'.repeat(filled)) + c.faint('▱'.repeat(cells - filled))
}

/** Plain text of the agent-mode badge, or '' when presets are not composed. */
export function modeBadgeText(state: UiState): string {
  if (state.agentMode === undefined) return ''
  return `${modeGlyph(state.agentMode)} ${modeInfo(state.agentMode).label}`
}

function modeGlyph(id: string): string {
  switch (id) {
    case 'ptc': return '{}'
    case 'minimal': return '$'
    case 'cordis': return '✦'
    default: return '◇'
  }
}

/** The coloured agent-mode badge that leads the status line. */
function modeBadge(state: UiState): string {
  const text = modeBadgeText(state)
  if (text === '') return ''
  switch (state.agentMode) {
    case 'standard': return c.muted(text)
    case 'ptc': return ansi.bold(c.accent(text))
    case 'cordis': return ansi.bold(c.plan(text))
    default: return ansi.bold(c.text(text))
  }
}

/**
 * The status line under the composer. Parts drop from the right as the
 * terminal narrows.
 * @param state - UI state.
 * @param width - available columns.
 * @returns one ANSI line.
 */
export function statusLine(state: UiState, width: number): string {
  const sep = c.faint('  ·  ')
  const home = process.env.HOME ?? ''
  const model = c.muted(state.model.model) + (state.model.effort === undefined ? '' : c.faint(` ${state.model.effort}`)) + (state.demo ? c.warning(' demo') : '')
  const window = state.contextWindow ?? 0
  const used = state.pressure ?? 0
  const ctx = window > 0 ? `${meter(used / window, 8)} ${c.faint(`${String(Math.round((used / window) * 100))}% ctx`)}` : c.faint('ctx —')
  const u = state.usage
  const tokens = c.faint(`↑ ${formatTokens(u.input + u.cacheRead)}  ↓ ${formatTokens(u.output)}`)
  const cwd = c.faint(tildify(state.cwd, home)) + (state.branch === undefined ? '' : c.faint(` ⎇ ${state.branch}`))
  const extras: string[] = []
  if (state.goal !== undefined) extras.push(c.accent(`◎ ${state.goal.length > 28 ? `${state.goal.slice(0, 27)}…` : state.goal}`))
  if (state.jobs > 0) extras.push(c.muted(`${String(state.jobs)} job${state.jobs === 1 ? '' : 's'}`))
  if (state.problems > 0) extras.push(c.warning(`${String(state.problems)} log warning${state.problems === 1 ? '' : 's'} · /logs`))
  // Mouse capture being off changes how the screen behaves, so it outranks the rest.
  const badge = modeBadge(state)
  const parts = [...badge === '' ? [] : [badge], model, ctx, ...state.mouseOff ? [c.muted('○ mouse off · /mouse on')] : [], tokens, cwd, ...extras]
  while (parts.length > 1 && stringWidth(`  ${parts.join(sep)}`) > width) parts.pop()
  return `  ${parts.join(sep)}`
}

/** Columns of the clickable agent-mode badge at the start of {@link statusLine}. */
export function statusModeSpan(state: UiState): { from: number; to: number } {
  const badge = modeBadgeText(state)
  return { from: 2, to: 2 + stringWidth(badge) }
}

/** Columns of the clickable model segment in {@link statusLine} (after the mode badge). */
export function statusModelSpan(state: UiState): { from: number; to: number } {
  const label = state.model.model + (state.model.effort === undefined ? '' : ` ${state.model.effort}`) + (state.demo ? ' demo' : '')
  const badge = modeBadgeText(state)
  const from = 2 + (badge === '' ? 0 : stringWidth(badge) + 5)
  return { from, to: from + stringWidth(label) }
}

/** Shimmer: a soft highlight sweeping across the text. */
export function shimmer(text: string, frame: number): string {
  const chars = Array.from(text) // display glyphs here are BMP symbols, not grapheme clusters
  const span = chars.length + 8
  const head = (frame % span) - 4
  return chars.map((ch, index) => {
    const distance = Math.abs(index - head)
    if (distance === 0) return ansi.hex(palette.shimmer1)(ch)
    if (distance === 1) return ansi.hex(palette.shimmer2)(ch)
    if (distance === 2) return ansi.hex(palette.shimmer3)(ch)
    return c.accent(ch)
  }).join('')
}

/**
 * The working indicator shown while a turn runs.
 * @param state - UI state.
 * @param frame - animation frame.
 * @returns one ANSI line.
 */
export function workingLine(state: UiState, frame: number): string {
  const started = state.turnStartedAt ?? Date.now()
  const verb = workingVerbs[Math.floor(started / 1000) % workingVerbs.length] ?? 'Working'
  const spinner = c.accent(spinnerFrames[frame % spinnerFrames.length] ?? '✻')
  const details = [formatElapsed(Date.now() - started)]
  const tokens = Math.round(state.turnOutputChars / 4)
  if (tokens > 0) details.push(`↓ ${formatTokens(tokens)} tokens`)
  const live = state.live
  if (live !== undefined && live.reasoning !== '' && live.text === '' && live.toolName === undefined) details.push('thinking')
  if (state.overlays.some(overlay => overlay.kind === 'approval')) details.push('waiting for approval')
  else if (state.overlays.some(overlay => overlay.kind === 'question')) details.push('waiting for your answer')
  details.push(c.text('esc') + c.faint(' to interrupt'))
  return `${spinner} ${shimmer(`${verb}…`, frame)} ${c.faint(`(${details.join(' · ')})`)}`
}
