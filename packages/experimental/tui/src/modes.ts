/**
 * Agent modes: the TUI's names for the harness agent presets it ships
 * (presets/*.patch.yml, registered with `@deepseek-ai/dsh-agent-preset-registry`).
 * A mode decides the tools, prompt sections and skills one session runs with,
 * so it is fixed when the session is created: switching starts a new session.
 * Permission presets and plan mode stay on Shift+Tab; they are per-session
 * policy, not composition.
 * @module @deepseek-ai/dsh-experimental-tui/modes
 */

/** Display metadata for one shipped preset. */
export interface AgentModeInfo {
  /** Preset id in the registry and the session log. */
  readonly id: string
  /** Short name for pickers and the status badge. */
  readonly label: string
  /** One line on what the mode is for. */
  readonly description: string
  /** Extra names accepted by `--mode` and `/mode`. */
  readonly aliases: readonly string[]
}

/** The four presets the TUI bundle declares, in picker order. */
export const AGENT_MODES: readonly AgentModeInfo[] = [
  {
    id: 'standard',
    label: 'Standard',
    description: 'Code, files and research for most tasks; search, edit and shell tools as needed.',
    aliases: ['default', 'native'],
  },
  {
    id: 'ptc',
    label: 'PTC',
    description: 'Standard, but tools are called from TypeScript programs (run_code): batch calls, then filter, count or summarize.',
    aliases: ['code', 'programmatic'],
  },
  {
    id: 'minimal',
    label: 'Minimal',
    description: 'A fixed one-line system prompt and a single persistent shell; for testing and comparing raw model behavior.',
    aliases: ['shell', 'bare'],
  },
  {
    id: 'cordis',
    label: 'Creator',
    description: 'Customize DSH by conversation: plugins, MCP setups and your own modes, with Plugin Manager and Cordis inspection.',
    aliases: ['creator', 'creative', 'create'],
  },
]

/** The preset a session uses when nothing asks for another. */
export const DEFAULT_MODE = 'standard'

/**
 * Map user input (`--mode`, `/mode`) to a preset id.
 * @param input - an id, label or alias, any case.
 * @param known - preset ids the registry declares (custom presets included).
 * @returns the preset id, or undefined when nothing matches.
 */
export function resolveModeId(input: string, known: readonly string[] = AGENT_MODES.map(mode => mode.id)): string | undefined {
  const wanted = input.trim().toLowerCase()
  if (wanted === '') return undefined
  const exact = known.find(id => id.toLowerCase() === wanted)
  if (exact !== undefined) return exact
  const info = AGENT_MODES.find(mode => mode.label.toLowerCase() === wanted || mode.aliases.includes(wanted))
  return info !== undefined && known.includes(info.id) ? info.id : undefined
}

/**
 * Display metadata for any preset id, shipped or custom.
 * @param id - preset id.
 * @returns the shipped info, or a label derived from the id.
 */
export function modeInfo(id: string): AgentModeInfo {
  return AGENT_MODES.find(mode => mode.id === id) ?? {
    id,
    label: id.charAt(0).toUpperCase() + id.slice(1),
    description: 'Custom agent preset from your profile.',
    aliases: [],
  }
}
