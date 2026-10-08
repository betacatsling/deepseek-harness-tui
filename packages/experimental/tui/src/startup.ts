/**
 * The TUI app's command-line provider. It parses this profile's own flags and
 * publishes {@link TUI_STARTUP_SERVICE}; the TUI row waits for that service
 * before mounting, exactly like the headless and Web startup providers.
 * @module @deepseek-ai/dsh-experimental-tui/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the TUI row. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** Values the TUI row reads from {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupValues {
  /** Force the scripted demo model even when a real key is configured. */
  demo: boolean
  /** Exact session to resume at startup. */
  resume: string | undefined
  /** Resume the most recent session recorded for this working directory. */
  continue: boolean
  /** Override the starting model as `provider/model` or a bare model id. */
  model: string | undefined
  /** Starting permission preset. */
  permission: string | undefined
  /** Optional first prompt submitted right after the banner. */
  prompt: string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiStartup: TuiStartupValues
  }
}

/**
 * Build this app's command grammar.
 * @returns a fresh program so tests can parse more than once.
 */
export function tuiCommand(): Command {
  return new Command()
    .name('dsh tui')
    .description('Interactive Claude Code-style terminal UI for DeepSeek Harness.')
    .helpOption('-h, --help', 'show this help')
    .option('--demo', 'use the built-in scripted demo model (no API key needed)')
    .option('-r, --resume <session-id>', 'resume a persisted session')
    .option('-c, --continue', 'resume the most recent session in this directory')
    .option('-m, --model <route>', 'starting model, as provider/model or a model id')
    .option('-p, --permission <preset>', 'starting permission preset, e.g. workspace-write')
    .argument('[prompt...]', 'optional first prompt')
    .addHelpText('after', `
Examples:
  dsh tui                         start a session in the current directory
  dsh tui --demo                  try every feature with the scripted demo model
  dsh tui -c                      continue the latest session here
  dsh tui "explain this repo"     start with a first prompt
`)
}

/**
 * Parse and provide the startup values.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    const options = program.opts<{
      demo?: boolean
      resume?: string
      continue?: boolean
      model?: string
      permission?: string
    }>()
    const prompt = program.args.join(' ').trim()
    ctx.provide(TUI_STARTUP_SERVICE, {
      demo: options.demo === true || process.env.DSH_TUI_DEMO === '1',
      resume: options.resume,
      continue: options.continue === true,
      model: options.model,
      permission: options.permission,
      prompt: prompt === '' ? undefined : prompt,
    } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, program)
}
