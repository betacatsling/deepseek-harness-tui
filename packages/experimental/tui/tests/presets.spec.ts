import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AGENT_MODES } from '../src/modes.ts'

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))
const read = (path: string): string => readFileSync(here(path), 'utf8')

const WEB_PERSONA = 'You are a coding agent powered by the {{model}} model.'
const TUI_PERSONA = 'You are a coding agent powered by the {{model}} model, working with the user in an interactive terminal. Keep replies concise and use Markdown.'

/**
 * Undo the documented TUI differences so what remains must match the Web
 * preset token for token: the terminal persona, and tool-schedule disabled
 * (its tools need the Web session controller's `schedule` service).
 */
function normalize(text: string): string {
  return text
    .replace(/^ *#.*\n/gm, '')
    .replace(/prefix: >-\n +/g, 'prefix: ')
    .replace(/\n +/g, ' ')
    .replace(TUI_PERSONA, WEB_PERSONA)
    .replace("dsh-tool-schedule' disabled: true", "dsh-tool-schedule'")
    .trim()
}

describe('TUI agent presets', () => {
  const pkg = JSON.parse(read('../package.json')) as { dsh: { bundle: { patch: string[] } } }

  it.each(AGENT_MODES.map(mode => mode.id))('%s matches the Web preset apart from the documented differences', (id) => {
    const tui = read(`../presets/${id}.patch.yml`)
    const web = read(`../../../bundle/web-app/presets/${id}.patch.yml`)
    expect(normalize(tui)).toBe(normalize(web))
    if (id !== 'minimal') {
      expect(tui).toContain('interactive terminal')
      expect(tui).toMatch(/dsh-tool-schedule'\n {12}disabled: true/)
    }
  })

  it('lists every preset in the bundle patch after the host composition', () => {
    expect(pkg.dsh.bundle.patch).toEqual(['./cordis.patch.yml', ...AGENT_MODES.map(mode => `./presets/${mode.id}.patch.yml`)])
  })

  it('mounts the registry with Standard as the default', () => {
    const host = read('../cordis.patch.yml')
    expect(host).toContain("name: '@deepseek-ai/dsh-agent-preset-registry'")
    expect(host).toMatch(/default: standard/)
  })
})
