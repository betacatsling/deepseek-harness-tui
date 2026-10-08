/**
 * `@deepseek-ai/dsh-experimental-tui` — a Claude Code-style terminal UI as a
 * dsh profile bundle. The plugin mounts after the base bundle's services,
 * diverts log output, registers the scripted demo provider, and renders the
 * Ink app; every action goes through the in-process harness via the
 * {@link Bridge}.
 * @module @deepseek-ai/dsh-experimental-tui
 */

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { render } from 'ink'
import { createElement } from 'react'
import type {} from './startup.ts'
import type {} from '@deepseek-ai/dsh-cmdline'
import { Bridge, dshHome, hasDeepSeekKey } from './bridge.ts'
import { DEMO_PROVIDER, DemoLlmAdapter } from './demo/adapter.ts'
import { FileIndex } from './files.ts'
import { captureLogs } from './log-capture.ts'
import { MouseController } from './mouse/controller.ts'
import { createFilteredStdin, type FilteredStdin } from './mouse/stdin.ts'
import { TerminalModes } from './mouse/terminal.ts'
import { chooseScreen } from './screen-mode.ts'
import { readSettings } from './settings.ts'
import { initialState, Store, type UiState } from './store.ts'
import { chooseTheme, parseThemeSetting, queryBackground, type ThemeChoice, themeFromAppleProfile } from './terminal-theme.ts'
import { ansi, palette, setColorLevel, setTheme } from './theme.ts'
import { App } from './ui/app.tsx'
import { FullscreenApp } from './ui/fullscreen.tsx'
import { buildTranscript } from './viewport.ts'
export { initialState } from './store.ts'

export { DEMO_MODEL, DEMO_PROVIDER, DemoLlmAdapter } from './demo/adapter.ts'
export { Bridge } from './bridge.ts'
export { Store } from './store.ts'

/** Stable Cordis plugin name. */
export const name = 'tui'

/** Services required before the UI mounts. */
export const inject = ['tuiStartup', 'agents', 'llm', 'commands']

/** Plugin config (none yet; flags come from `tuiStartup`). */
export interface Config {}


function readAppleProfile(): string | undefined {
  if (process.platform !== 'darwin' || process.env.TERM_PROGRAM !== 'Apple_Terminal') return undefined
  try {
    return execFileSync('defaults', ['read', 'com.apple.Terminal', 'Default Window Settings'], { timeout: 300, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (error: unknown) {
    void error
    return undefined
  }
}

/** Flag → env → tui.json → detection. */
async function resolveTheme(flag: string | undefined): Promise<ThemeChoice> {
  const env = process.env
  // Terminal.app before macOS 26 has no truecolor; 256 colours map the palette faithfully.
  if (env.TERM_PROGRAM === 'Apple_Terminal' && !/truecolor|24bit/i.test(env.COLORTERM ?? '')) setColorLevel(2)
  const fromFlag = parseThemeSetting(flag)
  const fromEnv = parseThemeSetting(env.DSH_TUI_THEME)
  const fromConfig = parseThemeSetting(readSettings(dshHome()).theme)
  if (flag !== undefined && fromFlag === undefined) process.stderr.write(`dsh tui: unknown --theme ${JSON.stringify(flag)} (use auto, dark or light)\n`)
  const explicit = fromFlag !== undefined ? { setting: fromFlag, source: 'flag' as const }
    : fromEnv !== undefined ? { setting: fromEnv, source: 'env' as const }
      : fromConfig !== undefined ? { setting: fromConfig, source: 'config' as const }
        : undefined
  return chooseTheme(explicit, env, () => queryBackground(process.stdin, process.stdout), () => themeFromAppleProfile(readAppleProfile()))
}

/** The settled conversation, printed to the primary screen after fullscreen exits. */
function exitTranscript(state: UiState, width: number): string {
  const lines = buildTranscript({ ...state, live: undefined }, { width, expanded: new Set(), frame: 0 }).lines
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

function packageVersion(): string {
  return process.env.DSH_VERSION ?? '0.2.1-alpha.1'
}

/**
 * Mount the TUI.
 * @param ctx - plugin context with the agent registry and startup values.
 */
export function apply(ctx: Context): void {
  const startup = ctx.tuiStartup
  const cwd = process.cwd()
  const keyed = hasDeepSeekKey(dshHome(), cwd)
  const demo = startup.demo || (!keyed && startup.model === undefined)
  const demoReason = startup.demo
    ? 'Demo mode · replies come from the built-in scripted model; tools, approvals, and sessions are real.'
    : demo
      ? 'No DEEPSEEK_API_KEY found · using the scripted demo model (tools, approvals, sessions are real). Run `dsh auth` or set DEEPSEEK_API_KEY, then /model.'
      : undefined

  ctx.effect(() => ctx.llm.registerAdapter([DEMO_PROVIDER], new DemoLlmAdapter()), 'tui demo provider')

  const store = new Store(initialState(packageVersion(), cwd))
  const files = new FileIndex(cwd)
  const exit = ctx.get('appExit')

  ctx.effect(() => {
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      process.stderr.write('dsh tui needs an interactive terminal (stdin and stdout must be TTYs).\n')
      queueMicrotask(() => exit?.(2))
      return () => {}
    }
    const life: { disposed: boolean; teardown?: () => void } = { disposed: false }
    void (async () => {
      const theme = await resolveTheme(startup.theme)
      if (life.disposed) return
      setTheme(theme.theme)
      store.update((draft) => { draft.theme = theme.theme })
      life.teardown = mount(theme)
    })()
    return () => {
      life.disposed = true
      life.teardown?.()
    }
  }, 'tui app')

  /** Render the UI; returns the dispose-time cleanup. */
  function mount(theme: ThemeChoice): () => void {
    const logs = captureLogs(join(dshHome(), 'logs', `tui-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.log`))
    const screen = chooseScreen(startup.mouse)
    const modes = new TerminalModes(process.stdout)
    let exiting = false
    let mouse: MouseController | undefined
    let stdin: FilteredStdin | undefined
    const restoreTerminal = (): void => {
      mouse?.dispose()
      modes.restoreSync()
      modes.uninstall()
      stdin?.dispose()
    }
    const bridge = new Bridge(ctx, store, {
      demo,
      demoReason,
      resume: startup.resume,
      continue: startup.continue,
      model: startup.model,
      permission: startup.permission,
      prompt: startup.prompt,
      logs,
      theme,
      requestExit: (code) => {
        if (exiting) return
        exiting = true
        void (async () => {
          modes.disable()
          instance.unmount()
          await instance.waitUntilExit().catch(() => {})
          restoreTerminal()
          await bridge.dispose()
          logs.restore()
          // Leaving the alternate screen drops the conversation; keep it in scrollback.
          if (screen.fullscreen) process.stdout.write(exitTranscript(store.get(), Math.max(40, (process.stdout.columns || 100) - 1)))
          const id = store.get().sessionId
          if (id !== undefined) process.stdout.write(`\n${ansi.hex(palette.faint)(`Session saved · resume with: dsh --profile tui -r ${id}`)}\n`)
          exit?.(code)
        })()
      },
    })
    if (screen.fullscreen) {
      const controller = new MouseController({
        modes,
        write: (data) => { process.stdout.write(data) },
        toast: (text, tone) => { bridge.toast(text, tone) },
        copyOnSelect: process.env.DSH_TUI_COPY_ON_SELECT !== '0',
      }, screen.capture)
      mouse = controller
      stdin = createFilteredStdin(process.stdin, (event) => { controller.handle(event) })
      if (screen.capture) modes.enable()
      else store.update((draft) => { draft.mouseOff = true })
      if (screen.note !== undefined) bridge.toast(screen.note, 'info')
    }
    const fullscreenOptions = stdin === undefined ? undefined : {
      exitOnCtrlC: false,
      patchConsole: false,
      maxFps: 60,
      alternateScreen: true,
      incrementalRendering: true,
      stdin: stdin as unknown as NodeJS.ReadStream,
    }
    const instance = mouse !== undefined && fullscreenOptions !== undefined
      ? render(createElement(FullscreenApp, { bridge, files, mouse }), fullscreenOptions)
      : render(createElement(App, { bridge, files }), { exitOnCtrlC: false, patchConsole: false, maxFps: 30 })
    void files.ensure()
    bridge.start().catch((error: unknown) => {
      store.update((draft) => {
        draft.phase = 'fatal'
        draft.fatal = error instanceof Error ? error.message : String(error)
      })
    })
    return () => {
      if (!exiting) {
        restoreTerminal()
        instance.unmount()
        void bridge.dispose()
        logs.restore()
      }
    }
  }

}
