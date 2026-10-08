/**
 * `@deepseek-ai/dsh-experimental-tui` — a Claude Code-style terminal UI as a
 * dsh profile bundle. The plugin mounts after the base bundle's services,
 * diverts log output, registers the scripted demo provider, and renders the
 * Ink app; every action goes through the in-process harness via the
 * {@link Bridge}.
 * @module @deepseek-ai/dsh-experimental-tui
 */

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
import { initialState, Store } from './store.ts'
export { initialState } from './store.ts'
import { App } from './ui/app.tsx'

export { DEMO_MODEL, DEMO_PROVIDER, DemoLlmAdapter } from './demo/adapter.ts'
export { Bridge } from './bridge.ts'
export { Store } from './store.ts'

/** Stable Cordis plugin name. */
export const name = 'tui'

/** Services required before the UI mounts. */
export const inject = ['tuiStartup', 'agents', 'llm', 'commands']

/** Plugin config (none yet; flags come from `tuiStartup`). */
export interface Config {}


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
    const logs = captureLogs(join(dshHome(), 'logs', `tui-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.log`))
    let exiting = false
    const bridge = new Bridge(ctx, store, {
      demo,
      demoReason,
      resume: startup.resume,
      continue: startup.continue,
      model: startup.model,
      permission: startup.permission,
      prompt: startup.prompt,
      logs,
      requestExit: (code) => {
        if (exiting) return
        exiting = true
        void (async () => {
          instance.unmount()
          await bridge.dispose()
          logs.restore()
          const id = store.get().sessionId
          if (id !== undefined) process.stdout.write(`\n\x1b[38;2;91;98;117mSession saved · resume with: dsh --profile tui -r ${id}\x1b[0m\n`)
          exit?.(code)
        })()
      },
    })
    const instance = render(createElement(App, { bridge, files }), {
      exitOnCtrlC: false,
      patchConsole: false,
      maxFps: 30,
    })
    void files.ensure()
    bridge.start().catch((error: unknown) => {
      store.update((draft) => {
        draft.phase = 'fatal'
        draft.fatal = error instanceof Error ? error.message : String(error)
      })
    })
    return () => {
      if (!exiting) {
        instance.unmount()
        void bridge.dispose()
        logs.restore()
      }
    }
  }, 'tui app')
}
